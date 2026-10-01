import type {
  AnalysisJob,
  AnalysisQueueStats,
  SourceRecord
} from "../shared/protocol";
import { AnalysisService } from "./analysis-service";
import { CatalogService } from "./catalog-service";

const MODULE = "file-probe-v1";

export class AnalysisCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = true;

  constructor(
    private readonly catalog: CatalogService,
    private readonly analysis: AnalysisService,
    private readonly onStats: (stats: AnalysisQueueStats) => void
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;

    await this.enqueueExistingSources();
    await this.refreshQueueState();

    this.timer = setInterval(() => {
      void this.pump();
    }, 750);
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
      await this.catalog.request("enqueueAnalysisJobs", {
        sourceId: source.id,
        module: MODULE
      });
    }
  }

  private async refreshQueueState(message?: string): Promise<AnalysisQueueStats> {
    const stats = await this.catalog.request<AnalysisQueueStats>(
      "getAnalysisQueueStats",
      { module: MODULE }
    );

    this.onStats(stats);

    this.analysis.setQueueState(
      stats.pending,
      stats.running,
      message ??
        (stats.pending > 0 || stats.running > 0
          ? "Analyse-Pipeline verarbeitet Medien im Hintergrund."
          : "Analyse-Pipeline ist aktuell abgearbeitet.")
    );

    return stats;
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return;
    if (this.analysis.getStatus().state !== "READY") return;

    this.pumping = true;

    try {
      const stats = await this.refreshQueueState();
      if (stats.running > 0) return;

      const job = await this.catalog.request<AnalysisJob | null>(
        "claimAnalysisJob",
        { module: MODULE }
      );

      if (!job) {
        await this.refreshQueueState();
        return;
      }

      this.analysis.setQueueState(
        Math.max(0, stats.pending - 1),
        1,
        `Technische Analyse: ${job.absolutePath}`
      );

      try {
        const result = await this.analysis.request<Record<string, unknown>>(
          "probe_media",
          {
            path: job.absolutePath,
            expectedSizeBytes: job.sizeBytes,
            expectedSha256: job.sha256,
            extension: job.extension
          },
          15000
        );

        await this.catalog.request("completeAnalysisJob", {
          jobId: job.id,
          result
        });
      } catch (error) {
        await this.catalog.request("failAnalysisJob", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      await this.refreshQueueState();
    } catch (error) {
      this.analysis.setQueueState(
        0,
        0,
        "Analyse-Queue: " + (error instanceof Error ? error.message : String(error))
      );
    } finally {
      this.pumping = false;
    }
  }
}
