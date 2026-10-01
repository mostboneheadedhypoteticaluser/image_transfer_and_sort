import { mkdir, access } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

type Request = {
  kind: "request";
  id: string;
  inputPath: string;
  outputPath: string;
  maxWidth: number;
  maxHeight: number;
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
