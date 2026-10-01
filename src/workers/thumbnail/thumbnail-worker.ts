import { mkdir, access } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

type CropBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Request = {
  kind: "request";
  id: string;
  mode?: "thumbnail" | "face-crop";
  inputPath: string;
  outputPath: string;
  maxWidth: number;
  maxHeight: number;
  crop?: CropBox;
};

type Response =
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

type MessageEventLike = { data: Request };

type ParentPortLike = {
  on(event: "message", listener: (event: MessageEventLike) => void): void;
  postMessage(message: Response): void;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) throw new Error("Thumbnail-Worker wurde ohne Parent-Port gestartet.");

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function orientedDimensions(metadata: sharp.Metadata): {
  width: number;
  height: number;
} {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const orientation = metadata.orientation ?? 1;
  const swapped = [5, 6, 7, 8].includes(orientation);

  return swapped
    ? { width: height, height: width }
    : { width, height };
}

function cropRegion(
  crop: CropBox,
  imageWidth: number,
  imageHeight: number
): { left: number; top: number; width: number; height: number } {
  const faceWidth = Math.max(1, crop.width);
  const faceHeight = Math.max(1, crop.height);
  const margin = Math.max(faceWidth, faceHeight) * 0.42;

  const left = Math.max(0, Math.floor(crop.x - margin));
  const top = Math.max(0, Math.floor(crop.y - margin));
  const right = Math.min(
    imageWidth,
    Math.ceil(crop.x + faceWidth + margin)
  );
  const bottom = Math.min(
    imageHeight,
    Math.ceil(crop.y + faceHeight + margin)
  );

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

async function createThumbnail(request: Request) {
  await mkdir(path.dirname(request.outputPath), { recursive: true });

  if (await exists(request.outputPath)) {
    const metadata = await sharp(request.outputPath).metadata();
    return {
      path: request.outputPath,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      format: metadata.format ?? "jpeg",
      reused: true
    };
  }

  if (request.mode === "face-crop") {
    if (!request.crop) throw new Error("Face-Crop enthält keine Gesichtsbox.");

    const metadata = await sharp(request.inputPath).metadata();
    const dimensions = orientedDimensions(metadata);

    if (dimensions.width <= 0 || dimensions.height <= 0) {
      throw new Error("Bildabmessungen für Face-Crop konnten nicht gelesen werden.");
    }

    const region = cropRegion(
      request.crop,
      dimensions.width,
      dimensions.height
    );

    const info = await sharp(request.inputPath, {
      failOn: "warning",
      sequentialRead: true
    })
      .rotate()
      .extract(region)
      .resize({
        width: request.maxWidth,
        height: request.maxHeight,
        fit: "cover",
        position: "centre"
      })
      .jpeg({
        quality: 82,
        mozjpeg: true
      })
      .toFile(request.outputPath);

    return {
      path: request.outputPath,
      width: info.width,
      height: info.height,
      format: info.format,
      reused: false
    };
  }

  const info = await sharp(request.inputPath, {
    failOn: "warning",
    sequentialRead: true
  })
    .rotate()
    .resize({
      width: request.maxWidth,
      height: request.maxHeight,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({
      quality: 78,
      mozjpeg: true
    })
    .toFile(request.outputPath);

  return {
    path: request.outputPath,
    width: info.width,
    height: info.height,
    format: info.format,
    reused: false
  };
}

parentPort.on("message", async (event) => {
  const request = event.data;
  if (!request || request.kind !== "request") return;

  try {
    const result = await createThumbnail(request);
    parentPort.postMessage({
      kind: "response",
      id: request.id,
      ok: true,
      result
    });
  } catch (error) {
    parentPort.postMessage({
      kind: "response",
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
