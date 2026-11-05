import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const inFlight = new Map<string, Promise<Buffer>>();

/**
 * Never re-seek the video for a scene with identity boxes: seeking can produce a
 * different frame, invalidating the original detection coordinates.
 */
export async function getVideoFrameJpeg(
  _inputPath: string,
  inputSha256: string,
  timestampMs: number,
  maxWidth: number,
  cacheRoot: string
): Promise<Buffer> {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 86400000) {
    throw new Error("Ungültige Zeitposition");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(inputSha256)) {
    throw new Error("Ungültiger Video-Inhaltshash");
  }
  const sourcePath = path.join(
    cacheRoot, "video-frames", inputSha256.slice(0, 2),
    inputSha256, timestampMs + "-analyzed-1600.jpg"
  );
  const outputWidth = maxWidth <= 400 ? 320 : 1600;
  const key = sourcePath + ":" + outputWidth;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async () => {
    try {
      const sourceSize = await stat(sourcePath);
      if (sourceSize.size <= 0) throw new Error("Leere Szenendatei");
    } catch {
      throw new Error(
        "Original-Analyseframe fehlt. Bitte dieses Video neu analysieren, " +
        "damit Erkennungsrechtecke und Szenenbild exakt zusammenpassen."
      );
    }
    if (outputWidth === 1600) return readFile(sourcePath);
    return sharp(sourcePath)
      .resize({ width: 320, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
  })();
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
