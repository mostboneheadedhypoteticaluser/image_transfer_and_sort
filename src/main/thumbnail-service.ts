import { randomUUID } from "node:crypto";
import path from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type WorkerResponse =
  | {
      kind: "response";
      id: string;
      ok: true;
      result: {
        path: string;
        width: number;
        height: number;
        format: string;
        reused: boolean;
      };
    }
  | {
      kind: "response";
      id: string;
      ok: false;
      error: string;
    };

export type ThumbnailResult = {
  path: string;
  width: number;
  height: number;
  format: string;
  reused: boolean;
};

export class ThumbnailService {
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly workerPath: string,
    private readonly cacheRoot: string
  ) {}

  start(): void {
    if (this.child) return;

    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: "Image Sortierer – Thumbnails"
    });

    child.on("message", (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      this.pending.delete(message.id);

      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
    });

    child.on("exit", (code) => {
      const error = new Error(
        `Thumbnail-Worker wurde beendet (Code ${code ?? "unbekannt"}).`
      );

      for (const pending of this.pending.values()) {
        pending.reject(error);
      }

      this.pending.clear();
      this.child = null;
    });

    this.child = child;
  }

  async generate(
    inputPath: string,
    sha256: string,
    maxWidth = 360,
    maxHeight = 260
  ): Promise<ThumbnailResult> {
    if (!this.child) this.start();

    const child = this.child;
    if (!child) throw new Error("Thumbnail-Worker konnte nicht gestartet werden.");

    const safeHash = sha256.toLowerCase().replace(/[^a-f0-9]/g, "");
    if (safeHash.length < 16) {
      throw new Error("Ungültiger SHA-256 für Thumbnail-Cache.");
    }

    const outputPath = path.join(
      this.cacheRoot,
      safeHash.slice(0, 2),
      `${safeHash}.jpg`
    );

    const id = randomUUID();

    const result = new Promise<ThumbnailResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as ThumbnailResult),
        reject
      });
    });

    child.postMessage({
      kind: "request",
      id,
      mode: "thumbnail",
      inputPath,
      outputPath,
      maxWidth,
      maxHeight
    });

    return result;
  }

  async generatePreview(
    inputPath: string,
    sha256: string,
    maxWidth = 1920,
    maxHeight = 1440
  ): Promise<ThumbnailResult> {
    if (!this.child) this.start();

    const child = this.child;
    if (!child) throw new Error("Thumbnail-Worker konnte nicht gestartet werden.");

    const safeHash = sha256.toLowerCase().replace(/[^a-f0-9]/g, "");
    if (safeHash.length < 16) {
      throw new Error("Ungültiger SHA-256 für Vorschau-Cache.");
    }

    const outputPath = path.join(
      this.cacheRoot,
      "previews",
      safeHash.slice(0, 2),
      `${safeHash}.jpg`
    );

    const id = randomUUID();

    const result = new Promise<ThumbnailResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as ThumbnailResult),
        reject
      });
    });

    child.postMessage({
      kind: "request",
      id,
      mode: "preview",
      inputPath,
      outputPath,
      maxWidth,
      maxHeight
    });

    return result;
  }

  async generatePetCrop(
    inputPath: string,
    sha256: string,
    petDetectionId: number,
    box: { x: number; y: number; width: number; height: number },
    size = 200
  ): Promise<ThumbnailResult> {
    if (!this.child) this.start();

    const child = this.child;
    if (!child) throw new Error("Thumbnail-Worker konnte nicht gestartet werden.");

    const safeHash = sha256.toLowerCase().replace(/[^a-f0-9]/g, "");
    if (safeHash.length < 16) {
      throw new Error("Ungültiger SHA-256 für Haustier-Crop-Cache.");
    }

    const cropKey = [
      petDetectionId,
      Math.round(box.x),
      Math.round(box.y),
      Math.round(box.width),
      Math.round(box.height)
    ].join("-");

    const outputPath = path.join(
      this.cacheRoot,
      "pet-crops",
      safeHash.slice(0, 2),
      `${safeHash}-${cropKey}.jpg`
    );

    const id = randomUUID();

    const result = new Promise<ThumbnailResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as ThumbnailResult),
        reject
      });
    });

    child.postMessage({
      kind: "request",
      id,
      mode: "pet-crop",
      inputPath,
      outputPath,
      maxWidth: size,
      maxHeight: size,
      crop: box
    });

    return result;
  }

  async generateFaceCrop(
    inputPath: string,
    sha256: string,
    faceDetectionId: number,
    box: { x: number; y: number; width: number; height: number },
    size = 180
  ): Promise<ThumbnailResult> {
    if (!this.child) this.start();

    const child = this.child;
    if (!child) throw new Error("Thumbnail-Worker konnte nicht gestartet werden.");

    const safeHash = sha256.toLowerCase().replace(/[^a-f0-9]/g, "");
    if (safeHash.length < 16) {
      throw new Error("Ungültiger SHA-256 für Face-Crop-Cache.");
    }

    const cropKey = [
      faceDetectionId,
      Math.round(box.x),
      Math.round(box.y),
      Math.round(box.width),
      Math.round(box.height)
    ].join("-");

    const outputPath = path.join(
      this.cacheRoot,
      "face-crops",
      safeHash.slice(0, 2),
      `${safeHash}-${cropKey}.jpg`
    );

    const id = randomUUID();

    const result = new Promise<ThumbnailResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as ThumbnailResult),
        reject
      });
    });

    child.postMessage({
      kind: "request",
      id,
      mode: "face-crop",
      inputPath,
      outputPath,
      maxWidth: size,
      maxHeight: size,
      crop: box
    });

    return result;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
