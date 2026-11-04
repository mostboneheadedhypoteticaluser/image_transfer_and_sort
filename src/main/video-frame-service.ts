import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const inFlight = new Map<string, Promise<Buffer>>();
let active = 0;
const waiting: Array<() => void> = [];

async function takeSlot(): Promise<void> {
  if (active < 2) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function releaseSlot(): void {
  active -= 1;
  waiting.shift()?.();
}

async function extractWithPython(input: string, output: string, timestampMs: number, maxWidth: number): Promise<void> {
  const root = path.resolve(__dirname, "..", "..");
  const python = process.platform === "win32"
    ? path.join(root, ".ai-venv", "Scripts", "python.exe")
    : path.join(root, ".ai-venv", "bin", "python");
  const script = path.join(root, "workers", "python-ai", "extract_frame.py");
  if (!existsSync(python)) throw new Error("Python-KI-Umgebung fehlt: npm run setup:ai ausführen");
  if (!existsSync(script)) throw new Error("Szenenbild-Extractor fehlt");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [script, input, String(timestampMs), output, String(maxWidth)], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let errors = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Szenenbild-Extraktion überschritt 30 Sekunden"));
    }, 30000);
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString("utf8")).slice(-2000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(errors.trim() || "OpenCV-Extraktion fehlgeschlagen (" + code + ")"));
    });
  });
}

export async function getVideoFrameJpeg(
  inputPath: string,
  inputSha256: string,
  timestampMs: number,
  maxWidth: number,
  cacheRoot: string
): Promise<Buffer> {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 86400000) {
    throw new Error("Ungültige Zeitposition");
  }
  const width = maxWidth <= 400 ? 320 : 1600;
  const cacheFile = path.join(cacheRoot, "video-frames", inputSha256.slice(0, 2), inputSha256, timestampMs + "-" + width + ".jpg");
  const existing = inFlight.get(cacheFile);
  if (existing) return existing;
  const task = (async () => {
    try {
      if ((await stat(cacheFile)).size > 0) return await readFile(cacheFile);
    } catch {
      // No cached JPEG yet.
    }
    await takeSlot();
    try {
      // Recheck after waiting: another request may already have generated it.
      try {
        if ((await stat(cacheFile)).size > 0) return await readFile(cacheFile);
      } catch {}
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await extractWithPython(inputPath, cacheFile, timestampMs, width);
      return await readFile(cacheFile);
    } finally {
      releaseSlot();
    }
  })();
  inFlight.set(cacheFile, task);
  try {
    return await task;
  } finally {
    inFlight.delete(cacheFile);
  }
}
