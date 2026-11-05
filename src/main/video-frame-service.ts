import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const VIDEO_FRAME_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;

type CacheFile = { filePath: string; bytes: number; usedAt: number };
const inFlight = new Map<string, Promise<Buffer>>();
const protectedFiles = new Set<string>();
let activeExtractors = 0;
const waitingExtractors: Array<() => void> = [];
let pruneInProgress: Promise<void> | null = null;

async function acquireExtractor(): Promise<void> {
  if (activeExtractors < 2) {
    activeExtractors += 1;
    return;
  }
  await new Promise<void>((resolve) => waitingExtractors.push(resolve));
  activeExtractors += 1;
}

function releaseExtractor(): void {
  activeExtractors -= 1;
  waitingExtractors.shift()?.();
}

function cacheBase(root: string): string {
  return path.join(root, "video-frames");
}

async function collectCachedJpegs(folder: string, files: CacheFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const item = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      await collectCachedJpegs(item, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jpg")) {
      try {
        const metadata = await stat(item);
        files.push({ filePath: item, bytes: metadata.size, usedAt: metadata.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

/** Enforces a global 500 MiB LRU limit, including scene JPEGs from older versions. */
export async function pruneVideoFrameCache(root: string): Promise<void> {
  if (pruneInProgress) return pruneInProgress;
  const task = (async () => {
    const files: CacheFile[] = [];
    await collectCachedJpegs(cacheBase(root), files);
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    if (total <= VIDEO_FRAME_CACHE_LIMIT_BYTES) return;
    files.sort((a, b) => a.usedAt - b.usedAt);
    for (const file of files) {
      if (total <= VIDEO_FRAME_CACHE_LIMIT_BYTES) break;
      if (protectedFiles.has(file.filePath)) continue;
      try {
        await rm(file.filePath, { force: true });
        total -= file.bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // A locked file on Windows can be considered in the next pass.
          continue;
        }
      }
    }
  })();
  pruneInProgress = task;
  try {
    await task;
  } finally {
    pruneInProgress = null;
  }
}

async function getCachedFile(filePath: string): Promise<Buffer | null> {
  try {
    const info = await stat(filePath);
    if (info.size <= 100) return null;
    const bytes = await readFile(filePath);
    const now = new Date();
    await utimes(filePath, now, now).catch(() => {});
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pythonRunner(): { command: string; prefix: string[]; script: string } {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const venv = process.platform === "win32"
    ? path.join(projectRoot, ".ai-venv", "Scripts", "python.exe")
    : path.join(projectRoot, ".ai-venv", "bin", "python");
  const script = path.join(projectRoot, "workers", "python-ai", "extract_frame.py");
  if (!existsSync(script)) throw new Error("Szenenbild-Extraktor fehlt.");
  if (existsSync(venv)) return { command: venv, prefix: [], script };
  // Mirror the analysis worker's normal platform fallback.
  return process.platform === "win32"
    ? { command: "py", prefix: ["-3"], script }
    : { command: "python3", prefix: [], script };
}

async function generateVerifiedJpeg(
  inputPath: string,
  frameIndex: number,
  frameHash: string,
  target: string,
  width: number
): Promise<void> {
  const { command, prefix, script } = pythonRunner();
  await mkdir(path.dirname(target), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      command,
      [...prefix, script, inputPath, String(frameIndex), frameHash, target, String(width)],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
    );
    let errorText = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Szenenbild-Extraktion nach 30 Sekunden abgebrochen."));
    }, 30000);
    child.stderr.on("data", (part: Buffer) => {
      errorText = (errorText + part.toString("utf8")).slice(-2500);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      finish(code === 0
        ? undefined
        : new Error(errorText.trim() || "Szenenbild-Extraktion fehlgeschlagen (" + code + ")."))
    );
  });
}

export async function getVideoFrameJpeg(
  inputPath: string,
  inputSha256: string,
  timestampMs: number,
  frameIndex: number | null,
  frameHash: string | null,
  maxWidth: number,
  root: string
): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/i.test(inputSha256) ||
      !Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error("Ungültige Szenenbild-Metadaten.");
  }
  const width = maxWidth <= 400 ? 320 : 1600;
  const frameFolder = path.join(cacheBase(root), inputSha256.slice(0, 2), inputSha256);
  const validIndex = frameIndex !== null && Number.isSafeInteger(frameIndex) && frameIndex >= 0;
  const validHash = typeof frameHash === "string" && /^[a-f0-9]{32}$/i.test(frameHash);
  const legacyPath = path.join(frameFolder, timestampMs + "-analyzed-1600.jpg");

  // Old catalogs contain timestamp/coordinates only. Their old exact JPEG may
  // still exist, but silently re-seeking by timestamp would misalign boxes.
  if (!validIndex || !validHash) {
    const legacy = await getCachedFile(legacyPath);
    if (!legacy) {
      throw new Error("Ältere Videoanalyse ohne Framenummer. Bitte Video neu analysieren.");
    }
    return width === 1600
      ? legacy
      : sharp(legacy).resize({ width: 320, withoutEnlargement: true })
          .jpeg({ quality: 78 }).toBuffer();
  }

  const outputPath = path.join(frameFolder, frameIndex + "-" + frameHash + "-" + width + ".jpg");
  const pending = inFlight.get(outputPath);
  if (pending) return pending;

  const task = (async () => {
    const cached = await getCachedFile(outputPath);
    if (cached) return cached;

    // Keep the file pinned until its bytes have been read and the pruning
    // pass completes, including while this job waits for an extractor slot.
    protectedFiles.add(outputPath);
    try {
      await acquireExtractor();
      try {
        const again = await getCachedFile(outputPath);
        if (again) return again;
        await generateVerifiedJpeg(inputPath, frameIndex!, frameHash!, outputPath, width);
        const generated = await getCachedFile(outputPath);
        if (!generated) throw new Error("OpenCV erzeugte keine lesbare JPEG-Datei.");
        return generated;
      } finally {
        releaseExtractor();
      }
    } finally {
      protectedFiles.delete(outputPath);
      // A single worker may temporarily exceed the limit until this pass.
      await pruneVideoFrameCache(root).catch(() => {});
    }
  })();
  inFlight.set(outputPath, task);
  try {
    return await task;
  } finally {
    inFlight.delete(outputPath);
  }
}
