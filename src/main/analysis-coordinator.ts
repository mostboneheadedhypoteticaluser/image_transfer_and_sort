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
    module: "object-detect-qwen3vl-gguf-v2",
    stage: "objectVerification",
    workerMethod: "detect_qwen3vl_objects",
    completeMethod: "completeVerifiedObjectDetectionJob",
    label: "Motive · Qwen3-VL-8B Q8_0 Vollbild/Kacheln",
    timeoutMs: 7200000
  }
];

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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      const stats = await this.catalog.request<AnalysisQueueStats>(
        "getAnalysisQueueStats",
        { module: spec.module }
      );

      result[spec.stage] = addStats(result[spec.stage], stats);
    }

    for (const stage of Object.keys(result) as PythonStage[]) {
      this.onStats(stage, result[stage]);
    }

    const queued =
      result.technical.pending +
      result.imageMetadata.pending +
      result.faces.pending +
      result.faceEmbeddings.pending +
      result.petDetection.pending +
      result.petFusion.pending +
      result.petEmbeddings.pending +
      result.objectVerification.pending +
      result.semanticEmbeddings.pending;
    const active =
      result.technical.running +
      result.imageMetadata.running +
      result.faces.running +
      result.faceEmbeddings.running +
      result.petDetection.running +
      result.petFusion.running +
      result.petEmbeddings.running +
      result.objectVerification.running +
      result.semanticEmbeddings.running;

    this.analysis.setQueueState(
      queued,
      active,
      queued > 0 || active > 0
        ? "Bildanalyse verarbeitet Medien im Hintergrund."
        : "Python-Analyse ist aktuell abgearbeitet."
    );

    return result;
  }

  private async nextPendingSpec(): Promise<ModuleSpec | null> {
    // Die Identitätsstufen stehen bewusst zuerst. Teure allgemeine Analysen
    // folgen erst danach; Qwen3-VL ist als schwerste Stufe ganz zuletzt.
    // Innerhalb einer Stufe bleibt das jeweilige Modell für die Bildserie geladen.
    for (const spec of MODULES) {
      const stats = await this.catalog.request<AnalysisQueueStats>(
        "getAnalysisQueueStats",
        { module: spec.module }
      );

      if (stats.pending > 0) return spec;
    }

    return null;
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return;
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

      const spec = await this.nextPendingSpec();
      if (!spec) return;

      const job = await this.catalog.request<AnalysisJob | null>(
        "claimAnalysisJob",
        { module: spec.module }
      );

      // Ein abhängiger Job kann PENDING sein, obwohl seine Vorstufe noch läuft.
      // Dann probieren wir beim nächsten Takt weiter, ohne ihn fälschlich zu starten.
      if (!job) {
        await this.refreshAllStats();
        return;
      }

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

        if (spec.module === "object-detect-qwen3vl-gguf-v2") {
          // Die alten Detektoren sind nur zusätzliche Recall-Hinweise.
          // Qwen analysiert Gesamtbild und Kacheln unabhängig davon und muss
          // jeden Hinweis anschließend selbst doppelt bestätigen.
          const hints = await this.catalog.request<
            Array<Record<string, unknown>>
          >("getObjectDetectionsForFusion", {
            mediaId: job.mediaId,
            inputSha256: job.sha256
          });

          extraPayload = { hints };
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

        await this.catalog.request(spec.completeMethod, {
          jobId: job.id,
          result
        });
      } catch (error) {
        await this.catalog.request("failAnalysisJob", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        });
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
