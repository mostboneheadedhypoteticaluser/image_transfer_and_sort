import type {
  AnalysisJob,
  AnalysisQueueStats,
  SourceRecord
} from "../shared/protocol";
import { CatalogService } from "./catalog-service";
import { ThumbnailService } from "./thumbnail-service";

const MODULE = "thumbnail-v1";

export class ThumbnailCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = true;

  constructor(
    private readonly catalog: CatalogService,
    private readonly thumbnails: ThumbnailService,
    private readonly onStats: (stats: AnalysisQueueStats) => void
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;

    await this.enqueueExistingSources();
    await this.refreshStats();

    this.timer = setInterval(() => {
      void this.pump();
    }, 650);
    this.timer.unref();

    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async waitUntilIdle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pumping && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    if (this.pumping) {
      throw new Error(
        "Thumbnail-Pipeline konnte vor dem Datenbank-Reset nicht sauber angehalten werden."
      );
    }
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

  private async refreshStats(): Promise<AnalysisQueueStats> {
    const stats = await this.catalog.request<AnalysisQueueStats>(
      "getAnalysisQueueStats",
      { module: MODULE }
    );

    this.onStats(stats);
    return stats;
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return;

    this.pumping = true;

    try {
      const stats = await this.refreshStats();
      if (stats.running > 0) return;

      const job = await this.catalog.request<AnalysisJob | null>(
        "claimAnalysisJob",
        { module: MODULE }
      );

      if (!job) {
        await this.refreshStats();
        return;
      }

      this.onStats({
        ...stats,
        pending: Math.max(0, stats.pending - 1),
        running: 1
      });

      try {
        const result = await this.thumbnails.generate(
          job.absolutePath,
          job.sha256
        );

        await this.catalog.request("completeThumbnailJob", {
          jobId: job.id,
          result
        });
      } catch (error) {
        await this.catalog.request("failAnalysisJob", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      await this.refreshStats();
    } finally {
      this.pumping = false;
    }
  }
}
