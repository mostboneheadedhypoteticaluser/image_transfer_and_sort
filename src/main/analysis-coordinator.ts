import type {
  AnalysisJob,
  AnalysisQueueStats,
  FaceDetectionForEmbedding,
  PipelineStatus,
  SourceRecord
} from "../shared/protocol";
import { AnalysisService } from "./analysis-service";
import { CatalogService } from "./catalog-service";

type PythonStage =
  | "technical"
  | "imageMetadata"
  | "faces"
  | "faceEmbeddings";

type ModuleSpec = {
  module: string;
  stage: PythonStage;
  workerMethod: string;
  completeMethod:
    | "completeAnalysisJob"
    | "completeImageMetadataJob"
    | "completeFaceDetectionJob"
    | "completeFaceEmbeddingJob";
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
  }
];

type PythonPipelineStats = Pick<
  PipelineStatus,
  "technical" | "imageMetadata" | "faces" | "faceEmbeddings"
>;

function emptyStats(): AnalysisQueueStats {
  return { pending: 0, running: 0, done: 0, failed: 0 };
}

export class AnalysisCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = true;
  private cursor = 0;

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
      faceEmbeddings: emptyStats()
    };

    for (const spec of MODULES) {
      const stats = await this.catalog.request<AnalysisQueueStats>(
        "getAnalysisQueueStats",
        { module: spec.module }
      );

      result[spec.stage] = stats;
      this.onStats(spec.stage, stats);
    }

    const queued =
      result.technical.pending +
      result.imageMetadata.pending +
      result.faces.pending +
      result.faceEmbeddings.pending;
    const active =
      result.technical.running +
      result.imageMetadata.running +
      result.faces.running +
      result.faceEmbeddings.running;

    this.analysis.setQueueState(
      queued,
      active,
      queued > 0 || active > 0
        ? "Bildanalyse verarbeitet Medien im Hintergrund."
        : "Python-Analyse ist aktuell abgearbeitet."
    );

    return result;
  }

  private nextPendingSpec(
    stats: PythonPipelineStats
  ): ModuleSpec | null {
    for (let offset = 0; offset < MODULES.length; offset += 1) {
      const index = (this.cursor + offset) % MODULES.length;
      const spec = MODULES[index];

      if (stats[spec.stage].pending > 0) {
        this.cursor = (index + 1) % MODULES.length;
        return spec;
      }
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
        stats.faceEmbeddings.running;

      if (totalRunning > 0) return;

      const spec = this.nextPendingSpec(stats);
      if (!spec) return;

      const job = await this.catalog.request<AnalysisJob | null>(
        "claimAnalysisJob",
        { module: spec.module }
      );

      if (!job) {
        await this.refreshAllStats();
        return;
      }

      const queued =
        stats.technical.pending +
        stats.imageMetadata.pending +
        stats.faces.pending +
        stats.faceEmbeddings.pending - 1;

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
