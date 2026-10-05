import path from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { walkMedia, type DiscoveredDirectory } from "../../catalog/file-scanner";
import { IMAGE_EXTENSIONS } from "../../catalog/constants";
import { sha256File } from "../../catalog/hash";
import {
  findRenamedSibling,
  isReadable,
  readPathIdentity,
  type PathIdentity
} from "../../catalog/source-identity";
import {
  listRecycleBinItems,
  restoreRecycleBinItem,
  type RecycleBinItem
} from "./recycle-bin";
import type {
  CatalogMethod,
  RestoreResult,
  SearchFacets,
  SearchFilter,
  SemanticTextEmbedding,
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

  CREATE TABLE IF NOT EXISTS media_thumbnails (
    media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
    input_sha256 TEXT NOT NULL,
    path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    format TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_thumbnail_hash
    ON media_thumbnails(input_sha256);

  CREATE TABLE IF NOT EXISTS media_image_metadata (
    media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
    input_sha256 TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    format TEXT,
    color_mode TEXT,
    orientation INTEGER,
    captured_at TEXT,
    camera_make TEXT,
    camera_model TEXT,
    lens_model TEXT,
    gps_latitude REAL,
    gps_longitude REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS face_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    detector_version TEXT NOT NULL,
    detection_index INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    score REAL NOT NULL,
    landmarks_json TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(media_id, detector_version, detection_index)
  );

  CREATE INDEX IF NOT EXISTS idx_face_media
    ON face_detections(media_id);

  CREATE TABLE IF NOT EXISTS face_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    face_detection_id INTEGER NOT NULL REFERENCES face_detections(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(face_detection_id, model_version)
  );

  CREATE INDEX IF NOT EXISTS idx_face_embedding_media
    ON face_embeddings(media_id);

  CREATE TABLE IF NOT EXISTS semantic_embeddings (
    media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    max_num_patches INTEGER NOT NULL,
    precision TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_semantic_embedding_hash
    ON semantic_embeddings(input_sha256);
  CREATE INDEX IF NOT EXISTS idx_semantic_embedding_model
    ON semantic_embeddings(model_version);

  CREATE TABLE IF NOT EXISTS media_semantic_annotations (
    media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    subjects_json TEXT NOT NULL DEFAULT '[]',
    actions_json TEXT NOT NULL DEFAULT '[]',
    scenes_json TEXT NOT NULL DEFAULT '[]',
    visible_text_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    concepts_json TEXT NOT NULL DEFAULT '[]',
    repaired INTEGER NOT NULL DEFAULT 0 CHECK(repaired IN (0,1)),
    region_count INTEGER NOT NULL DEFAULT 0,
    regions_json TEXT NOT NULL DEFAULT '[]',
    timings_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_media_semantic_annotation_hash
    ON media_semantic_annotations(input_sha256);
  CREATE INDEX IF NOT EXISTS idx_media_semantic_annotation_model
    ON media_semantic_annotations(model_version);

  CREATE TABLE IF NOT EXISTS pet_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    detector_version TEXT NOT NULL,
    detection_index INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL,
    pet_class TEXT NOT NULL CHECK(pet_class IN ('dog','cat')),
    class_id INTEGER NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    score REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(media_id, detector_version, detection_index)
  );

  CREATE INDEX IF NOT EXISTS idx_pet_detection_media
    ON pet_detections(media_id);
  CREATE INDEX IF NOT EXISTS idx_pet_detection_class
    ON pet_detections(pet_class);

  CREATE TABLE IF NOT EXISTS object_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    detector_version TEXT NOT NULL,
    detection_index INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL,
    class_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    score REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(media_id, detector_version, detection_index)
  );

  CREATE INDEX IF NOT EXISTS idx_object_detection_media
    ON object_detections(media_id);
  CREATE INDEX IF NOT EXISTS idx_object_detection_label
    ON object_detections(label);

  CREATE TABLE IF NOT EXISTS object_fused_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    fusion_version TEXT NOT NULL,
    detection_index INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL,
    class_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    score REAL NOT NULL,
    agreement_count INTEGER NOT NULL DEFAULT 1,
    sources_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(media_id, fusion_version, detection_index)
  );

  CREATE INDEX IF NOT EXISTS idx_object_fused_media
    ON object_fused_detections(media_id);
  CREATE INDEX IF NOT EXISTS idx_object_fused_label
    ON object_fused_detections(label);

  CREATE TABLE IF NOT EXISTS pet_fused_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    fusion_version TEXT NOT NULL,
    detection_index INTEGER NOT NULL,
    input_sha256 TEXT NOT NULL,
    pet_class TEXT NOT NULL CHECK(pet_class IN ('dog','cat')),
    class_id INTEGER NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    score REAL NOT NULL,
    agreement_count INTEGER NOT NULL DEFAULT 1,
    sources_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(media_id, fusion_version, detection_index)
  );

  CREATE INDEX IF NOT EXISTS idx_pet_fused_media
    ON pet_fused_detections(media_id);
  CREATE INDEX IF NOT EXISTS idx_pet_fused_class
    ON pet_fused_detections(pet_class);

  CREATE TABLE IF NOT EXISTS pet_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pet_detection_id INTEGER NOT NULL REFERENCES pet_fused_detections(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pet_detection_id, model_version)
  );

  CREATE INDEX IF NOT EXISTS idx_pet_embedding_media
    ON pet_embeddings(media_id);

  CREATE TABLE IF NOT EXISTS pets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pet_class TEXT NOT NULL CHECK(pet_class IN ('dog','cat')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pet_assignments (
    pet_detection_id INTEGER PRIMARY KEY REFERENCES pet_fused_detections(id) ON DELETE CASCADE,
    pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
    assignment_source TEXT NOT NULL DEFAULT 'CONFIRMED',
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_pet_assignment_pet
    ON pet_assignments(pet_id);

  CREATE TABLE IF NOT EXISTS pet_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
    pet_class TEXT NOT NULL CHECK(pet_class IN ('dog','cat')),
    algorithm_version TEXT NOT NULL,
    representative_pet_id INTEGER REFERENCES pet_fused_detections(id) ON DELETE SET NULL,
    average_similarity REAL NOT NULL,
    min_similarity REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_pet_candidate_source
    ON pet_candidates(source_id);

  CREATE TABLE IF NOT EXISTS pet_candidate_items (
    candidate_id INTEGER NOT NULL REFERENCES pet_candidates(id) ON DELETE CASCADE,
    pet_detection_id INTEGER NOT NULL REFERENCES pet_fused_detections(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    PRIMARY KEY(candidate_id, pet_detection_id)
  );

  CREATE TABLE IF NOT EXISTS pet_cluster_runs (
    source_id INTEGER PRIMARY KEY REFERENCES media_sources(id) ON DELETE CASCADE,
    embedding_revision TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pet_cluster_exclusions (
    pet_a_id INTEGER NOT NULL REFERENCES pet_fused_detections(id) ON DELETE CASCADE,
    pet_b_id INTEGER NOT NULL REFERENCES pet_fused_detections(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT 'USER_SPLIT',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(pet_a_id, pet_b_id),
    CHECK(pet_a_id < pet_b_id)
  );

  CREATE INDEX IF NOT EXISTS idx_pet_cluster_exclusion_b
    ON pet_cluster_exclusions(pet_b_id);

  CREATE TABLE IF NOT EXISTS pet_assignment_exclusions (
    pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
    pet_detection_id INTEGER NOT NULL REFERENCES pet_fused_detections(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT 'USER_REMOVED',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(pet_id, pet_detection_id)
  );

  CREATE TABLE IF NOT EXISTS persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS person_face_assignments (
    face_detection_id INTEGER PRIMARY KEY REFERENCES face_detections(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    assignment_source TEXT NOT NULL DEFAULT 'CONFIRMED',
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_person_assignment_person
    ON person_face_assignments(person_id);

  CREATE TABLE IF NOT EXISTS person_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
    algorithm_version TEXT NOT NULL,
    representative_face_id INTEGER REFERENCES face_detections(id) ON DELETE SET NULL,
    average_similarity REAL NOT NULL,
    min_similarity REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_person_candidate_source
    ON person_candidates(source_id);

  CREATE TABLE IF NOT EXISTS person_candidate_faces (
    candidate_id INTEGER NOT NULL REFERENCES person_candidates(id) ON DELETE CASCADE,
    face_detection_id INTEGER NOT NULL REFERENCES face_detections(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    PRIMARY KEY(candidate_id, face_detection_id)
  );

  CREATE TABLE IF NOT EXISTS person_cluster_runs (
    source_id INTEGER PRIMARY KEY REFERENCES media_sources(id) ON DELETE CASCADE,
    embedding_revision TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS person_cluster_exclusions (
    face_a_id INTEGER NOT NULL REFERENCES face_detections(id) ON DELETE CASCADE,
    face_b_id INTEGER NOT NULL REFERENCES face_detections(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT 'USER_SPLIT',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(face_a_id, face_b_id),
    CHECK(face_a_id < face_b_id)
  );

  CREATE INDEX IF NOT EXISTS idx_person_cluster_exclusion_b
    ON person_cluster_exclusions(face_b_id);

  CREATE TABLE IF NOT EXISTS person_face_exclusions (
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    face_detection_id INTEGER NOT NULL REFERENCES face_detections(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT 'USER_REMOVED',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(person_id, face_detection_id)
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
ensureColumn("media_items", "recycle_ambiguous", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("media_items", "recycle_original_path", "TEXT");
ensureColumn("analysis_jobs", "input_sha256", "TEXT");
ensureColumn("analysis_jobs", "result_json", "TEXT");
ensureColumn("analysis_jobs", "error_message", "TEXT");
ensureColumn("analysis_jobs", "started_at", "TEXT");
ensureColumn("analysis_jobs", "finished_at", "TEXT");

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

  UPDATE analysis_jobs
  SET status='PENDING', started_at=NULL, updated_at=CURRENT_TIMESTAMP
  WHERE status='RUNNING';
`);

function normalizeHistoricalUnavailableJobs(): void {
  const rows = db.prepare(`
    SELECT DISTINCT j.media_id, m.absolute_path
    FROM analysis_jobs j
    JOIN media_items m ON m.id=j.media_id
    WHERE j.status='FAILED'
      AND lower(COALESCE(j.error_message,'')) LIKE 'datei ist nicht erreichbar:%'
  `).all();

  if (rows.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const markMissing = db.prepare(`
      UPDATE media_items
      SET availability='MISSING'
      WHERE id=?
    `);

    const markUnavailable = db.prepare(`
      UPDATE analysis_jobs
      SET
        status='UNAVAILABLE',
        error_message=?,
        finished_at=COALESCE(finished_at, CURRENT_TIMESTAMP),
        updated_at=CURRENT_TIMESTAMP
      WHERE media_id=?
        AND status<>'DONE'
    `);

    for (const row of rows) {
      const mediaId = Number(row.media_id);
      const absolutePath = String(row.absolute_path);
      if (existsSync(absolutePath)) continue;

      markMissing.run(mediaId);
      markUnavailable.run(
        `Datei aktuell nicht erreichbar: ${absolutePath}`,
        mediaId
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

normalizeHistoricalUnavailableJobs();

db.prepare(`
  UPDATE analysis_jobs
  SET
    status='PENDING',
    attempts=0,
    result_json=NULL,
    error_message=NULL,
    started_at=NULL,
    finished_at=NULL,
    updated_at=CURRENT_TIMESTAMP
  WHERE module IN ('pet-detect-nanodet-v1', 'pet-detect-yolox-v1')
    AND status='DONE'
    AND (
      result_json IS NULL
      OR result_json NOT LIKE '%"objectDetectorVersion":"motif-raw-v2"%'
    )
`).run();

// Nur wirklich veraltete Haustier-Fusionsjobs neu rechnen. Eine ältere
// Migration prüfte hier fälschlich auf "objectFusionVersion". Dieses Feld wird
// seit der Trennung von Haustier- und allgemeiner Motiverkennung nicht mehr in
// result_json gespeichert und setzte dadurch bei JEDEM App-Start alle
// Haustier-Fusionsjobs erneut auf PENDING. completePetFusionJob() setzte danach
// wiederum Dog-ReID zurück – daher liefen die individuellen Hundemerkmale
// unnötig bei jedem Start erneut.
db.prepare(`
  UPDATE analysis_jobs
  SET
    status='PENDING',
    attempts=0,
    result_json=NULL,
    error_message=NULL,
    started_at=NULL,
    finished_at=NULL,
    updated_at=CURRENT_TIMESTAMP
  WHERE module='pet-fuse-ensemble-v1'
    AND status='DONE'
    AND (
      result_json IS NULL
      OR result_json NOT LIKE '%"fusion":"NanoDet+YOLOX-S weighted-box-v1"%'
    )
`).run();

// Ein früherer SigLIP2-Adapter hat BaseModelOutputWithPooling fälschlich wie
// einen Tensor behandelt. Nur genau diese bekannte, inzwischen behobene
// Fehlersignatur wird unabhängig vom ausgeschöpften Versuchszähler erneut
// eingeplant. Andere echte Fehler bleiben weiterhin nach 3 Versuchen stehen.
db.prepare(`
  UPDATE analysis_jobs
  SET
    status='PENDING',
    attempts=0,
    result_json=NULL,
    error_message=NULL,
    started_at=NULL,
    finished_at=NULL,
    updated_at=CURRENT_TIMESTAMP
  WHERE module='semantic-embed-siglip2-v1'
    AND status='FAILED'
    AND error_message LIKE '%BaseModelOutputWithPooling%object has no attribute%detach%'
`).run();

// Die frühere Qwen-8B-Serienstufe ist vollständig durch die neue
// Qwen3-VL-4B-Katalogsemantik ersetzt. Alte Jobzustände werden entfernt;
// vorhandene Bild-/Suchdaten bleiben davon unberührt.
db.prepare(`
  DELETE FROM analysis_jobs
  WHERE module='object-detect-qwen3vl-gguf-v2'
`).run();

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
      SUM(CASE WHEN availability='MISSING' AND (in_recycle_bin=1 OR recycle_ambiguous=1) THEN 1 ELSE 0 END) AS recycle_bin
    FROM media_items
    WHERE source_id=?
  `).get(sourceId);

  const duplicateStats = db.prepare(`
    SELECT
      COUNT(*) AS duplicate_groups,
      COALESCE(SUM(group_count), 0) AS duplicate_files
    FROM (
      SELECT COUNT(*) AS group_count
      FROM media_items
      WHERE source_id=?
        AND availability='AVAILABLE'
      GROUP BY sha256, size_bytes
      HAVING COUNT(*) > 1
    )
  `).get(sourceId);

  const personStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM person_candidates WHERE source_id=?) AS candidate_count,
      (
        SELECT COUNT(DISTINCT pfa.person_id)
        FROM person_face_assignments pfa
        JOIN face_detections fd ON fd.id=pfa.face_detection_id
        JOIN media_items m ON m.id=fd.media_id
        WHERE m.source_id=?
      ) AS person_count
  `).get(sourceId, sourceId);

  const petIdentityStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM pet_candidates WHERE source_id=?) AS candidate_count,
      (
        SELECT COUNT(DISTINCT pa.pet_id)
        FROM pet_assignments pa
        JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        WHERE m.source_id=?
      ) AS pet_count
  `).get(sourceId, sourceId);

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
    duplicateGroups: Number(duplicateStats?.duplicate_groups ?? 0),
    duplicateFiles: Number(duplicateStats?.duplicate_files ?? 0),
    personCandidates: Number(personStats?.candidate_count ?? 0),
    persons: Number(personStats?.person_count ?? 0),
    petCandidates: Number(petIdentityStats?.candidate_count ?? 0),
    pets: Number(petIdentityStats?.pet_count ?? 0),
    lastScan: lastScan?.finished_at ? String(lastScan.finished_at) : null
  };
}

function normalizeSearchFilter(raw: SearchFilter | undefined): SearchFilter | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const uniquePositiveIds = (values: unknown): number[] => {
    if (!Array.isArray(values)) return [];
    return [...new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )];
  };

  const objectLabels = Array.isArray(raw.objectLabels)
    ? [...new Set(
        raw.objectLabels
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      )]
    : [];

  const semanticQuery =
    typeof raw.semanticQuery === "string"
      ? raw.semanticQuery.trim()
      : "";
  const semanticMinProbability = Math.max(
    0,
    Math.min(0.999, Number(raw.semanticMinProbability) || 0)
  );

  return {
    personIds: uniquePositiveIds(raw.personIds),
    petIds: uniquePositiveIds(raw.petIds),
    objectLabels,
    minDogs: Math.max(0, Math.min(20, Math.trunc(Number(raw.minDogs) || 0))),
    minCats: Math.max(0, Math.min(20, Math.trunc(Number(raw.minCats) || 0))),
    semanticQuery,
    semanticMinProbability
  };
}

const SEMANTIC_SEARCH_STOP_WORDS = new Set([
  "am", "an", "auf", "aus", "bei", "beim", "das", "dem", "den", "der", "die",
  "ein", "eine", "einem", "einen", "einer", "im", "in", "ist", "mit", "oder",
  "und", "vom", "von", "vor", "zu", "zum", "zur"
]);

function normalizeSemanticSearchText(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase("de-DE")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function semanticSearchTokens(query: string): string[] {
  return [...new Set(
    normalizeSemanticSearchText(query)
      .split(/\s+/)
      .filter(
        (token) =>
          token.length >= 2 &&
          !SEMANTIC_SEARCH_STOP_WORDS.has(token)
      )
  )];
}

function semanticSearchTokenMatches(queryToken: string, candidate: string): boolean {
  if (queryToken === candidate) return true;
  if (queryToken.length >= 4 && candidate.startsWith(queryToken)) return true;
  if (candidate.length >= 4 && queryToken.startsWith(candidate)) return true;
  return false;
}

function parseSemanticStringList(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function catalogSemanticMatch(
  query: string,
  annotation: {
    description: string;
    subjects: string[];
    actions: string[];
    scenes: string[];
    visibleText: string[];
    tags: string[];
    concepts: string[];
  }
): { score: number; reasons: string[] } {
  const queryTokens = semanticSearchTokens(query);
  if (queryTokens.length === 0) return { score: 0, reasons: [] };

  const fields: Array<{
    label: string;
    values: string[];
    weight: number;
  }> = [
    { label: "Konzept", values: annotation.concepts, weight: 1.00 },
    { label: "Motiv", values: annotation.subjects, weight: 0.90 },
    { label: "Handlung", values: annotation.actions, weight: 0.90 },
    { label: "Suchbegriff", values: annotation.tags, weight: 0.82 },
    { label: "Szene", values: annotation.scenes, weight: 0.65 },
    {
      label: "Beschreibung",
      values: annotation.description ? [annotation.description] : [],
      weight: 0.60
    },
    { label: "Bildtext", values: annotation.visibleText, weight: 0.55 }
  ];

  let scoreSum = 0;
  let conceptHit = false;
  let subjectHit = false;
  const reasons: Array<{ weight: number; text: string }> = [];

  for (const queryToken of queryTokens) {
    let bestWeight = 0;
    let bestReason = "";

    for (const field of fields) {
      for (const value of field.values) {
        const words = normalizeSemanticSearchText(value).split(/\s+/).filter(Boolean);
        if (!words.some((word) => semanticSearchTokenMatches(queryToken, word))) {
          continue;
        }

        if (field.weight > bestWeight) {
          bestWeight = field.weight;
          bestReason = field.label + ": " + value;
        }
      }
    }

    if (bestWeight > 0) {
      scoreSum += bestWeight;
      if (bestReason.startsWith("Konzept:")) conceptHit = true;
      if (bestReason.startsWith("Motiv:")) subjectHit = true;
      reasons.push({ weight: bestWeight, text: bestReason });
    }
  }

  let score = scoreSum / queryTokens.length;
  if (conceptHit) score += 0.05;
  if (subjectHit) score += 0.03;

  const normalizedQuery = normalizeSemanticSearchText(query);
  if (normalizedQuery.length >= 5) {
    const phraseFields = [
      ...annotation.concepts,
      ...annotation.actions,
      ...annotation.tags,
      annotation.description
    ];
    if (
      phraseFields.some((value) =>
        normalizeSemanticSearchText(value).includes(normalizedQuery)
      )
    ) {
      score += 0.07;
    }
  }

  const uniqueReasons = [...new Map(
    reasons
      .sort((left, right) => right.weight - left.weight)
      .map((item) => [item.text.toLocaleLowerCase("de-DE"), item.text])
  ).values()].slice(0, 5);

  return {
    score: Math.max(0, Math.min(1, score)),
    reasons: uniqueReasons
  };
}

function listMedia(
  sourceId: number,
  requestedLimit: number,
  rawSearch?: SearchFilter,
  semantic?: SemanticTextEmbedding | null
) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(requestedLimit || 500)));
  const search = normalizeSearchFilter(rawSearch);
  const searchClauses: string[] = [];
  const searchArgs: Array<number | string> = [];

  if (search) {
    searchClauses.push("m.availability='AVAILABLE'");

    for (const personId of search.personIds) {
      searchClauses.push(`EXISTS (
        SELECT 1
        FROM person_face_assignments pfa_search
        JOIN face_detections fd_search
          ON fd_search.id=pfa_search.face_detection_id
        WHERE pfa_search.person_id=?
          AND fd_search.media_id=m.id
          AND fd_search.input_sha256=m.sha256
      )`);
      searchArgs.push(personId);
    }

    for (const petId of search.petIds) {
      searchClauses.push(`EXISTS (
        SELECT 1
        FROM pet_assignments pa_search
        JOIN pet_fused_detections pd_search
          ON pd_search.id=pa_search.pet_detection_id
        WHERE pa_search.pet_id=?
          AND pd_search.media_id=m.id
          AND pd_search.input_sha256=m.sha256
      )`);
      searchArgs.push(petId);
    }

    for (const label of search.objectLabels) {
      searchClauses.push(`EXISTS (
        SELECT 1
        FROM object_fused_detections od_search
        WHERE od_search.media_id=m.id
          AND od_search.input_sha256=m.sha256
          AND od_search.label=?
      )`);
      searchArgs.push(label);
    }

    if (search.minDogs > 0) {
      searchClauses.push(`(
        SELECT COUNT(*)
        FROM pet_fused_detections dog_search
        WHERE dog_search.media_id=m.id
          AND dog_search.input_sha256=m.sha256
          AND dog_search.pet_class='dog'
      )>=?`);
      searchArgs.push(search.minDogs);
    }

    if (search.minCats > 0) {
      searchClauses.push(`(
        SELECT COUNT(*)
        FROM pet_fused_detections cat_search
        WHERE cat_search.media_id=m.id
          AND cat_search.input_sha256=m.sha256
          AND cat_search.pet_class='cat'
      )>=?`);
      searchArgs.push(search.minCats);
    }
  }

  const semanticActive = Boolean(search?.semanticQuery);
  const siglipActive = Boolean(
    semanticActive &&
    semantic &&
    Array.isArray(semantic.vector) &&
    semantic.vector.length > 0 &&
    semantic.dimension === semantic.vector.length &&
    Number.isFinite(semantic.logitScale) &&
    Number.isFinite(semantic.logitBias)
  );

  const searchSql =
    searchClauses.length > 0
      ? "\n      AND " + searchClauses.join("\n      AND ")
      : "";
  const limitSql = semanticActive ? "" : "\n    LIMIT ?";

  const rows = db.prepare(`
    SELECT
      m.id,
      m.relative_path,
      m.extension,
      m.size_bytes,
      m.availability,
      m.in_recycle_bin,
      m.recycle_ambiguous,
      m.last_seen_at,
      CASE WHEN t.media_id IS NOT NULL AND t.input_sha256=m.sha256 THEN 1 ELSE 0 END AS thumbnail_ready,
      CASE WHEN t.media_id IS NOT NULL AND t.input_sha256=m.sha256 THEN t.input_sha256 ELSE NULL END AS thumbnail_version,
      CASE WHEN md.input_sha256=m.sha256 THEN md.captured_at ELSE NULL END AS captured_at,
      (
        SELECT COUNT(*)
        FROM face_detections fd
        WHERE fd.media_id=m.id
          AND fd.input_sha256=m.sha256
      ) AS face_count,
      (
        SELECT COUNT(*)
        FROM face_embeddings fe
        WHERE fe.media_id=m.id
          AND fe.input_sha256=m.sha256
      ) AS face_embedding_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
      ) AS pet_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.pet_class='dog'
      ) AS dog_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.pet_class='cat'
      ) AS cat_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.agreement_count>=2
      ) AS pet_multi_model_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.agreement_count=1
      ) AS pet_single_model_count,
      (
        SELECT COUNT(DISTINCT od.label)
        FROM object_fused_detections od
        WHERE od.media_id=m.id
          AND od.input_sha256=m.sha256
      ) AS object_count,
      (
        SELECT GROUP_CONCAT(DISTINCT od.label)
        FROM object_fused_detections od
        WHERE od.media_id=m.id
          AND od.input_sha256=m.sha256
      ) AS object_labels,
      CASE
        WHEN se.media_id IS NOT NULL AND se.input_sha256=m.sha256 THEN 1
        ELSE 0
      END AS semantic_ready,
      CASE
        WHEN se.media_id IS NOT NULL AND se.input_sha256=m.sha256
        THEN se.model_version
        ELSE NULL
      END AS semantic_model,
      CASE
        WHEN se.media_id IS NOT NULL AND se.input_sha256=m.sha256
        THEN se.dimension
        ELSE NULL
      END AS semantic_dimension,
      CASE
        WHEN se.media_id IS NOT NULL AND se.input_sha256=m.sha256
        THEN se.vector_blob
        ELSE NULL
      END AS semantic_vector,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256 THEN 1
        ELSE 0
      END AS catalog_semantic_ready,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.model_version
        ELSE NULL
      END AS catalog_semantic_model,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.description
        ELSE NULL
      END AS catalog_description,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.subjects_json
        ELSE '[]'
      END AS catalog_subjects_json,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.actions_json
        ELSE '[]'
      END AS catalog_actions_json,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.scenes_json
        ELSE '[]'
      END AS catalog_scenes_json,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.visible_text_json
        ELSE '[]'
      END AS catalog_visible_text_json,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.tags_json
        ELSE '[]'
      END AS catalog_tags_json,
      CASE
        WHEN msa.media_id IS NOT NULL AND msa.input_sha256=m.sha256
        THEN msa.concepts_json
        ELSE '[]'
      END AS catalog_concepts_json,
      CASE
        WHEN m.availability='AVAILABLE' THEN (
          SELECT COUNT(*) - 1
          FROM media_items d
          WHERE d.availability='AVAILABLE'
            AND d.source_id=m.source_id
            AND d.sha256=m.sha256
            AND d.size_bytes=m.size_bytes
        )
        ELSE 0
      END AS duplicate_count
    FROM media_items m
    LEFT JOIN media_thumbnails t ON t.media_id=m.id
    LEFT JOIN media_image_metadata md ON md.media_id=m.id
    LEFT JOIN semantic_embeddings se ON se.media_id=m.id
    LEFT JOIN media_semantic_annotations msa ON msa.media_id=m.id
    WHERE m.source_id=?${searchSql}
    ORDER BY
      CASE
        WHEN m.availability='MISSING' AND m.in_recycle_bin=1 THEN 1
        WHEN m.availability='MISSING' AND m.recycle_ambiguous=1 THEN 2
        WHEN m.availability='MISSING' THEN 3
        ELSE 0
      END,
      m.relative_path COLLATE NOCASE
    ${limitSql}
  `).all(
    sourceId,
    ...searchArgs,
    ...(semanticActive ? [] : [limit])
  );

  const mapped = rows.map((row) => {
    let semanticScore: number | null = null;

    if (siglipActive && semantic) {
      const dimension = Number(row.semantic_dimension);

      if (
        dimension === semantic.vector.length &&
        row.semantic_vector &&
        String(row.semantic_model ?? "") === semantic.model
      ) {
        const imageVector = vectorFromBlob(row.semantic_vector, dimension);
        let dot = 0;
        for (let index = 0; index < dimension; index += 1) {
          dot += imageVector[index] * semantic.vector[index];
        }

        const logit = dot * semantic.logitScale + semantic.logitBias;
        const score =
          logit >= 0
            ? 1 / (1 + Math.exp(-logit))
            : Math.exp(logit) / (1 + Math.exp(logit));

        if (Number.isFinite(score)) semanticScore = score;
      }
    }

    const catalogSemanticReady = Boolean(row.catalog_semantic_ready);
    const catalogDescription = catalogSemanticReady && row.catalog_description
      ? String(row.catalog_description)
      : "";
    const semanticConcepts = catalogSemanticReady
      ? parseSemanticStringList(row.catalog_concepts_json)
      : [];

    const catalogMatch =
      semanticActive && catalogSemanticReady && search
        ? catalogSemanticMatch(search.semanticQuery, {
            description: catalogDescription,
            subjects: parseSemanticStringList(row.catalog_subjects_json),
            actions: parseSemanticStringList(row.catalog_actions_json),
            scenes: parseSemanticStringList(row.catalog_scenes_json),
            visibleText: parseSemanticStringList(row.catalog_visible_text_json),
            tags: parseSemanticStringList(row.catalog_tags_json),
            concepts: semanticConcepts
          })
        : { score: 0, reasons: [] };

    const catalogSemanticScore =
      semanticActive && catalogSemanticReady
        ? catalogMatch.score
        : null;

    const combinedSemanticScore = semanticActive
      ? semanticScore !== null && catalogSemanticScore !== null
        ? Math.min(
            1,
            Math.max(semanticScore, catalogSemanticScore) +
              0.15 * Math.min(semanticScore, catalogSemanticScore)
          )
        : semanticScore ?? catalogSemanticScore
      : null;

    if (
      semanticActive &&
      (
        combinedSemanticScore === null ||
        combinedSemanticScore < (search?.semanticMinProbability ?? 0)
      )
    ) {
      return null;
    }

    return {
    id: Number(row.id),
    relativePath: String(row.relative_path),
    extension: String(row.extension),
    sizeBytes: Number(row.size_bytes),
    availability: String(row.availability),
    inRecycleBin: Boolean(row.in_recycle_bin),
    recycleState: Boolean(row.in_recycle_bin)
      ? "RESTORABLE"
      : Boolean(row.recycle_ambiguous)
        ? "AMBIGUOUS"
        : "NONE",
    duplicateCount: Math.max(0, Number(row.duplicate_count ?? 0)),
    thumbnailReady: Boolean(row.thumbnail_ready),
    thumbnailVersion: row.thumbnail_version ? String(row.thumbnail_version) : null,
    capturedAt: row.captured_at ? String(row.captured_at) : null,
    faceCount: Number(row.face_count ?? 0),
    faceEmbeddingCount: Number(row.face_embedding_count ?? 0),
    petCount: Number(row.pet_count ?? 0),
    dogCount: Number(row.dog_count ?? 0),
    catCount: Number(row.cat_count ?? 0),
    petMultiModelCount: Number(row.pet_multi_model_count ?? 0),
    petSingleModelCount: Number(row.pet_single_model_count ?? 0),
    objectCount: Number(row.object_count ?? 0),
    objectLabels: row.object_labels
      ? String(row.object_labels).split(",").filter(Boolean)
      : [],
    semanticReady: Boolean(row.semantic_ready),
    semanticModel: row.semantic_model ? String(row.semantic_model) : null,
    semanticScore,
    catalogSemanticReady,
    catalogSemanticModel: row.catalog_semantic_model
      ? String(row.catalog_semantic_model)
      : null,
    catalogSemanticScore,
    combinedSemanticScore,
    semanticMatchReasons: catalogMatch.reasons,
    semanticDescription: catalogDescription || null,
    semanticConcepts,
    lastSeenAt: String(row.last_seen_at)
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);

  if (semanticActive) {
    mapped.sort((left, right) =>
      (right.combinedSemanticScore ?? -1) - (left.combinedSemanticScore ?? -1) ||
      (right.catalogSemanticScore ?? -1) - (left.catalogSemanticScore ?? -1) ||
      (right.semanticScore ?? -1) - (left.semanticScore ?? -1) ||
      left.relativePath.localeCompare(right.relativePath, "de")
    );
  }

  return mapped.slice(0, limit);
}

function getSearchFacets(sourceId: number): SearchFacets {
  const persons = db.prepare(`
    SELECT
      p.id,
      p.name,
      COUNT(DISTINCT fd.media_id) AS media_count
    FROM persons p
    JOIN person_face_assignments pfa ON pfa.person_id=p.id
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
    GROUP BY p.id, p.name
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(sourceId).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    mediaCount: Number(row.media_count ?? 0)
  }));

  const pets = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.pet_class,
      COUNT(DISTINCT pd.media_id) AS media_count
    FROM pets p
    JOIN pet_assignments pa ON pa.pet_id=p.id
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
    GROUP BY p.id, p.name, p.pet_class
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(sourceId).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    petClass: String(row.pet_class) === "cat" ? "cat" as const : "dog" as const,
    mediaCount: Number(row.media_count ?? 0)
  }));

  const objects = db.prepare(`
    SELECT
      od.label,
      COUNT(DISTINCT od.media_id) AS media_count
    FROM object_fused_detections od
    JOIN media_items m ON m.id=od.media_id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND od.input_sha256=m.sha256
      AND od.label NOT IN ('dog','cat')
    GROUP BY od.label
    ORDER BY media_count DESC, od.label COLLATE NOCASE
  `).all(sourceId).map((row) => ({
    label: String(row.label),
    mediaCount: Number(row.media_count ?? 0)
  }));

  return { persons, pets, objects };
}

function listRecycleMedia(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(requestedLimit || 500)));

  return db.prepare(`
    SELECT
      m.id,
      m.relative_path,
      m.extension,
      m.size_bytes,
      m.availability,
      m.in_recycle_bin,
      m.recycle_ambiguous,
      m.last_seen_at,
      CASE WHEN t.media_id IS NOT NULL AND t.input_sha256=m.sha256 THEN 1 ELSE 0 END AS thumbnail_ready,
      CASE WHEN t.media_id IS NOT NULL AND t.input_sha256=m.sha256 THEN t.input_sha256 ELSE NULL END AS thumbnail_version,
      CASE WHEN md.input_sha256=m.sha256 THEN md.captured_at ELSE NULL END AS captured_at,
      (
        SELECT COUNT(*)
        FROM face_detections fd
        WHERE fd.media_id=m.id
          AND fd.input_sha256=m.sha256
      ) AS face_count,
      (
        SELECT COUNT(*)
        FROM face_embeddings fe
        WHERE fe.media_id=m.id
          AND fe.input_sha256=m.sha256
      ) AS face_embedding_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
      ) AS pet_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.pet_class='dog'
      ) AS dog_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.pet_class='cat'
      ) AS cat_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.agreement_count>=2
      ) AS pet_multi_model_count,
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        WHERE pd.media_id=m.id
          AND pd.input_sha256=m.sha256
          AND pd.agreement_count=1
      ) AS pet_single_model_count,
      (
        SELECT COUNT(DISTINCT od.label)
        FROM object_fused_detections od
        WHERE od.media_id=m.id
          AND od.input_sha256=m.sha256
      ) AS object_count,
      (
        SELECT GROUP_CONCAT(DISTINCT od.label)
        FROM object_fused_detections od
        WHERE od.media_id=m.id
          AND od.input_sha256=m.sha256
      ) AS object_labels
    FROM media_items m
    LEFT JOIN media_thumbnails t ON t.media_id=m.id
    LEFT JOIN media_image_metadata md ON md.media_id=m.id
    WHERE m.source_id=?
      AND m.availability='MISSING'
      AND (m.in_recycle_bin=1 OR m.recycle_ambiguous=1)
    ORDER BY
      CASE WHEN m.in_recycle_bin=1 THEN 0 ELSE 1 END,
      m.relative_path COLLATE NOCASE
    LIMIT ?
  `).all(sourceId, limit).map((row) => ({
    id: Number(row.id),
    relativePath: String(row.relative_path),
    extension: String(row.extension),
    sizeBytes: Number(row.size_bytes),
    availability: "MISSING" as const,
    inRecycleBin: Boolean(row.in_recycle_bin),
    recycleState: Boolean(row.in_recycle_bin)
      ? "RESTORABLE" as const
      : "AMBIGUOUS" as const,
    duplicateCount: 0,
    thumbnailReady: Boolean(row.thumbnail_ready),
    thumbnailVersion: row.thumbnail_version ? String(row.thumbnail_version) : null,
    capturedAt: row.captured_at ? String(row.captured_at) : null,
    faceCount: Number(row.face_count ?? 0),
    faceEmbeddingCount: Number(row.face_embedding_count ?? 0),
    petCount: Number(row.pet_count ?? 0),
    dogCount: Number(row.dog_count ?? 0),
    catCount: Number(row.cat_count ?? 0),
    petMultiModelCount: Number(row.pet_multi_model_count ?? 0),
    petSingleModelCount: Number(row.pet_single_model_count ?? 0),
    objectCount: Number(row.object_count ?? 0),
    objectLabels: row.object_labels
      ? String(row.object_labels).split(",").filter(Boolean)
      : [],
    semanticReady: false,
    semanticModel: null,
    semanticScore: null,
    lastSeenAt: String(row.last_seen_at)
  }));
}

function listDuplicateGroups(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(500, Math.trunc(requestedLimit || 100)));

  const groups = db.prepare(`
    SELECT sha256, size_bytes, COUNT(*) AS group_count
    FROM media_items
    WHERE source_id=?
      AND availability='AVAILABLE'
    GROUP BY sha256, size_bytes
    HAVING COUNT(*) > 1
    ORDER BY (COUNT(*) - 1) * size_bytes DESC, group_count DESC
    LIMIT ?
  `).all(sourceId, limit);

  const itemQuery = db.prepare(`
    SELECT id, relative_path, extension, size_bytes
    FROM media_items
    WHERE source_id=?
      AND availability='AVAILABLE'
      AND sha256=?
      AND size_bytes=?
    ORDER BY relative_path COLLATE NOCASE
  `);

  return groups.map((group) => {
    const sha256 = String(group.sha256);
    const sizeBytes = Number(group.size_bytes);
    const items = itemQuery.all(sourceId, sha256, sizeBytes).map((row) => ({
      id: Number(row.id),
      relativePath: String(row.relative_path),
      extension: String(row.extension),
      sizeBytes: Number(row.size_bytes)
    }));

    return {
      sha256,
      sizeBytes,
      count: items.length,
      wastedBytes: Math.max(0, items.length - 1) * sizeBytes,
      items
    };
  });
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
  deviceId: string,
  inode: string,
  byHash: Map<string, IndexedMedia[]>,
  seenIds: Set<number>
): Promise<IndexedMedia | null> {
  const candidates = (byHash.get(hash) ?? []).filter((candidate) => {
    if (
      candidate.sizeBytes !== sizeBytes ||
      candidate.inRecycleBin ||
      seenIds.has(candidate.id)
    ) {
      return false;
    }

    const candidateIdentity = identityKey(candidate.deviceId, candidate.inode);
    const discoveredIdentity = identityKey(deviceId, inode);

    // Auf demselben Dateisystem beweist eine andere File-ID, dass es eine
    // andere Datei ist (z. B. eine echte Kopie/Dublette) und keine Verschiebung.
    if (
      candidateIdentity &&
      discoveredIdentity &&
      candidate.deviceId === deviceId &&
      candidate.inode !== inode
    ) {
      return false;
    }

    return true;
  });

  const missingAtOldLocation: IndexedMedia[] = [];

  for (const candidate of candidates) {
    if (!(await isReadable(candidate.absolutePath))) {
      missingAtOldLocation.push(candidate);
    }
  }

  return missingAtOldLocation.length === 1 ? missingAtOldLocation[0] : null;
}

function normalizeRecyclePath(value: string): string {
  const normalized = value.replaceAll("/", "\\");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function fileNameForPath(value: string): string {
  return path.basename(value).toLowerCase();
}

async function refreshRecycleStatus(sourceId: number): Promise<number> {
  db.prepare(`
    UPDATE media_items
    SET
      in_recycle_bin=0,
      recycle_ambiguous=0,
      recycle_path=NULL,
      recycle_original_path=NULL,
      recycle_detected_at=NULL
    WHERE source_id=? AND availability='AVAILABLE'
  `).run(sourceId);

  if (process.platform !== "win32") {
    db.prepare(`
      UPDATE media_items
      SET
        in_recycle_bin=0,
        recycle_ambiguous=0,
        recycle_path=NULL,
        recycle_original_path=NULL,
        recycle_detected_at=NULL
      WHERE source_id=? AND availability='MISSING'
    `).run(sourceId);
    return 0;
  }

  let recycleItems: RecycleBinItem[];
  try {
    recycleItems = await listRecycleBinItems();
  } catch {
    return Number(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM media_items
        WHERE source_id=?
          AND availability='MISSING'
          AND (in_recycle_bin=1 OR recycle_ambiguous=1)
      `).get(sourceId)?.count ?? 0
    );
  }

  const missingRows = db.prepare(`
    SELECT id, absolute_path, size_bytes, sha256
    FROM media_items
    WHERE source_id=? AND availability='MISSING'
  `).all(sourceId);

  const byOriginalPath = new Map<string, RecycleBinItem[]>();
  for (const item of recycleItems) {
    const key = normalizeRecyclePath(item.originalPath);
    const values = byOriginalPath.get(key) ?? [];
    values.push(item);
    byOriginalPath.set(key, values);
  }

  const hashCache = new Map<string, string | null>();

  async function recycleHash(item: RecycleBinItem): Promise<string | null> {
    if (!item.recyclePath) return null;
    const key = normalizeRecyclePath(item.recyclePath);
    if (hashCache.has(key)) return hashCache.get(key) ?? null;

    try {
      if (!(await isReadable(item.recyclePath))) {
        hashCache.set(key, null);
        return null;
      }
      const hash = await sha256File(item.recyclePath);
      hashCache.set(key, hash);
      return hash;
    } catch {
      hashCache.set(key, null);
      return null;
    }
  }

  const setRecycle = db.prepare(`
    UPDATE media_items
    SET
      in_recycle_bin=1,
      recycle_ambiguous=0,
      recycle_path=?,
      recycle_original_path=?,
      recycle_detected_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  const setAmbiguous = db.prepare(`
    UPDATE media_items
    SET
      in_recycle_bin=0,
      recycle_ambiguous=1,
      recycle_path=NULL,
      recycle_original_path=NULL,
      recycle_detected_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  const clearRecycle = db.prepare(`
    UPDATE media_items
    SET
      in_recycle_bin=0,
      recycle_ambiguous=0,
      recycle_path=NULL,
      recycle_original_path=NULL,
      recycle_detected_at=NULL
    WHERE id=?
  `);

  let count = 0;

  for (const row of missingRows) {
    const mediaId = Number(row.id);
    const absolutePath = String(row.absolute_path);
    const expectedSize = Number(row.size_bytes);
    const expectedHash = String(row.sha256 ?? "");
    const exactCandidates = byOriginalPath.get(normalizeRecyclePath(absolutePath)) ?? [];

    let selected: RecycleBinItem | null = null;
    let ambiguous = false;
    let candidates = exactCandidates;

    if (candidates.length > 0) {
      const sameSize = candidates.filter(
        (candidate) => candidate.sizeBytes === null || candidate.sizeBytes === expectedSize
      );
      if (sameSize.length === 1) {
        selected = sameSize[0];
      } else if (sameSize.length > 1) {
        const targetName = fileNameForPath(absolutePath);
        const sameName = sameSize.filter(
          (candidate) => fileNameForPath(candidate.originalPath) === targetName
        );
        if (sameName.length === 1) {
          selected = sameName[0];
        } else {
          candidates = sameName.length > 0 ? sameName : sameSize;
          const hashMatches: RecycleBinItem[] = [];
          for (const candidate of candidates) {
            if ((await recycleHash(candidate)) === expectedHash) {
              hashMatches.push(candidate);
            }
          }
          if (hashMatches.length === 1) selected = hashMatches[0];
          else if (hashMatches.length > 1 || candidates.length > 1) ambiguous = true;
        }
      } else if (candidates.length === 1) {
        selected = candidates[0];
      }
    } else {
      const sizeCandidates = recycleItems.filter(
        (candidate) => candidate.sizeBytes !== null && candidate.sizeBytes === expectedSize
      );
      const hashMatches: RecycleBinItem[] = [];

      for (const candidate of sizeCandidates) {
        if ((await recycleHash(candidate)) === expectedHash) {
          hashMatches.push(candidate);
        }
      }

      if (hashMatches.length === 1) {
        selected = hashMatches[0];
      } else if (hashMatches.length > 1) {
        const targetName = fileNameForPath(absolutePath);
        const sameName = hashMatches.filter(
          (candidate) => fileNameForPath(candidate.originalPath) === targetName
        );
        if (sameName.length === 1) selected = sameName[0];
        else ambiguous = true;
      }
    }

    if (selected) {
      setRecycle.run(
        selected.recyclePath,
        selected.originalPath,
        mediaId
      );
      count += 1;
    } else if (ambiguous) {
      setAmbiguous.run(mediaId);
      count += 1;
    } else {
      clearRecycle.run(mediaId);
    }
  }

  return count;
}

function reactivateAvailableMediaJobs(sourceId: number): void {
  const rows = db.prepare(`
    SELECT j.id
    FROM analysis_jobs j
    JOIN media_items m ON m.id=j.media_id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND j.status='UNAVAILABLE'
  `).all(sourceId);

  const reset = db.prepare(`
    UPDATE analysis_jobs
    SET
      status='PENDING',
      attempts=0,
      error_message=NULL,
      started_at=NULL,
      finished_at=NULL,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);

  for (const row of rows) {
    reset.run(Number(row.id));
  }
}

function enqueueAnalysisJobs(sourceId: number, module = "file-probe-v1") {
  const imageExtensions = [...IMAGE_EXTENSIONS];
  const imageOnlyModules = new Set([
    "thumbnail-v1",
    "image-metadata-v1",
    "face-detect-yunet-v1",
    "face-embed-sface-v1",
    "pet-detect-nanodet-v1",
    "pet-detect-yolox-v1",
    "pet-fuse-ensemble-v1",
    "pet-embed-dogreid-v1",
    "catalog-semantic-qwen3vl4b-v3",
    "semantic-embed-siglip2-v1"
  ]);
  const imageFilter =
    imageOnlyModules.has(module)
      ? ` AND m.extension IN (${imageExtensions.map(() => "?").join(",")})`
      : "";

  const statement = db.prepare(`
    INSERT INTO analysis_jobs(
      media_id,
      module,
      status,
      priority,
      attempts,
      payload_json,
      input_sha256,
      result_json,
      error_message,
      started_at,
      finished_at,
      created_at,
      updated_at
    )
    SELECT
      m.id,
      ?,
      'PENDING',
      100,
      0,
      NULL,
      m.sha256,
      NULL,
      NULL,
      NULL,
      NULL,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM media_items m
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      ${imageFilter}
    ON CONFLICT(media_id, module) DO UPDATE SET
      status='PENDING',
      attempts=CASE
        WHEN analysis_jobs.input_sha256 IS NULL
          OR analysis_jobs.input_sha256<>excluded.input_sha256
        THEN 0
        ELSE analysis_jobs.attempts
      END,
      payload_json=NULL,
      input_sha256=excluded.input_sha256,
      result_json=NULL,
      error_message=NULL,
      started_at=NULL,
      finished_at=NULL,
      updated_at=CURRENT_TIMESTAMP
    WHERE analysis_jobs.input_sha256 IS NULL
       OR analysis_jobs.input_sha256<>excluded.input_sha256
       OR (analysis_jobs.status='FAILED' AND analysis_jobs.attempts<3)
  `);

  const args: (string | number)[] = [module, sourceId];
  if (imageOnlyModules.has(module)) args.push(...imageExtensions);

  const result = statement.run(...args);

  const stats = getAnalysisQueueStats(sourceId, module);
  return {
    queuedOrUpdated: Number(result.changes),
    ...stats
  };
}

function getAnalysisQueueStats(sourceId?: number, module = "file-probe-v1") {
  const filter = sourceId === undefined
    ? "j.module=?"
    : "j.module=? AND m.source_id=?";

  const args = sourceId === undefined ? [module] : [module, sourceId];

  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN j.status='PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN j.status='RUNNING' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN j.status='DONE' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN j.status='FAILED' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN j.status='UNAVAILABLE' THEN 1 ELSE 0 END) AS unavailable
    FROM analysis_jobs j
    JOIN media_items m ON m.id=j.media_id
    WHERE ${filter}
  `).get(...args);

  return {
    pending: Number(row?.pending ?? 0),
    running: Number(row?.running ?? 0),
    done: Number(row?.done ?? 0),
    failed: Number(row?.failed ?? 0),
    unavailable: Number(row?.unavailable ?? 0)
  };
}


function listAnalysisErrors(sourceId?: number, requestedLimit = 200) {
  const limit = Math.max(1, Math.min(1000, Math.trunc(requestedLimit || 200)));
  const sourceFilter = sourceId === undefined ? "" : "AND m.source_id=?";
  const args: number[] = sourceId === undefined ? [] : [sourceId];

  return db.prepare(`
    SELECT
      j.id,
      j.status,
      j.media_id,
      j.module,
      j.attempts,
      j.error_message,
      j.started_at,
      j.finished_at,
      m.relative_path,
      m.extension
    FROM analysis_jobs j
    JOIN media_items m ON m.id=j.media_id
    WHERE (
        j.status='FAILED'
        OR (
          j.status='UNAVAILABLE'
          AND j.id=(
            SELECT MIN(j2.id)
            FROM analysis_jobs j2
            WHERE j2.media_id=j.media_id
              AND j2.status='UNAVAILABLE'
          )
        )
      )
      ${sourceFilter}
    ORDER BY
      COALESCE(j.finished_at, j.updated_at) DESC,
      j.id DESC
    LIMIT ?
  `).all(...args, limit).map((row) => ({
    id: Number(row.id),
    status: String(row.status) === "UNAVAILABLE" ? "UNAVAILABLE" : "FAILED",
    mediaId: Number(row.media_id),
    module: String(row.module),
    relativePath: String(row.relative_path),
    extension: String(row.extension),
    attempts: Number(row.attempts ?? 0),
    errorMessage: String(row.error_message ?? "Unbekannter Analysefehler"),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at)
  }));
}

function resetAnalysisJob(jobId: number): number {
  const job = db.prepare(`
    SELECT
      j.id,
      j.media_id,
      j.module,
      j.status,
      m.sha256,
      m.absolute_path
    FROM analysis_jobs j
    JOIN media_items m ON m.id=j.media_id
    WHERE j.id=?
      AND j.status IN ('FAILED','UNAVAILABLE')
  `).get(jobId);

  if (!job) return 0;

  if (String(job.status) === "UNAVAILABLE") {
    const absolutePath = String(job.absolute_path);
    if (!existsSync(absolutePath)) return 0;

    const mediaId = Number(job.media_id);

    db.prepare(`
      UPDATE media_items
      SET availability='AVAILABLE', last_seen_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(mediaId);

    const result = db.prepare(`
      UPDATE analysis_jobs
      SET
        status='PENDING',
        attempts=0,
        input_sha256=?,
        result_json=NULL,
        error_message=NULL,
        started_at=NULL,
        finished_at=NULL,
        updated_at=CURRENT_TIMESTAMP
      WHERE media_id=?
        AND status='UNAVAILABLE'
    `).run(String(job.sha256), mediaId);

    return Number(result.changes);
  }

  const mediaId = Number(job.media_id);
  const module = String(job.module);
  const sha256 = String(job.sha256);

  const modules = new Set<string>([module]);

  if (module === "face-detect-yunet-v1") {
    modules.add("face-embed-sface-v1");
  }

  if (
    module === "pet-detect-nanodet-v1" ||
    module === "pet-detect-yolox-v1"
  ) {
    modules.add("pet-fuse-ensemble-v1");
    modules.add("pet-embed-dogreid-v1");
  } else if (module === "pet-fuse-ensemble-v1") {
    modules.add("pet-embed-dogreid-v1");
  }

  const reset = db.prepare(`
    UPDATE analysis_jobs
    SET
      status='PENDING',
      attempts=0,
      input_sha256=?,
      result_json=NULL,
      error_message=NULL,
      started_at=NULL,
      finished_at=NULL,
      updated_at=CURRENT_TIMESTAMP
    WHERE media_id=?
      AND module=?
      AND status<>'RUNNING'
  `);

  let changes = 0;
  for (const targetModule of modules) {
    changes += Number(reset.run(sha256, mediaId, targetModule).changes);
  }

  return changes;
}

function retryAnalysisJob(jobId: number) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const retried = resetAnalysisJob(jobId);
    db.exec("COMMIT");
    return { retried };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function retryFailedAnalysisJobs(sourceId?: number) {
  const sourceFilter = sourceId === undefined ? "" : "AND m.source_id=?";
  const args: number[] = sourceId === undefined ? [] : [sourceId];

  const ids = db.prepare(`
    SELECT j.id
    FROM analysis_jobs j
    JOIN media_items m ON m.id=j.media_id
    WHERE j.status IN ('FAILED','UNAVAILABLE')
      ${sourceFilter}
    ORDER BY j.id
  `).all(...args).map((row) => Number(row.id));

  db.exec("BEGIN IMMEDIATE");
  try {
    let retried = 0;
    for (const id of ids) retried += resetAnalysisJob(id);
    db.exec("COMMIT");
    return { retried };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function claimAnalysisJob(module = "file-probe-v1") {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT
        j.id,
        j.media_id,
        j.module,
        m.absolute_path,
        m.extension,
        m.size_bytes,
        m.sha256
      FROM analysis_jobs j
      JOIN media_items m ON m.id=j.media_id
      WHERE j.module=?
        AND j.status='PENDING'
        AND m.availability='AVAILABLE'
        AND (
          j.module<>'face-embed-sface-v1'
          OR EXISTS (
            SELECT 1
            FROM analysis_jobs dependency
            WHERE dependency.media_id=j.media_id
              AND dependency.module='face-detect-yunet-v1'
              AND dependency.status='DONE'
              AND dependency.input_sha256=j.input_sha256
          )
        )
        AND (
          j.module<>'pet-fuse-ensemble-v1'
          OR (
            EXISTS (
              SELECT 1
              FROM analysis_jobs dependency
              WHERE dependency.media_id=j.media_id
                AND dependency.module='pet-detect-nanodet-v1'
                AND dependency.status='DONE'
                AND dependency.input_sha256=j.input_sha256
            )
            AND EXISTS (
              SELECT 1
              FROM analysis_jobs dependency
              WHERE dependency.media_id=j.media_id
                AND dependency.module='pet-detect-yolox-v1'
                AND dependency.status='DONE'
                AND dependency.input_sha256=j.input_sha256
            )
          )
        )
        AND (
          j.module<>'pet-embed-dogreid-v1'
          OR EXISTS (
            SELECT 1
            FROM analysis_jobs dependency
            WHERE dependency.media_id=j.media_id
              AND dependency.module='pet-fuse-ensemble-v1'
              AND dependency.status='DONE'
              AND dependency.input_sha256=j.input_sha256
          )
        )
        AND (
          j.module<>'catalog-semantic-qwen3vl4b-v3'
          OR (
            EXISTS (
              SELECT 1
              FROM analysis_jobs dependency
              WHERE dependency.media_id=j.media_id
                AND dependency.module='pet-detect-nanodet-v1'
                AND dependency.status='DONE'
                AND dependency.input_sha256=j.input_sha256
            )
            AND EXISTS (
              SELECT 1
              FROM analysis_jobs dependency
              WHERE dependency.media_id=j.media_id
                AND dependency.module='pet-detect-yolox-v1'
                AND dependency.status='DONE'
                AND dependency.input_sha256=j.input_sha256
            )
            AND EXISTS (
              SELECT 1
              FROM analysis_jobs dependency
              WHERE dependency.media_id=j.media_id
                AND dependency.module='semantic-embed-siglip2-v1'
                AND dependency.status='DONE'
                AND dependency.input_sha256=j.input_sha256
            )
          )
        )
      ORDER BY j.priority ASC, j.id ASC
      LIMIT 1
    `).get(module);

    if (!row) {
      db.exec("COMMIT");
      return null;
    }

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='RUNNING',
        attempts=attempts+1,
        started_at=CURRENT_TIMESTAMP,
        error_message=NULL,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(Number(row.id));

    db.exec("COMMIT");

    return {
      id: Number(row.id),
      mediaId: Number(row.media_id),
      module: String(row.module),
      absolutePath: String(row.absolute_path),
      extension: String(row.extension),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256)
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function completeAnalysisJob(jobId: number, result: unknown) {
  const encoded = JSON.stringify(result ?? null);

  db.prepare(`
    UPDATE analysis_jobs
    SET
      status='DONE',
      result_json=?,
      error_message=NULL,
      finished_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
      AND status='RUNNING'
  `).run(encoded, jobId);

  return { completed: true };
}

function failAnalysisJob(jobId: number, errorMessage: string) {
  const job = db.prepare(`
    SELECT j.media_id, j.module, m.absolute_path
    FROM analysis_jobs j
    JOIN media_items m ON m.id=j.media_id
    WHERE j.id=?
  `).get(jobId);

  const normalizedError = errorMessage.toLowerCase();
  const unavailable =
    normalizedError.includes("nicht erreichbar:") ||
    normalizedError.includes("no such file or directory") ||
    normalizedError.includes("enoent") ||
    normalizedError.includes("input file is missing");

  db.exec("BEGIN IMMEDIATE");
  try {
    if (job && unavailable) {
      const mediaId = Number(job.media_id);
      const absolutePath = String(job.absolute_path);

      db.prepare(`
        UPDATE media_items
        SET availability='MISSING'
        WHERE id=?
      `).run(mediaId);

      db.prepare(`
        UPDATE analysis_jobs
        SET
          status='UNAVAILABLE',
          error_message=?,
          finished_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
        WHERE media_id=?
          AND status<>'DONE'
      `).run(
        `Datei aktuell nicht erreichbar: ${absolutePath}`,
        mediaId
      );

      db.exec("COMMIT");
      return { failed: false, unavailable: true };
    }

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='FAILED',
        error_message=?,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(errorMessage.slice(0, 4000), jobId);

    if (job && String(job.module) === "face-detect-yunet-v1") {
      db.prepare(`
        UPDATE analysis_jobs
        SET
          status='FAILED',
          error_message='Abhängige Gesichtsdetektion ist fehlgeschlagen.',
          finished_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
        WHERE media_id=?
          AND module='face-embed-sface-v1'
          AND status<>'DONE'
      `).run(Number(job.media_id));
    }

    if (
      job &&
      (
        String(job.module) === "pet-detect-nanodet-v1" ||
        String(job.module) === "pet-detect-yolox-v1"
      )
    ) {
      db.prepare(`
        UPDATE analysis_jobs
        SET
          status='FAILED',
          error_message='Mindestens ein abhängiger Haustierdetektor ist fehlgeschlagen.',
          finished_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
        WHERE media_id=?
          AND module='pet-fuse-ensemble-v1'
          AND status<>'DONE'
      `).run(Number(job.media_id));

      db.prepare(`
        UPDATE analysis_jobs
        SET
          status='FAILED',
          error_message='Abhängige Haustierfusion ist fehlgeschlagen.',
          finished_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
        WHERE media_id=?
          AND module='pet-embed-dogreid-v1'
          AND status<>'DONE'
      `).run(Number(job.media_id));
    }

    if (job && String(job.module) === "pet-fuse-ensemble-v1") {
      db.prepare(`
        UPDATE analysis_jobs
        SET
          status='FAILED',
          error_message='Abhängige Haustierfusion ist fehlgeschlagen.',
          finished_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
        WHERE media_id=?
          AND module='pet-embed-dogreid-v1'
          AND status<>'DONE'
      `).run(Number(job.media_id));
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { failed: true };
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
              file.deviceId,
              file.inode,
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
    reactivateAvailableMediaJobs(sourceId);
    enqueueAnalysisJobs(sourceId, "file-probe-v1");
    enqueueAnalysisJobs(sourceId, "thumbnail-v1");
    enqueueAnalysisJobs(sourceId, "image-metadata-v1");
    enqueueAnalysisJobs(sourceId, "face-detect-yunet-v1");
    enqueueAnalysisJobs(sourceId, "face-embed-sface-v1");
    enqueueAnalysisJobs(sourceId, "pet-detect-nanodet-v1");
    enqueueAnalysisJobs(sourceId, "pet-detect-yolox-v1");
    enqueueAnalysisJobs(sourceId, "pet-fuse-ensemble-v1");
    enqueueAnalysisJobs(sourceId, "pet-embed-dogreid-v1");
    enqueueAnalysisJobs(sourceId, "semantic-embed-siglip2-v1");
    enqueueAnalysisJobs(sourceId, "catalog-semantic-qwen3vl4b-v3");

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

function jobForModule(jobId: number, module: string) {
  const job = db.prepare(`
    SELECT id, media_id, input_sha256, status
    FROM analysis_jobs
    WHERE id=? AND module=?
  `).get(jobId, module);

  if (!job) throw new Error(`Analysejob ${module} wurde nicht gefunden.`);
  if (String(job.status) !== "RUNNING") {
    throw new Error(`Analysejob ${module} ist nicht im Status RUNNING.`);
  }

  return job;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function completeImageMetadataJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Metadaten-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const width = Number(value.width);
  const height = Number(value.height);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Metadaten-Ergebnis enthält keine gültigen Bildabmessungen.");
  }

  const job = jobForModule(jobId, "image-metadata-v1");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO media_image_metadata(
        media_id,
        input_sha256,
        width,
        height,
        format,
        color_mode,
        orientation,
        captured_at,
        camera_make,
        camera_model,
        lens_model,
        gps_latitude,
        gps_longitude,
        updated_at
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(media_id) DO UPDATE SET
        input_sha256=excluded.input_sha256,
        width=excluded.width,
        height=excluded.height,
        format=excluded.format,
        color_mode=excluded.color_mode,
        orientation=excluded.orientation,
        captured_at=excluded.captured_at,
        camera_make=excluded.camera_make,
        camera_model=excluded.camera_model,
        lens_model=excluded.lens_model,
        gps_latitude=excluded.gps_latitude,
        gps_longitude=excluded.gps_longitude,
        updated_at=CURRENT_TIMESTAMP
    `).run(
      Number(job.media_id),
      String(job.input_sha256 ?? ""),
      Math.trunc(width),
      Math.trunc(height),
      typeof value.format === "string" ? value.format : null,
      typeof value.mode === "string" ? value.mode : null,
      nullableNumber(value.orientation) === null
        ? null
        : Math.trunc(nullableNumber(value.orientation)!),
      typeof value.capturedAt === "string" ? value.capturedAt : null,
      typeof value.cameraMake === "string" ? value.cameraMake : null,
      typeof value.cameraModel === "string" ? value.cameraModel : null,
      typeof value.lensModel === "string" ? value.lensModel : null,
      nullableNumber(value.gpsLatitude),
      nullableNumber(value.gpsLongitude)
    );

    db.prepare(`
      UPDATE analysis_jobs
      SET status='DONE', result_json=?, error_message=NULL,
          finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(JSON.stringify(result), jobId);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { completed: true };
}

function completeFaceDetectionJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Gesichtsdetektions-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const rawFaces = Array.isArray(value.faces) ? value.faces : [];
  const detectorVersion =
    typeof value.detector === "string" && value.detector.trim()
      ? value.detector.trim()
      : "YuNet 2023mar";

  const job = jobForModule(jobId, "face-detect-yunet-v1");

  const upsert = db.prepare(`
    INSERT INTO face_detections(
      media_id,
      detector_version,
      detection_index,
      input_sha256,
      x,
      y,
      width,
      height,
      score,
      landmarks_json,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(media_id, detector_version, detection_index) DO UPDATE SET
      input_sha256=excluded.input_sha256,
      x=excluded.x,
      y=excluded.y,
      width=excluded.width,
      height=excluded.height,
      score=excluded.score,
      landmarks_json=excluded.landmarks_json,
      updated_at=CURRENT_TIMESTAMP
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    let written = 0;

    for (let index = 0; index < rawFaces.length; index += 1) {
      const face = rawFaces[index];
      if (!face || typeof face !== "object") continue;

      const item = face as Record<string, unknown>;
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      const score = Number(item.score);

      if (![x, y, width, height, score].every(Number.isFinite)) continue;

      upsert.run(
        Number(job.media_id),
        detectorVersion,
        written,
        String(job.input_sha256 ?? ""),
        x,
        y,
        width,
        height,
        score,
        JSON.stringify(Array.isArray(item.landmarks) ? item.landmarks : [])
      );
      written += 1;
    }

    db.prepare(`
      DELETE FROM face_detections
      WHERE media_id=?
        AND detector_version=?
        AND detection_index>=?
    `).run(Number(job.media_id), detectorVersion, written);

    db.prepare(`
      DELETE FROM face_detections
      WHERE media_id=?
        AND detector_version<>?
    `).run(Number(job.media_id), detectorVersion);

    db.prepare(`
      DELETE FROM face_embeddings
      WHERE media_id=?
    `).run(Number(job.media_id));

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='PENDING',
        attempts=0,
        result_json=NULL,
        error_message=NULL,
        started_at=NULL,
        finished_at=NULL,
        updated_at=CURRENT_TIMESTAMP
      WHERE media_id=?
        AND module='face-embed-sface-v1'
    `).run(Number(job.media_id));

    db.prepare(`
      UPDATE analysis_jobs
      SET status='DONE', result_json=?, error_message=NULL,
          finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(JSON.stringify({ detector: detectorVersion, faceCount: written }), jobId);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { completed: true };
}

function completePetDetectionJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Haustierdetektions-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const rawPets = Array.isArray(value.pets) ? value.pets : [];
  const rawObjects = Array.isArray(value.objects) ? value.objects : [];
  const detectorVersion =
    typeof value.detector === "string" && value.detector.trim()
      ? value.detector.trim()
      : "Unbekannter Haustierdetektor";

  const module =
    value.module === "pet-detect-yolox-v1"
      ? "pet-detect-yolox-v1"
      : value.module === "pet-detect-nanodet-v1"
        ? "pet-detect-nanodet-v1"
        : null;

  if (!module) {
    throw new Error("Haustierdetektions-Ergebnis enthält kein bekanntes Modul.");
  }

  const job = jobForModule(jobId, module);
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  const objectUpsert = db.prepare(`
    INSERT INTO object_detections(
      media_id,
      detector_version,
      detection_index,
      input_sha256,
      class_id,
      label,
      x,
      y,
      width,
      height,
      score,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(media_id, detector_version, detection_index) DO UPDATE SET
      input_sha256=excluded.input_sha256,
      class_id=excluded.class_id,
      label=excluded.label,
      x=excluded.x,
      y=excluded.y,
      width=excluded.width,
      height=excluded.height,
      score=excluded.score,
      updated_at=CURRENT_TIMESTAMP
  `);

  const upsert = db.prepare(`
    INSERT INTO pet_detections(
      media_id,
      detector_version,
      detection_index,
      input_sha256,
      pet_class,
      class_id,
      x,
      y,
      width,
      height,
      score,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(media_id, detector_version, detection_index) DO UPDATE SET
      input_sha256=excluded.input_sha256,
      pet_class=excluded.pet_class,
      class_id=excluded.class_id,
      x=excluded.x,
      y=excluded.y,
      width=excluded.width,
      height=excluded.height,
      score=excluded.score,
      updated_at=CURRENT_TIMESTAMP
  `);

  let written = 0;
  let objectWritten = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const rawPet of rawPets) {
      if (!rawPet || typeof rawPet !== "object") continue;

      const item = rawPet as Record<string, unknown>;
      const petClass =
        item.class === "dog" || item.class === "cat"
          ? String(item.class)
          : null;
      if (!petClass) continue;

      const classId = Number(item.classId);
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      const score = Number(item.score);

      if (
        !Number.isInteger(classId) ||
        ![x, y, width, height, score].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
      ) {
        continue;
      }

      upsert.run(
        mediaId,
        detectorVersion,
        written,
        inputSha256,
        petClass,
        classId,
        x,
        y,
        width,
        height,
        score
      );
      written += 1;
    }

    for (const rawObject of rawObjects) {
      if (!rawObject || typeof rawObject !== "object") continue;

      const item = rawObject as Record<string, unknown>;
      const classId = Number(item.classId);
      const label =
        typeof item.label === "string" ? item.label.trim() : "";
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      const score = Number(item.score);

      if (
        !Number.isInteger(classId) ||
        !label ||
        ![x, y, width, height, score].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
      ) {
        continue;
      }

      objectUpsert.run(
        mediaId,
        detectorVersion,
        objectWritten,
        inputSha256,
        classId,
        label,
        x,
        y,
        width,
        height,
        score
      );
      objectWritten += 1;
    }

    db.prepare(`
      DELETE FROM object_detections
      WHERE media_id=?
        AND detector_version=?
        AND detection_index>=?
    `).run(mediaId, detectorVersion, objectWritten);

    db.prepare(`
      DELETE FROM pet_detections
      WHERE media_id=?
        AND detector_version=?
        AND detection_index>=?
    `).run(mediaId, detectorVersion, written);

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      JSON.stringify({
        detector: detectorVersion,
        petCount: written,
        objectCount: objectWritten,
        objectDetectorVersion: "motif-raw-v2"
      }),
      jobId
    );

    // Jede neue Rohdetektion macht die bisherige Ensemble-Fusion ungültig.
    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='PENDING',
        attempts=0,
        input_sha256=?,
        result_json=NULL,
        error_message=NULL,
        started_at=NULL,
        finished_at=NULL,
        updated_at=CURRENT_TIMESTAMP
      WHERE media_id=?
        AND module='pet-fuse-ensemble-v1'
        AND status<>'RUNNING'
    `).run(inputSha256, mediaId);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    completed: true,
    petCount: written,
    objectCount: objectWritten
  };
}

function getPetDetectionsForFusion(
  mediaId: number,
  inputSha256: string
) {
  return db.prepare(`
    SELECT
      detector_version,
      pet_class,
      class_id,
      x,
      y,
      width,
      height,
      score
    FROM pet_detections
    WHERE media_id=?
      AND input_sha256=?
      AND detector_version IN ('NanoDet 2022nov', 'YOLOX-S 2022nov')
    ORDER BY detector_version, detection_index
  `).all(mediaId, inputSha256).map((row) => ({
    detector: String(row.detector_version),
    petClass: String(row.pet_class),
    classId: Number(row.class_id),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    score: Number(row.score)
  }));
}

function getObjectDetectionsForFusion(
  mediaId: number,
  inputSha256: string
) {
  return db.prepare(`
    SELECT
      detector_version,
      class_id,
      label,
      x,
      y,
      width,
      height,
      score
    FROM object_detections
    WHERE media_id=?
      AND input_sha256=?
      AND detector_version IN ('NanoDet 2022nov', 'YOLOX-S 2022nov')
    ORDER BY detector_version, detection_index
  `).all(mediaId, inputSha256).map((row) => ({
    detector: String(row.detector_version),
    classId: Number(row.class_id),
    label: String(row.label),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    score: Number(row.score)
  }));
}

function completePetFusionJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Haustierfusions-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const rawPets = Array.isArray(value.pets) ? value.pets : [];
  const fusionVersion =
    typeof value.fusion === "string" && value.fusion.trim()
      ? value.fusion.trim()
      : "NanoDet+YOLOX-S weighted-box-v1";

  const job = jobForModule(jobId, "pet-fuse-ensemble-v1");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  const insertPet = db.prepare(`
    INSERT INTO pet_fused_detections(
      media_id,
      fusion_version,
      detection_index,
      input_sha256,
      pet_class,
      class_id,
      x,
      y,
      width,
      height,
      score,
      agreement_count,
      sources_json,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(media_id, fusion_version, detection_index) DO UPDATE SET
      input_sha256=excluded.input_sha256,
      pet_class=excluded.pet_class,
      class_id=excluded.class_id,
      x=excluded.x,
      y=excluded.y,
      width=excluded.width,
      height=excluded.height,
      score=excluded.score,
      agreement_count=excluded.agreement_count,
      sources_json=excluded.sources_json,
      updated_at=CURRENT_TIMESTAMP
  `);

  let written = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const rawPet of rawPets) {
      if (!rawPet || typeof rawPet !== "object") continue;

      const item = rawPet as Record<string, unknown>;
      const petClass =
        item.class === "dog" || item.class === "cat"
          ? String(item.class)
          : null;
      if (!petClass) continue;

      const classId = Number(item.classId);
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      const score = Number(item.score);
      const agreementCount = Math.max(1, Math.trunc(Number(item.agreementCount)));
      const sources = Array.isArray(item.sources)
        ? item.sources.filter((source) => typeof source === "string")
        : [];

      if (
        !Number.isInteger(classId) ||
        ![x, y, width, height, score].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
      ) {
        continue;
      }

      insertPet.run(
        mediaId,
        fusionVersion,
        written,
        inputSha256,
        petClass,
        classId,
        x,
        y,
        width,
        height,
        score,
        Number.isFinite(agreementCount) ? agreementCount : 1,
        JSON.stringify(sources)
      );
      written += 1;
    }

    db.prepare(`
      DELETE FROM pet_fused_detections
      WHERE media_id=?
        AND fusion_version=?
        AND detection_index>=?
    `).run(mediaId, fusionVersion, written);

    db.prepare(`
      DELETE FROM pet_fused_detections
      WHERE media_id=?
        AND fusion_version<>?
    `).run(mediaId, fusionVersion);

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      JSON.stringify({
        fusion: fusionVersion,
        petFusionVersion: fusionVersion,
        petCount: written
      }),
      jobId
    );

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='PENDING',
        attempts=0,
        input_sha256=?,
        result_json=NULL,
        error_message=NULL,
        started_at=NULL,
        finished_at=NULL,
        updated_at=CURRENT_TIMESTAMP
      WHERE media_id=?
        AND module='pet-embed-dogreid-v1'
        AND status<>'RUNNING'
    `).run(inputSha256, mediaId);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    completed: true,
    petCount: written
  };
}

function completeCatalogSemanticJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Qwen-4B-Kataloganalyse ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const semantic =
    value.semantic && typeof value.semantic === "object"
      ? value.semantic as Record<string, unknown>
      : null;

  if (!semantic) {
    throw new Error("Qwen-4B-Kataloganalyse enthält keine Semantikdaten.");
  }

  const cleanText = (raw: unknown, max = 1000): string =>
    typeof raw === "string"
      ? raw.trim().replace(/\s+/g, " ").slice(0, max)
      : "";

  const cleanList = (raw: unknown, limit = 80): string[] => {
    if (!Array.isArray(raw)) return [];
    const values: string[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
      const text = cleanText(entry, 160);
      const key = text.toLocaleLowerCase("de-DE");
      if (!text || seen.has(key)) continue;
      seen.add(key);
      values.push(text);
      if (values.length >= limit) break;
    }
    return values;
  };

  const modelVersion = cleanText(value.model, 240) || "Qwen3-VL 4B Instruct Q4_K_M + Vision Q8_0";
  const profileVersion = cleanText(value.profileVersion, 160) || "qwen3vl4b-catalog-whole-plus-4-v1";
  const description = cleanText(semantic.description, 1200);
  const subjects = cleanList(semantic.subjects, 60);
  const actions = cleanList(semantic.actions, 50);
  const scenes = cleanList(semantic.scenes, 40);
  const visibleText = cleanList(semantic.visibleText, 80);
  const tags = cleanList(semantic.tags, 100);
  const concepts = cleanList(semantic.concepts, 60);
  const repaired = Boolean(semantic.repaired);
  const regions = Array.isArray(value.regions) ? value.regions.slice(0, 5) : [];
  const timings =
    value.timings && typeof value.timings === "object"
      ? value.timings
      : {};
  const regionCount = Math.max(
    0,
    Math.min(5, Math.trunc(Number(value.regionCount) || regions.length))
  );

  const job = jobForModule(jobId, "catalog-semantic-qwen3vl4b-v3");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO media_semantic_annotations(
        media_id,
        model_version,
        input_sha256,
        profile_version,
        description,
        subjects_json,
        actions_json,
        scenes_json,
        visible_text_json,
        tags_json,
        concepts_json,
        repaired,
        region_count,
        regions_json,
        timings_json,
        updated_at
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(media_id) DO UPDATE SET
        model_version=excluded.model_version,
        input_sha256=excluded.input_sha256,
        profile_version=excluded.profile_version,
        description=excluded.description,
        subjects_json=excluded.subjects_json,
        actions_json=excluded.actions_json,
        scenes_json=excluded.scenes_json,
        visible_text_json=excluded.visible_text_json,
        tags_json=excluded.tags_json,
        concepts_json=excluded.concepts_json,
        repaired=excluded.repaired,
        region_count=excluded.region_count,
        regions_json=excluded.regions_json,
        timings_json=excluded.timings_json,
        updated_at=CURRENT_TIMESTAMP
    `).run(
      mediaId,
      modelVersion,
      inputSha256,
      profileVersion,
      description,
      JSON.stringify(subjects),
      JSON.stringify(actions),
      JSON.stringify(scenes),
      JSON.stringify(visibleText),
      JSON.stringify(tags),
      JSON.stringify(concepts),
      repaired ? 1 : 0,
      regionCount,
      JSON.stringify(regions),
      JSON.stringify(timings)
    );

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
        AND status='RUNNING'
    `).run(
      JSON.stringify({
        model: modelVersion,
        profileVersion,
        regionCount,
        description,
        subjects,
        actions,
        scenes,
        visibleText,
        tags,
        concepts,
        repaired
      }),
      jobId
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    completed: true,
    model: modelVersion,
    profileVersion,
    regionCount,
    subjects: subjects.length,
    tags: tags.length,
    concepts: concepts.length,
    repaired
  };
}


function completeVerifiedObjectDetectionJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Verifiziertes Motiverkennungs-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const rawObjects = Array.isArray(value.objects) ? value.objects : [];
  const detectorVersion =
    typeof value.detector === "string" && value.detector.trim()
      ? value.detector.trim()
      : "Qwen3-VL-8B-Thinking GGUF Q8_0 + mmproj F16 structured non-thinking v3";

  const candidateCount = Math.max(0, Math.trunc(Number(value.candidateCount) || 0));
  const rejectedCount = Math.max(0, Math.trunc(Number(value.rejectedCount) || 0));

  const job = jobForModule(jobId, "object-detect-qwen3vl-gguf-v2");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  const insert = db.prepare(`
    INSERT INTO object_fused_detections(
      media_id,
      fusion_version,
      detection_index,
      input_sha256,
      class_id,
      label,
      x,
      y,
      width,
      height,
      score,
      agreement_count,
      sources_json,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(media_id, fusion_version, detection_index) DO UPDATE SET
      input_sha256=excluded.input_sha256,
      class_id=excluded.class_id,
      label=excluded.label,
      x=excluded.x,
      y=excluded.y,
      width=excluded.width,
      height=excluded.height,
      score=excluded.score,
      agreement_count=excluded.agreement_count,
      sources_json=excluded.sources_json,
      updated_at=CURRENT_TIMESTAMP
  `);

  let written = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    // Alte NanoDet/YOLOX-Motivfusion oder eine ältere Prüfgeneration darf nach
    // erfolgreicher Präzisionsanalyse nicht mehr für Suche/Anzeige sichtbar sein.
    db.prepare(`
      DELETE FROM object_fused_detections
      WHERE media_id=?
    `).run(mediaId);

    for (const rawObject of rawObjects) {
      if (!rawObject || typeof rawObject !== "object") continue;

      const item = rawObject as Record<string, unknown>;
      const classId = Number(item.classId);
      const label = typeof item.label === "string" ? item.label.trim() : "";
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      const score = Number(item.score);
      const agreementCount = Math.max(1, Math.trunc(Number(item.agreementCount) || 3));
      const sources = Array.isArray(item.sources)
        ? item.sources.filter((source) => typeof source === "string")
        : [];

      if (
        !Number.isInteger(classId) ||
        !label ||
        ![x, y, width, height, score].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
      ) {
        continue;
      }

      insert.run(
        mediaId,
        detectorVersion,
        written,
        inputSha256,
        classId,
        label,
        x,
        y,
        width,
        height,
        score,
        agreementCount,
        JSON.stringify(sources)
      );
      written += 1;
    }

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      JSON.stringify({
        detector: detectorVersion,
        candidateCount,
        verifiedCount: written,
        rejectedCount,
        verificationVersion: "qwen3vl-gguf-object-v3"
      }),
      jobId
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    completed: true,
    candidateCount,
    verifiedCount: written,
    rejectedCount
  };
}

function getPetDetectionsForEmbedding(
  mediaId: number,
  inputSha256: string
) {
  return db.prepare(`
    SELECT
      id,
      pet_class,
      x,
      y,
      width,
      height,
      score
    FROM pet_fused_detections
    WHERE media_id=?
      AND input_sha256=?
      AND pet_class='dog'
    ORDER BY detection_index ASC
  `).all(mediaId, inputSha256).map((row) => ({
    id: Number(row.id),
    petClass: String(row.pet_class),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    score: Number(row.score)
  }));
}

function completePetEmbeddingJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Haustiermerkmal-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const rawEmbeddings = Array.isArray(value.embeddings) ? value.embeddings : [];
  const modelVersion =
    typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : "DogReID DINOv2-B14 0.2.0";

  const job = jobForModule(jobId, "pet-embed-dogreid-v1");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  const insert = db.prepare(`
    INSERT INTO pet_embeddings(
      pet_detection_id,
      media_id,
      model_version,
      input_sha256,
      dimension,
      vector_blob,
      updated_at
    )
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(pet_detection_id, model_version) DO UPDATE SET
      media_id=excluded.media_id,
      input_sha256=excluded.input_sha256,
      dimension=excluded.dimension,
      vector_blob=excluded.vector_blob,
      updated_at=CURRENT_TIMESTAMP
  `);

  let written = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      DELETE FROM pet_embeddings
      WHERE media_id=?
        AND model_version=?
    `).run(mediaId, modelVersion);

    for (const raw of rawEmbeddings) {
      if (!raw || typeof raw !== "object") continue;

      const item = raw as Record<string, unknown>;
      const petDetectionId = Number(item.petDetectionId);
      if (!Number.isInteger(petDetectionId) || petDetectionId <= 0) continue;

      const belongsToMedia = db.prepare(`
        SELECT 1
        FROM pet_fused_detections
        WHERE id=?
          AND media_id=?
          AND input_sha256=?
          AND pet_class='dog'
      `).get(petDetectionId, mediaId, inputSha256);

      if (!belongsToMedia) continue;

      const vector = Array.isArray(item.vector) ? item.vector : [];
      const blob = embeddingToBlob(vector);

      insert.run(
        petDetectionId,
        mediaId,
        modelVersion,
        inputSha256,
        vector.length,
        blob
      );
      written += 1;
    }

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      JSON.stringify({ model: modelVersion, embeddingCount: written }),
      jobId
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { completed: true, embeddingCount: written };
}

function completeSemanticEmbeddingJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Semantik-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const modelVersion =
    typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : "SigLIP2 unbekannt";
  const dimension = Math.trunc(Number(value.dimension));
  const maxNumPatches = Math.trunc(Number(value.maxNumPatches));
  const precision =
    typeof value.precision === "string" && value.precision.trim()
      ? value.precision.trim()
      : "float32";
  const vector = Array.isArray(value.vector) ? value.vector : [];

  if (
    dimension <= 0 ||
    dimension !== vector.length ||
    maxNumPatches <= 0
  ) {
    throw new Error("Semantik-Vektor oder Modellparameter sind ungültig.");
  }

  const blob = embeddingToBlob(vector);
  const job = jobForModule(jobId, "semantic-embed-siglip2-v1");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO semantic_embeddings(
        media_id,
        model_version,
        input_sha256,
        dimension,
        vector_blob,
        max_num_patches,
        precision,
        updated_at
      )
      VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(media_id) DO UPDATE SET
        model_version=excluded.model_version,
        input_sha256=excluded.input_sha256,
        dimension=excluded.dimension,
        vector_blob=excluded.vector_blob,
        max_num_patches=excluded.max_num_patches,
        precision=excluded.precision,
        updated_at=CURRENT_TIMESTAMP
    `).run(
      mediaId,
      modelVersion,
      inputSha256,
      dimension,
      blob,
      maxNumPatches,
      precision
    );

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      JSON.stringify({
        model: modelVersion,
        dimension,
        maxNumPatches,
        precision
      }),
      jobId
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { completed: true, dimension, model: modelVersion };
}

function getPetEmbeddingsForClustering(
  sourceId: number,
  algorithmVersion: string
) {
  const rows = db.prepare(`
    SELECT
      pd.id AS pet_detection_id,
      pd.detection_index,
      pd.pet_class,
      pe.media_id,
      pe.dimension,
      pe.vector_blob,
      pe.updated_at,
      m.sha256
    FROM pet_embeddings pe
    JOIN pet_fused_detections pd ON pd.id=pe.pet_detection_id
    JOIN media_items m ON m.id=pe.media_id
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pe.input_sha256=m.sha256
      AND pd.input_sha256=m.sha256
      AND pd.pet_class='dog'
      AND pa.pet_detection_id IS NULL
    ORDER BY pd.id ASC
  `).all(sourceId);

  const ids = rows.map((row) => Number(row.pet_detection_id));
  const maxUpdatedAt = rows.reduce(
    (current, row) =>
      String(row.updated_at ?? "") > current ? String(row.updated_at ?? "") : current,
    ""
  );
  const idSum = ids.reduce((sum, id) => sum + id, 0);

  const assignmentCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM pet_assignments pa
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE m.source_id=?
  `).get(sourceId);

  const cannotLinkRows = db.prepare(`
    SELECT pce.pet_a_id, pce.pet_b_id, pce.created_at
    FROM pet_cluster_exclusions pce
    JOIN pet_fused_detections pa ON pa.id=pce.pet_a_id
    JOIN media_items ma ON ma.id=pa.media_id
    JOIN pet_fused_detections pb ON pb.id=pce.pet_b_id
    JOIN media_items mb ON mb.id=pb.media_id
    WHERE ma.source_id=?
      AND mb.source_id=?
  `).all(sourceId, sourceId);

  const cannotLinkSignature = cannotLinkRows
    .map((row) =>
      `${Number(row.pet_a_id)}-${Number(row.pet_b_id)}-${String(row.created_at ?? "")}`
    )
    .sort()
    .join("|");

  const revision = [
    rows.length,
    ids.length > 0 ? Math.max(...ids) : 0,
    idSum,
    maxUpdatedAt,
    Number(assignmentCount?.count ?? 0),
    cannotLinkSignature
  ].join(":");

  const previousRun = db.prepare(`
    SELECT embedding_revision, algorithm_version
    FROM pet_cluster_runs
    WHERE source_id=?
  `).get(sourceId);

  return {
    revision,
    needsRebuild:
      !previousRun ||
      String(previousRun.embedding_revision) !== revision ||
      String(previousRun.algorithm_version) !== algorithmVersion,
    pets: rows.map((row) => ({
      petDetectionId: Number(row.pet_detection_id),
      mediaId: Number(row.media_id),
      contentKey: `${String(row.sha256)}:${Number(row.detection_index)}`,
      petClass: String(row.pet_class),
      vector: vectorFromBlob(row.vector_blob, Number(row.dimension))
    })),
    cannotLinks: cannotLinkRows.map((row) => ({
      petAId: Number(row.pet_a_id),
      petBId: Number(row.pet_b_id)
    }))
  };
}

