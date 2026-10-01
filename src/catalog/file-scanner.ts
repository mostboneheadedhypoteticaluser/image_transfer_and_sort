import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIRECTORY_NAMES, MEDIA_EXTENSIONS } from "./constants";

export type FileSystemIdentity = {
  deviceId: string;
  inode: string;
};

export type DiscoveredDirectory = FileSystemIdentity & {
  absolutePath: string;
  relativePath: string;
};

export type DiscoveredFile = FileSystemIdentity & {
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

export type WalkMediaOptions = {
  onError?: (error: ScanReadError) => void;
  onDirectory?: (directory: DiscoveredDirectory) => void | Promise<void>;
};

function identityFromStat(info: { dev: bigint; ino: bigint }): FileSystemIdentity {
  return {
    deviceId: info.dev.toString(),
    inode: info.ino.toString()
  };
}

export async function* walkMedia(
  root: string,
  options: WalkMediaOptions = {}
): AsyncGenerator<DiscoveredFile> {
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let directory;

    try {
      directory = await opendir(current);

      try {
        const directoryInfo = await stat(current, { bigint: true });
        await options.onDirectory?.({
          absolutePath: current,
          relativePath: path.relative(root, current).split(path.sep).join("/"),
          ...identityFromStat(directoryInfo)
        });
      } catch (error) {
        options.onError?.({
          path: current,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } catch (error) {
      options.onError?.({
        path: current,
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    for await (const entry of directory) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          continue;
        }
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(extension)) {
        continue;
      }

      try {
        const info = await stat(absolutePath, { bigint: true });
        yield {
          absolutePath,
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
          extension,
          sizeBytes: Number(info.size),
          mtimeMs: Number(info.mtimeMs),
          ...identityFromStat(info)
        };
      } catch (error) {
        options.onError?.({
          path: absolutePath,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
