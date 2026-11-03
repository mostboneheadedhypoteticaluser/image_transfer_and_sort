import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  nativeImage,
  utilityProcess,
  type NativeImage,
  type UtilityProcess
} from "electron";

const THUMBNAIL_WORKER_COUNT = 2;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  worker: UtilityProcess;
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

type CropBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ThumbnailRequest = {
  mode: "thumbnail" | "preview" | "face-crop" | "pet-crop";
  inputPath: string;
  outputPath: string;
  maxWidth: number;
  maxHeight: number;
  crop?: CropBox;
};

export type ThumbnailResult = {
  path: string;
  width: number;
  height: number;
  format: string;
  reused: boolean;
};

export class ThumbnailService {
  private readonly children: UtilityProcess[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly workerLoads = new Map<UtilityProcess, number>();
  private readonly inFlightOutputs = new Map<string, Promise<ThumbnailResult>>();

  constructor(
    private readonly workerPath: string,
    private readonly cacheRoot: string,
    private readonly onDiagnostic?: (
      event: string,
      fields?: Record<string, unknown>
    ) => void
  ) {}

  start(): void {
    while (this.children.length < THUMBNAIL_WORKER_COUNT) {
      this.spawnWorker(this.children.length + 1);
    }
  }

  private spawnWorker(index: number): void {
    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: `Image Sortierer – Thumbnails ${index}`
    });

    this.children.push(child);
    this.workerLoads.set(child, 0);
    this.onDiagnostic?.("THUMBNAIL_WORKER_STARTED", { index });

