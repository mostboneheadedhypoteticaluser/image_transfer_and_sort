import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { CatalogService } from "./catalog-service";
import { IGNORED_DIRECTORY_NAMES, MEDIA_EXTENSIONS } from "../catalog/constants";
import type {
  CatalogWatchEvent,
  CatalogWatchSnapshot,
  CatalogWatchSourceState,
  ScanResult,
  SourceRecord
} from "../shared/protocol";

type WatchMode = "WATCHING" | "FALLBACK" | "ERROR";

type SourceWatch = {
  sourceId: number;
  sourcePath: string;
  watcher: FSWatcher | null;
  recursive: boolean;
  mode: WatchMode;
  scanning: boolean;
  debounceTimer: NodeJS.Timeout | null;
  pendingPaths: Set<string>;
  lastEventAt: string | null;
  lastScanAt: string | null;
};

const WATCH_DEBOUNCE_MS = 3000;
const WATCH_RETRY_MS = 5000;
const SAFETY_SCAN_MS = 15 * 60 * 1000;
const HISTORY_LIMIT = 50;

export class CatalogWatchService {
  private readonly sources = new Map<number, SourceWatch>();
  private readonly history: CatalogWatchEvent[] = [];
  private readonly pendingScans = new Map<
    number,
    {
      automatic: boolean;
      trigger: string;
      paths: string[] | null;
      full: boolean;
    }
  >();
  private processingScans = false;
  private safetyTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly catalog: CatalogService,
    private readonly onEvent: (event: CatalogWatchEvent) => void
  ) {}

  async start(runInitialSafetyScan = true): Promise<void> {
    if (!this.stopped) {
      await this.syncSources();
      return;
    }

    this.stopped = false;
    await this.syncSources();

    if (!this.safetyTimer) {
      this.safetyTimer = setInterval(() => {
        void this.runSafetySweep("periodisch");
      }, SAFETY_SCAN_MS);
      this.safetyTimer.unref();
    }

    if (runInitialSafetyScan) {
      // Der vorhandene SQLite-Katalog soll beim Programmstart sofort
      // sichtbar sein. Ein Vollscan direkt nach 1,2 s blockiert sonst den
      // seriellen Katalog-Worker und verzögert listSources/getStats/listMedia.
      // Live-Watching startet sofort; der Sicherheits-Vollscan folgt später.
      setTimeout(() => {
        if (!this.stopped) void this.runSafetySweep("Programmstart");
      }, 30000).unref();
    }
  }

  stop(): void {
    this.stopped = true;

    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }

    for (const source of this.sources.values()) {
      this.closeSource(source);
    }

    this.sources.clear();
    this.pendingScans.clear();
  }

  async waitUntilIdle(timeoutMs = 300000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.processingScans && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    if (this.processingScans) {
      throw new Error(
        "Ein automatischer Dateiscan läuft noch. Der Datenbank-Reset wurde zur Sicherheit nicht gestartet."
      );
    }
  }

  getSnapshot(): CatalogWatchSnapshot {
    return {
      sources: [...this.sources.values()]
        .map((source): CatalogWatchSourceState => ({
          sourceId: source.sourceId,
          sourcePath: source.sourcePath,
          state: source.scanning ? "SCANNING" : source.mode,
          recursive: source.recursive,
          lastEventAt: source.lastEventAt,
          lastScanAt: source.lastScanAt
        }))
        .sort((left, right) => left.sourceId - right.sourceId),
      history: [...this.history]
    };
  }

  async syncSources(): Promise<void> {
    if (this.stopped) return;

    const configured = await this.catalog.request<SourceRecord[]>("listSources");
    const active = configured.filter((source) => source.enabled);
    const activeIds = new Set(active.map((source) => source.id));

    for (const [sourceId, source] of this.sources) {
      if (!activeIds.has(sourceId)) {
        this.closeSource(source);
        this.sources.delete(sourceId);
      }
    }

    for (const source of active) {
      const existing = this.sources.get(source.id);
      if (
        existing &&
        path.resolve(existing.sourcePath) === path.resolve(source.path)
      ) {
        continue;
      }

      if (existing) {
        this.closeSource(existing);
        this.sources.delete(source.id);
      }

      this.startSource(source);
    }
  }

  async sourceAdded(sourceId: number): Promise<void> {
    await this.syncSources();
    this.requestScan(sourceId, "neue Quelle", true);
  }

  requestScan(
    sourceId: number,
    trigger = "Dateisystemänderung",
    automatic = true
  ): void {
    if (this.stopped || !this.sources.has(sourceId)) return;

    // Pro Quelle reicht ein ausstehender Scan. Weitere Ereignisse werden von
    // diesem Scan automatisch mit erfasst.
    this.pendingScans.set(sourceId, {
      automatic,
      trigger,
      paths: null,
      full: true
    });
    void this.processScanQueue();
  }

  requestChangedPaths(
    sourceId: number,
    paths: string[],
    trigger = "Dateisystemänderung",
    automatic = true
  ): void {
    if (this.stopped || !this.sources.has(sourceId)) return;

    const existing = this.pendingScans.get(sourceId);
    if (existing?.full) return;

    const unique = [...new Set([...(existing?.paths ?? []), ...paths].filter(Boolean))];

    this.pendingScans.set(sourceId, {
      automatic,
      trigger,
      paths: unique.length > 0 && unique.length <= 24 ? unique : null,
      full: unique.length === 0 || unique.length > 24
    });
    void this.processScanQueue();
  }

  private startSource(source: SourceRecord): void {
    const state: SourceWatch = {
      sourceId: source.id,
      sourcePath: source.path,
      watcher: null,
      recursive: false,
      mode: "ERROR",
      scanning: false,
      debounceTimer: null,
      pendingPaths: new Set(),
      lastEventAt: null,
      lastScanAt: null
    };

    this.sources.set(source.id, state);

    try {
      this.installWatcher(state, true);
      state.mode = "WATCHING";
      state.recursive = true;
      this.emit({
        sourceId: source.id,
        sourcePath: source.path,
        kind: "WATCHING",
        occurredAt: new Date().toISOString(),
        message: "Quelle wird live und rekursiv überwacht.",
        changedPath: null,
        automatic: true,
        scanResult: null
      });
    } catch {
      try {
        this.installWatcher(state, false);
        state.mode = "FALLBACK";
        state.recursive = false;
        this.emit({
          sourceId: source.id,
          sourcePath: source.path,
          kind: "FALLBACK",
          occurredAt: new Date().toISOString(),
          message:
            "Rekursive Live-Überwachung nicht verfügbar. Wurzelordner wird beobachtet; " +
            "der 15-Minuten-Sicherheitsabgleich bleibt aktiv.",
          changedPath: null,
          automatic: true,
          scanResult: null
        });
      } catch (error) {
        state.mode = "ERROR";
        state.recursive = false;
        this.emit({
          sourceId: source.id,
          sourcePath: source.path,
          kind: "ERROR",
          occurredAt: new Date().toISOString(),
          message:
            "Quelle kann aktuell nicht live überwacht werden: " +
            (error instanceof Error ? error.message : String(error)),
          changedPath: null,
          automatic: true,
          scanResult: null
        });
      }
    }
  }

  private installWatcher(source: SourceWatch, recursive: boolean): void {
    const watcher = watch(
      source.sourcePath,
      { recursive, persistent: false },
      (_eventType, filename) => {
        if (this.stopped) return;
        const changedPath =
          filename === null || filename === undefined
            ? ""
            : filename.toString();

        if (this.shouldIgnore(changedPath)) return;
        this.queueChange(source, changedPath);
      }
    );

    watcher.on("error", (error) => {
      if (this.stopped) return;

      if (source.recursive) {
        try {
          watcher.close();
        } catch {
          // Bereits geschlossen.
        }

        try {
          this.installWatcher(source, false);
          source.mode = "FALLBACK";
          source.recursive = false;
          this.emit({
            sourceId: source.sourceId,
            sourcePath: source.sourcePath,
            kind: "FALLBACK",
            occurredAt: new Date().toISOString(),
            message:
              "Rekursive Überwachung wurde beendet. Wurzelordner-Watcher und " +
              "Sicherheitsabgleich bleiben aktiv.",
            changedPath: null,
            automatic: true,
            scanResult: null
          });
          return;
        } catch {
          // Unterhalb als Fehler melden.
        }
      }

      source.mode = "ERROR";
      this.emit({
        sourceId: source.sourceId,
        sourcePath: source.sourcePath,
        kind: "ERROR",
        occurredAt: new Date().toISOString(),
        message:
          "Dateisystem-Watcher meldet einen Fehler: " +
          (error instanceof Error ? error.message : String(error)),
        changedPath: null,
        automatic: true,
        scanResult: null
      });
    });

    source.watcher = watcher;
    source.recursive = recursive;
  }

  private closeSource(source: SourceWatch): void {
    if (source.debounceTimer) {
      clearTimeout(source.debounceTimer);
      source.debounceTimer = null;
    }

    try {
      source.watcher?.close();
    } catch {
      // Bereits beendet.
    }
    source.watcher = null;
  }

  private shouldIgnore(changedPath: string): boolean {
    if (!changedPath) return false;

    const normalized = changedPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((part) => part.toLocaleLowerCase("de-DE"));

    if (normalized.some((part) => IGNORED_DIRECTORY_NAMES.has(part))) {
      return true;
    }

    const extension = path.extname(changedPath).toLocaleLowerCase("de-DE");
    if (extension && !MEDIA_EXTENSIONS.has(extension)) {
      return true;
    }

    return false;
  }

  private queueChange(source: SourceWatch, changedPath: string): void {
    source.lastEventAt = new Date().toISOString();
    if (changedPath && source.pendingPaths.size < 20) {
      source.pendingPaths.add(changedPath);
    }

    const wasIdle = source.debounceTimer === null;

    if (source.debounceTimer) {
      clearTimeout(source.debounceTimer);
    }

    source.debounceTimer = setTimeout(() => {
      source.debounceTimer = null;
      const paths = [...source.pendingPaths];
      source.pendingPaths.clear();
      this.requestChangedPaths(
        source.sourceId,
        paths,
        paths.length > 0
          ? "Dateisystemänderung: " + paths.slice(0, 3).join(", ")
          : "Dateisystemänderung",
        true
      );
    }, WATCH_DEBOUNCE_MS);
    source.debounceTimer.unref();

    if (wasIdle) {
      this.emit({
        sourceId: source.sourceId,
        sourcePath: source.sourcePath,
        kind: "CHANGE_DETECTED",
        occurredAt: source.lastEventAt,
        message:
          "Änderung erkannt" +
          (changedPath ? ": " + changedPath : "") +
          ". Warte kurz auf abgeschlossene Schreibvorgänge …",
        changedPath: changedPath || null,
        automatic: true,
        scanResult: null
      });
    }
  }

  private async processScanQueue(): Promise<void> {
    if (this.processingScans || this.stopped) return;
    this.processingScans = true;

    try {
      while (!this.stopped && this.pendingScans.size > 0) {
        const first = this.pendingScans.entries().next().value as
          | [
              number,
              {
                automatic: boolean;
                trigger: string;
                paths: string[] | null;
                full: boolean;
              }
            ]
          | undefined;
        if (!first) break;

        const [sourceId, request] = first;
        this.pendingScans.delete(sourceId);
        await this.performScan(
          sourceId,
          request.trigger,
          request.automatic,
          request.paths,
          request.full
        );
      }
    } finally {
      this.processingScans = false;
    }
  }

  private async performScan(
    sourceId: number,
    trigger: string,
    automatic: boolean,
    paths: string[] | null,
    full: boolean
  ): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source || this.stopped) return;

    source.scanning = true;
    this.emit({
      sourceId,
      sourcePath: source.sourcePath,
      kind: "SCAN_STARTED",
      occurredAt: new Date().toISOString(),
      message:
        (full ? "Vollständiger" : "Gezielter") +
        " Katalogabgleich läuft · " +
        trigger,
      changedPath: null,
      automatic,
      scanResult: null
    });

    try {
      const result =
        full || !source.recursive || source.mode !== "WATCHING"
          ? await this.catalog.request<ScanResult>("scanSource", { sourceId })
          : await this.catalog.request<ScanResult>("reconcileSourceChanges", {
              sourceId,
              paths: paths ?? []
            });

      const finishedAt = new Date().toISOString();
      source.lastScanAt = finishedAt;
      source.scanning = false;

      // resolveSourceRoot kann einen umbenannten Quellordner übernommen haben.
      // Erst den Watcher auf den neuen Pfad setzen, dann das Ergebnis melden.
      await this.syncSources();
      const currentSource = this.sources.get(sourceId) ?? source;
      currentSource.lastScanAt = finishedAt;
      currentSource.scanning = false;

      const summary =
        result.added.toLocaleString("de-DE") + " neu · " +
        result.moved.toLocaleString("de-DE") + " verschoben · " +
        result.changed.toLocaleString("de-DE") + " geändert · " +
        result.missing.toLocaleString("de-DE") + " fehlend · " +
        result.recycleBin.toLocaleString("de-DE") + " Papierkorb";

      this.emit({
        sourceId,
        sourcePath: currentSource.sourcePath,
        kind: "SCAN_FINISHED",
        occurredAt: finishedAt,
        message:
          (result.mode === "INCREMENTAL"
            ? "Schnellabgleich abgeschlossen: "
            : "Vollabgleich abgeschlossen: ") +
          summary,
        changedPath: null,
        automatic,
        scanResult: result
      });
    } catch (error) {
      source.scanning = false;
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("Es läuft bereits ein Scan")) {
        const retry = setTimeout(() => {
          if (!this.stopped) {
            if (full) this.requestScan(sourceId, trigger, automatic);
            else this.requestChangedPaths(sourceId, paths ?? [], trigger, automatic);
          }
        }, WATCH_RETRY_MS);
        retry.unref();
        return;
      }

      source.mode = "ERROR";
      this.emit({
        sourceId,
        sourcePath: source.sourcePath,
        kind: "ERROR",
        occurredAt: new Date().toISOString(),
        message: "Automatischer Katalogabgleich fehlgeschlagen: " + message,
        changedPath: null,
        automatic,
        scanResult: null
      });
    }
  }

  private async runSafetySweep(trigger: string): Promise<void> {
    if (this.stopped) return;

    try {
      await this.syncSources();
      for (const sourceId of this.sources.keys()) {
        this.requestScan(sourceId, "Sicherheitsabgleich · " + trigger, true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const source of this.sources.values()) {
        this.emit({
          sourceId: source.sourceId,
          sourcePath: source.sourcePath,
          kind: "ERROR",
          occurredAt: new Date().toISOString(),
          message: "Sicherheitsabgleich konnte nicht vorbereitet werden: " + message,
          changedPath: null,
          automatic: true,
          scanResult: null
        });
      }
    }
  }

  private emit(event: CatalogWatchEvent): void {
    this.history.unshift(event);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.length = HISTORY_LIMIT;
    }
    this.onEvent(event);
  }
}
