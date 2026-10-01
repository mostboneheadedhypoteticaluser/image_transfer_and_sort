import { randomUUID } from "node:crypto";
import { utilityProcess, type UtilityProcess } from "electron";
import type { CatalogMethod, ScanProgress, WorkerResponse } from "../shared/protocol";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class CatalogService {
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly workerPath: string,
    private readonly dbPath: string,
    private readonly onProgress: (progress: ScanProgress) => void
  ) {}

  start(): void {
    if (this.child) return;

    const child = utilityProcess.fork(this.workerPath, [], {
      env: {
        ...process.env,
        IMAGE_SORTER_DB: this.dbPath
      },
      serviceName: "Image Sortierer – Katalog"
    });

    child.on("message", (message: WorkerResponse) => {
      if (message.kind === "event") {
        if (message.event === "scanProgress") this.onProgress(message.payload);
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
    });

    child.on("exit", (code) => {
      const error = new Error(`Katalog-Worker wurde beendet (Code ${code ?? "unbekannt"}).`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = null;
    });

    this.child = child;
  }

  async request<T>(method: CatalogMethod, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.child) this.start();
    const child = this.child;
    if (!child) throw new Error("Katalog-Worker konnte nicht gestartet werden.");

    const id = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });

    child.postMessage({ kind: "request", id, method, payload });
    return result;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
