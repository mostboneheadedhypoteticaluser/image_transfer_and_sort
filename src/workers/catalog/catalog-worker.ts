import path from "node:path";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { walkMedia, type DiscoveredDirectory } from "../../catalog/file-scanner";
import { sha256File } from "../../catalog/hash";
import {
  findRenamedSibling,
  isReadable,
  readPathIdentity,
  type PathIdentity
} from "../../catalog/source-identity";
import {
  recycleBinIndex,
  recycleLookupKey,
  restoreRecycleBinItem
} from "./recycle-bin";
import type {
  CatalogMethod,
  RestoreResult,
  ScanProgress,
  ScanResult,
  WorkerRequest,
  WorkerResponse
} from "../../shared/protocol";

type MessageEventLike = { data: WorkerRequest };
type ParentPortLike = {
  on(event: "message", listener: (event: MessageEventLike) => void): void;
  postMessage(message: WorkerResponse): void;
};

type IndexedMedia = {
  id: number;
  relativePath: string;
  absolutePath: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  deviceId: string | null;
  inode: string | null;
  availability: "AVAILABLE" | "MISSING";
  inRecycleBin: boolean;
};

type IndexedDirectory = {
  id: number;
  relativePath: string;
  absolutePath: string;
  deviceId: string | null;
  inode: string | null;
  availability: boolean;
};

type DirectoryIndex = {
  byPath: Map<string, IndexedDirectory>;
  byIdentity: Map<string, IndexedDirectory[]>;
  all: Map<number, IndexedDirectory>;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) throw new Error("Katalog-Worker wurde ohne Parent-Port gestartet.");

const dbPath = process.env.IMAGE_SORTER_DB;
if (!dbPath) throw new Error("IMAGE_SORTER_DB fehlt.");

const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;

  CREATE TABLE IF NOT EXISTS media_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'RUNNING',
    discovered_count INTEGER NOT NULL DEFAULT 0,
    added_count INTEGER NOT NULL DEFAULT 0,
    changed_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS media_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    extension TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    availability TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(availability IN ('AVAILABLE','MISSING')),
    scan_token TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, relative_path)
  );

  CREATE INDEX IF NOT EXISTS idx_media_source ON media_items(source_id);
  CREATE INDEX IF NOT EXISTS idx_media_hash ON media_items(sha256);
  CREATE INDEX IF NOT EXISTS idx_media_availability ON media_items(source_id, availability);

  CREATE TABLE IF NOT EXISTS media_directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    device_id TEXT,
    inode TEXT,
    availability INTEGER NOT NULL DEFAULT 1 CHECK(availability IN (0,1)),
    scan_token TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_moved_at TEXT,
    UNIQUE(source_id, relative_path)
  );

  CREATE INDEX IF NOT EXISTS idx_directory_source
    ON media_directories(source_id);
  CREATE INDEX IF NOT EXISTS idx_directory_identity
    ON media_directories(source_id, device_id, inode);

  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    module TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    priority INTEGER NOT NULL DEFAULT 100,
    attempts INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(media_id, module)
  );
`);

function tableHasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => String(row.name) === column);
}

function ensureColumn(table: string, column: string, definition: string): void {
  if (!tableHasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("media_sources", "device_id", "TEXT");
ensureColumn("media_sources", "inode", "TEXT");
ensureColumn("scans", "moved_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("scans", "recycle_bin_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("media_items", "in_recycle_bin", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("media_items", "recycle_path", "TEXT");
ensureColumn("media_items", "recycle_detected_at", "TEXT");
ensureColumn("media_items", "last_moved_at", "TEXT");
ensureColumn("media_items", "device_id", "TEXT");
ensureColumn("media_items", "inode", "TEXT");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_media_recycle
    ON media_items(source_id, in_recycle_bin);
  CREATE INDEX IF NOT EXISTS idx_media_identity
    ON media_items(source_id, device_id, inode);

  DELETE FROM media_items
  WHERE lower(relative_path) LIKE '$recycle.bin/%'
     OR lower(relative_path) LIKE '%/$recycle.bin/%'
     OR lower(relative_path) LIKE 'system volume information/%'
     OR lower(relative_path) LIKE '%/system volume information/%';
`);

let scanRunning = false;

function post(message: WorkerResponse): void {
  parentPort.postMessage(message);
}

function progress(sourceId: number, discovered: number, message: string): void {
  const payload: ScanProgress = { sourceId, discovered, message };
  post({ kind: "event", event: "scanProgress", payload });
}

function asNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} ist ungültig.`);
  return number;
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathAffectedByReadError(filePath: string, errorPaths: string[]): boolean {
  const file = normalizeForComparison(filePath);

  return errorPaths.some((errorPath) => {
    const error = normalizeForComparison(errorPath);
    if (file === error) return true;
    const prefix = error.endsWith(path.sep) ? error : error + path.sep;
    return file.startsWith(prefix);
  });
}

function listSources() {
  return db.prepare("SELECT id, path, enabled FROM media_sources ORDER BY id")
    .all()
    .map((row) => ({
      id: Number(row.id),
      path: String(row.path),
      enabled: Boolean(row.enabled)
    }));
}

async function addSource(sourcePath: unknown) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new Error("Quellpfad fehlt.");
  }

  const canonical = path.resolve(sourcePath.trim());
  const identity = await readPathIdentity(canonical);

  db.prepare(`
    INSERT INTO media_sources(path, enabled, device_id, inode)
    VALUES(?,1,?,?)
    ON CONFLICT(path) DO UPDATE SET
      enabled=1,
      device_id=COALESCE(excluded.device_id, media_sources.device_id),
      inode=COALESCE(excluded.inode, media_sources.inode),
      updated_at=CURRENT_TIMESTAMP
  `).run(
    canonical,
    identity?.deviceId ?? null,
    identity?.inode ?? null
  );

  const row = db.prepare("SELECT id, path, enabled FROM media_sources WHERE path=?").get(canonical);
  if (!row) throw new Error("Quelle konnte nicht gespeichert werden.");

  return {
    id: Number(row.id),
    path: String(row.path),
    enabled: Boolean(row.enabled)
  };
}

function sourceSamples(sourceId: number): string[] {
  return db.prepare(`
    SELECT relative_path
    FROM media_items
    WHERE source_id=?
      AND availability='AVAILABLE'
      AND lower(relative_path) NOT LIKE '$recycle.bin/%'
    ORDER BY id
    LIMIT 5
  `).all(sourceId).map((row) => String(row.relative_path));
}

async function resolveSourceRoot(sourceId: number): Promise<string> {
  const source = db.prepare(`
    SELECT path, device_id, inode
    FROM media_sources
    WHERE id=? AND enabled=1
  `).get(sourceId);

  if (!source) {
    throw new Error("Medienquelle wurde nicht gefunden oder ist deaktiviert.");
  }

  const oldPath = String(source.path);

  if (await isReadable(oldPath)) {
    const identity = await readPathIdentity(oldPath);
    if (identity) {
      db.prepare(`
        UPDATE media_sources
        SET device_id=?, inode=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(identity.deviceId, identity.inode, sourceId);
    }
    return oldPath;
  }

  const storedIdentity: PathIdentity | null =
    source.device_id && source.inode
      ? {
          deviceId: String(source.device_id),
          inode: String(source.inode)
        }
      : null;

  const renamedPath = await findRenamedSibling(
    oldPath,
    storedIdentity,
    sourceSamples(sourceId)
  );

  if (!renamedPath) {
    throw new Error(
      `Medienquelle ist nicht erreichbar: ${oldPath}. ` +
      "Eine eindeutige Umbenennung im gleichen übergeordneten Ordner wurde nicht gefunden."
    );
  }

  const newIdentity = await readPathIdentity(renamedPath);

  try {
    db.prepare(`
      UPDATE media_sources
      SET path=?, device_id=?, inode=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      renamedPath,
      newIdentity?.deviceId ?? null,
      newIdentity?.inode ?? null,
      sourceId
    );
  } catch (error) {
    throw new Error(
      `Der umbenannte Quellordner wurde als ${renamedPath} erkannt, konnte aber nicht übernommen werden: ` +
      (error instanceof Error ? error.message : String(error))
    );
  }

  progress(sourceId, 0, `Quellordner umbenannt erkannt: ${oldPath} → ${renamedPath}`);
  return renamedPath;
}

function getStats(sourceId: number) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN availability='AVAILABLE' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN availability='MISSING' THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN availability='MISSING' AND in_recycle_bin=1 THEN 1 ELSE 0 END) AS recycle_bin
    FROM media_items
    WHERE source_id=?
  `).get(sourceId);

  const lastScan = db.prepare(`
    SELECT finished_at
    FROM scans
    WHERE source_id=? AND finished_at IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(sourceId);

  return {
    total: Number(row?.total ?? 0),
    available: Number(row?.available ?? 0),
    missing: Number(row?.missing ?? 0),
    recycleBin: Number(row?.recycle_bin ?? 0),
    lastScan: lastScan?.finished_at ? String(lastScan.finished_at) : null
  };
}

function listMedia(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(requestedLimit || 500)));

  return db.prepare(`
    SELECT id, relative_path, extension, size_bytes, availability, in_recycle_bin, last_seen_at
    FROM media_items
    WHERE source_id=?
    ORDER BY
      CASE
        WHEN availability='MISSING' AND in_recycle_bin=1 THEN 1
        WHEN availability='MISSING' THEN 2
        ELSE 0
      END,
      relative_path COLLATE NOCASE
    LIMIT ?
  `).all(sourceId, limit).map((row) => ({
    id: Number(row.id),
    relativePath: String(row.relative_path),
    extension: String(row.extension),
    sizeBytes: Number(row.size_bytes),
    availability: String(row.availability),
    inRecycleBin: Boolean(row.in_recycle_bin),
    lastSeenAt: String(row.last_seen_at)
  }));
}

function identityKey(deviceId: string | null | undefined, inode: string | null | undefined): string | null {
  if (!deviceId || !inode || inode === "0") return null;
  return `${deviceId}:${inode}`;
}

function sameIdentity(
  leftDeviceId: string | null | undefined,
  leftInode: string | null | undefined,
  rightDeviceId: string | null | undefined,
  rightInode: string | null | undefined
): boolean {
  const left = identityKey(leftDeviceId, leftInode);
  const right = identityKey(rightDeviceId, rightInode);
  return left !== null && left === right;
}

function loadIndex(sourceId: number): {
  byPath: Map<string, IndexedMedia>;
  byHash: Map<string, IndexedMedia[]>;
  byIdentity: Map<string, IndexedMedia[]>;
} {
  const rows = db.prepare(`
    SELECT
      id,
      relative_path,
      absolute_path,
      extension,
      size_bytes,
      mtime_ms,
      sha256,
      device_id,
      inode,
      availability,
      in_recycle_bin
    FROM media_items
    WHERE source_id=?
  `).all(sourceId);

  const byPath = new Map<string, IndexedMedia>();
  const byHash = new Map<string, IndexedMedia[]>();
  const byIdentity = new Map<string, IndexedMedia[]>();

  for (const row of rows) {
    const media: IndexedMedia = {
      id: Number(row.id),
      relativePath: String(row.relative_path),
      absolutePath: String(row.absolute_path),
      extension: String(row.extension),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
      sha256: String(row.sha256),
      deviceId: row.device_id === null ? null : String(row.device_id),
      inode: row.inode === null ? null : String(row.inode),
      availability: String(row.availability) as "AVAILABLE" | "MISSING",
      inRecycleBin: Boolean(row.in_recycle_bin)
    };

    byPath.set(media.relativePath, media);

    const hashItems = byHash.get(media.sha256) ?? [];
    hashItems.push(media);
    byHash.set(media.sha256, hashItems);

    const key = identityKey(media.deviceId, media.inode);
    if (key) {
      const identityItems = byIdentity.get(key) ?? [];
      identityItems.push(media);
      byIdentity.set(key, identityItems);
    }
  }

  return { byPath, byHash, byIdentity };
}

function loadDirectoryIndex(sourceId: number): DirectoryIndex {
  const rows = db.prepare(`
    SELECT id, relative_path, absolute_path, device_id, inode, availability
    FROM media_directories
    WHERE source_id=?
  `).all(sourceId);

  const index: DirectoryIndex = {
    byPath: new Map(),
    byIdentity: new Map(),
    all: new Map()
  };

  for (const row of rows) {
    const directory: IndexedDirectory = {
      id: Number(row.id),
      relativePath: String(row.relative_path),
      absolutePath: String(row.absolute_path),
      deviceId: row.device_id === null ? null : String(row.device_id),
      inode: row.inode === null ? null : String(row.inode),
      availability: Boolean(row.availability)
    };

    index.byPath.set(directory.relativePath, directory);
    index.all.set(directory.id, directory);

    const key = identityKey(directory.deviceId, directory.inode);
    if (key) {
      const identityItems = index.byIdentity.get(key) ?? [];
      identityItems.push(directory);
      index.byIdentity.set(key, identityItems);
    }
  }

  return index;
}

function pathIsInside(relativePath: string, directoryPath: string): boolean {
  if (directoryPath === "") return true;
  return relativePath === directoryPath || relativePath.startsWith(directoryPath + "/");
}

function replaceDirectoryPrefix(relativePath: string, oldPrefix: string, newPrefix: string): string {
  if (relativePath === oldPrefix) return newPrefix;
  const suffix = relativePath.slice(oldPrefix.length + 1);
  return newPrefix ? `${newPrefix}/${suffix}` : suffix;
}

function applyDirectoryMove(
  sourceId: number,
  root: string,
  oldPrefix: string,
  newPrefix: string,
  directoryIndex: DirectoryIndex,
  mediaByPath: Map<string, IndexedMedia>
): number {
  if (oldPrefix === newPrefix) return 0;

  const affectedDirectories = [...directoryIndex.all.values()]
    .filter((directory) => pathIsInside(directory.relativePath, oldPrefix));
  const affectedDirectoryIds = new Set(affectedDirectories.map((directory) => directory.id));

  for (const directory of affectedDirectories) {
    const target = replaceDirectoryPrefix(directory.relativePath, oldPrefix, newPrefix);
    const collision = directoryIndex.byPath.get(target);
    if (collision && !affectedDirectoryIds.has(collision.id)) {
      return 0;
    }
  }

  const affectedMedia = [...mediaByPath.values()]
    .filter((media) => pathIsInside(media.relativePath, oldPrefix));

  const updateDirectory = db.prepare(`
    UPDATE media_directories
    SET relative_path=?, absolute_path=?, last_moved_at=CURRENT_TIMESTAMP
    WHERE id=? AND source_id=?
  `);

  const updateMedia = db.prepare(`
    UPDATE media_items
    SET relative_path=?, absolute_path=?, last_moved_at=CURRENT_TIMESTAMP
    WHERE id=? AND source_id=?
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const directory of affectedDirectories) {
      const oldRelativePath = directory.relativePath;
      const newRelativePath = replaceDirectoryPrefix(oldRelativePath, oldPrefix, newPrefix);
      const newAbsolutePath = newRelativePath
        ? path.join(root, ...newRelativePath.split("/"))
        : root;

      updateDirectory.run(newRelativePath, newAbsolutePath, directory.id, sourceId);
    }

    for (const media of affectedMedia) {
      const newRelativePath = replaceDirectoryPrefix(media.relativePath, oldPrefix, newPrefix);
      const newAbsolutePath = path.join(root, ...newRelativePath.split("/"));
      updateMedia.run(newRelativePath, newAbsolutePath, media.id, sourceId);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  for (const directory of affectedDirectories) {
    directoryIndex.byPath.delete(directory.relativePath);
  }
  for (const directory of affectedDirectories) {
    directory.relativePath = replaceDirectoryPrefix(directory.relativePath, oldPrefix, newPrefix);
    directory.absolutePath = directory.relativePath
      ? path.join(root, ...directory.relativePath.split("/"))
      : root;
    directoryIndex.byPath.set(directory.relativePath, directory);
  }

  for (const media of affectedMedia) {
    mediaByPath.delete(media.relativePath);
  }
  for (const media of affectedMedia) {
    media.relativePath = replaceDirectoryPrefix(media.relativePath, oldPrefix, newPrefix);
    media.absolutePath = path.join(root, ...media.relativePath.split("/"));
    mediaByPath.set(media.relativePath, media);
  }

  return affectedMedia.length;
}

function registerDirectoryIdentity(index: DirectoryIndex, directory: IndexedDirectory): void {
  const key = identityKey(directory.deviceId, directory.inode);
  if (!key) return;
  const values = index.byIdentity.get(key) ?? [];
  if (!values.some((value) => value.id === directory.id)) {
    values.push(directory);
    index.byIdentity.set(key, values);
  }
}

function reconcileDirectory(
  sourceId: number,
  root: string,
  directory: DiscoveredDirectory,
  scanToken: string,
  directoryIndex: DirectoryIndex,
  seenDirectoryIds: Set<number>,
  mediaByPath: Map<string, IndexedMedia>
): number {
  const existingAtPath = directoryIndex.byPath.get(directory.relativePath);

  if (existingAtPath) {
    db.prepare(`
      UPDATE media_directories
      SET absolute_path=?, device_id=?, inode=?, availability=1,
          scan_token=?, last_seen_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      directory.absolutePath,
      directory.deviceId,
      directory.inode,
      scanToken,
      existingAtPath.id
    );

    existingAtPath.absolutePath = directory.absolutePath;
    existingAtPath.deviceId = directory.deviceId;
    existingAtPath.inode = directory.inode;
    existingAtPath.availability = true;
    seenDirectoryIds.add(existingAtPath.id);
    registerDirectoryIdentity(directoryIndex, existingAtPath);
    return 0;
  }

  const key = identityKey(directory.deviceId, directory.inode);
  const identityCandidates = key
    ? (directoryIndex.byIdentity.get(key) ?? []).filter(
        (candidate) => !seenDirectoryIds.has(candidate.id)
      )
    : [];

  if (identityCandidates.length === 1) {
    const candidate = identityCandidates[0];
    const movedMedia = applyDirectoryMove(
      sourceId,
      root,
      candidate.relativePath,
      directory.relativePath,
      directoryIndex,
      mediaByPath
    );

    const movedDirectory = directoryIndex.all.get(candidate.id)!;
    db.prepare(`
      UPDATE media_directories
      SET absolute_path=?, device_id=?, inode=?, availability=1,
          scan_token=?, last_seen_at=CURRENT_TIMESTAMP,
          last_moved_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      directory.absolutePath,
      directory.deviceId,
      directory.inode,
      scanToken,
      movedDirectory.id
    );

    movedDirectory.absolutePath = directory.absolutePath;
    movedDirectory.deviceId = directory.deviceId;
    movedDirectory.inode = directory.inode;
    movedDirectory.availability = true;
    seenDirectoryIds.add(movedDirectory.id);
    registerDirectoryIdentity(directoryIndex, movedDirectory);
    return movedMedia;
  }

  const inserted = db.prepare(`
    INSERT INTO media_directories(
      source_id, relative_path, absolute_path, device_id, inode, availability, scan_token
    )
    VALUES(?,?,?,?,?,1,?)
  `).run(
    sourceId,
    directory.relativePath,
    directory.absolutePath,
    directory.deviceId,
    directory.inode,
    scanToken
  );

  const indexed: IndexedDirectory = {
    id: Number(inserted.lastInsertRowid),
    relativePath: directory.relativePath,
    absolutePath: directory.absolutePath,
    deviceId: directory.deviceId,
    inode: directory.inode,
    availability: true
  };

  directoryIndex.byPath.set(indexed.relativePath, indexed);
  directoryIndex.all.set(indexed.id, indexed);
  registerDirectoryIdentity(directoryIndex, indexed);
  seenDirectoryIds.add(indexed.id);
  return 0;
}

async function uniqueIdentityMoveCandidate(
  deviceId: string,
  inode: string,
  byIdentity: Map<string, IndexedMedia[]>,
  seenIds: Set<number>
): Promise<IndexedMedia | null> {
  const key = identityKey(deviceId, inode);
  if (!key) return null;

  const candidates = (byIdentity.get(key) ?? []).filter(
    (candidate) =>
      !candidate.inRecycleBin &&
      !seenIds.has(candidate.id)
  );

  const missingAtOldLocation: IndexedMedia[] = [];
  for (const candidate of candidates) {
    if (!(await isReadable(candidate.absolutePath))) {
      missingAtOldLocation.push(candidate);
    }
  }

  return missingAtOldLocation.length === 1 ? missingAtOldLocation[0] : null;
}

async function uniqueMoveCandidate(
  hash: string,
  sizeBytes: number,
  byHash: Map<string, IndexedMedia[]>,
  seenIds: Set<number>
): Promise<IndexedMedia | null> {
  const candidates = (byHash.get(hash) ?? []).filter(
    (candidate) =>
      candidate.sizeBytes === sizeBytes &&
      !candidate.inRecycleBin &&
      !seenIds.has(candidate.id)
  );

  const missingAtOldLocation: IndexedMedia[] = [];

  for (const candidate of candidates) {
    if (!(await isReadable(candidate.absolutePath))) {
      missingAtOldLocation.push(candidate);
    }
  }

  return missingAtOldLocation.length === 1 ? missingAtOldLocation[0] : null;
}

async function refreshRecycleStatus(sourceId: number): Promise<number> {
  db.prepare(`
    UPDATE media_items
    SET in_recycle_bin=0, recycle_path=NULL, recycle_detected_at=NULL
    WHERE source_id=? AND availability='AVAILABLE'
  `).run(sourceId);

  if (process.platform !== "win32") {
    db.prepare(`
      UPDATE media_items
      SET in_recycle_bin=0, recycle_path=NULL, recycle_detected_at=NULL
      WHERE source_id=? AND availability='MISSING'
    `).run(sourceId);
    return 0;
  }

  let recycle;
  try {
    recycle = await recycleBinIndex();
  } catch {
    return Number(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM media_items
        WHERE source_id=? AND availability='MISSING' AND in_recycle_bin=1
      `).get(sourceId)?.count ?? 0
    );
  }

  const missingRows = db.prepare(`
    SELECT id, absolute_path
    FROM media_items
    WHERE source_id=? AND availability='MISSING'
  `).all(sourceId);

  const setRecycle = db.prepare(`
    UPDATE media_items
    SET in_recycle_bin=1, recycle_path=?, recycle_detected_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  const clearRecycle = db.prepare(`
    UPDATE media_items
    SET in_recycle_bin=0, recycle_path=NULL, recycle_detected_at=NULL
    WHERE id=?
  `);

  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of missingRows) {
      const item = recycle.get(recycleLookupKey(String(row.absolute_path)));
      if (item) {
        setRecycle.run(item.recyclePath, Number(row.id));
        count += 1;
      } else {
        clearRecycle.run(Number(row.id));
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return count;
}

async function scanSource(sourceId: number): Promise<ScanResult> {
  if (scanRunning) throw new Error("Es läuft bereits ein Scan.");
  scanRunning = true;

  let scanId: number | null = null;
  let discovered = 0;
  let added = 0;
  let moved = 0;
  let changed = 0;
  let unchanged = 0;
  let missing = 0;
  let recycleBin = 0;
  let errors = 0;

  try {
    const root = await resolveSourceRoot(sourceId);

    db.prepare(`
      DELETE FROM media_items
      WHERE source_id=?
        AND (
          lower(relative_path) LIKE '$recycle.bin/%'
          OR lower(relative_path) LIKE '%/$recycle.bin/%'
          OR lower(relative_path) LIKE 'system volume information/%'
          OR lower(relative_path) LIKE '%/system volume information/%'
        )
    `).run(sourceId);

    const started = db.prepare("INSERT INTO scans(source_id) VALUES(?)").run(sourceId);
    scanId = Number(started.lastInsertRowid);

    const token = randomUUID();
    const { byPath, byHash, byIdentity } = loadIndex(sourceId);
    const directoryIndex = loadDirectoryIndex(sourceId);
    const seenIds = new Set<number>();
    const seenDirectoryIds = new Set<number>();
    const readErrorPaths: string[] = [];

    const touch = db.prepare(`
      UPDATE media_items
      SET
        absolute_path=?,
        device_id=?,
        inode=?,
        availability='AVAILABLE',
        in_recycle_bin=0,
        recycle_path=NULL,
        recycle_detected_at=NULL,
        scan_token=?,
        last_seen_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);

    const statOnly = db.prepare(`
      UPDATE media_items
      SET
        absolute_path=?,
        size_bytes=?,
        mtime_ms=?,
        device_id=?,
        inode=?,
        availability='AVAILABLE',
        in_recycle_bin=0,
        recycle_path=NULL,
        recycle_detected_at=NULL,
        scan_token=?,
        last_seen_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);

    const updateContent = db.prepare(`
      UPDATE media_items
      SET
        absolute_path=?,
        extension=?,
        size_bytes=?,
        mtime_ms=?,
        sha256=?,
        device_id=?,
        inode=?,
        availability='AVAILABLE',
        in_recycle_bin=0,
        recycle_path=NULL,
        recycle_detected_at=NULL,
        scan_token=?,
        last_seen_at=CURRENT_TIMESTAMP,
        last_changed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);

    const moveExisting = db.prepare(`
      UPDATE media_items
      SET
        relative_path=?,
        absolute_path=?,
        extension=?,
        size_bytes=?,
        mtime_ms=?,
        sha256=?,
        device_id=?,
        inode=?,
        availability='AVAILABLE',
        in_recycle_bin=0,
        recycle_path=NULL,
        recycle_detected_at=NULL,
        scan_token=?,
        last_seen_at=CURRENT_TIMESTAMP,
        last_moved_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);

    const insertMedia = db.prepare(`
      INSERT INTO media_items(
        source_id,
        relative_path,
        absolute_path,
        extension,
        size_bytes,
        mtime_ms,
        sha256,
        device_id,
        inode,
        availability,
        in_recycle_bin,
        scan_token
      )
      VALUES(?,?,?,?,?,?,?,?,?,'AVAILABLE',0,?)
    `);

    for await (const file of walkMedia(root, {
      onError: (readError) => {
        errors += 1;
        readErrorPaths.push(readError.path);
      },
      onDirectory: async (directory) => {
        moved += reconcileDirectory(
          sourceId,
          root,
          directory,
          token,
          directoryIndex,
          seenDirectoryIds,
          byPath
        );
      }
    })) {
      discovered += 1;

      try {
        const previous = byPath.get(file.relativePath);

        if (previous) {
          seenIds.add(previous.id);

          if (
            previous.sizeBytes === file.sizeBytes &&
            previous.mtimeMs === file.mtimeMs &&
            (
              !identityKey(previous.deviceId, previous.inode) ||
              sameIdentity(previous.deviceId, previous.inode, file.deviceId, file.inode)
            )
          ) {
            touch.run(
              file.absolutePath,
              file.deviceId,
              file.inode,
              token,
              previous.id
            );
            previous.absolutePath = file.absolutePath;
            previous.deviceId = file.deviceId;
            previous.inode = file.inode;
            unchanged += 1;
          } else {
            const hash = await sha256File(file.absolutePath);

            if (previous.sha256 === hash) {
              statOnly.run(
                file.absolutePath,
                file.sizeBytes,
                file.mtimeMs,
                file.deviceId,
                file.inode,
                token,
                previous.id
              );
              previous.absolutePath = file.absolutePath;
              previous.sizeBytes = file.sizeBytes;
              previous.mtimeMs = file.mtimeMs;
              previous.deviceId = file.deviceId;
              previous.inode = file.inode;
              unchanged += 1;
            } else {
              updateContent.run(
                file.absolutePath,
                file.extension,
                file.sizeBytes,
                file.mtimeMs,
                hash,
                file.deviceId,
                file.inode,
                token,
                previous.id
              );
              previous.absolutePath = file.absolutePath;
              previous.extension = file.extension;
              previous.sizeBytes = file.sizeBytes;
              previous.mtimeMs = file.mtimeMs;
              previous.sha256 = hash;
              previous.deviceId = file.deviceId;
              previous.inode = file.inode;
              changed += 1;
            }
          }
        } else {
          const identityCandidate = await uniqueIdentityMoveCandidate(
            file.deviceId,
            file.inode,
            byIdentity,
            seenIds
          );

          if (identityCandidate) {
            moveExisting.run(
              file.relativePath,
              file.absolutePath,
              file.extension,
              file.sizeBytes,
              file.mtimeMs,
              identityCandidate.sha256,
              file.deviceId,
              file.inode,
              token,
              identityCandidate.id
            );

            byPath.delete(identityCandidate.relativePath);
            identityCandidate.relativePath = file.relativePath;
            identityCandidate.absolutePath = file.absolutePath;
            identityCandidate.extension = file.extension;
            identityCandidate.sizeBytes = file.sizeBytes;
            identityCandidate.mtimeMs = file.mtimeMs;
            identityCandidate.deviceId = file.deviceId;
            identityCandidate.inode = file.inode;
            byPath.set(identityCandidate.relativePath, identityCandidate);

            seenIds.add(identityCandidate.id);
            moved += 1;
          } else {
            const hash = await sha256File(file.absolutePath);
            const moveCandidate = await uniqueMoveCandidate(
              hash,
              file.sizeBytes,
              byHash,
              seenIds
            );

            if (moveCandidate) {
              moveExisting.run(
                file.relativePath,
                file.absolutePath,
                file.extension,
                file.sizeBytes,
                file.mtimeMs,
                hash,
                file.deviceId,
                file.inode,
                token,
                moveCandidate.id
              );

              byPath.delete(moveCandidate.relativePath);
              moveCandidate.relativePath = file.relativePath;
              moveCandidate.absolutePath = file.absolutePath;
              moveCandidate.extension = file.extension;
              moveCandidate.sizeBytes = file.sizeBytes;
              moveCandidate.mtimeMs = file.mtimeMs;
              moveCandidate.deviceId = file.deviceId;
              moveCandidate.inode = file.inode;
              byPath.set(moveCandidate.relativePath, moveCandidate);

              seenIds.add(moveCandidate.id);
              moved += 1;
            } else {
              const inserted = insertMedia.run(
                sourceId,
                file.relativePath,
                file.absolutePath,
                file.extension,
                file.sizeBytes,
                file.mtimeMs,
                hash,
                file.deviceId,
                file.inode,
                token
              );

              const insertedMedia: IndexedMedia = {
                id: Number(inserted.lastInsertRowid),
                relativePath: file.relativePath,
                absolutePath: file.absolutePath,
                extension: file.extension,
                sizeBytes: file.sizeBytes,
                mtimeMs: file.mtimeMs,
                sha256: hash,
                deviceId: file.deviceId,
                inode: file.inode,
                availability: "AVAILABLE",
                inRecycleBin: false
              };
              byPath.set(insertedMedia.relativePath, insertedMedia);

              const hashItems = byHash.get(hash) ?? [];
              hashItems.push(insertedMedia);
              byHash.set(hash, hashItems);

              const key = identityKey(file.deviceId, file.inode);
              if (key) {
                const identityItems = byIdentity.get(key) ?? [];
                identityItems.push(insertedMedia);
                byIdentity.set(key, identityItems);
              }

              seenIds.add(insertedMedia.id);
              added += 1;
            }
          }
        }
      } catch {
        errors += 1;
        readErrorPaths.push(file.absolutePath);
      }

      if (discovered % 100 === 0) {
        progress(
          sourceId,
          discovered,
          `${discovered.toLocaleString("de-DE")} Medien gefunden …`
        );
      }
    }

    db.prepare(`
      UPDATE media_directories
      SET availability=0
      WHERE source_id=? AND scan_token<>? AND availability=1
    `).run(sourceId, token);

    const staleRows = db.prepare(`
      SELECT id, absolute_path
      FROM media_items
      WHERE source_id=?
        AND scan_token<>?
        AND availability='AVAILABLE'
    `).all(sourceId, token);

    const markMissing = db.prepare(`
      UPDATE media_items
      SET availability='MISSING'
      WHERE id=?
    `);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of staleRows) {
        const absolutePath = String(row.absolute_path);

        if (pathAffectedByReadError(absolutePath, readErrorPaths)) {
          continue;
        }

        markMissing.run(Number(row.id));
        missing += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    recycleBin = await refreshRecycleStatus(sourceId);

    const result: ScanResult = {
      discovered,
      added,
      moved,
      changed,
      unchanged,
      missing,
      recycleBin,
      errors
    };

    db.prepare(`
      UPDATE scans
      SET
        finished_at=CURRENT_TIMESTAMP,
        status='DONE',
        discovered_count=?,
        added_count=?,
        moved_count=?,
        changed_count=?,
        unchanged_count=?,
        missing_count=?,
        recycle_bin_count=?,
        error_count=?
      WHERE id=?
    `).run(
      discovered,
      added,
      moved,
      changed,
      unchanged,
      missing,
      recycleBin,
      errors,
      scanId
    );

    progress(
      sourceId,
      discovered,
      `Fertig: ${discovered.toLocaleString("de-DE")} Medien · ` +
      `${moved.toLocaleString("de-DE")} verschoben/umbenannt · ` +
      `${recycleBin.toLocaleString("de-DE")} im Papierkorb.`
    );

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (scanId !== null) {
      db.prepare(`
        UPDATE scans
        SET
          finished_at=CURRENT_TIMESTAMP,
          status='FAILED',
          discovered_count=?,
          added_count=?,
          moved_count=?,
          changed_count=?,
          unchanged_count=?,
          missing_count=?,
          recycle_bin_count=?,
          error_count=?,
          error_message=?
        WHERE id=?
      `).run(
        discovered,
        added,
        moved,
        changed,
        unchanged,
        missing,
        recycleBin,
        errors + 1,
        message,
        scanId
      );
    }

    throw error;
  } finally {
    scanRunning = false;
  }
}

async function restoreMedia(mediaId: number): Promise<RestoreResult> {
  const row = db.prepare(`
    SELECT id, absolute_path, availability, in_recycle_bin
    FROM media_items
    WHERE id=?
  `).get(mediaId);

  if (!row) throw new Error("Medium wurde im Katalog nicht gefunden.");

  if (String(row.availability) !== "MISSING" || !Boolean(row.in_recycle_bin)) {
    throw new Error("Dieses Medium ist nicht als wiederherstellbar im Papierkorb markiert.");
  }

  const originalPath = String(row.absolute_path);
  await restoreRecycleBinItem(originalPath);

  if (!(await isReadable(originalPath))) {
    throw new Error("Windows meldet die Wiederherstellung, aber die Datei ist noch nicht erreichbar.");
  }

  const info = await stat(originalPath);
  const hash = await sha256File(originalPath);

  db.prepare(`
    UPDATE media_items
    SET
      size_bytes=?,
      mtime_ms=?,
      sha256=?,
      availability='AVAILABLE',
      in_recycle_bin=0,
      recycle_path=NULL,
      recycle_detected_at=NULL,
      last_seen_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    info.size,
    Math.trunc(info.mtimeMs),
    hash,
    mediaId
  );

  return {
    restored: true,
    path: originalPath
  };
}

function resetCatalog(): { reset: true } {
  if (scanRunning) {
    throw new Error("Während eines laufenden Scans kann der Katalog nicht zurückgesetzt werden.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM analysis_jobs;
      DELETE FROM media_items;
      DELETE FROM media_directories;
      DELETE FROM scans;
      DELETE FROM media_sources;
      DELETE FROM sqlite_sequence
      WHERE name IN ('analysis_jobs', 'media_items', 'media_directories', 'scans', 'media_sources');
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { reset: true };
}

async function dispatch(method: CatalogMethod, payload: Record<string, unknown> = {}) {
  switch (method) {
    case "listSources":
      return listSources();
    case "addSource":
      return addSource(payload.path);
    case "getStats":
      return getStats(asNumber(payload.sourceId, "sourceId"));
    case "listMedia":
      return listMedia(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 500 : asNumber(payload.limit, "limit")
      );
    case "scanSource":
      return scanSource(asNumber(payload.sourceId, "sourceId"));
    case "restoreMedia":
      return restoreMedia(asNumber(payload.mediaId, "mediaId"));
    case "resetCatalog":
      return resetCatalog();
  }
}

parentPort.on("message", async (event) => {
  const request = event.data;
  if (!request || request.kind !== "request") return;

  try {
    const result = await dispatch(request.method, request.payload);
    post({ kind: "response", id: request.id, ok: true, result });
  } catch (error) {
    post({
      kind: "response",
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

process.on("exit", () => db.close());