function replacePetCandidates(
  sourceId: number,
  revision: string,
  algorithmVersion: string,
  rawClusters: unknown
) {
  const clusters = Array.isArray(rawClusters) ? rawClusters : [];

  const eligibleRows = db.prepare(`
    SELECT pd.id
    FROM pet_fused_detections pd
    JOIN pet_embeddings pe ON pe.pet_detection_id=pd.id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND pd.pet_class='dog'
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pe.input_sha256=m.sha256
      AND pd.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
  `).all(sourceId);

  const eligibleIds = new Set(
    eligibleRows.map((row) => Number(row.id))
  );

  const insertCandidate = db.prepare(`
    INSERT INTO pet_candidates(
      source_id,
      pet_class,
      algorithm_version,
      representative_pet_id,
      average_similarity,
      min_similarity
    )
    VALUES(?,'dog',?,?,?,?)
  `);

  const insertMember = db.prepare(`
    INSERT INTO pet_candidate_items(
      candidate_id,
      pet_detection_id,
      similarity
    )
    VALUES(?,?,?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM pet_candidates WHERE source_id=?").run(sourceId);

    let writtenClusters = 0;
    let writtenPets = 0;
    const usedPets = new Set<number>();

    for (const rawCluster of clusters) {
      if (!rawCluster || typeof rawCluster !== "object") continue;

      const cluster = rawCluster as Record<string, unknown>;
      const rawMembers = Array.isArray(cluster.members) ? cluster.members : [];

      const members = rawMembers
        .filter((value) => value && typeof value === "object")
        .map((value) => {
          const item = value as Record<string, unknown>;
          return {
            petDetectionId: Number(item.petDetectionId),
            similarity: Number(item.similarity)
          };
        })
        .filter(
          (member) =>
            Number.isInteger(member.petDetectionId) &&
            eligibleIds.has(member.petDetectionId) &&
            Number.isFinite(member.similarity) &&
            !usedPets.has(member.petDetectionId)
        );

      if (members.length < 2) continue;

      const requestedRepresentative = Number(cluster.representativePetId);
      const representativePetId = members.some(
        (member) => member.petDetectionId === requestedRepresentative
      )
        ? requestedRepresentative
        : members[0].petDetectionId;

      const averageSimilarity = Number(cluster.averageSimilarity);
      const minSimilarity = Number(cluster.minSimilarity);

      const inserted = insertCandidate.run(
        sourceId,
        algorithmVersion,
        representativePetId,
        Number.isFinite(averageSimilarity) ? averageSimilarity : 1,
        Number.isFinite(minSimilarity) ? minSimilarity : 1
      );
      const candidateId = Number(inserted.lastInsertRowid);

      for (const member of members) {
        insertMember.run(
          candidateId,
          member.petDetectionId,
          member.similarity
        );
        usedPets.add(member.petDetectionId);
        writtenPets += 1;
      }

      writtenClusters += 1;
    }

    db.prepare(`
      INSERT INTO pet_cluster_runs(
        source_id,
        embedding_revision,
        algorithm_version,
        updated_at
      )
      VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source_id) DO UPDATE SET
        embedding_revision=excluded.embedding_revision,
        algorithm_version=excluded.algorithm_version,
        updated_at=CURRENT_TIMESTAMP
    `).run(sourceId, revision, algorithmVersion);

    db.exec("COMMIT");
    return { writtenClusters, writtenPets };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm <= 0 || rightNorm <= 0) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dimension = vectors[0].length;
  if (dimension === 0 || vectors.some((vector) => vector.length !== dimension)) {
    return null;
  }

  const result = new Array<number>(dimension).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) {
      result[index] += vector[index];
    }
  }

  for (let index = 0; index < dimension; index += 1) {
    result[index] /= vectors.length;
  }

  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return result.map((value) => value / norm);
}

function knownPetCentroids(sourceId: number) {
  const rows = db.prepare(`
    SELECT
      p.id AS pet_id,
      p.name,
      p.pet_class,
      pe.dimension,
      pe.vector_blob
    FROM pets p
    JOIN pet_assignments pa ON pa.pet_id=p.id
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    JOIN pet_embeddings pe ON pe.pet_detection_id=pd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND pa.assignment_source='CONFIRMED'
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pe.input_sha256=m.sha256
      AND pd.input_sha256=m.sha256
    ORDER BY p.id, pd.id
  `).all(sourceId);

  const grouped = new Map<number, {
    id: number;
    name: string;
    petClass: string;
    vectors: number[][];
  }>();

  for (const row of rows) {
    const id = Number(row.pet_id);
    const entry = grouped.get(id) ?? {
      id,
      name: String(row.name),
      petClass: String(row.pet_class),
      vectors: []
    };

    entry.vectors.push(
      vectorFromBlob(row.vector_blob, Number(row.dimension))
    );
    grouped.set(id, entry);
  }

  return [...grouped.values()]
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      petClass: entry.petClass,
      referenceCount: entry.vectors.length,
      vector: centroid(entry.vectors)
    }))
    .filter(
      (entry): entry is {
        id: number;
        name: string;
        petClass: string;
        referenceCount: number;
        vector: number[];
      } => entry.vector !== null
    );
}

function autoAssignKnownPetCandidates(sourceId: number) {
  const candidates = db.prepare(`
    SELECT id, pet_class
    FROM pet_candidates
    WHERE source_id=?
    ORDER BY id
  `).all(sourceId);

  if (candidates.length === 0) return { assignedCandidates: 0, assignedPets: 0 };

  const knownPets = knownPetCentroids(sourceId);
  if (knownPets.length === 0) return { assignedCandidates: 0, assignedPets: 0 };

  const memberRows = db.prepare(`
    SELECT
      pci.pet_detection_id,
      pe.dimension,
      pe.vector_blob
    FROM pet_candidate_items pci
    JOIN pet_embeddings pe ON pe.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
    ORDER BY pci.pet_detection_id
  `);

  const exclusionQuery = db.prepare(`
    SELECT 1
    FROM pet_candidate_items pci
    JOIN pet_assignment_exclusions pae
      ON pae.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND pae.pet_id=?
    LIMIT 1
  `);

  const assign = db.prepare(`
    INSERT INTO pet_assignments(
      pet_detection_id,
      pet_id,
      assignment_source,
      confidence,
      updated_at
    )
    VALUES(?,?, 'AUTO_HIGH_CONFIDENCE', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(pet_detection_id) DO UPDATE SET
      pet_id=excluded.pet_id,
      assignment_source=excluded.assignment_source,
      confidence=excluded.confidence,
      updated_at=CURRENT_TIMESTAMP
  `);

  let assignedCandidates = 0;
  let assignedPets = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const candidate of candidates) {
      const candidateId = Number(candidate.id);
      const vectors = memberRows.all(candidateId).map((row) => ({
        petDetectionId: Number(row.pet_detection_id),
        vector: vectorFromBlob(row.vector_blob, Number(row.dimension))
      }));

      if (vectors.length < 2) continue;

      const candidateCentroid = centroid(vectors.map((entry) => entry.vector));
      if (!candidateCentroid) continue;

      const matches = knownPets
        .filter(
          (known) =>
            known.petClass === String(candidate.pet_class) &&
            known.referenceCount >= 3 &&
            !exclusionQuery.get(candidateId, known.id)
        )
        .map((known) => {
          const centroidSimilarity = cosineSimilarity(candidateCentroid, known.vector);
          const memberSimilarities = vectors.map((entry) =>
            cosineSimilarity(entry.vector, known.vector)
          );

          return {
            known,
            centroidSimilarity,
            memberSimilarities,
            minimumSimilarity: Math.min(...memberSimilarities)
          };
        })
        .sort((left, right) => right.centroidSimilarity - left.centroidSimilarity);

      const best = matches[0];
      if (!best) continue;

      const secondSimilarity = matches[1]?.centroidSimilarity ?? -1;
      const margin = best.centroidSimilarity - secondSimilarity;

      // Bewusst streng: automatische Zuordnung nur bei sehr klaren Treffern.
      if (
        best.centroidSimilarity < 0.88 ||
        best.minimumSimilarity < 0.82 ||
        margin < 0.08
      ) {
        continue;
      }

      const clearExclusion = db.prepare(`
        DELETE FROM pet_assignment_exclusions
        WHERE pet_id=?
          AND pet_detection_id=?
      `);

      for (let index = 0; index < vectors.length; index += 1) {
        const entry = vectors[index];
        clearExclusion.run(best.known.id, entry.petDetectionId);
        assign.run(
          entry.petDetectionId,
          best.known.id,
          best.memberSimilarities[index]
        );
        assignedPets += 1;
      }

      db.prepare("DELETE FROM pet_candidates WHERE id=?").run(candidateId);
      assignedCandidates += 1;
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { assignedCandidates, assignedPets };
}

function listPetCandidates(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(500, Math.trunc(requestedLimit || 100)));

  const candidates = db.prepare(`
    SELECT
      pc.id,
      pc.pet_class,
      pc.representative_pet_id,
      pc.average_similarity,
      pc.min_similarity,
      COUNT(pci.pet_detection_id) AS detection_count
    FROM pet_candidates pc
    JOIN pet_candidate_items pci ON pci.candidate_id=pc.id
    WHERE pc.source_id=?
    GROUP BY pc.id
    ORDER BY detection_count DESC, pc.average_similarity DESC, pc.id ASC
    LIMIT ?
  `).all(sourceId, limit);

  const itemQuery = db.prepare(`
    SELECT
      pci.pet_detection_id,
      pd.media_id,
      m.relative_path,
      pci.similarity
    FROM pet_candidate_items pci
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE pci.candidate_id=?
    ORDER BY
      CASE WHEN pci.pet_detection_id=? THEN 0 ELSE 1 END,
      pci.similarity DESC,
      pci.pet_detection_id ASC
    LIMIT 24
  `);

  const embeddingQuery = db.prepare(`
    SELECT
      pci.pet_detection_id,
      pe.dimension,
      pe.vector_blob
    FROM pet_candidate_items pci
    JOIN pet_embeddings pe ON pe.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
    ORDER BY pci.pet_detection_id
  `);

  const exclusionQuery = db.prepare(`
    SELECT 1
    FROM pet_candidate_items pci
    JOIN pet_assignment_exclusions pae
      ON pae.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND pae.pet_id=?
    LIMIT 1
  `);

  const knownPets = knownPetCentroids(sourceId);

  return candidates.map((candidate) => {
    const candidateId = Number(candidate.id);
    const representativePetId = candidate.representative_pet_id === null
      ? null
      : Number(candidate.representative_pet_id);

    const candidateVector = centroid(
      embeddingQuery.all(candidateId).map((row) =>
        vectorFromBlob(row.vector_blob, Number(row.dimension))
      )
    );

    let suggestedPetId: number | null = null;
    let suggestedPetName: string | null = null;
    let suggestedPetSimilarity: number | null = null;

    if (candidateVector) {
      for (const known of knownPets) {
        if (known.petClass !== String(candidate.pet_class)) continue;
        if (exclusionQuery.get(candidateId, known.id)) continue;

        const similarity = cosineSimilarity(candidateVector, known.vector);
        if (
          similarity >= 0.60 &&
          (suggestedPetSimilarity === null || similarity > suggestedPetSimilarity)
        ) {
          suggestedPetId = known.id;
          suggestedPetName = known.name;
          suggestedPetSimilarity = similarity;
        }
      }
    }

    return {
      id: candidateId,
      petClass: String(candidate.pet_class),
      detectionCount: Number(candidate.detection_count),
      representativePetId,
      averageSimilarity: Number(candidate.average_similarity),
      minSimilarity: Number(candidate.min_similarity),
      suggestedPetId,
      suggestedPetName,
      suggestedPetSimilarity,
      pets: itemQuery.all(
        candidateId,
        representativePetId ?? -1
      ).map((row) => ({
        petDetectionId: Number(row.pet_detection_id),
        mediaId: Number(row.media_id),
        relativePath: String(row.relative_path),
        similarity: Number(row.similarity)
      }))
    };
  });
}

function listPets(sourceId: number) {
  const pets = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.pet_class,
      COUNT(*) AS detection_count,
      SUM(CASE WHEN pa.assignment_source='CONFIRMED' THEN 1 ELSE 0 END) AS confirmed_count,
      SUM(CASE WHEN pa.assignment_source='AUTO_HIGH_CONFIDENCE' THEN 1 ELSE 0 END) AS automatic_count,
      MIN(pd.id) AS representative_pet_id
    FROM pets p
    JOIN pet_assignments pa ON pa.pet_id=p.id
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE m.source_id=?
    GROUP BY p.id, p.name, p.pet_class
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(sourceId);

  const itemQuery = db.prepare(`
    SELECT
      pa.pet_detection_id,
      pd.media_id,
      m.relative_path,
      pa.confidence,
      pa.assignment_source
    FROM pet_assignments pa
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE pa.pet_id=?
      AND m.source_id=?
    ORDER BY
      CASE WHEN pa.assignment_source='AUTO_HIGH_CONFIDENCE' THEN 0 ELSE 1 END,
      pa.pet_detection_id ASC
    LIMIT 48
  `);

  return pets.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    petClass: String(row.pet_class),
    detectionCount: Number(row.detection_count),
    confirmedCount: Number(row.confirmed_count ?? 0),
    automaticCount: Number(row.automatic_count ?? 0),
    representativePetId:
      row.representative_pet_id === null ? null : Number(row.representative_pet_id),
    pets: itemQuery.all(Number(row.id), sourceId).map((pet) => ({
      petDetectionId: Number(pet.pet_detection_id),
      mediaId: Number(pet.media_id),
      relativePath: String(pet.relative_path),
      confidence:
        pet.confidence === null || pet.confidence === undefined
          ? null
          : Number(pet.confidence),
      assignmentSource:
        String(pet.assignment_source) === "AUTO_HIGH_CONFIDENCE"
          ? "AUTO_HIGH_CONFIDENCE"
          : "CONFIRMED"
    }))
  }));
}

function confirmPetCandidate(
  candidateId: number,
  rawName: unknown,
  rejectedPetId?: number
) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für das Haustier eingeben.");
  if (name.length > 120) throw new Error("Der Haustiername ist zu lang.");

  const candidate = db.prepare(`
    SELECT id, source_id, pet_class
    FROM pet_candidates
    WHERE id=?
  `).get(candidateId);

  if (!candidate) {
    throw new Error("Der Haustiervorschlag wurde nicht mehr gefunden.");
  }

  const members = db.prepare(`
    SELECT pci.pet_detection_id, pci.similarity
    FROM pet_candidate_items pci
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND pa.pet_detection_id IS NULL
    ORDER BY pci.pet_detection_id
  `).all(candidateId);

  if (members.length === 0) {
    throw new Error("Der Haustiervorschlag enthält keine unbestätigten Fundstellen mehr.");
  }

  const petClass = String(candidate.pet_class);

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(`
      SELECT id
      FROM pets
      WHERE name=? COLLATE NOCASE
        AND pet_class=?
      ORDER BY id ASC
      LIMIT 1
    `).get(name, petClass);

    const petId = existing
      ? Number(existing.id)
      : Number(
          db.prepare(`
            INSERT INTO pets(name, pet_class)
            VALUES(?,?)
          `).run(name, petClass).lastInsertRowid
        );

    db.prepare(`
      UPDATE pets
      SET name=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(name, petId);

    if (
      Number.isInteger(rejectedPetId) &&
      Number(rejectedPetId) > 0 &&
      Number(rejectedPetId) !== petId
    ) {
      const rejectedPet = db.prepare(`
        SELECT id, pet_class
        FROM pets
        WHERE id=?
      `).get(Number(rejectedPetId));

      if (rejectedPet && String(rejectedPet.pet_class) === petClass) {
        const rejectedReferenceIds = db.prepare(`
          SELECT pa.pet_detection_id
          FROM pet_assignments pa
          JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
          JOIN media_items m ON m.id=pd.media_id
          WHERE pa.pet_id=?
            AND pa.assignment_source='CONFIRMED'
            AND m.source_id=?
        `).all(Number(rejectedPetId), Number(candidate.source_id))
          .map((row) => Number(row.pet_detection_id));

        const rejectAssignment = db.prepare(`
          INSERT OR IGNORE INTO pet_assignment_exclusions(
            pet_id,
            pet_detection_id,
            reason
          )
          VALUES(?,?,'USER_REJECTED_SUGGESTION')
        `);

        const candidateIds = members.map((member) =>
          Number(member.pet_detection_id)
        );

        for (const id of candidateIds) {
          rejectAssignment.run(Number(rejectedPetId), id);
        }

        insertPetCannotLinks(
          candidateIds,
          rejectedReferenceIds,
          "USER_REJECTED_SUGGESTION"
        );
      }
    }

    const assign = db.prepare(`
      INSERT INTO pet_assignments(
        pet_detection_id,
        pet_id,
        assignment_source,
        confidence,
        updated_at
      )
      VALUES(?,?,'CONFIRMED',?,CURRENT_TIMESTAMP)
    `);

    const clearExplicitExclusion = db.prepare(`
      DELETE FROM pet_assignment_exclusions
      WHERE pet_id=?
        AND pet_detection_id=?
    `);

    let detectionCount = 0;
    for (const member of members) {
      const petDetectionId = Number(member.pet_detection_id);
      clearExplicitExclusion.run(petId, petDetectionId);
      assign.run(
        petDetectionId,
        petId,
        Number(member.similarity)
      );
      detectionCount += 1;
    }

    db.prepare("DELETE FROM pet_candidates WHERE id=?").run(candidateId);
    db.prepare("DELETE FROM pet_cluster_runs WHERE source_id=?")
      .run(Number(candidate.source_id));

    db.exec("COMMIT");

    return { petId, name, detectionCount };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function equivalentPetDetectionIds(
  petDetectionId: number,
  sourceId: number
): number[] {
  const pet = db.prepare(`
    SELECT
      pd.detection_index,
      pd.fusion_version,
      m.sha256
    FROM pet_fused_detections pd
    JOIN media_items m ON m.id=pd.media_id
    WHERE pd.id=?
      AND m.source_id=?
  `).get(petDetectionId, sourceId);

  if (!pet) return [];

  return db.prepare(`
    SELECT pd.id
    FROM pet_fused_detections pd
    JOIN media_items m ON m.id=pd.media_id
    WHERE m.source_id=?
      AND m.sha256=?
      AND pd.input_sha256=m.sha256
      AND pd.detection_index=?
      AND pd.fusion_version=?
    ORDER BY pd.id
  `).all(
    sourceId,
    String(pet.sha256),
    Number(pet.detection_index),
    String(pet.fusion_version)
  ).map((row) => Number(row.id));
}

function insertPetCannotLinks(
  leftPetIds: number[],
  rightPetIds: number[],
  reason: string
): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pet_cluster_exclusions(
      pet_a_id,
      pet_b_id,
      reason
    )
    VALUES(?,?,?)
  `);

  let changes = 0;

  for (const left of leftPetIds) {
    for (const right of rightPetIds) {
      if (left === right) continue;
      const petAId = Math.min(left, right);
      const petBId = Math.max(left, right);
      changes += Number(insert.run(petAId, petBId, reason).changes);
    }
  }

  return changes;
}

function removePetFromCandidate(
  candidateId: number,
  petDetectionId: number
) {
  const candidate = db.prepare(`
    SELECT source_id
    FROM pet_candidates
    WHERE id=?
  `).get(candidateId);

  if (!candidate) throw new Error("Der Haustiervorschlag wurde nicht gefunden.");

  const sourceId = Number(candidate.source_id);

  const membership = db.prepare(`
    SELECT 1
    FROM pet_candidate_items
    WHERE candidate_id=?
      AND pet_detection_id=?
  `).get(candidateId, petDetectionId);

  if (!membership) {
    throw new Error("Diese Hundefundstelle gehört nicht mehr zu diesem Vorschlag.");
  }

  const equivalentIds = equivalentPetDetectionIds(petDetectionId, sourceId);
  const equivalentSet = new Set(equivalentIds);

  const members = db.prepare(`
    SELECT pet_detection_id
    FROM pet_candidate_items
    WHERE candidate_id=?
  `).all(candidateId).map((row) => Number(row.pet_detection_id));

  const removedIds = members.filter((id) => equivalentSet.has(id));
  const remainingIds = members.filter((id) => !equivalentSet.has(id));

  if (removedIds.length === 0) {
    throw new Error("Die Hundefundstelle konnte im Vorschlag nicht mehr gefunden werden.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    insertPetCannotLinks(removedIds, remainingIds, "USER_SPLIT");

    const remove = db.prepare(`
      DELETE FROM pet_candidate_items
      WHERE candidate_id=?
        AND pet_detection_id=?
    `);

    for (const id of removedIds) remove.run(candidateId, id);

    if (remainingIds.length < 2) {
      db.prepare("DELETE FROM pet_candidates WHERE id=?").run(candidateId);
    } else {
      const representative = db.prepare(`
        SELECT 1
        FROM pet_candidate_items
        WHERE candidate_id=?
          AND pet_detection_id=(
            SELECT representative_pet_id
            FROM pet_candidates
            WHERE id=?
          )
      `).get(candidateId, candidateId);

      if (!representative) {
        db.prepare(`
          UPDATE pet_candidates
          SET representative_pet_id=?
          WHERE id=?
        `).run(remainingIds[0], candidateId);
      }
    }

    db.prepare("DELETE FROM pet_cluster_runs WHERE source_id=?").run(sourceId);

    db.exec("COMMIT");
    return { changed: true, affectedPets: removedIds.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function confirmPetDetection(petId: number, petDetectionId: number) {
  const assignment = db.prepare(`
    SELECT
      pa.assignment_source,
      m.source_id
    FROM pet_assignments pa
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE pa.pet_id=?
      AND pa.pet_detection_id=?
  `).get(petId, petDetectionId);

  if (!assignment) {
    throw new Error("Diese Hundefundstelle ist dem Haustier nicht mehr zugeordnet.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE pet_assignments
      SET
        assignment_source='CONFIRMED',
        updated_at=CURRENT_TIMESTAMP
      WHERE pet_id=?
        AND pet_detection_id=?
    `).run(petId, petDetectionId);

    db.prepare(`
      DELETE FROM pet_assignment_exclusions
      WHERE pet_id=?
        AND pet_detection_id=?
    `).run(petId, petDetectionId);

    db.prepare(`
      UPDATE pets
      SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(petId);

    db.prepare("DELETE FROM pet_cluster_runs WHERE source_id=?")
      .run(Number(assignment.source_id));

    db.exec("COMMIT");

    return {
      changed: true,
      affectedPets:
        String(assignment.assignment_source) === "CONFIRMED" ? 0 : 1
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function removePetFromPet(petId: number, petDetectionId: number) {
  const assignment = db.prepare(`
    SELECT m.source_id
    FROM pet_assignments pa
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE pa.pet_id=?
      AND pa.pet_detection_id=?
  `).get(petId, petDetectionId);

  if (!assignment) {
    throw new Error("Diese Hundefundstelle ist dem Haustier nicht mehr zugeordnet.");
  }

  const sourceId = Number(assignment.source_id);
  const equivalentIds = equivalentPetDetectionIds(petDetectionId, sourceId);
  const equivalentSet = new Set(equivalentIds);

  const assignedIds = db.prepare(`
    SELECT pa.pet_detection_id
    FROM pet_assignments pa
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE pa.pet_id=?
      AND m.source_id=?
  `).all(petId, sourceId).map((row) => Number(row.pet_detection_id));

  const removedIds = assignedIds.filter((id) => equivalentSet.has(id));
  const remainingIds = assignedIds.filter((id) => !equivalentSet.has(id));

  if (removedIds.length === 0) {
    throw new Error("Die korrigierbare Haustierzuordnung wurde nicht gefunden.");
  }

  const insertExclusion = db.prepare(`
    INSERT OR IGNORE INTO pet_assignment_exclusions(
      pet_id,
      pet_detection_id,
      reason
    )
    VALUES(?,?,'USER_REMOVED')
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    insertPetCannotLinks(
      removedIds,
      remainingIds,
      "USER_REMOVED_FROM_PET"
    );

    for (const id of removedIds) {
      insertExclusion.run(petId, id);
      db.prepare(`
        DELETE FROM pet_assignments
        WHERE pet_id=?
          AND pet_detection_id=?
      `).run(petId, id);
    }

    db.prepare(`
      UPDATE pets
      SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(petId);

    db.prepare("DELETE FROM pet_cluster_runs WHERE source_id=?").run(sourceId);

    db.exec("COMMIT");
    return { changed: true, affectedPets: removedIds.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function renamePet(petId: number, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für das Haustier eingeben.");
  if (name.length > 120) throw new Error("Der Haustiername ist zu lang.");

  const pet = db.prepare("SELECT id FROM pets WHERE id=?").get(petId);
  if (!pet) throw new Error("Das Haustier wurde nicht gefunden.");

  db.prepare(`
    UPDATE pets
    SET name=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(name, petId);

  return { changed: true, affectedPets: 0 };
}

function mergePets(targetPetId: number, sourcePetId: number) {
  if (targetPetId === sourcePetId) {
    throw new Error("Ein Haustier kann nicht mit sich selbst zusammengeführt werden.");
  }

  const target = db.prepare(
    "SELECT id, name, pet_class FROM pets WHERE id=?"
  ).get(targetPetId);
  const source = db.prepare(
    "SELECT id, name, pet_class FROM pets WHERE id=?"
  ).get(sourcePetId);

  if (!target || !source) {
    throw new Error("Eines der beiden Haustiere wurde nicht gefunden.");
  }

  if (String(target.pet_class) !== String(source.pet_class)) {
    throw new Error("Nur Haustiere derselben Art können zusammengeführt werden.");
  }

  const sourceDetections = db.prepare(`
    SELECT pet_detection_id
    FROM pet_assignments
    WHERE pet_id=?
  `).all(sourcePetId).map((row) => Number(row.pet_detection_id));

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT OR IGNORE INTO pet_assignment_exclusions(
        pet_id,
        pet_detection_id,
        reason
      )
      SELECT ?, pet_detection_id, reason
      FROM pet_assignment_exclusions
      WHERE pet_id=?
    `).run(targetPetId, sourcePetId);

    const clearContradictingExclusion = db.prepare(`
      DELETE FROM pet_assignment_exclusions
      WHERE pet_id=?
        AND pet_detection_id=?
    `);

    for (const id of sourceDetections) {
      clearContradictingExclusion.run(targetPetId, id);
    }

    db.prepare(`
      UPDATE pet_assignments
      SET
        pet_id=?,
        assignment_source='CONFIRMED',
        updated_at=CURRENT_TIMESTAMP
      WHERE pet_id=?
    `).run(targetPetId, sourcePetId);

    db.prepare("DELETE FROM pets WHERE id=?").run(sourcePetId);
    db.prepare(`
      UPDATE pets
      SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(targetPetId);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM pet_assignments
    WHERE pet_id=?
  `).get(targetPetId);

  return {
    petId: targetPetId,
    name: String(target.name),
    detectionCount: Number(count?.count ?? 0)
  };
}

function getPetCropInfo(petDetectionId: number) {
  const row = db.prepare(`
    SELECT
      pd.id,
      pd.input_sha256,
      pd.pet_class,
      pd.x,
      pd.y,
      pd.width,
      pd.height,
      m.absolute_path,
      m.sha256
    FROM pet_fused_detections pd
    JOIN media_items m ON m.id=pd.media_id
    WHERE pd.id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
  `).get(petDetectionId);

  if (!row) return null;

  return {
    petDetectionId: Number(row.id),
    absolutePath: String(row.absolute_path),
    inputSha256: String(row.input_sha256),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    petClass: String(row.pet_class)
  };
}

function getFaceDetectionsForEmbedding(
  mediaId: number,
  inputSha256: string
) {
  const rows = db.prepare(`
    SELECT id, x, y, width, height, score, landmarks_json
    FROM face_detections
    WHERE media_id=?
      AND input_sha256=?
    ORDER BY detection_index ASC
  `).all(mediaId, inputSha256);

  return rows.map((row) => {
    let landmarks: Array<{ x: number; y: number }> = [];

    try {
      const parsed = JSON.parse(String(row.landmarks_json ?? "[]"));
      if (Array.isArray(parsed)) {
        landmarks = parsed
          .filter((value) => value && typeof value === "object")
          .map((value) => ({
            x: Number((value as Record<string, unknown>).x),
            y: Number((value as Record<string, unknown>).y)
          }))
          .filter((value) => Number.isFinite(value.x) && Number.isFinite(value.y));
      }
    } catch {
      landmarks = [];
    }

    return {
      id: Number(row.id),
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
      score: Number(row.score),
      landmarks
    };
  });
}

function embeddingToBlob(values: unknown): Buffer {
  if (!Array.isArray(values) || values.length === 0 || values.length > 4096) {
    throw new Error("Gesichtsmerkmal-Vektor ist ungültig.");
  }

  const buffer = Buffer.allocUnsafe(values.length * 4);

  for (let index = 0; index < values.length; index += 1) {
    const number = Number(values[index]);
    if (!Number.isFinite(number)) {
      throw new Error("Gesichtsmerkmal enthält einen ungültigen Zahlenwert.");
    }
    buffer.writeFloatLE(number, index * 4);
  }

  return buffer;
}

function completeFaceEmbeddingJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Gesichtsmerkmal-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const rawEmbeddings = Array.isArray(value.embeddings) ? value.embeddings : [];
  const modelVersion =
    typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : "SFace 2021dec";

  const job = jobForModule(jobId, "face-embed-sface-v1");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  let written = 0;

  const insert = db.prepare(`
    INSERT INTO face_embeddings(
      face_detection_id,
      media_id,
      model_version,
      input_sha256,
      dimension,
      vector_blob,
      updated_at
    )
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(face_detection_id, model_version) DO UPDATE SET
      media_id=excluded.media_id,
      input_sha256=excluded.input_sha256,
      dimension=excluded.dimension,
      vector_blob=excluded.vector_blob,
      updated_at=CURRENT_TIMESTAMP
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      DELETE FROM face_embeddings
      WHERE media_id=?
        AND model_version=?
    `).run(mediaId, modelVersion);

    for (const raw of rawEmbeddings) {
      if (!raw || typeof raw !== "object") continue;

      const item = raw as Record<string, unknown>;
      const faceDetectionId = Number(item.faceDetectionId);
      if (!Number.isInteger(faceDetectionId) || faceDetectionId <= 0) continue;

      const belongsToMedia = db.prepare(`
        SELECT 1
        FROM face_detections
        WHERE id=?
          AND media_id=?
          AND input_sha256=?
      `).get(faceDetectionId, mediaId, inputSha256);

      if (!belongsToMedia) continue;

      const vector = Array.isArray(item.vector) ? item.vector : [];
      const blob = embeddingToBlob(vector);

      insert.run(
        faceDetectionId,
        mediaId,
        modelVersion,
        inputSha256,
        vector.length,
        blob
      );
      written += 1;
    }

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      JSON.stringify({ model: modelVersion, embeddingCount: written }),
      jobId
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { completed: true, embeddingCount: written };
}

function vectorFromBlob(value: unknown, dimension: number): number[] {
  let buffer: Buffer;

  if (Buffer.isBuffer(value)) {
    buffer = value;
  } else if (value instanceof Uint8Array) {
    buffer = Buffer.from(value);
  } else {
    throw new Error("Gesichtsmerkmal konnte nicht aus SQLite gelesen werden.");
  }

  if (
    !Number.isInteger(dimension) ||
    dimension <= 0 ||
    dimension > 4096 ||
    buffer.length !== dimension * 4
  ) {
    throw new Error("Gesichtsmerkmal hat eine ungültige Dimension.");
  }

  const vector = new Array<number>(dimension);
  for (let index = 0; index < dimension; index += 1) {
    vector[index] = buffer.readFloatLE(index * 4);
  }
  return vector;
}

function getFaceEmbeddingsForClustering(
  sourceId: number,
  algorithmVersion: string
) {
  const rows = db.prepare(`
    SELECT
      fd.id AS face_detection_id,
      fd.detection_index,
      fe.media_id,
      fe.dimension,
      fe.vector_blob,
      fe.updated_at,
      m.sha256
    FROM face_embeddings fe
    JOIN face_detections fd ON fd.id=fe.face_detection_id
    JOIN media_items m ON m.id=fe.media_id
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=fd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND fe.model_version='SFace 2021dec'
      AND fe.input_sha256=m.sha256
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
    ORDER BY fd.id ASC
  `).all(sourceId);

  const faceIds = rows.map((row) => Number(row.face_detection_id));
  const maxUpdatedAt = rows.reduce(
    (current, row) =>
      String(row.updated_at ?? "") > current ? String(row.updated_at ?? "") : current,
    ""
  );
  const idSum = faceIds.reduce((sum, id) => sum + id, 0);

  const assignmentCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM person_face_assignments pfa
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE m.source_id=?
  `).get(sourceId);

  const cannotLinkRows = db.prepare(`
    SELECT pce.face_a_id, pce.face_b_id, pce.created_at
    FROM person_cluster_exclusions pce
    JOIN face_detections fa ON fa.id=pce.face_a_id
    JOIN media_items ma ON ma.id=fa.media_id
    JOIN face_detections fb ON fb.id=pce.face_b_id
    JOIN media_items mb ON mb.id=fb.media_id
    WHERE ma.source_id=?
      AND mb.source_id=?
  `).all(sourceId, sourceId);

  const cannotLinkSignature = cannotLinkRows
    .map((row) =>
      `${Number(row.face_a_id)}-${Number(row.face_b_id)}-${String(row.created_at ?? "")}`
    )
    .sort()
    .join("|");

  const revision = [
    rows.length,
    faceIds.length > 0 ? Math.max(...faceIds) : 0,
    idSum,
    maxUpdatedAt,
    Number(assignmentCount?.count ?? 0),
    cannotLinkSignature
  ].join(":");

  const previousRun = db.prepare(`
    SELECT embedding_revision, algorithm_version
    FROM person_cluster_runs
    WHERE source_id=?
  `).get(sourceId);

  return {
    revision,
    needsRebuild:
      !previousRun ||
      String(previousRun.embedding_revision) !== revision ||
      String(previousRun.algorithm_version) !== algorithmVersion,
    faces: rows.map((row) => ({
      faceDetectionId: Number(row.face_detection_id),
      mediaId: Number(row.media_id),
      contentKey: `${String(row.sha256)}:${Number(row.detection_index)}`,
      vector: vectorFromBlob(row.vector_blob, Number(row.dimension))
    })),
    cannotLinks: cannotLinkRows.map((row) => ({
      faceAId: Number(row.face_a_id),
      faceBId: Number(row.face_b_id)
    }))
  };
}

function replacePersonCandidates(
  sourceId: number,
  revision: string,
  algorithmVersion: string,
  rawClusters: unknown
) {
  const clusters = Array.isArray(rawClusters) ? rawClusters : [];

  const eligibleRows = db.prepare(`
    SELECT fd.id
    FROM face_detections fd
    JOIN face_embeddings fe ON fe.face_detection_id=fd.id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa ON pfa.face_detection_id=fd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND fe.model_version='SFace 2021dec'
      AND fe.input_sha256=m.sha256
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
  `).all(sourceId);

  const eligibleIds = new Set(
    eligibleRows.map((row) => Number(row.id))
  );

  const insertCandidate = db.prepare(`
    INSERT INTO person_candidates(
      source_id,
      algorithm_version,
      representative_face_id,
      average_similarity,
      min_similarity
    )
    VALUES(?,?,?,?,?)
  `);

  const insertMember = db.prepare(`
    INSERT INTO person_candidate_faces(
      candidate_id,
      face_detection_id,
      similarity
    )
    VALUES(?,?,?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM person_candidates WHERE source_id=?").run(sourceId);

    let writtenClusters = 0;
    let writtenFaces = 0;
    const usedFaces = new Set<number>();

    for (const rawCluster of clusters) {
      if (!rawCluster || typeof rawCluster !== "object") continue;
      const cluster = rawCluster as Record<string, unknown>;
      const rawMembers = Array.isArray(cluster.members) ? cluster.members : [];

      const members = rawMembers
        .filter((value) => value && typeof value === "object")
        .map((value) => {
          const item = value as Record<string, unknown>;
          return {
            faceDetectionId: Number(item.faceDetectionId),
            similarity: Number(item.similarity)
          };
        })
        .filter(
          (member) =>
            Number.isInteger(member.faceDetectionId) &&
            eligibleIds.has(member.faceDetectionId) &&
            Number.isFinite(member.similarity) &&
            !usedFaces.has(member.faceDetectionId)
        );

      if (members.length === 0) continue;

      const requestedRepresentative = Number(cluster.representativeFaceId);
      const representativeFaceId = members.some(
        (member) => member.faceDetectionId === requestedRepresentative
      )
        ? requestedRepresentative
        : members[0].faceDetectionId;

      const averageSimilarity = Number(cluster.averageSimilarity);
      const minSimilarity = Number(cluster.minSimilarity);

      const inserted = insertCandidate.run(
        sourceId,
        algorithmVersion,
        representativeFaceId,
        Number.isFinite(averageSimilarity) ? averageSimilarity : 1,
        Number.isFinite(minSimilarity) ? minSimilarity : 1
      );
      const candidateId = Number(inserted.lastInsertRowid);

      for (const member of members) {
        insertMember.run(
          candidateId,
          member.faceDetectionId,
          member.similarity
        );
        usedFaces.add(member.faceDetectionId);
        writtenFaces += 1;
      }

      writtenClusters += 1;
    }

    db.prepare(`
      INSERT INTO person_cluster_runs(
        source_id,
        embedding_revision,
        algorithm_version,
        updated_at
      )
      VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source_id) DO UPDATE SET
        embedding_revision=excluded.embedding_revision,
        algorithm_version=excluded.algorithm_version,
        updated_at=CURRENT_TIMESTAMP
    `).run(sourceId, revision, algorithmVersion);

    db.exec("COMMIT");
    return { writtenClusters, writtenFaces };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function listPersonCandidates(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(500, Math.trunc(requestedLimit || 100)));

  const candidates = db.prepare(`
    SELECT
      pc.id,
      pc.representative_face_id,
      pc.average_similarity,
      pc.min_similarity,
      COUNT(pcf.face_detection_id) AS face_count
    FROM person_candidates pc
    JOIN person_candidate_faces pcf ON pcf.candidate_id=pc.id
    WHERE pc.source_id=?
    GROUP BY pc.id
    ORDER BY face_count DESC, pc.average_similarity DESC, pc.id ASC
    LIMIT ?
  `).all(sourceId, limit);

  const faceQuery = db.prepare(`
    SELECT
      pcf.face_detection_id,
      fd.media_id,
      m.relative_path,
      pcf.similarity
    FROM person_candidate_faces pcf
    JOIN face_detections fd ON fd.id=pcf.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE pcf.candidate_id=?
    ORDER BY
      CASE WHEN pcf.face_detection_id=? THEN 0 ELSE 1 END,
      pcf.similarity DESC,
      pcf.face_detection_id ASC
    LIMIT 48
  `);

  return candidates.map((candidate) => {
    const representativeFaceId = candidate.representative_face_id === null
      ? null
      : Number(candidate.representative_face_id);

    return {
      id: Number(candidate.id),
      faceCount: Number(candidate.face_count),
      representativeFaceId,
      averageSimilarity: Number(candidate.average_similarity),
      minSimilarity: Number(candidate.min_similarity),
      faces: faceQuery.all(
        Number(candidate.id),
        representativeFaceId ?? -1
      ).map((row) => ({
        faceDetectionId: Number(row.face_detection_id),
        mediaId: Number(row.media_id),
        relativePath: String(row.relative_path),
        similarity: Number(row.similarity)
      }))
    };
  });
}

function listPersons(sourceId: number) {
  const persons = db.prepare(`
    SELECT
      p.id,
      p.name,
      COUNT(*) AS face_count,
      MIN(fd.id) AS representative_face_id
    FROM persons p
    JOIN person_face_assignments pfa ON pfa.person_id=p.id
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE m.source_id=?
    GROUP BY p.id, p.name
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(sourceId);

  const faceQuery = db.prepare(`
    SELECT
      pfa.face_detection_id,
      fd.media_id,
      m.relative_path,
      pfa.confidence
    FROM person_face_assignments pfa
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE pfa.person_id=?
      AND m.source_id=?
    ORDER BY pfa.face_detection_id ASC
    LIMIT 48
  `);

  return persons.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    faceCount: Number(row.face_count),
    representativeFaceId:
      row.representative_face_id === null ? null : Number(row.representative_face_id),
    faces: faceQuery.all(Number(row.id), sourceId).map((face) => ({
      faceDetectionId: Number(face.face_detection_id),
      mediaId: Number(face.media_id),
      relativePath: String(face.relative_path),
      confidence:
        face.confidence === null || face.confidence === undefined
          ? null
          : Number(face.confidence)
    }))
  }));
}

