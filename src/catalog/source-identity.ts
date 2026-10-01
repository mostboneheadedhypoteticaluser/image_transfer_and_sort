import path from "node:path";
import { access, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

export type PathIdentity = {
  deviceId: string;
  inode: string;
};

export async function isReadable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readPathIdentity(targetPath: string): Promise<PathIdentity | null> {
  try {
    const info = await stat(targetPath, { bigint: true });
    return {
      deviceId: info.dev.toString(),
      inode: info.ino.toString()
    };
  } catch {
    return null;
  }
}

async function findByIdentity(
  candidates: string[],
  identity: PathIdentity
): Promise<string | null> {
  const matches: string[] = [];

  for (const candidate of candidates) {
    const candidateIdentity = await readPathIdentity(candidate);
    if (
      candidateIdentity &&
      candidateIdentity.deviceId === identity.deviceId &&
      candidateIdentity.inode === identity.inode
    ) {
      matches.push(candidate);
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

async function findBySamples(
  candidates: string[],
  sampleRelativePaths: string[]
): Promise<string | null> {
  if (sampleRelativePaths.length === 0) return null;

  const matches: string[] = [];
  for (const candidate of candidates) {
    let allPresent = true;

    for (const relativePath of sampleRelativePaths) {
      const testPath = path.join(candidate, ...relativePath.split("/"));
      if (!(await isReadable(testPath))) {
        allPresent = false;
        break;
      }
    }

    if (allPresent) matches.push(candidate);
  }

  return matches.length === 1 ? matches[0] : null;
}

export async function findRenamedSibling(
  originalPath: string,
  identity: PathIdentity | null,
  sampleRelativePaths: string[]
): Promise<string | null> {
  const parent = path.dirname(originalPath);
  const base = path.basename(originalPath);

  if (!base || parent === originalPath) return null;
  if (!(await isReadable(parent))) return null;

  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name !== base)
    .map((entry) => path.join(parent, entry.name));

  if (identity) {
    const byIdentity = await findByIdentity(candidates, identity);
    if (byIdentity) return byIdentity;
  }

  return findBySamples(candidates, sampleRelativePaths);
}
