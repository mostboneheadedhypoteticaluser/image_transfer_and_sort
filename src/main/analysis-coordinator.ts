import type {
  AnalysisJob,
  AnalysisQueueStats,
  FaceDetectionForEmbedding,
  PetDetectionForEmbedding,
  PipelineStatus,
  SourceRecord
} from "../shared/protocol";
import { AnalysisService } from "./analysis-service";
import { CatalogService } from "./catalog-service";

type PythonStage =
  | "technical"
  | "imageMetadata"
  | "faces"
  | "faceEmbeddings"
  | "petDetection"
  | "petFusion"
  | "petEmbeddings"
  | "objectVerification"
  | "semanticEmbeddings"
  | "videoAnalysis";

type ModuleSpec = {
  module: string;
  stage: PythonStage;
  workerMethod: string;
  completeMethod:
    | "completeAnalysisJob"
    | "completeImageMetadataJob"
    | "completeFaceDetectionJob"
    | "completeFaceEmbeddingJob"
    | "completePetDetectionJob"
    | "completePetFusionJob"
    | "completePetEmbeddingJob"
    | "completeVerifiedObjectDetectionJob"
    | "completeCatalogSemanticJob"
    | "completeSemanticEmbeddingJob"
    | "completeVideoAnalysisJob";
  label: string;
  timeoutMs: number;
};

const MODULES: ModuleSpec[] = [
  {
    module: "file-probe-v1",
    stage: "technical",
    workerMethod: "probe_media",
    completeMethod: "completeAnalysisJob",
    label: "Technische Prüfung",
    timeoutMs: 15000
  },
  {
    module: "video-analyze-v1",
    stage: "videoAnalysis",
    workerMethod: "analyze_video_frames",
    completeMethod: "completeVideoAnalysisJob",
    label: "Video · Personen, Haustiere und Motive",
    timeoutMs: 1800000
  },
  {
    module: "image-metadata-v1",
    stage: "imageMetadata",
    workerMethod: "extract_image_metadata",
    completeMethod: "completeImageMetadataJob",
    label: "Bildmetadaten",
    timeoutMs: 30000
  },
  {
    module: "face-detect-yunet-v1",
    stage: "faces",
    workerMethod: "detect_faces",
    completeMethod: "completeFaceDetectionJob",
    label: "Gesichtsdetektion",
    timeoutMs: 180000
  },
  {
    module: "face-embed-sface-v1",
    stage: "faceEmbeddings",
    workerMethod: "extract_face_embeddings",
    completeMethod: "completeFaceEmbeddingJob",
    label: "Gesichtsmerkmale",
    timeoutMs: 180000
  },
  {
    module: "pet-detect-nanodet-v1",
    stage: "petDetection",
    workerMethod: "detect_pets",
    completeMethod: "completePetDetectionJob",
    label: "Haustiere · NanoDet",
    timeoutMs: 180000
  },
  {
    module: "pet-detect-yolox-v1",
    stage: "petDetection",
    workerMethod: "detect_pets_yolox",
    completeMethod: "completePetDetectionJob",
    label: "Haustiere · YOLOX-S",
    timeoutMs: 240000
  },
  {
    module: "pet-fuse-ensemble-v1",
    stage: "petFusion",
    workerMethod: "fuse_pet_detections",
    completeMethod: "completePetFusionJob",
    label: "Haustier-Ergebnisse fusionieren",
    timeoutMs: 30000
  },
  {
    module: "pet-embed-dogreid-v1",
    stage: "petEmbeddings",
    workerMethod: "extract_dog_embeddings",
    completeMethod: "completePetEmbeddingJob",
    label: "Individuelle Hundemerkmale",
    timeoutMs: 240000
  },
  {
    module: "semantic-embed-siglip2-v1",
    stage: "semanticEmbeddings",
    workerMethod: "extract_semantic_image_embedding",
    completeMethod: "completeSemanticEmbeddingJob",
    label: "Semantikanalyse · SigLIP2 So400m NaFlex",
    timeoutMs: 1800000
  },
  {
    module: "catalog-semantic-qwen3vl4b-v3",
    stage: "objectVerification",
    workerMethod: "analyze_catalog_qwen3vl4b",
    completeMethod: "completeCatalogSemanticJob",
    label: "Kataloginhalt · Qwen3-VL 4B Gesamtbild + 4 Teilbilder",
    // Inaktivitäts-Watchdog statt absoluter Jobdauer. Fortschrittsereignisse
    // aus dem Worker setzen diese Frist jeweils neu.
    timeoutMs: 1800000
  }
];