function equivalentFaceIds(faceDetectionId: number, sourceId: number): number[] {
  const face = db.prepare(`
    SELECT
      fd.detection_index,
      fd.detector_version,
      m.sha256
    FROM face_detections fd
    JOIN media_items m ON m.id=fd.media_id
    WHERE fd.id=?
      AND m.source_id=?
  `).get(faceDetectionId, sourceId);

  if (!face) return [];

  return db.prepare(`
    SELECT fd.id
    FROM face_detections fd
    JOIN media_items m ON m.id=fd.media_id
    WHERE m.source_id=?
      AND m.sha256=?
      AND fd.input_sha256=m.sha256
      AND fd.detection_index=?
      AND fd.detector_version=?
    ORDER BY fd.id
  `).all(
    sourceId,
    String(face.sha256),
    Number(face.detection_index),
    String(face.detector_version)
  ).map((row) => Number(row.id));
}

function insertCannotLinks(
  leftFaceIds: number[],
  rightFaceIds: number[],
  reason: string
): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO person_cluster_exclusions(
      face_a_id,
      face_b_id,
      reason
    )
    VALUES(?,?,?)
  `);

  let changes = 0;

  for (const left of leftFaceIds) {
    for (const right of rightFaceIds) {
      if (left === right) continue;
      const faceAId = Math.min(left, right);
      const faceBId = Math.max(left, right);
      changes += Number(insert.run(faceAId, faceBId, reason).changes);
    }
  }

  return changes;
}

function removeFaceFromPersonCandidate(
  candidateId: number,
  faceDetectionId: number
) {
  const candidate = db.prepare(`
    SELECT source_id
    FROM person_candidates
    WHERE id=?
  `).get(candidateId);

  if (!candidate) throw new Error("Der Personenvorschlag wurde nicht gefunden.");

  const sourceId = Number(candidate.source_id);

  const membership = db.prepare(`
    SELECT 1
    FROM person_candidate_faces
    WHERE candidate_id=?
      AND face_detection_id=?
  `).get(candidateId, faceDetectionId);

  if (!membership) {
    throw new Error("Das Gesicht gehört nicht mehr zu diesem Personenvorschlag.");
  }

  const equivalentIds = equivalentFaceIds(faceDetectionId, sourceId);
  const equivalentSet = new Set(equivalentIds);

  const members = db.prepare(`
    SELECT face_detection_id
    FROM person_candidate_faces
    WHERE candidate_id=?
  `).all(candidateId).map((row) => Number(row.face_detection_id));

  const removedIds = members.filter((id) => equivalentSet.has(id));
  const remainingIds = members.filter((id) => !equivalentSet.has(id));

  if (removedIds.length === 0) {
    throw new Error("Das Gesicht konnte im Vorschlag nicht mehr gefunden werden.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    insertCannotLinks(removedIds, remainingIds, "USER_SPLIT");

    const deleteMember = db.prepare(`
      DELETE FROM person_candidate_faces
      WHERE candidate_id=?
        AND face_detection_id=?
    `);

    for (const id of removedIds) deleteMember.run(candidateId, id);

    if (remainingIds.length === 0) {
      db.prepare("DELETE FROM person_candidates WHERE id=?").run(candidateId);
    } else {
      const representative = db.prepare(`
        SELECT 1
        FROM person_candidate_faces
        WHERE candidate_id=?
          AND face_detection_id=(
            SELECT representative_face_id
            FROM person_candidates
            WHERE id=?
          )
      `).get(candidateId, candidateId);

      if (!representative) {
        db.prepare(`
          UPDATE person_candidates
          SET representative_face_id=?
          WHERE id=?
        `).run(remainingIds[0], candidateId);
      }
    }

    db.prepare("DELETE FROM person_cluster_runs WHERE source_id=?").run(sourceId);

    db.exec("COMMIT");
    return { changed: true, affectedFaces: removedIds.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function removeFaceFromPerson(personId: number, faceDetectionId: number) {
  const assignment = db.prepare(`
    SELECT m.source_id
    FROM person_face_assignments pfa
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE pfa.person_id=?
      AND pfa.face_detection_id=?
  `).get(personId, faceDetectionId);

  if (!assignment) {
    throw new Error("Das Gesicht ist dieser Person nicht mehr zugeordnet.");
  }

  const sourceId = Number(assignment.source_id);
  const equivalentIds = equivalentFaceIds(faceDetectionId, sourceId);
  const equivalentSet = new Set(equivalentIds);

  const assignedEquivalentIds = db.prepare(`
    SELECT pfa.face_detection_id
    FROM person_face_assignments pfa
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE pfa.person_id=?
      AND m.source_id=?
  `).all(personId, sourceId)
    .map((row) => Number(row.face_detection_id))
    .filter((id) => equivalentSet.has(id));

  const remainingSourceFaceIds = db.prepare(`
    SELECT pfa.face_detection_id
    FROM person_face_assignments pfa
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE pfa.person_id=?
      AND m.source_id=?
  `).all(personId, sourceId)
    .map((row) => Number(row.face_detection_id))
    .filter((id) => !equivalentSet.has(id));

  if (assignedEquivalentIds.length === 0) {
    throw new Error("Die korrigierbare Gesichtszuordnung wurde nicht gefunden.");
  }

  const insertPersonExclusion = db.prepare(`
    INSERT OR IGNORE INTO person_face_exclusions(
      person_id,
      face_detection_id,
      reason
    )
    VALUES(?,?,'USER_REMOVED')
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    insertCannotLinks(
      assignedEquivalentIds,
      remainingSourceFaceIds,
      "USER_REMOVED_FROM_PERSON"
    );

    for (const id of assignedEquivalentIds) {
      insertPersonExclusion.run(personId, id);
      db.prepare(`
        DELETE FROM person_face_assignments
        WHERE person_id=?
          AND face_detection_id=?
      `).run(personId, id);
    }

    db.prepare(`
      UPDATE persons
      SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(personId);

    db.prepare("DELETE FROM person_cluster_runs WHERE source_id=?").run(sourceId);

    db.exec("COMMIT");
    return { changed: true, affectedFaces: assignedEquivalentIds.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function renamePerson(personId: number, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für die Person eingeben.");
  if (name.length > 120) throw new Error("Der Personenname ist zu lang.");

  const person = db.prepare("SELECT id FROM persons WHERE id=?").get(personId);
  if (!person) throw new Error("Die Person wurde nicht gefunden.");

  db.prepare(`
    UPDATE persons
    SET name=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(name, personId);

  return { changed: true, affectedFaces: 0 };
}

