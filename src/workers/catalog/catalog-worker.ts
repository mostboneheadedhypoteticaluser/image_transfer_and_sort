import path from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { walkImages } from "../../catalog/file-scanner";
import { sha256File } from "../../catalog/hash";
import type {
  CatalogMethod,
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

function listSources() {
  return db.prepare("SELECT id, path, enabled FROM media_sources ORDER BY id")
    .all()
    .map((row) => ({
      id: Number(row.id),
      path: String(row.path),
      enabled: Boolean(row.enabled)
    }));
}

function addSource(sourcePath: unknown) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new Error("Quellpfad fehlt.");
  }
  const canonical = path.resolve(sourcePath.trim());
  db.prepare(`
    INSERT INTO media_sources(path, enabled) VALUES(?,1)
    ON CONFLICT(path) DO UPDATE SET enabled=1, updated_at=CURRENT_TIMESTAMP
  `).run(canonical);

  const row = db.prepare("SELECT id, path, enabled FROM media_sources WHERE path=?").get(canonical);
  if (!row) throw new Error("Quelle konnte nicht gespeichert werden.");
  return { id: Number(row.id), path: String(row.path), enabled: Boolean(row.enabled) };
}

function getStats(sourceId: number) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN availability='AVAILABLE' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN availability='MISSING' THEN 1 ELSE 0 END) AS missing
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
    lastScan: lastScan?.finished_at ? String(lastScan.finished_at) : null
  };
}

function listMedia(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(requestedLimit || 500)));
  return db.prepare(`
    SELECT id, relative_path, extension, size_bytes, availability, last_seen_at
    FROM media_items
    WHERE source_id=?
    ORDER BY relative_path COLLATE NOCASE
    LIMIT ?
  `).all(sourceId, limit).map((row) => ({
    id: Number(row.id),
    relativePath: String(row.relative_path),
    extension: String(row.extension),
    sizeBytes: Number(row.size_bytes),
    availability: String(row.availability),
    lastSeenAt: String(row.last_seen_at)
  }));
}

async function scanSource(sourceId: number): Promise<ScanResult> {
  if (scanRunning) throw new Error("Es läuft bereits ein Scan.");
  scanRunning = true;

  const source = db.prepare("SELECT path FROM media_sources WHERE id=? AND enabled=1").get(sourceId);
  if (!source) {
    scanRunning = false;
    throw new Error("Medienquelle wurde nicht gefunden oder ist deaktiviert.");
  }

  const root = String(source.path);
  try {
    await access(root, fsConstants.R_OK);
  } catch {
    scanRunning = false;
    throw new Error(`Medienquelle ist nicht erreichbar: ${root}`);
  }

  const started = db.prepare("INSERT INTO scans(source_id) VALUES(?)").run(sourceId);
  const scanId = Number(started.lastInsertRowid);
  const token = randomUUID();

  const indexRows = db.prepare(`
    SELECT id, relative_path, size_bytes, mtime_ms, sha256
    FROM media_items
    WHERE source_id=?
  `).all(sourceId);

  const index = new Map<string, {
    id: number;
    sizeBytes: number;
    mtimeMs: number;
    sha256: string;
  }>();

  for (const row of indexRows) {
    index.set(String(row.relative_path), {
      id: Number(row.id),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
      sha256: String(row.sha256)
    });
  }

  let discovered = 0;
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let errors = 0;

  const touch = db.prepare(`
    UPDATE media_items
    SET absolute_path=?, availability='AVAILABLE', scan_token=?, last_seen_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  const statOnly = db.prepare(`
    UPDATE media_items
    SET absolute_path=?, size_bytes=?, mtime_ms=?, availability='AVAILABLE',
        scan_token=?, last_seen_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  const upsert = db.prepare(`
    INSERT INTO media_items(
      source_id, relative_path, absolute_path, extension, size_bytes, mtime_ms, sha256, availability, scan_token
    ) VALUES(?,?,?,?,?,?,?,'AVAILABLE',?)
    ON CONFLICT(source_id, relative_path) DO UPDATE SET
      absolute_path=excluded.absolute_path,
      extension=excluded.extension,
      size_bytes=excluded.size_bytes,
      mtime_ms=excluded.mtime_ms,
      sha256=excluded.sha256,
      availability='AVAILABLE',
      scan_token=excluded.scan_token,
      last_seen_at=CURRENT_TIMESTAMP,
      last_changed_at=CURRENT_TIMESTAMP
  `);

  try {
    for await (const file of walkImages(root)) {
      discovered += 1;

      try {
        const previous = index.get(file.relativePath);

        if (
          previous &&
          previous.sizeBytes === file.sizeBytes &&
          previous.mtimeMs === file.mtimeMs
        ) {
          touch.run(file.absolutePath, token, previous.id);
          unchanged += 1;
        } else {
          const hash = await sha256File(file.absolutePath);

          if (previous && previous.sha256 === hash) {
            statOnly.run(file.absolutePath, file.sizeBytes, file.mtimeMs, token, previous.id);
            unchanged += 1;
          } else {
            upsert.run(
              sourceId,
              file.relativePath,
              file.absolutePath,
              file.extension,
              file.sizeBytes,
              file.mtimeMs,
              hash,
              token
            );

            if (previous) changed += 1;
            else added += 1;
          }
        }
      } catch {
        errors += 1;
      }

      if (discovered % 100 === 0) {
        progress(sourceId, discovered, `${discovered.toLocaleString("de-DE")} Bilder gefunden …`);
      }
    }

    const missingRows = db.prepare(`
      SELECT id
      FROM media_items
      WHERE source_id=? AND scan_token<>? AND availability='AVAILABLE'
    `).all(sourceId, token);

    db.prepare(`
      UPDATE media_items
      SET availability='MISSING'
      WHERE source_id=? AND scan_token<>? AND availability='AVAILABLE'
    `).run(sourceId, token);

    const missing = missingRows.length;
    const result: ScanResult = { discovered, added, changed, unchanged, missing, errors };

    db.prepare(`
      UPDATE scans
      SET finished_at=CURRENT_TIMESTAMP, status='DONE', discovered_count=?, added_count=?,
          changed_count=?, unchanged_count=?, missing_count=?, error_count=?
      WHERE id=?
    `).run(discovered, added, changed, unchanged, missing, errors, scanId);

    progress(sourceId, discovered, `Fertig: ${discovered.toLocaleString("de-DE")} Bilder gefunden.`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE scans
      SET finished_at=CURRENT_TIMESTAMP, status='FAILED', discovered_count=?,
          added_count=?, changed_count=?, unchanged_count=?, error_count=?, error_message=?
      WHERE id=?
    `).run(discovered, added, changed, unchanged, errors + 1, message, scanId);
    throw error;
  } finally {
    scanRunning = false;
  }
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
