import type {
  AnalysisJob,
  AnalysisQueueStats,
  SourceRecord
} from "../shared/protocol";
import { CatalogService } from "./catalog-service";
import { ThumbnailService } from "./thumbnail-service";

const MODULE = "thumbnail-v1";
const THUMBNAIL_CONCURRENCY = 2;

export class ThumbnailCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = true;
  private shutdownRequested = false;
  private userPaused = false;
  private activeJobs = 0;
  private readonly activeMediaJobs = new Map<number, number>();

  constructor(
    private readonly catalog: CatalogService,
    private readonly thumbnails: ThumbnailService,
    private readonly onStats: (stats: AnalysisQueueStats) => void,
    private readonly onDiagnostic?: (
      event: string,
      fields?: Record<string, unknown>
    ) => void
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.shutdownRequested = false;
    this.stopped = false;

    await this.refreshStats();

    this.timer = setInterval(() => {
      void this.pump();
    }, 650);
    this.timer.unref();

    void this.pump();

    // Fehlende Thumbnail-Jobs im Hintergrund ergänzen. Der Scheduler darf
    // bereits vorhandene bzw. vom Live-Scan neu angelegte Jobs sofort abarbeiten.
    void this.enqueueExistingSources().catch(() => {
      // Der nächste Scan/Neustart ergänzt fehlende Jobs erneut.
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  prepareForShutdown(): void {
    this.shutdownRequested = true;
    this.stop();
  }

  async pauseForUser(): Promise<void> {
    if (this.userPaused) return;
    this.userPaused = true;

    // Worker beenden statt nur keine neuen Jobs zu starten. Dadurch endet auch
    // die CPU-Last eines gerade laufenden Sharp-Resizes sofort.
    this.thumbnails.stop();

    const deadline = Date.now() + 10000;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  resumeFromUserPause(): void {
    if (!this.userPaused) return;
    this.thumbnails.start();
    this.userPaused = false;
    void this.pump();
    void this.enqueueExistingSources().catch(() => {
      // Idempotenter Backfill; ein späterer Lauf kann erneut ergänzen.
    });
  }

  async waitForMediaIdle(mediaId: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.pumping || (this.activeMediaJobs.get(mediaId) ?? 0) > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (this.pumping || (this.activeMediaJobs.get(mediaId) ?? 0) > 0) {
      throw new Error("Thumbnail-Erzeugung für dieses Medium ist noch aktiv.");
    }
  }

  async waitUntilIdle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.pumping || this.activeJobs > 0) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    if (this.pumping || this.activeJobs > 0) {
      throw new Error(
        "Thumbnail-Pipeline konnte vor dem Datenbank-Reset nicht sauber angehalten werden."
      );
    }
  }

  private async enqueueExistingSources(): Promise<void> {
    const sources = await this.catalog.request<SourceRecord[]>("listSources");

    for (const source of sources) {
      if (!source.enabled || this.stopped || this.userPaused) continue;

      await this.catalog.request("enqueueAnalysisJobs", {
        sourceId: source.id,
        module: MODULE
      });

      void this.pump();
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

  private launchJob(job: AnalysisJob): void {
    this.activeJobs += 1;
    this.activeMediaJobs.set(job.mediaId, (this.activeMediaJobs.get(job.mediaId) ?? 0) + 1);

    void this.runJob(job).finally(() => {
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      const remaining = (this.activeMediaJobs.get(job.mediaId) ?? 1) - 1;
      if (remaining > 0) this.activeMediaJobs.set(job.mediaId, remaining);
      else this.activeMediaJobs.delete(job.mediaId);

      if (!this.stopped && !this.userPaused) {
        void this.pump();
      }
    });
  }

  private async runJob(job: AnalysisJob): Promise<void> {
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
      const message = error instanceof Error ? error.message : String(error);
      this.onDiagnostic?.("THUMBNAIL_JOB_ERROR", {
        jobId: job.id,
        mediaId: job.mediaId,
        target: job.absolutePath,
        error: message
      });

      await this.catalog.request("failAnalysisJob", {
        jobId: job.id,
        error: message
      });

      if (this.shutdownRequested || this.userPaused) {
        await this.catalog.request("retryAnalysisJob", {
          jobId: job.id
        });
      }
    }

    await this.refreshStats();
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping || this.userPaused) return;

    this.pumping = true;

    try {
      while (!this.stopped && this.activeJobs < THUMBNAIL_CONCURRENCY) {
        const job = await this.catalog.request<AnalysisJob | null>(
          "claimAnalysisJob",
          { module: MODULE }
        );

        if (!job) break;
        this.launchJob(job);
      }

      await this.refreshStats();
    } finally {
      this.pumping = false;
    }
  }
}