    child.on("message", (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending || pending.worker !== child) return;

      this.pending.delete(message.id);
      this.workerLoads.set(
        child,
        Math.max(0, (this.workerLoads.get(child) ?? 1) - 1)
      );

      if (message.ok) {
        pending.resolve(message.result);
      } else {
        this.onDiagnostic?.("THUMBNAIL_WORKER_ERROR", {
          error: message.error
        });
        pending.reject(new Error(message.error));
      }
    });

    child.on("exit", (code) => {
      const position = this.children.indexOf(child);
      if (position >= 0) this.children.splice(position, 1);
      this.workerLoads.delete(child);

      const error = new Error(
        `Thumbnail-Worker wurde beendet (Code ${code ?? "unbekannt"}).`
      );
      this.onDiagnostic?.("THUMBNAIL_WORKER_EXIT", {
        code: code ?? null,
        pending: [...this.pending.values()].filter(
          (pending) => pending.worker === child
        ).length
      });

      for (const [id, pending] of [...this.pending.entries()]) {
        if (pending.worker !== child) continue;
        this.pending.delete(id);
        pending.reject(error);
      }
    });
  }

  private leastBusyWorker(): UtilityProcess {
    this.start();

    const worker = this.children
      .map((child) => ({
        child,
        load: this.workerLoads.get(child) ?? 0
      }))
      .sort((left, right) => left.load - right.load)[0]?.child;

    if (!worker) {
      throw new Error("Thumbnail-Worker konnte nicht gestartet werden.");
    }

    return worker;
  }

  private inputSignature(inputPath: string): Record<string, unknown> {
    try {
      const info = statSync(inputPath);
      const fd = openSync(inputPath, "r");
      try {
        const buffer = Buffer.alloc(32);
        const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
        return {
          sizeBytes: info.size,
          firstBytesHex: buffer.subarray(0, bytesRead).toString("hex")
        };
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return {
        signatureError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private nativeImageCrop(
    image: NativeImage,
    crop: CropBox,
    marginFraction: number
  ): NativeImage {
    const size = image.getSize();
    const faceWidth = Math.max(1, crop.width);
    const faceHeight = Math.max(1, crop.height);
    const margin = Math.max(faceWidth, faceHeight) * marginFraction;

    const left = Math.max(0, Math.floor(crop.x - margin));
    const top = Math.max(0, Math.floor(crop.y - margin));
    const right = Math.min(
      size.width,
      Math.ceil(crop.x + faceWidth + margin)
    );
    const bottom = Math.min(
      size.height,
      Math.ceil(crop.y + faceHeight + margin)
    );

    return image.crop({
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    });
  }

  private nativeImageFallback(request: ThumbnailRequest): ThumbnailResult {
    let image = nativeImage.createFromPath(request.inputPath);
    if (image.isEmpty()) {
      throw new Error(
        "Datei konnte weder von Sharp noch vom Electron-Bilddecoder gelesen werden."
      );
    }

    if (request.mode === "face-crop" || request.mode === "pet-crop") {
      if (!request.crop) {
        throw new Error("Crop enthält keine gültige Bounding Box.");
      }

      image = this.nativeImageCrop(
        image,
        request.crop,
        request.mode === "pet-crop" ? 0.16 : 0.42
      );
      image = image.resize({
        width: request.maxWidth,
        height: request.maxHeight,
        quality: "best"
      });
    } else {
      const size = image.getSize();
      if (size.width <= 0 || size.height <= 0) {
        throw new Error("Electron-Bilddecoder lieferte ungültige Abmessungen.");
      }

      const scale = Math.min(
        1,
        request.maxWidth / size.width,
        request.maxHeight / size.height
      );
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "best"
      });
    }

    mkdirSync(path.dirname(request.outputPath), { recursive: true });
    writeFileSync(
      request.outputPath,
      image.toJPEG(request.mode === "thumbnail" ? 78 : 82)
    );

    const size = image.getSize();
    return {
      path: request.outputPath,
      width: size.width,
      height: size.height,
      format: "jpeg",
      reused: false
    };
  }

  private request(request: ThumbnailRequest): Promise<ThumbnailResult> {
    // Der Cache ist SHA-basiert. Zwei Medien mit identischem Inhalt können
    // deshalb exakt denselben outputPath besitzen. Mit mehreren Workern darf
    // niemals gleichzeitig in dieselbe Datei geschrieben werden.
    const existing = this.inFlightOutputs.get(request.outputPath);
    if (existing) {
      this.onDiagnostic?.("THUMBNAIL_OUTPUT_REUSED_IN_FLIGHT", {
        outputPath: request.outputPath
      });
      return existing;
    }

    const worker = this.leastBusyWorker();
    const id = randomUUID();

    const result = new Promise<ThumbnailResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as ThumbnailResult),
        reject,
        worker
      });
    });

    this.inFlightOutputs.set(request.outputPath, result);
    const cleanup = () => {
      if (this.inFlightOutputs.get(request.outputPath) === result) {
        this.inFlightOutputs.delete(request.outputPath);
      }
    };
    void result.then(cleanup, cleanup);

    this.workerLoads.set(worker, (this.workerLoads.get(worker) ?? 0) + 1);

    this.onDiagnostic?.("THUMBNAIL_REQUEST_BEGIN", {
      inputPath: request.inputPath,
      outputPath: request.outputPath,
      mode: request.mode
    });

    worker.postMessage({
      kind: "request",
      id,
      ...request
    });

    return result.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("unsupported image format")) {
        throw error;
      }

      this.onDiagnostic?.("THUMBNAIL_SHARP_UNSUPPORTED", {
        inputPath: request.inputPath,
        mode: request.mode,
        ...this.inputSignature(request.inputPath)
      });

      try {
        const fallback = this.nativeImageFallback(request);
        this.onDiagnostic?.("THUMBNAIL_NATIVE_FALLBACK_OK", {
          inputPath: request.inputPath,
          mode: request.mode,
          width: fallback.width,
          height: fallback.height
        });
        return fallback;
      } catch (fallbackError) {
        this.onDiagnostic?.("THUMBNAIL_NATIVE_FALLBACK_ERROR", {
          inputPath: request.inputPath,
          mode: request.mode,
          ...this.inputSignature(request.inputPath),
          error:
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError)
        });
        throw fallbackError;
      }
    });
  }

  async generate(
    inputPath: string,
    sha256: string,
    maxWidth = 360,
    maxHeight = 260
  ): Promise<ThumbnailResult> {
    const safeHash = this.safeHash(sha256, "Thumbnail");
    const outputPath = path.join(
      this.cacheRoot,
      safeHash.slice(0, 2),
      `${safeHash}.jpg`
    );

    return this.request({
      mode: "thumbnail",
      inputPath,
      outputPath,
      maxWidth,
      maxHeight
    });
  }

  async generatePreview(
    inputPath: string,
    sha256: string,
    maxWidth = 1920,
    maxHeight = 1440
  ): Promise<ThumbnailResult> {
    const safeHash = this.safeHash(sha256, "Vorschau");
    const outputPath = path.join(
      this.cacheRoot,
      "previews",
      safeHash.slice(0, 2),
      `${safeHash}.jpg`
    );

    return this.request({
      mode: "preview",
      inputPath,
      outputPath,
      maxWidth,
      maxHeight
    });
  }

  async generatePetCrop(
    inputPath: string,
    sha256: string,
    petDetectionId: number,
    box: CropBox,
    size = 200
  ): Promise<ThumbnailResult> {
    const safeHash = this.safeHash(sha256, "Haustier-Crop");
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

    return this.request({
      mode: "pet-crop",
      inputPath,
      outputPath,
      maxWidth: size,
      maxHeight: size,
      crop: box
    });
  }

  async generateFaceCrop(
    inputPath: string,
    sha256: string,
    faceDetectionId: number,
    box: CropBox,
    size = 180
  ): Promise<ThumbnailResult> {
    const safeHash = this.safeHash(sha256, "Face-Crop");
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

    return this.request({
      mode: "face-crop",
      inputPath,
      outputPath,
      maxWidth: size,
      maxHeight: size,
      crop: box
    });
  }

  private safeHash(sha256: string, label: string): string {
    const safeHash = sha256.toLowerCase().replace(/[^a-f0-9]/g, "");
    if (safeHash.length < 16) {
      throw new Error(`Ungültiger SHA-256 für ${label}-Cache.`);
    }
    return safeHash;
  }

  stop(): void {
    const children = [...this.children];
    this.children.length = 0;
    this.workerLoads.clear();
    this.inFlightOutputs.clear();

    const error = new Error("Thumbnail-Worker wurde für einen Neustart beendet.");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    for (const child of children) {
      try {
        child.kill();
      } catch {
        // Worker ist bereits beendet.
      }
    }
  }
}
