import path from "node:path";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { walkImages } from "../../catalog/file-scanner";
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
  availability: "AVAILABLE" | "MISSING";
  inRecycleBin: boolean;
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

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_media_recycle
    ON media_items(source_id, in_recycle_bin);

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

function loadIndex(sourceId: number): {
  byPath: Map<string, IndexedMedia>;
  byHash: Map<string, IndexedMedia[]>;
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
      availability,
      in_recycle_bin
    FROM media_items
    WHERE source_id=?
  `).all(sourceId);

  const byPath = new Map<string, IndexedMedia>();
  const byHash = new Map<string, IndexedMedia[]>();

  for (const row of rows) {
    const media: IndexedMedia = {
      id: Number(row.id),
      relativePath: String(row.relative_path),
      absolutePath: String(row.absolute_path),
      extension: String(row.extension),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
      sha256: String(row.sha256),
      availability: String(row.availability) as "AVAILABLE" | "MISSING",
      inRecycleBin: Boolean(row.in_recycle_bin)
    };

    byPath.set(media.relativePath, media);

    const hashItems = byHash.get(media.sha256) ?? [];
    hashItems.push(media);
    byHash.set(media.sha256, hashItems);
  }

  return { byPath, byHash };
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
    const { byPath, byHash } = loadIndex(sourceId);
    const seenIds = new Set<number>();
    const readErrorPaths: string[] = [];

    const touch = db.prepare(`
      UPDATE media_items
      SET
        absolute_path=?,
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
        availability,
        in_recycle_bin,
        scan_token
      )
      VALUES(?,?,?,?,?,?,?,'AVAILABLE',0,?)
    `);

    for await (const file of walkImages(root, (readError) => {
      errors += 1;
      readErrorPaths.push(readError.path);
    })) {
      discovered += 1;

      try {
        const previous = byPath.get(file.relativePath);

        if (previous) {
          seenIds.add(previous.id);

          if (
            previous.sizeBytes === file.sizeBytes &&
            previous.mtimeMs === file.mtimeMs
          ) {
            touch.run(file.absolutePath, token, previous.id);
            unchanged += 1;
          } else {
            const hash = await sha256File(file.absolutePath);

            if (previous.sha256 === hash) {
              statOnly.run(
                file.absolutePath,
                file.sizeBytes,
                file.mtimeMs,
                token,
                previous.id
              );
              unchanged += 1;
            } else {
              updateContent.run(
                file.absolutePath,
                file.extension,
                file.sizeBytes,
                file.mtimeMs,
                hash,
                token,
                previous.id
              );
              changed += 1;
            }
          }
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
              token,
              moveCandidate.id
            );
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
              token
            );
            seenIds.add(Number(inserted.lastInsertRowid));
            added += 1;
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
          `${discovered.toLocaleString("de-DE")} Bilder gefunden …`
        );
      }
    }

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
      `Fertig: ${discovered.toLocaleString("de-DE")} Bilder · ` +
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

  if (!row) throw new Error("Bild wurde im Katalog nicht gefunden.");

  if (String(row.availability) !== "MISSING" || !Boolean(row.in_recycle_bin)) {
    throw new Error("Dieses Bild ist nicht als wiederherstellbar im Papierkorb markiert.");
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