const FACE_INFERENCE_MODULE_NAMES = new Set([
  "face-detect-yunet-v1",
  "face-embed-sface-v1"
]);

const HEAVY_MODULE_NAMES = new Set([
  // Nur die großen semantischen Modelle bleiben exklusiv hinten. Videos sind
  // normale Jobs und belegen wie ein Bild genau eine konfigurierbare Lane.
  "semantic-embed-siglip2-v1",
  "catalog-semantic-qwen3vl4b-v3"
]);

const FAST_MODULES = MODULES.filter(
  (spec) => !HEAVY_MODULE_NAMES.has(spec.module)
);

const HEAVY_MODULES = MODULES.filter(
  (spec) => HEAVY_MODULE_NAMES.has(spec.module)
);

type PythonPipelineStats = Pick<
  PipelineStatus,
  | "technical"
  | "imageMetadata"
  | "faces"
  | "faceEmbeddings"
  | "petDetection"
  | "petFusion"
  | "petEmbeddings"
  | "objectVerification"
  | "semanticEmbeddings"
  | "videoAnalysis"
>;

type PipelineQueueSnapshot = {
  byModule: Record<string, AnalysisQueueStats>;
  petDetection: AnalysisQueueStats;
};

function emptyStats(): AnalysisQueueStats {
  return { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 };
}

function addStats(
  left: AnalysisQueueStats,
  right: AnalysisQueueStats
): AnalysisQueueStats {
  return {
    pending: left.pending + right.pending,
    running: left.running + right.running,
    done: left.done + right.done,
    failed: left.failed + right.failed,
    unavailable: left.unavailable + right.unavailable
  };
}

const MAX_FAST_CONCURRENCY = 8;