function mergePersons(targetPersonId: number, sourcePersonId: number) {
  if (targetPersonId === sourcePersonId) {
    throw new Error("Eine Person kann nicht mit sich selbst zusammengeführt werden.");
  }

  const target = db.prepare("SELECT id, name FROM persons WHERE id=?")
    .get(targetPersonId);
  const source = db.prepare("SELECT id, name FROM persons WHERE id=?")
    .get(sourcePersonId);

  if (!target || !source) {
    throw new Error("Eine der beiden Personen wurde nicht gefunden.");
  }

  const sourceFaces = db.prepare(`
    SELECT face_detection_id
    FROM person_face_assignments
    WHERE person_id=?
  `).all(sourcePersonId).map((row) => Number(row.face_detection_id));

  const copyExclusions = db.prepare(`
    INSERT OR IGNORE INTO person_face_exclusions(
      person_id,
      face_detection_id,
      reason
    )
    SELECT ?, face_detection_id, reason
    FROM person_face_exclusions
    WHERE person_id=?
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    copyExclusions.run(targetPersonId, sourcePersonId);

    const clearContradictingExclusion = db.prepare(`
      DELETE FROM person_face_exclusions
      WHERE person_id=?
        AND face_detection_id=?
    `);

    for (const faceId of sourceFaces) {
      clearContradictingExclusion.run(targetPersonId, faceId);
    }

    db.prepare(`
      UPDATE person_face_assignments
      SET
        person_id=?,
        assignment_source='CONFIRMED',
        updated_at=CURRENT_TIMESTAMP
      WHERE person_id=?
    `).run(targetPersonId, sourcePersonId);

    db.prepare("DELETE FROM persons WHERE id=?").run(sourcePersonId);
    db.prepare(`
      UPDATE persons
      SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(targetPersonId);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM person_face_assignments
    WHERE person_id=?
  `).get(targetPersonId);

  return {
    personId: targetPersonId,
    name: String(target.name),
    faceCount: Number(count?.count ?? 0)
  };
}

function confirmPersonCandidate(candidateId: number, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für die Person eingeben.");
  if (name.length > 120) throw new Error("Der Personenname ist zu lang.");

  const candidate = db.prepare(`
    SELECT id, source_id
    FROM person_candidates
    WHERE id=?
  `).get(candidateId);

  if (!candidate) {
    throw new Error("Der Personenvorschlag wurde nicht mehr gefunden.");
  }

  const members = db.prepare(`
    SELECT pcf.face_detection_id, pcf.similarity
    FROM person_candidate_faces pcf
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND pfa.face_detection_id IS NULL
    ORDER BY pcf.face_detection_id
  `).all(candidateId);

  if (members.length === 0) {
    throw new Error("Der Personenvorschlag enthält keine unbestätigten Gesichter mehr.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const existingPerson = db.prepare(`
      SELECT id
      FROM persons
      WHERE name = ? COLLATE NOCASE
      ORDER BY id ASC
      LIMIT 1
    `).get(name);

    const personId = existingPerson
      ? Number(existingPerson.id)
      : Number(
          db.prepare(`
            INSERT INTO persons(name)
            VALUES(?)
          `).run(name).lastInsertRowid
        );

    db.prepare(`
      UPDATE persons
      SET name=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(name, personId);

    const assign = db.prepare(`
      INSERT INTO person_face_assignments(
        face_detection_id,
        person_id,
        assignment_source,
        confidence,
        updated_at
      )
      VALUES(?,?,'CONFIRMED',?,CURRENT_TIMESTAMP)
    `);

    const clearExplicitExclusion = db.prepare(`
      DELETE FROM person_face_exclusions
      WHERE person_id=?
        AND face_detection_id=?
    `);

    let faceCount = 0;
    for (const member of members) {
      const faceDetectionId = Number(member.face_detection_id);
      clearExplicitExclusion.run(personId, faceDetectionId);
      assign.run(
        faceDetectionId,
        personId,
        Number(member.similarity)
      );
      faceCount += 1;
    }

    db.prepare("DELETE FROM person_candidates WHERE id=?").run(candidateId);
    db.prepare("DELETE FROM person_cluster_runs WHERE source_id=?")
      .run(Number(candidate.source_id));

    db.exec("COMMIT");

    return { personId, name, faceCount };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getFaceCropInfo(faceDetectionId: number) {
  const row = db.prepare(`
    SELECT
      fd.id,
      fd.input_sha256,
      fd.x,
      fd.y,
      fd.width,
      fd.height,
      m.absolute_path,
      m.sha256
    FROM face_detections fd
    JOIN media_items m ON m.id=fd.media_id
    WHERE fd.id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
  `).get(faceDetectionId);

  if (!row) return null;

  return {
    faceDetectionId: Number(row.id),
    absolutePath: String(row.absolute_path),
    inputSha256: String(row.input_sha256),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height)
  };
}

function completeThumbnailJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Thumbnail-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const thumbnailPath = typeof value.path === "string" ? value.path : "";
  const width = Number(value.width);
  const height = Number(value.height);
  const format = typeof value.format === "string" ? value.format : "jpeg";

  if (!thumbnailPath || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Thumbnail-Ergebnis ist unvollständig.");
  }

  const job = db.prepare(`
    SELECT id, media_id, input_sha256, status
    FROM analysis_jobs
    WHERE id=? AND module='thumbnail-v1'
  `).get(jobId);

  if (!job) throw new Error("Thumbnail-Job wurde nicht gefunden.");
  if (String(job.status) !== "RUNNING") {
    throw new Error("Thumbnail-Job ist nicht im Status RUNNING.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO media_thumbnails(
        media_id,
        input_sha256,
        path,
        width,
        height,
        format,
        updated_at
      )
      VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(media_id) DO UPDATE SET
        input_sha256=excluded.input_sha256,
        path=excluded.path,
        width=excluded.width,
        height=excluded.height,
        format=excluded.format,
        updated_at=CURRENT_TIMESTAMP
    `).run(
      Number(job.media_id),
      String(job.input_sha256 ?? ""),
      thumbnailPath,
      Math.trunc(width),
      Math.trunc(height),
      format
    );

    db.prepare(`
      UPDATE analysis_jobs
      SET
        status='DONE',
        result_json=?,
        error_message=NULL,
        finished_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(JSON.stringify(result), jobId);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { completed: true };
}

function getThumbnailInfo(mediaId: number) {
  const row = db.prepare(`
    SELECT
      t.media_id,
      t.path,
      t.input_sha256,
      t.width,
      t.height,
      t.format
    FROM media_thumbnails t
    JOIN media_items m ON m.id=t.media_id
    WHERE t.media_id=?
      AND t.input_sha256=m.sha256
  `).get(mediaId);

  if (!row) return null;

  return {
    mediaId: Number(row.media_id),
    path: String(row.path),
    inputSha256: String(row.input_sha256),
    width: Number(row.width),
    height: Number(row.height),
    format: String(row.format)
  };
}

async function restoreMedia(mediaId: number): Promise<RestoreResult> {
  const row = db.prepare(`
    SELECT
      m.id,
      m.source_id,
      m.absolute_path,
      m.availability,
      m.in_recycle_bin,
      m.recycle_path,
      m.recycle_original_path,
      s.path AS source_path
    FROM media_items m
    JOIN media_sources s ON s.id=m.source_id
    WHERE m.id=?
  `).get(mediaId);

  if (!row) throw new Error("Medium wurde im Katalog nicht gefunden.");

  if (String(row.availability) !== "MISSING" || !Boolean(row.in_recycle_bin)) {
    throw new Error("Dieses Medium ist nicht als wiederherstellbar im Papierkorb markiert.");
  }

  const catalogPath = String(row.absolute_path);
  const restoreTarget = row.recycle_original_path
    ? String(row.recycle_original_path)
    : catalogPath;
  const recyclePath = row.recycle_path ? String(row.recycle_path) : null;

  await restoreRecycleBinItem(restoreTarget, recyclePath);

  if (!(await isReadable(restoreTarget))) {
    throw new Error("Windows meldet die Wiederherstellung, aber die Datei ist noch nicht erreichbar.");
  }

  const info = await stat(restoreTarget);
  const hash = await sha256File(restoreTarget);
  const identity = await readPathIdentity(restoreTarget);
  const sourcePath = String(row.source_path);
  const relativePath = path.relative(sourcePath, restoreTarget).split(path.sep).join("/");

  if (relativePath.startsWith("../") || relativePath === ".." || path.isAbsolute(relativePath)) {
    throw new Error("Die wiederhergestellte Datei liegt außerhalb der eingestellten Medienquelle.");
  }

  db.prepare(`
    UPDATE media_items
    SET
      relative_path=?,
      absolute_path=?,
      size_bytes=?,
      mtime_ms=?,
      sha256=?,
      device_id=?,
      inode=?,
      availability='AVAILABLE',
      in_recycle_bin=0,
      recycle_ambiguous=0,
      recycle_path=NULL,
      recycle_original_path=NULL,
      recycle_detected_at=NULL,
      last_seen_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    relativePath,
    restoreTarget,
    info.size,
    Math.trunc(info.mtimeMs),
    hash,
    identity?.deviceId ?? null,
    identity?.inode ?? null,
    mediaId
  );

  return {
    restored: true,
    path: restoreTarget
  };
}

function getMediaDetails(mediaId: number) {
  const media = db.prepare(`
    SELECT
      m.id,
      m.source_id,
      m.relative_path,
      m.absolute_path,
      m.extension,
      m.size_bytes,
      m.mtime_ms,
      m.sha256,
      m.availability,
      m.device_id,
      m.inode,
      m.first_seen_at,
      m.last_seen_at,
      m.last_changed_at,
      m.last_moved_at,
      m.recycle_path,
      (
        SELECT COUNT(*) - 1
        FROM media_items d
        WHERE d.source_id=m.source_id
          AND d.sha256=m.sha256
          AND d.size_bytes=m.size_bytes
          AND d.availability='AVAILABLE'
      ) AS duplicate_count
    FROM media_items m
    WHERE m.id=?
  `).get(mediaId);

  if (!media) return null;

  const currentSha = String(media.sha256);

  const metadata = db.prepare(`
    SELECT
      width,
      height,
      format,
      color_mode,
      orientation,
      captured_at,
      camera_make,
      camera_model,
      lens_model,
      gps_latitude,
      gps_longitude,
      updated_at
    FROM media_image_metadata
    WHERE media_id=?
      AND input_sha256=?
  `).get(mediaId, currentSha);

  const faceRows = db.prepare(`
    SELECT
      fd.id,
      fd.detector_version,
      fd.score,
      fd.x,
      fd.y,
      fd.width,
      fd.height,
      fe.model_version AS embedding_model,
      p.id AS person_id,
      p.name AS person_name,
      pfa.assignment_source,
      pfa.confidence AS assignment_confidence,
      (
        SELECT pcf.candidate_id
        FROM person_candidate_faces pcf
        WHERE pcf.face_detection_id=fd.id
        ORDER BY pcf.similarity DESC
        LIMIT 1
      ) AS candidate_id,
      (
        SELECT pcf.similarity
        FROM person_candidate_faces pcf
        WHERE pcf.face_detection_id=fd.id
        ORDER BY pcf.similarity DESC
        LIMIT 1
      ) AS candidate_similarity
    FROM face_detections fd
    LEFT JOIN face_embeddings fe
      ON fe.face_detection_id=fd.id
      AND fe.input_sha256=?
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=fd.id
    LEFT JOIN persons p
      ON p.id=pfa.person_id
    WHERE fd.media_id=?
      AND fd.input_sha256=?
    ORDER BY fd.detection_index, fd.id
  `).all(currentSha, mediaId, currentSha);

  const petRows = db.prepare(`
    SELECT
      pd.id,
      pd.pet_class,
      pd.score,
      pd.x,
      pd.y,
      pd.width,
      pd.height,
      pd.fusion_version,
      pd.agreement_count,
      pd.sources_json,
      pe.model_version AS embedding_model,
      p.id AS pet_id,
      p.name AS pet_name,
      pa.assignment_source,
      pa.confidence AS assignment_confidence,
      (
        SELECT pci.candidate_id
        FROM pet_candidate_items pci
        WHERE pci.pet_detection_id=pd.id
        ORDER BY pci.similarity DESC
        LIMIT 1
      ) AS candidate_id,
      (
        SELECT pci.similarity
        FROM pet_candidate_items pci
        WHERE pci.pet_detection_id=pd.id
        ORDER BY pci.similarity DESC
        LIMIT 1
      ) AS candidate_similarity
    FROM pet_fused_detections pd
    LEFT JOIN pet_embeddings pe
      ON pe.pet_detection_id=pd.id
      AND pe.input_sha256=?
    LEFT JOIN pet_assignments pa
      ON pa.pet_detection_id=pd.id
    LEFT JOIN pets p
      ON p.id=pa.pet_id
    WHERE pd.media_id=?
      AND pd.input_sha256=?
    ORDER BY pd.detection_index, pd.id
  `).all(currentSha, mediaId, currentSha);

  const fusedObjects = db.prepare(`
    SELECT
      label,
      score,
      x,
      y,
      width,
      height,
      fusion_version AS version,
      agreement_count,
      sources_json
    FROM object_fused_detections
    WHERE media_id=?
      AND input_sha256=?
    ORDER BY detection_index, id
  `).all(mediaId, currentSha);

  const rawObjects = db.prepare(`
    SELECT
      label,
      score,
      x,
      y,
      width,
      height,
      detector_version AS version
    FROM object_detections
    WHERE media_id=?
      AND input_sha256=?
    ORDER BY detector_version, detection_index, id
  `).all(mediaId, currentSha);

  const embedding = db.prepare(`
    SELECT
      model_version,
      dimension,
      max_num_patches,
      precision,
      updated_at
    FROM semantic_embeddings
    WHERE media_id=?
      AND input_sha256=?
  `).get(mediaId, currentSha);

  const semantic = db.prepare(`
    SELECT
      model_version,
      profile_version,
      description,
      subjects_json,
      actions_json,
      scenes_json,
      visible_text_json,
      tags_json,
      concepts_json,
      repaired,
      region_count,
      regions_json,
      timings_json,
      updated_at
    FROM media_semantic_annotations
    WHERE media_id=?
      AND input_sha256=?
  `).get(mediaId, currentSha);

  const jobs = db.prepare(`
    SELECT
      module,
      status,
      attempts,
      error_message,
      started_at,
      finished_at,
      updated_at
    FROM analysis_jobs
    WHERE media_id=?
    ORDER BY id
  `).all(mediaId);

  const jsonArray = (value: unknown): unknown[] => {
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const jsonObject = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "string" || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  };

  const stringArray = (value: unknown): string[] =>
    jsonArray(value).filter((entry): entry is string => typeof entry === "string");

  return {
    mediaId: Number(media.id),
    sourceId: Number(media.source_id),
    relativePath: String(media.relative_path),
    absolutePath: String(media.absolute_path),
    extension: String(media.extension),
    sizeBytes: Number(media.size_bytes),
    mtimeMs: Number(media.mtime_ms),
    sha256: currentSha,
    availability: String(media.availability),
    deviceId: media.device_id ? String(media.device_id) : null,
    inode: media.inode ? String(media.inode) : null,
    firstSeenAt: String(media.first_seen_at),
    lastSeenAt: String(media.last_seen_at),
    lastChangedAt: String(media.last_changed_at),
    lastMovedAt: media.last_moved_at ? String(media.last_moved_at) : null,
    recyclePath: media.recycle_path ? String(media.recycle_path) : null,
    duplicateCount: Math.max(0, Number(media.duplicate_count ?? 0)),
    imageMetadata: metadata
      ? {
          width: Number(metadata.width),
          height: Number(metadata.height),
          format: metadata.format ? String(metadata.format) : null,
          colorMode: metadata.color_mode ? String(metadata.color_mode) : null,
          orientation: metadata.orientation === null || metadata.orientation === undefined
            ? null
            : Number(metadata.orientation),
          capturedAt: metadata.captured_at ? String(metadata.captured_at) : null,
          cameraMake: metadata.camera_make ? String(metadata.camera_make) : null,
          cameraModel: metadata.camera_model ? String(metadata.camera_model) : null,
          lensModel: metadata.lens_model ? String(metadata.lens_model) : null,
          gpsLatitude: metadata.gps_latitude === null || metadata.gps_latitude === undefined
            ? null
            : Number(metadata.gps_latitude),
          gpsLongitude: metadata.gps_longitude === null || metadata.gps_longitude === undefined
            ? null
            : Number(metadata.gps_longitude),
          updatedAt: String(metadata.updated_at)
        }
      : null,
    faces: faceRows.map((row) => ({
      id: Number(row.id),
      detectorVersion: String(row.detector_version),
      score: Number(row.score),
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
      embeddingReady: Boolean(row.embedding_model),
      embeddingModel: row.embedding_model ? String(row.embedding_model) : null,
      personId: row.person_id === null || row.person_id === undefined ? null : Number(row.person_id),
      personName: row.person_name ? String(row.person_name) : null,
      assignmentSource: row.assignment_source ? String(row.assignment_source) : null,
      assignmentConfidence:
        row.assignment_confidence === null || row.assignment_confidence === undefined
          ? null
          : Number(row.assignment_confidence),
      candidateId: row.candidate_id === null || row.candidate_id === undefined
        ? null
        : Number(row.candidate_id),
      candidateSimilarity:
        row.candidate_similarity === null || row.candidate_similarity === undefined
          ? null
          : Number(row.candidate_similarity)
    })),
    pets: petRows.map((row) => ({
      id: Number(row.id),
      petClass: String(row.pet_class) === "cat" ? "cat" : "dog",
      score: Number(row.score),
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
      fusionVersion: String(row.fusion_version),
      agreementCount: Number(row.agreement_count),
      sources: stringArray(row.sources_json),
      embeddingReady: Boolean(row.embedding_model),
      embeddingModel: row.embedding_model ? String(row.embedding_model) : null,
      petId: row.pet_id === null || row.pet_id === undefined ? null : Number(row.pet_id),
      petName: row.pet_name ? String(row.pet_name) : null,
      assignmentSource: row.assignment_source ? String(row.assignment_source) : null,
      assignmentConfidence:
        row.assignment_confidence === null || row.assignment_confidence === undefined
          ? null
          : Number(row.assignment_confidence),
      candidateId: row.candidate_id === null || row.candidate_id === undefined
        ? null
        : Number(row.candidate_id),
      candidateSimilarity:
        row.candidate_similarity === null || row.candidate_similarity === undefined
          ? null
          : Number(row.candidate_similarity)
    })),
    objects: [
      ...fusedObjects.map((row) => ({
        label: String(row.label),
        score: Number(row.score),
        x: Number(row.x),
        y: Number(row.y),
        width: Number(row.width),
        height: Number(row.height),
        version: String(row.version),
        agreementCount: Number(row.agreement_count),
        sources: stringArray(row.sources_json),
        raw: false
      })),
      ...rawObjects.map((row) => ({
        label: String(row.label),
        score: Number(row.score),
        x: Number(row.x),
        y: Number(row.y),
        width: Number(row.width),
        height: Number(row.height),
        version: String(row.version),
        agreementCount: null,
        sources: [],
        raw: true
      }))
    ],
    semanticEmbedding: embedding
      ? {
          model: String(embedding.model_version),
          dimension: Number(embedding.dimension),
          maxNumPatches: Number(embedding.max_num_patches),
          precision: String(embedding.precision),
          updatedAt: String(embedding.updated_at)
        }
      : null,
    semantic: semantic
      ? {
          model: String(semantic.model_version),
          profileVersion: String(semantic.profile_version),
          description: String(semantic.description ?? ""),
          subjects: stringArray(semantic.subjects_json),
          actions: stringArray(semantic.actions_json),
          scenes: stringArray(semantic.scenes_json),
          visibleText: stringArray(semantic.visible_text_json),
          tags: stringArray(semantic.tags_json),
          concepts: stringArray(semantic.concepts_json),
          repaired: Boolean(semantic.repaired),
          regionCount: Number(semantic.region_count ?? 0),
          regions: jsonArray(semantic.regions_json),
          timings: jsonObject(semantic.timings_json),
          updatedAt: String(semantic.updated_at)
        }
      : null,
    analysisJobs: jobs.map((row) => ({
      module: String(row.module),
      status: String(row.status),
      attempts: Number(row.attempts ?? 0),
      errorMessage: row.error_message ? String(row.error_message) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      updatedAt: String(row.updated_at)
    }))
  };
}


function getMediaPreviewInfo(mediaId: number) {
  const row = db.prepare(`
    SELECT id, absolute_path, sha256
    FROM media_items
    WHERE id=?
      AND availability='AVAILABLE'
  `).get(mediaId);

  if (!row) return null;

  return {
    mediaId: Number(row.id),
    absolutePath: String(row.absolute_path),
    inputSha256: String(row.sha256)
  };
}



function getMediaPath(mediaId: number) {
  const row = db.prepare(`
    SELECT id, absolute_path, relative_path, availability
    FROM media_items
    WHERE id=?
  `).get(mediaId);

  if (!row) return null;

  return {
    mediaId: Number(row.id),
    absolutePath: String(row.absolute_path),
    relativePath: String(row.relative_path),
    availability: String(row.availability)
  };
}

function resetCatalog(): { reset: true } {
  if (scanRunning) {
    throw new Error("Während eines laufenden Scans kann der Katalog nicht zurückgesetzt werden.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Bewusst vollständig: Nach einem Reset sollen weder alte KI-Ergebnisse
    // noch Kandidaten, Suchvektoren oder alte IDs in der neuen Datenbank
    // weiterleben. Die eigentlichen Bild-/Videodateien und Modellgewichte
    // werden nicht verändert.
    db.exec(`
      DELETE FROM analysis_jobs;

      DELETE FROM person_candidate_faces;
      DELETE FROM person_candidates;
      DELETE FROM person_cluster_runs;
      DELETE FROM person_cluster_exclusions;
      DELETE FROM person_face_exclusions;
      DELETE FROM person_face_assignments;
      DELETE FROM persons;

      DELETE FROM pet_candidate_items;
      DELETE FROM pet_candidates;
      DELETE FROM pet_cluster_runs;
      DELETE FROM pet_cluster_exclusions;
      DELETE FROM pet_assignment_exclusions;
      DELETE FROM pet_assignments;
      DELETE FROM pets;
      DELETE FROM pet_embeddings;
      DELETE FROM pet_fused_detections;
      DELETE FROM pet_detections;

      DELETE FROM object_fused_detections;
      DELETE FROM object_detections;
      DELETE FROM media_semantic_annotations;
      DELETE FROM semantic_embeddings;
      DELETE FROM face_embeddings;
      DELETE FROM face_detections;

      DELETE FROM media_image_metadata;
      DELETE FROM media_thumbnails;
      DELETE FROM media_items;
      DELETE FROM media_directories;
      DELETE FROM scans;
      DELETE FROM media_sources;

      DELETE FROM sqlite_sequence;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // Freie Seiten und WAL-Reste ebenfalls entfernen, damit ein
  // Entwicklungs-Reset wirklich mit einer kompakten Datenbank neu startet.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.exec("VACUUM;");

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
    case "getSearchFacets":
      return getSearchFacets(asNumber(payload.sourceId, "sourceId"));
    case "searchMedia":
      return listMedia(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 500 : asNumber(payload.limit, "limit"),
        payload.filter as SearchFilter | undefined,
        payload.semantic as SemanticTextEmbedding | null | undefined
      );
    case "listDuplicateGroups":
      return listDuplicateGroups(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 100 : asNumber(payload.limit, "limit")
      );
    case "listRecycleMedia":
      return listRecycleMedia(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 500 : asNumber(payload.limit, "limit")
      );
    case "enqueueAnalysisJobs":
      return enqueueAnalysisJobs(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.module === "string" ? payload.module : "file-probe-v1"
      );
    case "getAnalysisQueueStats":
      return getAnalysisQueueStats(
        payload.sourceId === undefined ? undefined : asNumber(payload.sourceId, "sourceId"),
        typeof payload.module === "string" ? payload.module : "file-probe-v1"
      );
    case "listAnalysisErrors":
      return listAnalysisErrors(
        payload.sourceId === undefined ? undefined : asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 200 : asNumber(payload.limit, "limit")
      );
    case "retryAnalysisJob":
      return retryAnalysisJob(asNumber(payload.jobId, "jobId"));
    case "retryFailedAnalysisJobs":
      return retryFailedAnalysisJobs(
        payload.sourceId === undefined ? undefined : asNumber(payload.sourceId, "sourceId")
      );
    case "claimAnalysisJob":
      return claimAnalysisJob(
        typeof payload.module === "string" ? payload.module : "file-probe-v1"
      );
    case "completeAnalysisJob":
      return completeAnalysisJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "failAnalysisJob":
      return failAnalysisJob(
        asNumber(payload.jobId, "jobId"),
        typeof payload.error === "string" ? payload.error : "Unbekannter Analysefehler"
      );
    case "completeThumbnailJob":
      return completeThumbnailJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "completeImageMetadataJob":
      return completeImageMetadataJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "completeFaceDetectionJob":
      return completeFaceDetectionJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "completePetDetectionJob":
      return completePetDetectionJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "getPetDetectionsForFusion":
      return getPetDetectionsForFusion(
        asNumber(payload.mediaId, "mediaId"),
        typeof payload.inputSha256 === "string" ? payload.inputSha256 : ""
      );
    case "getObjectDetectionsForFusion":
      return getObjectDetectionsForFusion(
        asNumber(payload.mediaId, "mediaId"),
        typeof payload.inputSha256 === "string" ? payload.inputSha256 : ""
      );
    case "completePetFusionJob":
      return completePetFusionJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "completeVerifiedObjectDetectionJob":
      return completeVerifiedObjectDetectionJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "completeCatalogSemanticJob":
      return completeCatalogSemanticJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "getPetDetectionsForEmbedding":
      return getPetDetectionsForEmbedding(
        asNumber(payload.mediaId, "mediaId"),
        typeof payload.inputSha256 === "string" ? payload.inputSha256 : ""
      );
    case "completePetEmbeddingJob":
      return completePetEmbeddingJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "completeSemanticEmbeddingJob":
      return completeSemanticEmbeddingJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "getPetEmbeddingsForClustering":
      return getPetEmbeddingsForClustering(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.algorithmVersion === "string"
          ? payload.algorithmVersion
          : "dogreid-centroid-v1"
      );
    case "replacePetCandidates":
      return replacePetCandidates(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.revision === "string" ? payload.revision : "",
        typeof payload.algorithmVersion === "string"
          ? payload.algorithmVersion
          : "dogreid-centroid-v1",
        payload.clusters
      );
    case "autoAssignKnownPetCandidates":
      return autoAssignKnownPetCandidates(
        asNumber(payload.sourceId, "sourceId")
      );
    case "listPetCandidates":
      return listPetCandidates(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 100 : asNumber(payload.limit, "limit")
      );
    case "listPets":
      return listPets(asNumber(payload.sourceId, "sourceId"));
    case "confirmPetCandidate":
      return confirmPetCandidate(
        asNumber(payload.candidateId, "candidateId"),
        payload.name,
        payload.rejectedPetId === undefined
          ? undefined
          : asNumber(payload.rejectedPetId, "rejectedPetId")
      );
    case "removePetFromCandidate":
      return removePetFromCandidate(
        asNumber(payload.candidateId, "candidateId"),
        asNumber(payload.petDetectionId, "petDetectionId")
      );
    case "removePetFromPet":
      return removePetFromPet(
        asNumber(payload.petId, "petId"),
        asNumber(payload.petDetectionId, "petDetectionId")
      );
    case "confirmPetDetection":
      return confirmPetDetection(
        asNumber(payload.petId, "petId"),
        asNumber(payload.petDetectionId, "petDetectionId")
      );
    case "mergePets":
      return mergePets(
        asNumber(payload.targetPetId, "targetPetId"),
        asNumber(payload.sourcePetId, "sourcePetId")
      );
    case "renamePet":
      return renamePet(
        asNumber(payload.petId, "petId"),
        payload.name
      );
    case "getPetCropInfo":
      return getPetCropInfo(asNumber(payload.petDetectionId, "petDetectionId"));
    case "getFaceDetectionsForEmbedding":
      return getFaceDetectionsForEmbedding(
        asNumber(payload.mediaId, "mediaId"),
        typeof payload.inputSha256 === "string" ? payload.inputSha256 : ""
      );
    case "completeFaceEmbeddingJob":
      return completeFaceEmbeddingJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "getFaceEmbeddingsForClustering":
      return getFaceEmbeddingsForClustering(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.algorithmVersion === "string"
          ? payload.algorithmVersion
          : "person-centroid-v1"
      );
    case "replacePersonCandidates":
      return replacePersonCandidates(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.revision === "string" ? payload.revision : "",
        typeof payload.algorithmVersion === "string"
          ? payload.algorithmVersion
          : "person-centroid-v1",
        payload.clusters
      );
    case "listPersonCandidates":
      return listPersonCandidates(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 100 : asNumber(payload.limit, "limit")
      );
    case "listPersons":
      return listPersons(asNumber(payload.sourceId, "sourceId"));
    case "confirmPersonCandidate":
      return confirmPersonCandidate(
        asNumber(payload.candidateId, "candidateId"),
        payload.name
      );
    case "removeFaceFromPersonCandidate":
      return removeFaceFromPersonCandidate(
        asNumber(payload.candidateId, "candidateId"),
        asNumber(payload.faceDetectionId, "faceDetectionId")
      );
    case "removeFaceFromPerson":
      return removeFaceFromPerson(
        asNumber(payload.personId, "personId"),
        asNumber(payload.faceDetectionId, "faceDetectionId")
      );
    case "mergePersons":
      return mergePersons(
        asNumber(payload.targetPersonId, "targetPersonId"),
        asNumber(payload.sourcePersonId, "sourcePersonId")
      );
    case "renamePerson":
      return renamePerson(
        asNumber(payload.personId, "personId"),
        payload.name
      );
    case "getFaceCropInfo":
      return getFaceCropInfo(asNumber(payload.faceDetectionId, "faceDetectionId"));
    case "getThumbnailInfo":
      return getThumbnailInfo(asNumber(payload.mediaId, "mediaId"));
    case "getMediaPreviewInfo":
      return getMediaPreviewInfo(asNumber(payload.mediaId, "mediaId"));
    case "getMediaDetails":
      return getMediaDetails(asNumber(payload.mediaId, "mediaId"));
    case "getMediaPath":
      return getMediaPath(asNumber(payload.mediaId, "mediaId"));
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
