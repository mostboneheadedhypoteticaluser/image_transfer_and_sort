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
  pendingPaths: Map<string, number>;
  lastEventAt: string | null;
  lastScanAt: string | null;
};

// Eine Datei muss nur selbst kurz ruhig sein. Andere Dateien im selben
// Import dürfen währenddessen bereits in den Katalog weiterlaufen.
const WATCH_SETTLE_MS = 650;
const WATCH_FLUSH_MAX_PATHS = 128;
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
  private readonly scanWaiters = new Map<
    number,
    Array<{
      resolve: (result: ScanResult) => void;
      reject: (error: Error) => void;
    }>
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

    const error = new Error("Dateiscan wurde wegen App-Beendigung abgebrochen.");
    for (const waiters of this.scanWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.scanWaiters.clear();
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  async waitUntilIdle(timeoutMs = 300000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.processingScans || this.pendingScans.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    if (this.processingScans || this.pendingScans.size > 0) {
      throw new Error(
        "Ein automatischer Dateiscan läuft noch oder wartet bereits in der Scan-Warteschlange."
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

  requestManualScan(sourceId: number): Promise<ScanResult> {
    if (this.stopped || !this.sources.has(sourceId)) {
      return Promise.reject(new Error("Medienquelle wird aktuell nicht überwacht."));
    }

    const result = new Promise<ScanResult>((resolve, reject) => {
      const waiters = this.scanWaiters.get(sourceId) ?? [];
      waiters.push({ resolve, reject });
      this.scanWaiters.set(sourceId, waiters);
    });

    this.requestScan(sourceId, "manuell", false);
    return result;
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

    // Ein Watcher-Ereignis ohne konkreten Pfad ist bewusst ein Vollscan-
    // Signal. Das darf nicht durch bereits wartende Einzelpfade abgeschwächt
    // werden.
    if (paths.length === 0) {
      this.pendingScans.set(sourceId, {
        automatic,
        trigger,
        paths: null,
        full: true
      });
      void this.processScanQueue();
      return;
    }

    const unique = [...new Set([...(existing?.paths ?? []), ...paths].filter(Boolean))];

    this.pendingScans.set(sourceId, {
      automatic,
      trigger,
      paths: unique,
      // Viele Einzeldateien sind kein Grund mehr für einen teuren Vollscan.
      full: false
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
      pendingPaths: new Map(),
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
    const eventAt = Date.now();
    source.lastEventAt = new Date(eventAt).toISOString();

    // Der Zeitstempel wird nur für den konkret geänderten Pfad erneuert.
    // Dadurch hält eine große Kopieraktion bereits fertige Dateien nicht mehr
    // künstlich zurück, nur weil an anderer Stelle weiterhin geschrieben wird.
    source.pendingPaths.set(changedPath || ".", eventAt);

    const wasIdle = source.debounceTimer === null;
    if (!source.debounceTimer) {
      this.scheduleSettledChanges(source, WATCH_SETTLE_MS);
    }

    if (wasIdle) {
      this.emit({
        sourceId: source.sourceId,
        sourcePath: source.sourcePath,
        kind: "CHANGE_DETECTED",
        occurredAt: source.lastEventAt,
        message:
          "Änderung erkannt" +
          (changedPath ? ": " + changedPath : "") +
          ". Prüfe kurz, ob die Datei fertig geschrieben ist …",
        changedPath: changedPath || null,
        automatic: true,
        scanResult: null
      });
    }
  }

  private scheduleSettledChanges(source: SourceWatch, delayMs: number): void {
    source.debounceTimer = setTimeout(() => {
      source.debounceTimer = null;
      const now = Date.now();
      const ready: string[] = [];
      let nextDelay = WATCH_SETTLE_MS;

      for (const [changedPath, changedAt] of source.pendingPaths) {
        const age = now - changedAt;

        if (age >= WATCH_SETTLE_MS && ready.length < WATCH_FLUSH_MAX_PATHS) {
          ready.push(changedPath);
          source.pendingPaths.delete(changedPath);
          continue;
        }

        // Bereits ruhige Pfade, die nur wegen der Batch-Grenze noch warten,
        // sollen direkt im nächsten kurzen Durchlauf folgen.
        nextDelay = Math.min(
          nextDelay,
          age >= WATCH_SETTLE_MS ? 25 : Math.max(25, WATCH_SETTLE_MS - age)
        );
      }

      if (ready.length > 0) {
        const needsFullScan = ready.includes(".");
        const concretePaths = ready.filter((item) => item !== ".");
        this.requestChangedPaths(
          source.sourceId,
          needsFullScan ? [] : concretePaths,
          needsFullScan
            ? "Dateisystemänderung ohne konkreten Pfad"
            : "Dateisystemänderung: " + concretePaths.slice(0, 3).join(", "),
          true
        );
      }

      if (source.pendingPaths.size > 0) {
        this.scheduleSettledChanges(source, nextDelay);
      }
    }, Math.max(25, delayMs));
    source.debounceTimer.unref();
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

  private resolveScanWaiters(sourceId: number, result: ScanResult): void {
    if (this.pendingScans.has(sourceId)) return;

    const waiters = this.scanWaiters.get(sourceId);
    if (!waiters || waiters.length === 0) return;
    this.scanWaiters.delete(sourceId);
    for (const waiter of waiters) waiter.resolve(result);
  }

  private rejectScanWaiters(sourceId: number, error: Error): void {
    const waiters = this.scanWaiters.get(sourceId);
    if (!waiters || waiters.length === 0) return;
    this.scanWaiters.delete(sourceId);
    for (const waiter of waiters) waiter.reject(error);
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
      this.resolveScanWaiters(sourceId, result);
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
      this.rejectScanWaiters(
        sourceId,
        error instanceof Error ? error : new Error(message)
      );
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
