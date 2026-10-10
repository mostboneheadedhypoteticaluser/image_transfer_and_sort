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
  | "semanticEmbeddings";

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
    | "completeSemanticEmbeddingJob";
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
    timeoutMs: 60000
  },
  {
    module: "face-embed-sface-v1",
    stage: "faceEmbeddings",
    workerMethod: "extract_face_embeddings",
    completeMethod: "completeFaceEmbeddingJob",
    label: "Gesichtsmerkmale",
    timeoutMs: 60000
  },
  {
    module: "pet-detect-nanodet-v1",
    stage: "petDetection",
    workerMethod: "detect_pets",
    completeMethod: "completePetDetectionJob",
    label: "Haustiere · NanoDet",
    timeoutMs: 60000
  },
  {
    module: "pet-detect-yolox-v1",
    stage: "petDetection",
    workerMethod: "detect_pets_yolox",
    completeMethod: "completePetDetectionJob",
    label: "Haustiere · YOLOX-S",
    timeoutMs: 90000
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
    timeoutMs: 120000
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

const HEAVY_MODULE_NAMES = new Set([
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
>;

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

export class AnalysisCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = true;
  private benchmarkPaused = false;
  private maintenancePaused = false;
  private shutdownRequested = false;
  private currentFastMediaId: number | null = null;

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

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.shutdownRequested = false;
    this.stopped = false;

    await this.enqueueExistingSources();
    await this.refreshAllStats();

    this.timer = setInterval(() => {
      void this.pump();
    }, 600);
    this.timer.unref();

    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.maintenancePaused = false;
    this.currentFastMediaId = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  prepareForShutdown(): void {
    this.shutdownRequested = true;
    this.stop();
  }

  async waitUntilIdle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pumping && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    if (this.pumping) {
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
    while (this.pumping && !this.stopped) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  resumeAfterMaintenance(): void {
    this.maintenancePaused = false;

    if (!this.stopped && !this.benchmarkPaused) {
      void this.pump();
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
    while (this.pumping && Date.now() < deadline) {
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
    if (!this.stopped && !this.benchmarkPaused) {
      void this.pump();
    }
  }

  disableAutomaticQwen(): void {
    this.automaticQwenEnabled = false;
  }

  private async enqueueExistingSources(): Promise<void> {
    const sources = await this.catalog.request<SourceRecord[]>("listSources");

    for (const source of sources) {
      if (!source.enabled) continue;

      for (const spec of MODULES) {
        await this.catalog.request("enqueueAnalysisJobs", {
          sourceId: source.id,
          module: spec.module
        });
      }
    }
  }

  private async refreshAllStats(): Promise<PythonPipelineStats> {
    const result: PythonPipelineStats = {
      technical: emptyStats(),
      imageMetadata: emptyStats(),
      faces: emptyStats(),
      faceEmbeddings: emptyStats(),
      petDetection: emptyStats(),
      petFusion: emptyStats(),
      petEmbeddings: emptyStats(),
      objectVerification: emptyStats(),
      semanticEmbeddings: emptyStats()
    };

    for (const spec of MODULES) {
      // Die beiden Haustierdetektoren werden für die Anzeige weiter unten
      // bildbezogen zusammengeführt. Einfaches Addieren würde jedes Bild
      // doppelt zählen.
      if (spec.stage === "petDetection") continue;

      const stats = await this.catalog.request<AnalysisQueueStats>(
        "getAnalysisQueueStats",
        { module: spec.module }
      );

      result[spec.stage] = addStats(result[spec.stage], stats);
    }

    result.petDetection =
      await this.catalog.request<AnalysisQueueStats>(
        "getPetDetectionQueueStats"
      );

    for (const stage of Object.keys(result) as PythonStage[]) {
      this.onStats(stage, result[stage]);
    }

    // Solange die Qwen-Serienanalyse nicht ausdrücklich gestartet wurde,
    // zählen deren wartende Jobs nicht als aktive Worker-Warteschlange. Die
    // Pipeline-Kachel zeigt sie weiterhin als offen, aber der Worker bleibt
    // speicherschonend ohne llama.cpp-Modell.
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
      result.semanticEmbeddings.pending;
    const active =
      result.technical.running +
      result.imageMetadata.running +
      result.faces.running +
      result.faceEmbeddings.running +
      result.petDetection.running +
      result.petFusion.running +
      result.petEmbeddings.running +
      qwenActive +
      result.semanticEmbeddings.running;

    const pausedQwen =
      (!this.automaticQwenEnabled || !this.analysis.isQwen3vl4bAvailable()) &&
      (result.objectVerification.pending > 0 ||
        result.objectVerification.running > 0);

    this.analysis.setQueueState(
      queued,
      active,
      queued > 0 || active > 0
        ? "Bildanalyse verarbeitet Medien im Hintergrund."
        : pausedQwen
          ? this.analysis.isQwen3vl4bAvailable()
            ? "Qwen-Serienanalyse pausiert · Einzelbildtest ist frei."
            : (this.analysis.getQwen3vl4bIssue() ?? "Qwen3-VL 4B ist derzeit nicht verfügbar.")
          : "Python-Analyse ist aktuell abgearbeitet."
    );

    return result;
  }

  private async claimFastJob(): Promise<{
    spec: ModuleSpec;
    job: AnalysisJob;
  } | null> {
    // Ein angefangenes Bild wird bewusst durch alle schnellen Stufen geführt,
    // bevor ein anderes Bild an die Reihe kommt.
    if (this.currentFastMediaId !== null) {
      for (const spec of FAST_MODULES) {
        const job = await this.catalog.request<AnalysisJob | null>(
          "claimAnalysisJob",
          {
            module: spec.module,
            mediaId: this.currentFastMediaId
          }
        );

        if (job) return { spec, job };
      }

      this.currentFastMediaId = null;
    }

    // Danach beginnt das nächste Bild. Durch die Sortierung im Katalog-Worker
    // werden neu hinzugekommene Bilder vor altem Backlog bevorzugt.
    for (const spec of FAST_MODULES) {
      const job = await this.catalog.request<AnalysisJob | null>(
        "claimAnalysisJob",
        { module: spec.module }
      );

      if (job) {
        this.currentFastMediaId = job.mediaId;
        return { spec, job };
      }
    }

    return null;
  }

  private async nextHeavySpec(): Promise<ModuleSpec | null> {
    // Schwere Stufen werden erst betrachtet, wenn kein schneller Job im
    // gesamten Katalog mehr ausführbar ist. SigLIP2 steht vor Qwen4B, sodass
    // zunächst alle Vektoren und erst danach die 5-fache 4B-Analyse laufen.
    for (const spec of HEAVY_MODULES) {
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

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping || this.maintenancePaused) return;
    if (this.analysis.getStatus().state !== "READY") return;

    this.pumping = true;

    try {
      const stats = await this.refreshAllStats();
      const totalRunning =
        stats.technical.running +
        stats.imageMetadata.running +
        stats.faces.running +
        stats.faceEmbeddings.running +
        stats.petDetection.running +
        stats.petFusion.running +
        stats.petEmbeddings.running +
        stats.objectVerification.running +
        stats.semanticEmbeddings.running;

      if (totalRunning > 0) return;

      let selection = await this.claimFastJob();

      if (!selection) {
        const heavySpec = await this.nextHeavySpec();
        if (heavySpec) {
          const heavyJob = await this.catalog.request<AnalysisJob | null>(
            "claimAnalysisJob",
            { module: heavySpec.module }
          );

          if (heavyJob) {
            selection = { spec: heavySpec, job: heavyJob };
          }
        }
      }

      if (!selection) {
        await this.refreshAllStats();
        return;
      }

      const { spec, job } = selection;

      const queued =
        stats.technical.pending +
        stats.imageMetadata.pending +
        stats.faces.pending +
        stats.faceEmbeddings.pending +
        stats.petDetection.pending +
        stats.petFusion.pending +
        stats.petEmbeddings.pending +
        stats.objectVerification.pending +
        stats.semanticEmbeddings.pending - 1;

      this.analysis.setQueueState(
        Math.max(0, queued),
        1,
        `${spec.label}: ${job.absolutePath}`
      );

      // claimAnalysisJob setzt den Datensatz bereits auf RUNNING. Den Status
      // sofort erneut aus SQLite lesen und veröffentlichen, damit eine lange
      // SigLIP-/Qwen-Berechnung nicht minutenlang mit dem Stand vor dem Claim
      // angezeigt wird.
      await this.refreshAllStats();

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
        await this.catalog.request("failAnalysisJob", {
          jobId: job.id,
          error: message
        });

        // Benchmarkpause und App-Shutdown sind kontrollierte Unterbrechungen,
        // keine echten Analysefehler. Der gerade beanspruchte Job wird deshalb
        // wieder auf PENDING gesetzt und beim nächsten Start sauber wiederholt.
        if (this.benchmarkPaused || this.shutdownRequested) {
          await this.catalog.request("retryAnalysisJob", {
            jobId: job.id
          });
        }
      }

      await this.refreshAllStats();
    } catch (error) {
      this.analysis.setQueueState(
        0,
        0,
        "Analyse-Queue: " +
          (error instanceof Error ? error.message : String(error))
      );
    } finally {
      this.pumping = false;
    }
  }
}
