import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import { IMAGE_EXTENSIONS } from "./constants";

export type DiscoveredFile = {
  absolutePath: string;
  relativePath: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type ScanReadError = {
  path: string;
  message: string;
};

export async function* walkImages(
  root: string,
  onError?: (error: ScanReadError) => void
): AsyncGenerator<DiscoveredFile> {
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let directory;

    try {
      directory = await opendir(current);
    } catch (error) {
      onError?.({
        path: current,
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    for await (const entry of directory) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) {
        continue;
      }

      try {
        const info = await stat(absolutePath);
        yield {
          absolutePath,
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
          extension,
          sizeBytes: info.size,
          mtimeMs: Math.trunc(info.mtimeMs)
        };
      } catch (error) {
        onError?.({
          path: absolutePath,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