export class AnalysisCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = true;
  private benchmarkPaused = false;
  private maintenancePaused = false;
  private userPaused = false;
  private shutdownRequested = false;
  private concurrency = 2;
  private readonly fastLaneMediaIds: Array<number | null> =
    Array.from({ length: MAX_FAST_CONCURRENCY }, () => null);
  private readonly fastLaneBusy: boolean[] =
    Array.from({ length: MAX_FAST_CONCURRENCY }, () => false);
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly activeModuleCounts = new Map<string, number>();
  private statsRefreshPromise: Promise<PythonPipelineStats> | null = null;
  private heavyRunning = false;
  private backfillRunning = false;

  // Die 4B-Kataloganalyse läuft wieder automatisch. Sie bleibt bewusst die
  // letzte Pipeline-Stufe, damit neue Bilder zuerst alle schnellen technischen,
  // Personen-, Haustier- und SigLIP2-Stufen erhalten.
  private automaticQwenEnabled = true;

  constructor(
    private readonly catalog: CatalogService,
    private readonly analysis: AnalysisService,
    private readonly onStats: (
      stage: PythonStage,
      stats: AnalysisQueueStats
    ) => void
  ) {}

  setConcurrency(value: number): number {
    this.concurrency = Math.max(
      1,
      Math.min(MAX_FAST_CONCURRENCY, Math.trunc(value || 1))
    );

    if (!this.stopped && !this.userPaused && !this.maintenancePaused) {
      void this.pump();
    }
    return this.concurrency;
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.shutdownRequested = false;

    // Qwen3-VL 4B ist wieder fester Bestandteil des normalen Katalog-Flows.
    // Ein vorheriger Benchmark-/Wartungszustand darf die automatische letzte
    // Pipeline-Stufe nach einem Neustart des Coordinators nicht deaktivieren.
    this.automaticQwenEnabled = true;
    this.stopped = false;

    // Scheduler sofort aktivieren. Der frühere Startpfad hat zuerst für alle
    // Quellen und Module einen vollständigen Job-Backfill durchgeführt. Bei
    // großen Katalogen liefen deshalb minutenlang nur die separaten Thumbnails,
    // obwohl bereits fertige Bilder für technische Analyse bereitstanden.
    await this.refreshAllStats();

    this.timer = setInterval(() => {
      void this.pump();
    }, 600);
    this.timer.unref();

    void this.pump();

    // Fehlende Jobs parallel zum laufenden Scheduler ergänzen. Bereits vom
    // Live-Scan angelegte Fast-Jobs können dadurch sofort verarbeitet werden.
    // Während dieses Backfills startet noch keine schwere Stufe, damit zuerst
    // sicher alle Fast-Jobs sichtbar werden.
    this.backfillRunning = true;
    void this.enqueueExistingSources()
      .catch((error) => {
        this.analysis.logDiagnostic("ANALYSIS_BACKFILL_ERROR", {
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.backfillRunning = false;
        void this.pump();
      });
  }

  stop(): void {
    this.stopped = true;
    this.maintenancePaused = false;
    this.fastLaneMediaIds.fill(null);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  prepareForShutdown(): void {
    this.shutdownRequested = true;
    this.stop();
  }

  async waitUntilIdle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.pumping || this.activeTasks.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    if (this.pumping || this.activeTasks.size > 0) {
      throw new Error(
        "Analyse-Pipeline konnte vor dem Datenbank-Reset nicht sauber angehalten werden."
      );
    }
  }

  async pauseForMaintenance(): Promise<void> {
    this.maintenancePaused = true;

    // Einen bereits laufenden schnellen Bildschritt sauber fertigstellen.
    // Nicht abbrechen: danach kann die Gruppierung denselben Worker exklusiv
    // nutzen und die Fast-Lane setzt exakt beim aktuellen Bild fort.
    while (
      (this.pumping || this.activeTasks.size > 0) &&
      !this.stopped
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  resumeAfterMaintenance(): void {
    this.maintenancePaused = false;

    if (!this.stopped && !this.benchmarkPaused && !this.userPaused) {
      void this.pump();
    }
  }

  async pauseForUser(): Promise<void> {
    if (this.userPaused) return;
    this.userPaused = true;

    // Laufende Python-/Qwen-Arbeit hart stoppen, damit CPU/GPU sofort frei
    // werden. Die betroffenen Queue-Jobs werden unten wieder auf PENDING gesetzt.
    this.analysis.stopForUserPause();

    const deadline = Date.now() + 15000;
    while (
      (this.pumping || this.activeTasks.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    this.analysis.setQueueState(
      0,
      0,
      "Hintergrundanalyse pausiert."
    );
  }

  async resumeFromUserPause(): Promise<void> {
    if (!this.userPaused) return;

    await this.analysis.start();
    this.userPaused = false;

    // Falls zuvor ein exklusiver Benchmark den Coordinator gestoppt hatte,
    // normal starten; sonst die bestehenden Fast-Lanes direkt fortsetzen.
    if (this.stopped) {
      await this.start();
    } else {
      void this.pump();
      // Ein während der Benutzerpause abgebrochener Job-Backfill wird hier
      // erneut aufgenommen. ON CONFLICT macht das idempotent.
      this.backfillRunning = true;
      void this.enqueueExistingSources()
        .catch((error) => {
          this.analysis.logDiagnostic("ANALYSIS_BACKFILL_RESUME_ERROR", {
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          this.backfillRunning = false;
          void this.pump();
        });
    }
  }

  async pauseForBenchmark(): Promise<void> {
    this.benchmarkPaused = true;
    this.stop();

    // Wichtig: nicht nur keine neuen Jobs starten, sondern einen bereits
    // laufenden Qwen/llama.cpp-Prozess wirklich beenden. Sonst bleibt der PC
    // so ausgelastet, dass selbst der Dateidialog des Einzeltests stockt.
    this.analysis.stopForBenchmark();

    const deadline = Date.now() + 15000;
    while (
      (this.pumping || this.activeTasks.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    this.analysis.setQueueState(
      0,
      0,
      "Standardanalyse für Qwen-Einzelbildtest pausiert."
    );
  }

  endBenchmarkPause(): void {
    this.benchmarkPaused = false;
  }

  isAutomaticQwenEnabled(): boolean {
    return this.automaticQwenEnabled;
  }

  enableAutomaticQwen(): void {
    this.automaticQwenEnabled = true;

    // Falls alle leichteren Stufen bereits fertig sind, muss die Queue nicht
    // bis zum nächsten Intervall warten.
    if (!this.stopped && !this.benchmarkPaused && !this.userPaused) {
      void this.pump();
    }
  }

  disableAutomaticQwen(): void {
    this.automaticQwenEnabled = false;
  }

  private async enqueueExistingSources(): Promise<void> {
    const sources = await this.catalog.request<SourceRecord[]>("listSources");

    // Erst alle schnellen Stufen bereitstellen. So wartet ein Bild nicht auf
    // das Einreihen der schweren Video-/SigLIP-/Qwen-Jobs des gesamten Katalogs.
    for (const specs of [FAST_MODULES, HEAVY_MODULES]) {
      for (const source of sources) {
        if (!source.enabled || this.stopped || this.userPaused) continue;

        for (const spec of specs) {
          if (this.stopped || this.userPaused) return;
          if (!this.analysis.isWorkerMethodAvailable(spec.workerMethod)) continue;

          await this.catalog.request("enqueueAnalysisJobs", {
            sourceId: source.id,
            module: spec.module
          });

          // Sobald ein Fast-Modul für eine Quelle eingereiht wurde, den
          // Scheduler direkt anstoßen statt auf das 600-ms-Intervall zu warten.
          if (!HEAVY_MODULE_NAMES.has(spec.module)) {
            void this.pump();
          }
        }
      }
    }
  }

  private refreshAllStats(): Promise<PythonPipelineStats> {
    // Mehrere parallele Jobs können nahezu gleichzeitig fertig werden.
    // Früher startete jeder davon einen kompletten Statistikdurchlauf und hielt
    // seine Fast-Lane bis zum Ende dieser DB-Abfragen blockiert. Einen bereits
    // laufenden Refresh teilen deshalb jetzt alle Aufrufer.
    if (this.statsRefreshPromise) return this.statsRefreshPromise;

    const task = this.refreshAllStatsNow();
    this.statsRefreshPromise = task;
    void task.finally(() => {
      if (this.statsRefreshPromise === task) {
        this.statsRefreshPromise = null;
      }
    });
    return task;
  }

  private async refreshAllStatsNow(): Promise<PythonPipelineStats> {
    const result: PythonPipelineStats = {
      technical: emptyStats(),
      imageMetadata: emptyStats(),
      faces: emptyStats(),
      faceEmbeddings: emptyStats(),
      petDetection: emptyStats(),
      petFusion: emptyStats(),
      petEmbeddings: emptyStats(),
      objectVerification: emptyStats(),
      semanticEmbeddings: emptyStats(),
      videoAnalysis: emptyStats()
    };

    // Statt 10+ serieller IPC-/SQLite-Abfragen kommt der komplette Queue-
    // Snapshot in einem einzigen Katalogaufruf zurück.
    const snapshot = await this.catalog.request<PipelineQueueSnapshot>(
      "getPipelineQueueStats"
    );

    for (const spec of MODULES) {
      if (spec.stage === "petDetection") continue;
      const stats = snapshot.byModule[spec.module] ?? emptyStats();
      result[spec.stage] = addStats(result[spec.stage], stats);
    }

    result.petDetection = snapshot.petDetection ?? emptyStats();

    for (const stage of Object.keys(result) as PythonStage[]) {
      this.onStats(stage, result[stage]);
    }

    const qwenRunnable =
      this.automaticQwenEnabled && this.analysis.isQwen3vl4bAvailable();
    const qwenQueued = qwenRunnable
      ? result.objectVerification.pending
      : 0;
    const qwenActive = qwenRunnable
      ? result.objectVerification.running
      : 0;

    const queued =
      result.technical.pending +
      result.imageMetadata.pending +
      result.faces.pending +
      result.faceEmbeddings.pending +
      result.petDetection.pending +
      result.petFusion.pending +
      result.petEmbeddings.pending +
      qwenQueued +
      result.semanticEmbeddings.pending +
      result.videoAnalysis.pending;
    const active =
      result.technical.running +
      result.imageMetadata.running +
      result.faces.running +
      result.faceEmbeddings.running +
      result.petDetection.running +
      result.petFusion.running +
      result.petEmbeddings.running +
      qwenActive +
      result.semanticEmbeddings.running +
      result.videoAnalysis.running;

    const pausedQwen =
      (!this.automaticQwenEnabled || !this.analysis.isQwen3vl4bAvailable()) &&
      (result.objectVerification.pending > 0 ||
        result.objectVerification.running > 0);

    this.analysis.setQueueState(
      queued,
      active,
      queued > 0 || active > 0
        ? active > 1
          ? `${active} Bildanalysen laufen parallel im Hintergrund.`
          : "Bildanalyse verarbeitet Medien im Hintergrund."
        : pausedQwen
          ? this.analysis.isQwen3vl4bAvailable()
            ? "Qwen-Serienanalyse pausiert · Einzelbildtest ist frei."
            : (this.analysis.getQwen3vl4bIssue() ?? "Qwen3-VL 4B ist derzeit nicht verfügbar.")
          : "Python-Analyse ist aktuell abgearbeitet."
    );

    return result;
  }

  private markModuleActive(module: string, delta: number): void {
    const next = Math.max(0, (this.activeModuleCounts.get(module) ?? 0) + delta);
    if (next === 0) this.activeModuleCounts.delete(module);
    else this.activeModuleCounts.set(module, next);
  }

  private faceInferenceBusy(): boolean {
    for (const module of FACE_INFERENCE_MODULE_NAMES) {
      if ((this.activeModuleCounts.get(module) ?? 0) > 0) return true;
    }
    return false;
  }

  private mayClaimSpec(spec: ModuleSpec): boolean {
    return !(
      FACE_INFERENCE_MODULE_NAMES.has(spec.module) &&
      this.faceInferenceBusy()
    );
  }

  private async claimFastJob(laneIndex: number): Promise<{
    spec: ModuleSpec;
    job: AnalysisJob;
  } | null> {
    // Jede Fast-Lane hält ihr eigenes Bild fest und führt es durch die
    // schnellen Stufen. So entstehen früh vollständige Gesichts-/Haustierdaten,
    // obwohl zwei Bilder gleichzeitig bearbeitet werden.
    const currentMediaId = this.fastLaneMediaIds[laneIndex];
    if (currentMediaId !== null) {
      for (const spec of FAST_MODULES) {
        if (!this.analysis.isWorkerMethodAvailable(spec.workerMethod)) continue;
        if (!this.mayClaimSpec(spec)) continue;

        const job = await this.catalog.request<AnalysisJob | null>(
          "claimAnalysisJob",
          {
            module: spec.module,
            mediaId: currentMediaId
          }
        );

        if (job) return { spec, job };
      }

      this.fastLaneMediaIds[laneIndex] = null;
    }

    // Freie Lane mit dem nächsten frischen Bild belegen. Die Katalogsortierung
    // priorisiert weiterhin neu hinzugekommene Medien vor altem Backlog.
    for (const spec of FAST_MODULES) {
      if (!this.analysis.isWorkerMethodAvailable(spec.workerMethod)) continue;
      if (!this.mayClaimSpec(spec)) continue;

      const job = await this.catalog.request<AnalysisJob | null>(
        "claimAnalysisJob",
        { module: spec.module }
      );

      if (job) {
        this.fastLaneMediaIds[laneIndex] = job.mediaId;
        return { spec, job };
      }
    }

    return null;
  }

  private async nextHeavySpec(): Promise<ModuleSpec | null> {
    // Schwere Stufen werden erst betrachtet, wenn kein schneller Job im
    // gesamten Katalog mehr ausführbar ist. Dadurch laufen zuerst alle
    // Foto-Stufen bis einschließlich Personen-/Haustiermerkmalen durch.
    // Anschließend folgen Videoanalyse, SigLIP2 und zuletzt Qwen4B.
    for (const spec of HEAVY_MODULES) {
      if (!this.analysis.isWorkerMethodAvailable(spec.workerMethod)) continue;

      if (
        spec.module === "catalog-semantic-qwen3vl4b-v3" &&
        (
          !this.automaticQwenEnabled ||
          !this.analysis.isQwen3vl4bAvailable()
        )
      ) {
        continue;
      }

      const stats = await this.catalog.request<AnalysisQueueStats>(
        "getAnalysisQueueStats",
        { module: spec.module }
      );

      if (stats.pending > 0) return spec;
    }

    return null;
  }

  private launchSelection(
    selection: { spec: ModuleSpec; job: AnalysisJob },
    laneIndex: number | null,
    heavy: boolean
  ): void {
    if (laneIndex !== null) this.fastLaneBusy[laneIndex] = true;
    if (heavy) this.heavyRunning = true;
    this.markModuleActive(selection.spec.module, 1);

    const task = this.runSelection(selection);

    this.activeTasks.add(task);
    void task.finally(() => {
      this.activeTasks.delete(task);
      if (laneIndex !== null) this.fastLaneBusy[laneIndex] = false;
      if (heavy) this.heavyRunning = false;
      this.markModuleActive(selection.spec.module, -1);

      if (
        !this.stopped &&
        !this.maintenancePaused &&
        !this.benchmarkPaused &&
        !this.userPaused
      ) {
        void this.pump();
      }
    });
  }

  private async runSelection(
    selection: { spec: ModuleSpec; job: AnalysisJob }
  ): Promise<void> {
    const { spec, job } = selection;

    try {
      let extraPayload: Record<string, unknown> = {};

      if (spec.module === "face-embed-sface-v1") {
        const faces = await this.catalog.request<FaceDetectionForEmbedding[]>(
          "getFaceDetectionsForEmbedding",
          {
            mediaId: job.mediaId,
            inputSha256: job.sha256
          }
        );

        extraPayload = { faces };
      }

      if (spec.module === "pet-fuse-ensemble-v1") {
        const detections = await this.catalog.request<
          Array<Record<string, unknown>>
        >("getPetDetectionsForFusion", {
          mediaId: job.mediaId,
          inputSha256: job.sha256
        });
        const objects = await this.catalog.request<
          Array<Record<string, unknown>>
        >("getObjectDetectionsForFusion", {
          mediaId: job.mediaId,
          inputSha256: job.sha256
        });

        extraPayload = { detections, objects };
      }

      if (spec.module === "pet-embed-dogreid-v1") {
        const pets = await this.catalog.request<PetDetectionForEmbedding[]>(
          "getPetDetectionsForEmbedding",
          {
            mediaId: job.mediaId,
            inputSha256: job.sha256
          }
        );

        extraPayload = { pets };
      }

      const result = await this.analysis.request<Record<string, unknown>>(
        spec.workerMethod,
        {
          path: job.absolutePath,
          expectedSizeBytes: job.sizeBytes,
          expectedSha256: job.sha256,
          extension: job.extension,
          ...extraPayload
        },
        spec.timeoutMs
      );

      const completion = await this.catalog.request<Record<string, unknown>>(
        spec.completeMethod,
        {
          jobId: job.id,
          result
        }
      );

      if (
        spec.module === "face-detect-yunet-v1" ||
        spec.module === "face-embed-sface-v1" ||
        spec.module === "pet-fuse-ensemble-v1" ||
        spec.module === "pet-embed-dogreid-v1"
      ) {
        const workerItems =
          spec.module === "face-detect-yunet-v1"
            ? (Array.isArray(result.faces) ? result.faces.length : 0)
            : spec.module === "face-embed-sface-v1"
              ? (Array.isArray(result.embeddings) ? result.embeddings.length : 0)
              : spec.module === "pet-fuse-ensemble-v1"
                ? (Array.isArray(result.pets)
                    ? result.pets.filter(
                        (item) =>
                          item &&
                          typeof item === "object" &&
                          (item as Record<string, unknown>).class === "dog"
                      ).length
                    : 0)
                : (Array.isArray(result.embeddings) ? result.embeddings.length : 0);

        this.analysis.logDiagnostic("IDENTITY_STAGE_RESULT", {
          module: spec.module,
          mediaId: job.mediaId,
          target: job.absolutePath,
          workerItems,
          databaseItems:
            completion.embeddingCount ??
            completion.petCount ??
            completion.faceCount ??
            null
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.analysis.logDiagnostic("ANALYSIS_STAGE_ERROR", {
        module: spec.module,
        method: spec.workerMethod,
        mediaId: job.mediaId,
        target: job.absolutePath,
        error: message
      });

      try {
        await this.catalog.request("failAnalysisJob", {
          jobId: job.id,
          error: message
        });

        // Benchmarkpause und App-Shutdown sind kontrollierte Unterbrechungen,
        // keine echten Analysefehler. Der gerade beanspruchte Job wird deshalb
        // wieder auf PENDING gesetzt und beim nächsten Start sauber wiederholt.
        if (this.benchmarkPaused || this.userPaused || this.shutdownRequested) {
          await this.catalog.request("retryAnalysisJob", {
            jobId: job.id
          });
        }
      } catch (catalogError) {
        this.analysis.logDiagnostic("PARALLEL_JOB_CATALOG_ERROR", {
          module: spec.module,
          mediaId: job.mediaId,
          error:
            catalogError instanceof Error
              ? catalogError.message
              : String(catalogError)
        });
      }
    }

    // Anzeige-Statistik darf den nächsten Analysejob nicht blockieren.
    // Ein paralleler/folgender Refresh wird über statsRefreshPromise gebündelt.
    void this.refreshAllStats().catch(() => {
      // Der nächste Scheduler-Durchlauf aktualisiert die Anzeige erneut.
    });
  }

  private async pump(): Promise<void> {
    if (
      this.stopped ||
      this.pumping ||
      this.maintenancePaused ||
      this.userPaused
    ) return;
    if (this.analysis.getStatus().state !== "READY") return;

    this.pumping = true;

    try {
      // Eine laufende schwere Stufe blockiert neue Fast-Jobs nicht mehr.
      // Der Python-Worker besitzt dafür getrennte Fast-/Heavy-Lanes.
      let launchedFast = false;

      for (let laneIndex = 0; laneIndex < this.concurrency; laneIndex += 1) {
        if (this.fastLaneBusy[laneIndex]) continue;

        const selection = await this.claimFastJob(laneIndex);
        if (!selection) continue;

        this.launchSelection(selection, laneIndex, false);
        launchedFast = true;
      }

      // Schwere Stufen starten nur, wenn wirklich keine schnelle Lane arbeitet
      // und auch keine weitere schnelle Aufgabe claimbar war.
      if (
        !launchedFast &&
        !this.heavyRunning &&
        !this.backfillRunning &&
        this.activeTasks.size === 0
      ) {
        const heavySpec = await this.nextHeavySpec();
        if (heavySpec) {
          const heavyJob = await this.catalog.request<AnalysisJob | null>(
            "claimAnalysisJob",
            { module: heavySpec.module }
          );

          if (heavyJob) {
            this.launchSelection(
              { spec: heavySpec, job: heavyJob },
              null,
              true
            );
          }
        }
      }

      await this.refreshAllStats();
    } catch (error) {
      this.analysis.setQueueState(
        0,
        this.activeTasks.size,
        "Analyse-Queue: " +
          (error instanceof Error ? error.message : String(error))
      );
    } finally {
      this.pumping = false;
    }
  }
}
