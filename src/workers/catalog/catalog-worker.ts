import path from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  walkMedia,
  type DiscoveredDirectory,
  type DiscoveredFile
} from "../../catalog/file-scanner";
import { IMAGE_EXTENSIONS, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS } from "../../catalog/constants";
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
import { createLifeAreaStore } from "./life-areas";
import type {
  CatalogChange,
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
const lifeAreaStore = createLifeAreaStore(db);

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

  CREATE INDEX IF NOT EXISTS idx_analysis_module_status
    ON analysis_jobs(module, status);
  CREATE INDEX IF NOT EXISTS idx_analysis_module_status_priority
    ON analysis_jobs(module, status, priority, media_id);

  CREATE TABLE IF NOT EXISTS analysis_job_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_job_id INTEGER NOT NULL,
    media_id INTEGER NOT NULL,
    source_id INTEGER,
    module TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    input_sha256 TEXT,
    started_at TEXT,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(analysis_job_id, finished_at, status)
  );

  CREATE INDEX IF NOT EXISTS idx_analysis_history_finished
    ON analysis_job_history(finished_at);
  CREATE INDEX IF NOT EXISTS idx_analysis_history_module_finished
    ON analysis_job_history(module, finished_at);

  CREATE TRIGGER IF NOT EXISTS trg_analysis_job_terminal_history
  AFTER UPDATE OF status ON analysis_jobs
  WHEN NEW.status IN ('DONE','FAILED','UNAVAILABLE')
    AND OLD.status<>NEW.status
    AND NEW.finished_at IS NOT NULL
  BEGIN
    INSERT OR IGNORE INTO analysis_job_history(
      analysis_job_id,
      media_id,
      source_id,
      module,
      status,
      attempts,
      input_sha256,
      started_at,
      finished_at,
      duration_ms
    )
    VALUES(
      NEW.id,
      NEW.media_id,
      (SELECT source_id FROM media_items WHERE id=NEW.media_id),
      NEW.module,
      NEW.status,
      NEW.attempts,
      NEW.input_sha256,
      NEW.started_at,
      NEW.finished_at,
      CASE
        WHEN NEW.started_at IS NULL THEN NULL
        ELSE CAST(ROUND(
          (julianday(NEW.finished_at)-julianday(NEW.started_at))*86400000
        ) AS INTEGER)
      END
    );
  END;

  CREATE TABLE IF NOT EXISTS catalog_migrations (
    migration_key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  CREATE TABLE IF NOT EXISTS ignored_pet_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pet_class TEXT NOT NULL CHECK(pet_class IN ('dog','cat')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ignored_pet_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id INTEGER NOT NULL REFERENCES ignored_pet_identities(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    source_pet_detection_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(identity_id, source_pet_detection_id)
  );

  CREATE INDEX IF NOT EXISTS idx_ignored_pet_reference_identity
    ON ignored_pet_references(identity_id);

  CREATE TABLE IF NOT EXISTS ignored_pet_matches (
    pet_detection_id INTEGER PRIMARY KEY REFERENCES pet_fused_detections(id) ON DELETE CASCADE,
    identity_id INTEGER NOT NULL REFERENCES ignored_pet_identities(id) ON DELETE CASCADE,
    match_source TEXT NOT NULL CHECK(match_source IN ('USER_REJECTED','AUTO_HIGH_CONFIDENCE')),
    similarity REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_ignored_pet_match_identity
    ON ignored_pet_matches(identity_id);

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

  CREATE TABLE IF NOT EXISTS ignored_person_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ignored_person_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id INTEGER NOT NULL REFERENCES ignored_person_identities(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    source_face_detection_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(identity_id, source_face_detection_id)
  );

  CREATE INDEX IF NOT EXISTS idx_ignored_person_reference_identity
    ON ignored_person_references(identity_id);

  CREATE TABLE IF NOT EXISTS ignored_person_matches (
    face_detection_id INTEGER PRIMARY KEY REFERENCES face_detections(id) ON DELETE CASCADE,
    identity_id INTEGER NOT NULL REFERENCES ignored_person_identities(id) ON DELETE CASCADE,
    match_source TEXT NOT NULL CHECK(match_source IN ('USER_REJECTED','AUTO_HIGH_CONFIDENCE')),
    similarity REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_ignored_person_match_identity
    ON ignored_person_matches(identity_id);
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
ensureColumn("person_candidates", "member_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("person_candidates", "newest_face_id", "INTEGER");
ensureColumn("pet_candidates", "member_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("pet_candidates", "newest_pet_id", "INTEGER");

const identitySummaryMigrationKey = "identity-candidate-summary-v1";
const identitySummaryMigration = db.prepare(
  "SELECT 1 FROM catalog_migrations WHERE migration_key=?"
).get(identitySummaryMigrationKey);

if (!identitySummaryMigration) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      UPDATE person_candidates
      SET
        member_count=(
          SELECT COUNT(*)
          FROM person_candidate_faces pcf
          WHERE pcf.candidate_id=person_candidates.id
        ),
        newest_face_id=(
          SELECT MAX(pcf.face_detection_id)
          FROM person_candidate_faces pcf
          WHERE pcf.candidate_id=person_candidates.id
        );

      UPDATE pet_candidates
      SET
        member_count=(
          SELECT COUNT(*)
          FROM pet_candidate_items pci
          WHERE pci.candidate_id=pet_candidates.id
        ),
        newest_pet_id=(
          SELECT MAX(pci.pet_detection_id)
          FROM pet_candidate_items pci
          WHERE pci.candidate_id=pet_candidates.id
        );

      CREATE INDEX IF NOT EXISTS idx_person_candidate_source_count
        ON person_candidates(source_id, member_count DESC, average_similarity DESC, newest_face_id DESC);
      CREATE INDEX IF NOT EXISTS idx_pet_candidate_source_count
        ON pet_candidates(source_id, member_count DESC, average_similarity DESC, newest_pet_id DESC);
      CREATE INDEX IF NOT EXISTS idx_person_candidate_face_detection
        ON person_candidate_faces(face_detection_id, candidate_id);
      CREATE INDEX IF NOT EXISTS idx_pet_candidate_item_detection
        ON pet_candidate_items(pet_detection_id, candidate_id);

      CREATE TRIGGER IF NOT EXISTS trg_person_candidate_face_insert_summary
      AFTER INSERT ON person_candidate_faces
      BEGIN
        UPDATE person_candidates
        SET
          member_count=member_count+1,
          newest_face_id=CASE
            WHEN newest_face_id IS NULL OR NEW.face_detection_id>newest_face_id
              THEN NEW.face_detection_id
            ELSE newest_face_id
          END
        WHERE id=NEW.candidate_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_person_candidate_face_delete_summary
      AFTER DELETE ON person_candidate_faces
      BEGIN
        UPDATE person_candidates
        SET
          member_count=(
            SELECT COUNT(*)
            FROM person_candidate_faces pcf
            WHERE pcf.candidate_id=OLD.candidate_id
          ),
          newest_face_id=(
            SELECT MAX(pcf.face_detection_id)
            FROM person_candidate_faces pcf
            WHERE pcf.candidate_id=OLD.candidate_id
          )
        WHERE id=OLD.candidate_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_pet_candidate_item_insert_summary
      AFTER INSERT ON pet_candidate_items
      BEGIN
        UPDATE pet_candidates
        SET
          member_count=member_count+1,
          newest_pet_id=CASE
            WHEN newest_pet_id IS NULL OR NEW.pet_detection_id>newest_pet_id
              THEN NEW.pet_detection_id
            ELSE newest_pet_id
          END
        WHERE id=NEW.candidate_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_pet_candidate_item_delete_summary
      AFTER DELETE ON pet_candidate_items
      BEGIN
        UPDATE pet_candidates
        SET
          member_count=(
            SELECT COUNT(*)
            FROM pet_candidate_items pci
            WHERE pci.candidate_id=OLD.candidate_id
          ),
          newest_pet_id=(
            SELECT MAX(pci.pet_detection_id)
            FROM pet_candidate_items pci
            WHERE pci.candidate_id=OLD.candidate_id
          )
        WHERE id=OLD.candidate_id;
      END;
    `);

    db.prepare(
      "INSERT INTO catalog_migrations(migration_key) VALUES(?)"
    ).run(identitySummaryMigrationKey);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} else {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_person_candidate_source_count
      ON person_candidates(source_id, member_count DESC, average_similarity DESC, newest_face_id DESC);
    CREATE INDEX IF NOT EXISTS idx_pet_candidate_source_count
      ON pet_candidates(source_id, member_count DESC, average_similarity DESC, newest_pet_id DESC);
    CREATE INDEX IF NOT EXISTS idx_person_candidate_face_detection
      ON person_candidate_faces(face_detection_id, candidate_id);
    CREATE INDEX IF NOT EXISTS idx_pet_candidate_item_detection
      ON pet_candidate_items(pet_detection_id, candidate_id);

    CREATE TRIGGER IF NOT EXISTS trg_person_candidate_face_insert_summary
    AFTER INSERT ON person_candidate_faces
    BEGIN
      UPDATE person_candidates
      SET
        member_count=member_count+1,
        newest_face_id=CASE
          WHEN newest_face_id IS NULL OR NEW.face_detection_id>newest_face_id
            THEN NEW.face_detection_id
          ELSE newest_face_id
        END
      WHERE id=NEW.candidate_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_person_candidate_face_delete_summary
    AFTER DELETE ON person_candidate_faces
    BEGIN
      UPDATE person_candidates
      SET
        member_count=(
          SELECT COUNT(*)
          FROM person_candidate_faces pcf
          WHERE pcf.candidate_id=OLD.candidate_id
        ),
        newest_face_id=(
          SELECT MAX(pcf.face_detection_id)
          FROM person_candidate_faces pcf
          WHERE pcf.candidate_id=OLD.candidate_id
        )
      WHERE id=OLD.candidate_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pet_candidate_item_insert_summary
    AFTER INSERT ON pet_candidate_items
    BEGIN
      UPDATE pet_candidates
      SET
        member_count=member_count+1,
        newest_pet_id=CASE
          WHEN newest_pet_id IS NULL OR NEW.pet_detection_id>newest_pet_id
            THEN NEW.pet_detection_id
          ELSE newest_pet_id
        END
      WHERE id=NEW.candidate_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pet_candidate_item_delete_summary
    AFTER DELETE ON pet_candidate_items
    BEGIN
      UPDATE pet_candidates
      SET
        member_count=(
          SELECT COUNT(*)
          FROM pet_candidate_items pci
          WHERE pci.candidate_id=OLD.candidate_id
        ),
        newest_pet_id=(
          SELECT MAX(pci.pet_detection_id)
          FROM pet_candidate_items pci
          WHERE pci.candidate_id=OLD.candidate_id
        )
      WHERE id=OLD.candidate_id;
    END;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS media_video_analysis (
    media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
    input_sha256 TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    fps REAL NOT NULL,
    sample_interval_ms INTEGER NOT NULL,
    sampled_frames INTEGER NOT NULL,
    scene_count INTEGER NOT NULL,
    frames_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS video_identity_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    identity_kind TEXT NOT NULL CHECK(identity_kind IN ('person','pet')),
    identity_id INTEGER,
    pet_class TEXT,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    hit_count INTEGER NOT NULL,
    max_similarity REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_video_identity_media ON video_identity_tracks(media_id);
  CREATE INDEX IF NOT EXISTS idx_video_identity_lookup ON video_identity_tracks(identity_kind, identity_id);

  CREATE TABLE IF NOT EXISTS video_frame_identity_overrides (
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    timestamp_ms INTEGER NOT NULL,
    identity_kind TEXT NOT NULL CHECK(identity_kind IN ('person','pet')),
    detection_index INTEGER NOT NULL,
    pet_class TEXT,
    identity_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(media_id, timestamp_ms, identity_kind, detection_index)
  );

  CREATE INDEX IF NOT EXISTS idx_video_frame_override_media
    ON video_frame_identity_overrides(media_id, timestamp_ms);

  CREATE TABLE IF NOT EXISTS video_tags (
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    score REAL NOT NULL,
    hit_count INTEGER NOT NULL,
    PRIMARY KEY(media_id, label)
  );

  CREATE TABLE IF NOT EXISTS life_areas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS life_area_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    life_area_id INTEGER NOT NULL REFERENCES life_areas(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL DEFAULT 0,
    condition_type TEXT NOT NULL CHECK(condition_type IN ('person','pet','tag','path','date')),
    condition_value TEXT,
    date_from TEXT,
    date_to TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_life_area_rules_area
    ON life_area_rules(life_area_id, enabled);

  CREATE TABLE IF NOT EXISTS media_life_areas (
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    life_area_id INTEGER NOT NULL REFERENCES life_areas(id) ON DELETE CASCADE,
    assignment_source TEXT NOT NULL CHECK(assignment_source IN ('MANUAL','RULE')),
    rule_id INTEGER REFERENCES life_area_rules(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(media_id, life_area_id)
  );

  CREATE INDEX IF NOT EXISTS idx_media_life_areas_area
    ON media_life_areas(life_area_id, assignment_source);

  CREATE TABLE IF NOT EXISTS life_area_exclusions (
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    life_area_id INTEGER NOT NULL REFERENCES life_areas(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT 'MANUAL_REMOVE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(media_id, life_area_id)
  );
`);

ensureColumn("life_area_rules", "group_id", "INTEGER NOT NULL DEFAULT 0");
db.prepare("UPDATE life_area_rules SET group_id=id WHERE group_id=0").run();
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_life_area_rules_group
    ON life_area_rules(life_area_id, group_id, enabled);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_media_recycle
    ON media_items(source_id, in_recycle_bin);
  CREATE INDEX IF NOT EXISTS idx_media_identity
    ON media_items(source_id, device_id, inode);
  CREATE INDEX IF NOT EXISTS idx_media_library_duplicates
    ON media_items(source_id, availability, sha256, size_bytes);
  CREATE INDEX IF NOT EXISTS idx_analysis_media_sha_status
    ON analysis_jobs(media_id, input_sha256, status);
  CREATE INDEX IF NOT EXISTS idx_face_media_sha
    ON face_detections(media_id, input_sha256);
  CREATE INDEX IF NOT EXISTS idx_face_embedding_media_sha
    ON face_embeddings(media_id, input_sha256);
  CREATE INDEX IF NOT EXISTS idx_pet_fused_media_sha_class
    ON pet_fused_detections(media_id, input_sha256, pet_class);
  CREATE INDEX IF NOT EXISTS idx_pet_embedding_media_sha
    ON pet_embeddings(media_id, input_sha256);
  CREATE INDEX IF NOT EXISTS idx_object_fused_media_sha_label
    ON object_fused_detections(media_id, input_sha256, label);

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

runOneTimeCatalogMigration(
  "2026-11-09-analysis-history-seed-v1",
  () => {
    db.prepare(`
      INSERT OR IGNORE INTO analysis_job_history(
        analysis_job_id,
        media_id,
        source_id,
        module,
        status,
        attempts,
        input_sha256,
        started_at,
        finished_at,
        duration_ms
      )
      SELECT
        j.id,
        j.media_id,
        m.source_id,
        j.module,
        j.status,
        j.attempts,
        j.input_sha256,
        j.started_at,
        j.finished_at,
        CASE
          WHEN j.started_at IS NULL THEN NULL
          ELSE CAST(ROUND(
            (julianday(j.finished_at)-julianday(j.started_at))*86400000
          ) AS INTEGER)
        END
      FROM analysis_jobs j
      LEFT JOIN media_items m ON m.id=j.media_id
      WHERE j.status IN ('DONE','FAILED','UNAVAILABLE')
        AND j.finished_at IS NOT NULL
    `).run();
  }
);

function runOneTimeCatalogMigration(
  migrationKey: string,
  apply: () => void
): void {
  const alreadyApplied = db.prepare(`
    SELECT 1
    FROM catalog_migrations
    WHERE migration_key=?
  `).get(migrationKey);

  if (alreadyApplied) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    apply();
    db.prepare(`
      INSERT INTO catalog_migrations(migration_key)
      VALUES(?)
    `).run(migrationKey);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Nach der Parallelisierungs-/Timeoutkorrektur alle derzeit echten FAILED-Jobs
// genau einmal neu versuchen. UNAVAILABLE bleibt unangetastet, weil fehlende
// Dateien nicht durch blindes Retry repariert werden. Die Migration verhindert
// ein erneutes Endlos-Retry bei jedem App-Start.
runOneTimeCatalogMigration(
  "2026-11-03-retry-failed-analysis-after-vision-parallel-fix-v1",
  () => {
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
      WHERE status='FAILED'
    `).run();
  }
);

runOneTimeCatalogMigration(
  "2026-11-04-video-frame-identities-v1",
  () => {
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
      WHERE module='video-analyze-v1'
        AND status='DONE'
        AND media_id IN (
          SELECT media_id
          FROM media_video_analysis
          WHERE frames_json NOT LIKE '%"detectionIndex":%'
        )
    `).run();
  }
);

runOneTimeCatalogMigration(
  "2026-11-04-clean-stale-identity-candidate-links-v1",
  () => {
    db.prepare(`
      DELETE FROM pet_candidate_items
      WHERE pet_detection_id IN (
        SELECT pd.id
        FROM pet_fused_detections pd
        JOIN media_items m ON m.id=pd.media_id
        WHERE m.availability<>'AVAILABLE'
           OR pd.input_sha256<>m.sha256
      )
    `).run();

    db.prepare(`
      DELETE FROM pet_candidates
      WHERE NOT EXISTS (
        SELECT 1
        FROM pet_candidate_items pci
        WHERE pci.candidate_id=pet_candidates.id
      )
    `).run();

    db.prepare(`
      DELETE FROM person_candidate_faces
      WHERE face_detection_id IN (
        SELECT fd.id
        FROM face_detections fd
        JOIN media_items m ON m.id=fd.media_id
        WHERE m.availability<>'AVAILABLE'
           OR fd.input_sha256<>m.sha256
      )
    `).run();

    db.prepare(`
      DELETE FROM person_candidates
      WHERE NOT EXISTS (
        SELECT 1
        FROM person_candidate_faces pcf
        WHERE pcf.candidate_id=person_candidates.id
      )
    `).run();
  }
);

// Frühere technische Prüfungen haben nur aus der Dateiendung einen MIME-Typ
// abgeleitet. Sie müssen einmal neu laufen, damit falsch benannte Dateien
// (z. B. MP4 mit .jpg-Endung) anhand ihrer Signatur korrekt klassifiziert werden.
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
  WHERE module='file-probe-v1'
    AND status='DONE'
    AND (
      result_json IS NULL
      OR result_json NOT LIKE '%"detectedKind":%'
    )
`).run();

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

// Bekannter Programmfehler aus dem ersten 420-Sekunden-Timeout-Patch:
// Python interpretierte im Timeout-Handler einen String als Funktionsaufruf.
// Nur genau diese dadurch fehlgeschlagenen Qwen-4B-Jobs automatisch neu planen.
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
  WHERE module='catalog-semantic-qwen3vl4b-v3'
    AND status='FAILED'
    AND lower(COALESCE(error_message,'')) LIKE '%object is not callable%'
`).run();

// Die frühere Qwen-8B-Serienstufe ist vollständig durch die neue
// Qwen3-VL-4B-Katalogsemantik ersetzt. Alte Jobzustände werden entfernt;
// vorhandene Bild-/Suchdaten bleiben davon unberührt.
db.prepare(`
  DELETE FROM analysis_jobs
  WHERE module='object-detect-qwen3vl-gguf-v2'
`).run();

let scanRunning = false;
let processingPaused = false;

async function waitForProcessingResume(): Promise<void> {
  while (processingPaused) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function setProcessingPaused(paused: boolean) {
  processingPaused = paused;
  return { paused: processingPaused };
}

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
  return db.prepare(
    "SELECT id, path, enabled FROM media_sources WHERE enabled=1 ORDER BY id"
  )
    .all()
    .map((row) => ({
      id: Number(row.id),
      path: String(row.path),
      enabled: Boolean(row.enabled)
    }));
}

function pathIsSameOrInside(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeForComparison(candidatePath);
  const root = normalizeForComparison(rootPath);
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function relativePathFromRoot(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join("/");
}

function consolidateContainedSources(targetSourceId: number, targetRoot: string): number[] {
  const childSources = db.prepare(`
    SELECT id, path
    FROM media_sources
    WHERE enabled=1
      AND id<>?
    ORDER BY length(path) ASC, id ASC
  `).all(targetSourceId)
    .filter((row) => pathIsSameOrInside(String(row.path), targetRoot));

  if (childSources.length === 0) return [];

  const migratedSourceIds: number[] = [];
  db.exec("BEGIN IMMEDIATE");

  try {
    const findTargetMedia = db.prepare(`
      SELECT id, sha256, size_bytes
      FROM media_items
      WHERE source_id=? AND relative_path=?
      LIMIT 1
    `);
    const updateMedia = db.prepare(`
      UPDATE media_items
      SET source_id=?, relative_path=?
      WHERE id=?
    `);
    const deleteMedia = db.prepare("DELETE FROM media_items WHERE id=?");

    const findTargetDirectory = db.prepare(`
      SELECT id
      FROM media_directories
      WHERE source_id=? AND relative_path=?
      LIMIT 1
    `);
    const updateDirectory = db.prepare(`
      UPDATE media_directories
      SET source_id=?, relative_path=?
      WHERE id=?
    `);
    const deleteDirectory = db.prepare("DELETE FROM media_directories WHERE id=?");

    for (const source of childSources) {
      const childId = Number(source.id);

      const mediaRows = db.prepare(`
        SELECT id, absolute_path, sha256, size_bytes
        FROM media_items
        WHERE source_id=?
        ORDER BY id
      `).all(childId);

      for (const media of mediaRows) {
        const absolutePath = String(media.absolute_path);
        const relativePath = relativePathFromRoot(targetRoot, absolutePath);

        // Nur Datensätze übernehmen, die tatsächlich unterhalb des neuen
        // Stammordners liegen. So bleibt die Konsolidierung auch bei alten,
        // inzwischen umbenannten Pfaden defensiv.
        if (relativePath === ".." || relativePath.startsWith("../")) {
          continue;
        }

        const existing = findTargetMedia.get(targetSourceId, relativePath);
        if (existing) {
          const sameContent =
            String(existing.sha256) === String(media.sha256) &&
            Number(existing.size_bytes) === Number(media.size_bytes);

          if (sameContent) {
            // Derselbe physische Inhalt war bereits über eine andere
            // überlappende Quelle katalogisiert. Ein Datensatz genügt.
            deleteMedia.run(Number(media.id));
            continue;
          }

          throw new Error(
            "Quellen konnten nicht zusammengeführt werden: Pfadkonflikt bei " +
            relativePath
          );
        }

        updateMedia.run(targetSourceId, relativePath, Number(media.id));
      }

      const directories = db.prepare(`
        SELECT id, absolute_path
        FROM media_directories
        WHERE source_id=?
        ORDER BY length(relative_path) ASC, id ASC
      `).all(childId);

      for (const directory of directories) {
        const absolutePath = String(directory.absolute_path);
        const relativePath = relativePathFromRoot(targetRoot, absolutePath);
        if (relativePath === ".." || relativePath.startsWith("../")) {
          continue;
        }

        const existing = findTargetDirectory.get(targetSourceId, relativePath);
        if (existing) {
          deleteDirectory.run(Number(directory.id));
          continue;
        }

        updateDirectory.run(targetSourceId, relativePath, Number(directory.id));
      }

      db.prepare("UPDATE person_candidates SET source_id=? WHERE source_id=?")
        .run(targetSourceId, childId);
      db.prepare("UPDATE pet_candidates SET source_id=? WHERE source_id=?")
        .run(targetSourceId, childId);

      // Ein gemeinsamer Stamm verändert die Menge möglicher Clusterpartner.
      // Die nächsten Hintergrundläufe sollen deshalb neu clustern.
      db.prepare("DELETE FROM person_cluster_runs WHERE source_id IN (?,?)")
        .run(targetSourceId, childId);
      db.prepare("DELETE FROM pet_cluster_runs WHERE source_id IN (?,?)")
        .run(targetSourceId, childId);

      db.prepare(`
        UPDATE media_sources
        SET enabled=0, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(childId);

      migratedSourceIds.push(childId);
    }

    db.exec("COMMIT");
    return migratedSourceIds;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function addSource(sourcePath: unknown) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new Error("Quellpfad fehlt.");
  }

  const canonical = path.resolve(sourcePath.trim());
  const identity = await readPathIdentity(canonical);

  const activeSources = db.prepare(`
    SELECT id, path, enabled
    FROM media_sources
    WHERE enabled=1
    ORDER BY length(path) ASC, id ASC
  `).all();

  // Ist der gewünschte Ordner bereits Teil einer aktiven übergeordneten
  // Quelle, keine zweite überlappende Quelle anlegen.
  const coveringSource = activeSources.find((row) => {
    const existingPath = String(row.path);
    return (
      normalizeForComparison(existingPath) !== normalizeForComparison(canonical) &&
      pathIsSameOrInside(canonical, existingPath)
    );
  });

  if (coveringSource) {
    return {
      id: Number(coveringSource.id),
      path: String(coveringSource.path),
      enabled: Boolean(coveringSource.enabled)
    };
  }

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

  consolidateContainedSources(Number(row.id), canonical);

  return {
    id: Number(row.id),
    path: String(row.path),
    enabled: Boolean(row.enabled)
  };
}

function disableSource(sourceId: number) {
  const source = db.prepare(
    "SELECT id, path, enabled FROM media_sources WHERE id=?"
  ).get(sourceId);

  if (!source) {
    throw new Error("Medienquelle wurde nicht gefunden.");
  }

  db.prepare(`
    UPDATE media_sources
    SET enabled=0, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(sourceId);

  return {
    id: Number(source.id),
    path: String(source.path),
    enabled: false
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

function getIdentityCandidateSummaryStats(sourceId: number) {
  const people = db.prepare(`
    SELECT
      COUNT(*) AS candidate_count,
      COALESCE(SUM(member_count),0) AS member_count
    FROM person_candidates
    WHERE source_id=?
      AND member_count>=2
  `).get(sourceId);

  const pets = db.prepare(`
    SELECT
      COUNT(*) AS candidate_count,
      COALESCE(SUM(member_count),0) AS member_count
    FROM pet_candidates
    WHERE source_id=?
      AND member_count>=2
  `).get(sourceId);

  return {
    personCandidates: Number(people?.candidate_count ?? 0),
    personCandidateFaces: Number(people?.member_count ?? 0),
    petCandidates: Number(pets?.candidate_count ?? 0),
    petCandidateDetections: Number(pets?.member_count ?? 0)
  };
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
      (
        SELECT COUNT(*)
        FROM person_candidates pc
        WHERE pc.source_id=?
          AND pc.member_count>=2
      ) AS candidate_count,
      (
        SELECT COALESCE(SUM(pc.member_count), 0)
        FROM person_candidates pc
        WHERE pc.source_id=?
          AND pc.member_count>=2
      ) AS candidate_face_count,
      (
        SELECT COUNT(DISTINCT pfa.person_id)
        FROM person_face_assignments pfa
        JOIN face_detections fd ON fd.id=pfa.face_detection_id
        JOIN media_items m ON m.id=fd.media_id
        WHERE m.source_id=?
      ) AS person_count,
      (
        SELECT COUNT(*)
        FROM person_face_assignments pfa
        JOIN face_detections fd ON fd.id=pfa.face_detection_id
        JOIN media_items m ON m.id=fd.media_id
        WHERE m.source_id=?
      ) AS assigned_face_count
  `).get(sourceId, sourceId, sourceId, sourceId);

  const petIdentityStats = db.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM pet_candidates pc
        WHERE pc.source_id=?
          AND pc.member_count>=2
      ) AS candidate_count,
      (
        SELECT COALESCE(SUM(pc.member_count), 0)
        FROM pet_candidates pc
        WHERE pc.source_id=?
          AND pc.member_count>=2
      ) AS candidate_detection_count,
      (
        SELECT COUNT(DISTINCT pa.pet_id)
        FROM pet_assignments pa
        JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        WHERE m.source_id=?
      ) AS pet_count,
      (
        SELECT COUNT(*)
        FROM pet_assignments pa
        JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        WHERE m.source_id=?
      ) AS assigned_detection_count
  `).get(sourceId, sourceId, sourceId, sourceId);

  const facePipelineStats = db.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM face_detections fd
        JOIN media_items m ON m.id=fd.media_id
        WHERE m.source_id=?
          AND m.availability='AVAILABLE'
          AND fd.input_sha256=m.sha256
      ) AS detected_face_count,
      (
        SELECT COUNT(*)
        FROM face_embeddings fe
        JOIN face_detections fd ON fd.id=fe.face_detection_id
        JOIN media_items m ON m.id=fe.media_id
        WHERE m.source_id=?
          AND m.availability='AVAILABLE'
          AND fe.model_version='SFace 2021dec'
          AND fe.input_sha256=m.sha256
          AND fd.input_sha256=m.sha256
      ) AS embedded_face_count,
      (
        SELECT COUNT(*)
        FROM face_embeddings fe
        JOIN face_detections fd ON fd.id=fe.face_detection_id
        JOIN media_items m ON m.id=fe.media_id
        LEFT JOIN person_face_assignments pfa
          ON pfa.face_detection_id=fd.id
        LEFT JOIN ignored_person_matches ipm
          ON ipm.face_detection_id=fd.id
        WHERE m.source_id=?
          AND m.availability='AVAILABLE'
          AND fe.model_version='SFace 2021dec'
          AND fe.input_sha256=m.sha256
          AND fd.input_sha256=m.sha256
          AND pfa.face_detection_id IS NULL
          AND ipm.face_detection_id IS NULL
      ) AS unassigned_face_embedding_count
  `).get(sourceId, sourceId, sourceId);

  const dogPipelineStats = db.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM pet_fused_detections pd
        JOIN media_items m ON m.id=pd.media_id
        WHERE m.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.pet_class='dog'
          AND pd.input_sha256=m.sha256
      ) AS fused_dog_count,
      (
        SELECT COUNT(*)
        FROM pet_embeddings pe
        JOIN pet_fused_detections pd ON pd.id=pe.pet_detection_id
        JOIN media_items m ON m.id=pe.media_id
        WHERE m.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.pet_class='dog'
          AND pe.model_version='DogReID DINOv2-B14 0.2.0'
          AND pe.input_sha256=m.sha256
          AND pd.input_sha256=m.sha256
      ) AS embedded_dog_count,
      (
        SELECT COUNT(*)
        FROM pet_embeddings pe
        JOIN pet_fused_detections pd ON pd.id=pe.pet_detection_id
        JOIN media_items m ON m.id=pe.media_id
        LEFT JOIN pet_assignments pa
          ON pa.pet_detection_id=pd.id
        LEFT JOIN ignored_pet_matches ipm
          ON ipm.pet_detection_id=pd.id
        WHERE m.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.pet_class='dog'
          AND pe.model_version='DogReID DINOv2-B14 0.2.0'
          AND pe.input_sha256=m.sha256
          AND pd.input_sha256=m.sha256
          AND pa.pet_detection_id IS NULL
          AND ipm.pet_detection_id IS NULL
      ) AS unassigned_dog_embedding_count
  `).get(sourceId, sourceId, sourceId);

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
    personCandidateFaces: Number(personStats?.candidate_face_count ?? 0),
    detectedFaces: Number(facePipelineStats?.detected_face_count ?? 0),
    embeddedFaces: Number(facePipelineStats?.embedded_face_count ?? 0),
    unassignedFaceEmbeddings: Number(
      facePipelineStats?.unassigned_face_embedding_count ?? 0
    ),
    persons: Number(personStats?.person_count ?? 0),
    assignedPersonFaces: Number(personStats?.assigned_face_count ?? 0),
    petCandidates: Number(petIdentityStats?.candidate_count ?? 0),
    petCandidateDetections: Number(petIdentityStats?.candidate_detection_count ?? 0),
    fusedDogs: Number(dogPipelineStats?.fused_dog_count ?? 0),
    embeddedDogs: Number(dogPipelineStats?.embedded_dog_count ?? 0),
    unassignedDogEmbeddings: Number(
      dogPipelineStats?.unassigned_dog_embedding_count ?? 0
    ),
    pets: Number(petIdentityStats?.pet_count ?? 0),
    assignedPetDetections: Number(petIdentityStats?.assigned_detection_count ?? 0),
    lastScan: lastScan?.finished_at ? String(lastScan.finished_at) : null
  };
}

function getRemoteSummary() {
  const media = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN availability='AVAILABLE' THEN 1 ELSE 0 END), 0) AS available,
      COALESCE(SUM(CASE WHEN availability='MISSING' THEN 1 ELSE 0 END), 0) AS missing
    FROM media_items
  `).get();

  const identities = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM persons) AS person_count,
      (SELECT COUNT(*) FROM pets) AS pet_count
  `).get();

  const lastScan = db.prepare(`
    SELECT MAX(finished_at) AS finished_at
    FROM scans
    WHERE finished_at IS NOT NULL
  `).get();

  return {
    total: Number(media?.total ?? 0),
    available: Number(media?.available ?? 0),
    missing: Number(media?.missing ?? 0),
    persons: Number(identities?.person_count ?? 0),
    pets: Number(identities?.pet_count ?? 0),
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
  sourceId: number | undefined,
  requestedLimit: number,
  rawSearch?: SearchFilter,
  semantic?: SemanticTextEmbedding | null,
  mediaKind: "all" | "image" | "video" = "all"
) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(requestedLimit || 500)));
  const sourceWhere = sourceId === undefined ? "1=1" : "m.source_id=?";
  const sourceArgs: Array<number | string> =
    sourceId === undefined ? [] : [sourceId];
  const kindExtensions =
    mediaKind === "video"
      ? [...VIDEO_EXTENSIONS]
      : mediaKind === "image"
        ? [...IMAGE_EXTENSIONS]
        : [];
  const mediaKindSql = kindExtensions.length > 0
    ? " AND lower(m.extension) IN (" +
      kindExtensions.map(() => "?").join(",") +
      ")"
    : "";
  const search = normalizeSearchFilter(rawSearch);
  const searchClauses: string[] = [];
  const searchArgs: Array<number | string> = [];

  if (search) {
    searchClauses.push("m.availability='AVAILABLE'");

    for (const personId of search.personIds) {
      searchClauses.push(`(
        EXISTS (
          SELECT 1
          FROM person_face_assignments pfa_search
          JOIN face_detections fd_search
            ON fd_search.id=pfa_search.face_detection_id
          WHERE pfa_search.person_id=?
            AND fd_search.media_id=m.id
            AND fd_search.input_sha256=m.sha256
        )
        OR EXISTS (
          SELECT 1
          FROM video_identity_tracks vit_search
          WHERE vit_search.media_id=m.id
            AND vit_search.identity_kind='person'
            AND vit_search.identity_id=?
        )
      )`);
      searchArgs.push(personId, personId);
    }

    for (const petId of search.petIds) {
      searchClauses.push(`(
        EXISTS (
          SELECT 1
          FROM pet_assignments pa_search
          JOIN pet_fused_detections pd_search
            ON pd_search.id=pa_search.pet_detection_id
          WHERE pa_search.pet_id=?
            AND pd_search.media_id=m.id
            AND pd_search.input_sha256=m.sha256
        )
        OR EXISTS (
          SELECT 1
          FROM video_identity_tracks vit_search
          WHERE vit_search.media_id=m.id
            AND vit_search.identity_kind='pet'
            AND vit_search.identity_id=?
        )
      )`);
      searchArgs.push(petId, petId);
    }

    for (const label of search.objectLabels) {
      searchClauses.push(`(
        EXISTS (
          SELECT 1
          FROM object_fused_detections od_search
          WHERE od_search.media_id=m.id
            AND od_search.input_sha256=m.sha256
            AND od_search.label=?
        )
        OR EXISTS (
          SELECT 1
          FROM video_tags vt_search
          WHERE vt_search.media_id=m.id
            AND vt_search.label=?
        )
      )`);
      searchArgs.push(label, label);
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
      ms.path AS source_path,
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
        SELECT MAX(aj_last.finished_at)
        FROM analysis_jobs aj_last
        WHERE aj_last.media_id=m.id
          AND aj_last.input_sha256=m.sha256
          AND aj_last.status='DONE'
          AND aj_last.finished_at IS NOT NULL
      ) AS last_analyzed_at,
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
        SELECT COUNT(DISTINCT labels.label)
        FROM (
          SELECT od.label AS label
          FROM object_fused_detections od
          WHERE od.media_id=m.id
            AND od.input_sha256=m.sha256
          UNION
          SELECT vt.label AS label
          FROM video_tags vt
          WHERE vt.media_id=m.id
        ) labels
      ) AS object_count,
      (
        SELECT GROUP_CONCAT(labels.label)
        FROM (
          SELECT od.label AS label
          FROM object_fused_detections od
          WHERE od.media_id=m.id
            AND od.input_sha256=m.sha256
          UNION
          SELECT vt.label AS label
          FROM video_tags vt
          WHERE vt.media_id=m.id
        ) labels
      ) AS object_labels,
      (
        SELECT GROUP_CONCAT(names.name, CHAR(31))
        FROM (
          SELECT DISTINCT p.name AS name
          FROM person_face_assignments pfa_marker
          JOIN face_detections fd_marker
            ON fd_marker.id=pfa_marker.face_detection_id
          JOIN persons p ON p.id=pfa_marker.person_id
          WHERE fd_marker.media_id=m.id
            AND fd_marker.input_sha256=m.sha256
          UNION
          SELECT DISTINCT p.name AS name
          FROM video_identity_tracks vit_marker
          JOIN persons p ON p.id=vit_marker.identity_id
          WHERE vit_marker.media_id=m.id
            AND vit_marker.identity_kind='person'
        ) names
      ) AS person_names,
      (
        SELECT GROUP_CONCAT(names.name, CHAR(31))
        FROM (
          SELECT DISTINCT p.name AS name
          FROM pet_assignments pa_marker
          JOIN pet_fused_detections pd_marker
            ON pd_marker.id=pa_marker.pet_detection_id
          JOIN pets p ON p.id=pa_marker.pet_id
          WHERE pd_marker.media_id=m.id
            AND pd_marker.input_sha256=m.sha256
          UNION
          SELECT DISTINCT p.name AS name
          FROM video_identity_tracks vit_marker
          JOIN pets p ON p.id=vit_marker.identity_id
          WHERE vit_marker.media_id=m.id
            AND vit_marker.identity_kind='pet'
        ) names
      ) AS pet_names,
      (
        SELECT GROUP_CONCAT(la.name, CHAR(31))
        FROM media_life_areas mla_marker
        JOIN life_areas la ON la.id=mla_marker.life_area_id
        WHERE mla_marker.media_id=m.id
      ) AS life_area_names,
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
      END AS duplicate_count,
      (
        SELECT aj.module
        FROM analysis_jobs aj
        WHERE aj.media_id=m.id
          AND aj.status='DONE'
          AND aj.input_sha256=m.sha256
        ORDER BY CASE aj.module
          WHEN 'file-probe-v1' THEN 10
          WHEN 'thumbnail-v1' THEN 20
          WHEN 'image-metadata-v1' THEN 30
          WHEN 'face-detect-yunet-v1' THEN 40
          WHEN 'face-embed-sface-v1' THEN 50
          WHEN 'pet-detect-nanodet-v1' THEN 60
          WHEN 'pet-detect-yolox-v1' THEN 61
          WHEN 'pet-fuse-ensemble-v1' THEN 70
          WHEN 'pet-embed-dogreid-v1' THEN 80
          WHEN 'semantic-embed-siglip2-v1' THEN 90
          WHEN 'video-analyze-v1' THEN 95
          WHEN 'catalog-semantic-qwen3vl4b-v3' THEN 100
          ELSE 1
        END DESC, aj.id DESC
        LIMIT 1
      ) AS analysis_stage
    FROM media_items m
    JOIN media_sources ms ON ms.id=m.source_id
    LEFT JOIN media_thumbnails t ON t.media_id=m.id
    LEFT JOIN media_image_metadata md ON md.media_id=m.id
    LEFT JOIN semantic_embeddings se ON se.media_id=m.id
    LEFT JOIN media_semantic_annotations msa ON msa.media_id=m.id
    WHERE ${sourceWhere}${mediaKindSql}${searchSql}
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
    ...sourceArgs,
    ...kindExtensions,
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
    sourcePath: row.source_path ? String(row.source_path) : null,
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
    lastAnalyzedAt: row.last_analyzed_at ? String(row.last_analyzed_at) : null,
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
    analysisStage: row.analysis_stage ? String(row.analysis_stage) : "",
    analysisStageStatus: row.analysis_stage ? "DONE" : "NONE",
    markerLabels: [
      ...(row.person_names
        ? String(row.person_names).split("\u001f").filter(Boolean)
            .map((name) => "Person: " + name)
        : []),
      ...(row.pet_names
        ? String(row.pet_names).split("\u001f").filter(Boolean)
            .map((name) => "Haustier: " + name)
        : []),
      ...(row.life_area_names
        ? String(row.life_area_names).split("\u001f").filter(Boolean)
            .map((name) => "Lebensbereich: " + name)
        : []),
      ...parseSemanticStringList(row.catalog_subjects_json),
      ...parseSemanticStringList(row.catalog_actions_json),
      ...parseSemanticStringList(row.catalog_scenes_json),
      ...parseSemanticStringList(row.catalog_tags_json),
      ...parseSemanticStringList(row.catalog_concepts_json)
    ].filter((value, index, values) => value && values.indexOf(value) === index),
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

function listGeoMedia(sourceId?: number) {
  const rows = db.prepare(`
    SELECT
      m.id AS media_id,
      m.source_id,
      m.relative_path,
      md.gps_latitude,
      md.gps_longitude,
      md.captured_at,
      t.input_sha256 AS thumbnail_version
    FROM media_items m
    JOIN media_sources ms ON ms.id=m.source_id
    JOIN media_image_metadata md ON md.media_id=m.id
    LEFT JOIN media_thumbnails t ON t.media_id=m.id
    WHERE ms.enabled=1
      AND m.availability='AVAILABLE'
      AND md.gps_latitude IS NOT NULL
      AND md.gps_longitude IS NOT NULL
      AND md.gps_latitude BETWEEN -90 AND 90
      AND md.gps_longitude BETWEEN -180 AND 180
      AND (? IS NULL OR m.source_id=?)
    ORDER BY COALESCE(md.captured_at, m.last_seen_at) DESC, m.id DESC
  `).all(sourceId ?? null, sourceId ?? null);

  return rows.map((row) => ({
    mediaId: Number(row.media_id),
    sourceId: Number(row.source_id),
    relativePath: String(row.relative_path),
    latitude: Number(row.gps_latitude),
    longitude: Number(row.gps_longitude),
    capturedAt: row.captured_at ? String(row.captured_at) : null,
    thumbnailVersion: row.thumbnail_version ? String(row.thumbnail_version) : null
  }));
}

function getSearchFacets(sourceId?: number): SearchFacets {
  const sourceFilter = sourceId === undefined ? "" : "AND m.source_id=?";
  const sourceArgs = sourceId === undefined ? [] : [sourceId];

  const persons = db.prepare(`
    SELECT
      p.id,
      p.name,
      COUNT(DISTINCT fd.media_id) AS media_count,
      MIN(fd.id) AS representative_face_id
    FROM persons p
    JOIN person_face_assignments pfa ON pfa.person_id=p.id
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    WHERE m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      ${sourceFilter}
    GROUP BY p.id, p.name
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(...sourceArgs).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    mediaCount: Number(row.media_count ?? 0),
    representativeFaceId:
      row.representative_face_id === null
        ? null
        : Number(row.representative_face_id)
  }));

  const pets = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.pet_class,
      COUNT(DISTINCT pd.media_id) AS media_count,
      MIN(pd.id) AS representative_pet_id
    FROM pets p
    JOIN pet_assignments pa ON pa.pet_id=p.id
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      ${sourceFilter}
    GROUP BY p.id, p.name, p.pet_class
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(...sourceArgs).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    petClass: String(row.pet_class) === "cat" ? "cat" as const : "dog" as const,
    mediaCount: Number(row.media_count ?? 0),
    representativePetId:
      row.representative_pet_id === null
        ? null
        : Number(row.representative_pet_id)
  }));

  const objects = db.prepare(`
    SELECT
      od.label,
      COUNT(DISTINCT od.media_id) AS media_count
    FROM object_fused_detections od
    JOIN media_items m ON m.id=od.media_id
    WHERE m.availability='AVAILABLE'
      AND od.input_sha256=m.sha256
      AND od.label NOT IN ('dog','cat')
      ${sourceFilter}
    GROUP BY od.label
    ORDER BY media_count DESC, od.label COLLATE NOCASE
  `).all(...sourceArgs).map((row) => ({
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
    markerLabels: [],
    analysisStage: "",
    analysisStageStatus: "NONE",
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

function indexedMediaFromRow(row: Record<string, unknown>): IndexedMedia {
  return {
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
}

function createMediaIndex(rows: Array<Record<string, unknown>>): {
  byPath: Map<string, IndexedMedia>;
  byHash: Map<string, IndexedMedia[]>;
  byIdentity: Map<string, IndexedMedia[]>;
} {
  const byPath = new Map<string, IndexedMedia>();
  const byHash = new Map<string, IndexedMedia[]>();
  const byIdentity = new Map<string, IndexedMedia[]>();

  for (const row of rows) {
    const media = indexedMediaFromRow(row);
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

function indexedMediaSelectSql(): string {
  return `
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
  `;
}

function loadIndex(sourceId: number): {
  byPath: Map<string, IndexedMedia>;
  byHash: Map<string, IndexedMedia[]>;
  byIdentity: Map<string, IndexedMedia[]>;
} {
  const rows = db.prepare(
    indexedMediaSelectSql() + " WHERE source_id=?"
  ).all(sourceId) as Array<Record<string, unknown>>;

  return createMediaIndex(rows);
}

function loadIndexForPaths(
  sourceId: number,
  relativePaths: string[]
): {
  byPath: Map<string, IndexedMedia>;
  byHash: Map<string, IndexedMedia[]>;
  byIdentity: Map<string, IndexedMedia[]>;
} {
  const uniquePaths = [...new Set(relativePaths)];
  if (uniquePaths.length === 0) return createMediaIndex([]);

  const rows: Array<Record<string, unknown>> = [];
  const chunkSize = 400;

  for (let offset = 0; offset < uniquePaths.length; offset += chunkSize) {
    const chunk = uniquePaths.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const chunkRows = db.prepare(
      indexedMediaSelectSql() +
        ` WHERE source_id=? AND relative_path IN (${placeholders})`
    ).all(sourceId, ...chunk) as Array<Record<string, unknown>>;
    rows.push(...chunkRows);
  }

  return createMediaIndex(rows);
}

function loadIdentityCandidates(
  sourceId: number,
  deviceId: string,
  inode: string
): IndexedMedia[] {
  if (!identityKey(deviceId, inode)) return [];

  const rows = db.prepare(
    indexedMediaSelectSql() +
      " WHERE source_id=? AND device_id=? AND inode=?"
  ).all(sourceId, deviceId, inode) as Array<Record<string, unknown>>;

  return rows.map(indexedMediaFromRow);
}

function loadHashCandidates(
  sourceId: number,
  hash: string,
  sizeBytes: number
): IndexedMedia[] {
  const rows = db.prepare(
    indexedMediaSelectSql() +
      " WHERE source_id=? AND sha256=? AND size_bytes=?"
  ).all(sourceId, hash, sizeBytes) as Array<Record<string, unknown>>;

  return rows.map(indexedMediaFromRow);
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
  mediaByPath: Map<string, IndexedMedia>,
  changes: CatalogChange[]
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
      const previousPath = media.relativePath;
      const newRelativePath = replaceDirectoryPrefix(previousPath, oldPrefix, newPrefix);
      const newAbsolutePath = path.join(root, ...newRelativePath.split("/"));
      updateMedia.run(newRelativePath, newAbsolutePath, media.id, sourceId);
      changes.push({
        kind: "MOVED",
        mediaId: media.id,
        path: newRelativePath,
        previousPath
      });
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
  mediaByPath: Map<string, IndexedMedia>,
  changes: CatalogChange[]
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
      mediaByPath,
      changes
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

async function uniqueIdentityMoveCandidateFromDb(
  sourceId: number,
  deviceId: string,
  inode: string,
  seenIds: Set<number>
): Promise<IndexedMedia | null> {
  const key = identityKey(deviceId, inode);
  if (!key) return null;

  const candidates = loadIdentityCandidates(sourceId, deviceId, inode);
  return uniqueIdentityMoveCandidate(
    deviceId,
    inode,
    new Map([[key, candidates]]),
    seenIds
  );
}

async function uniqueMoveCandidateFromDb(
  sourceId: number,
  hash: string,
  sizeBytes: number,
  deviceId: string,
  inode: string,
  seenIds: Set<number>
): Promise<IndexedMedia | null> {
  return uniqueMoveCandidate(
    hash,
    sizeBytes,
    deviceId,
    inode,
    new Map([[hash, loadHashCandidates(sourceId, hash, sizeBytes)]]),
    seenIds
  );
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

const IMAGE_ANALYSIS_MODULES = new Set([
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

const VIDEO_ANALYSIS_MODULES = new Set(["video-analyze-v1"]);

function detectedMediaKindFilter(module: string, mediaAlias = "m"): string {
  const kind = IMAGE_ANALYSIS_MODULES.has(module)
    ? "image"
    : VIDEO_ANALYSIS_MODULES.has(module)
      ? "video"
      : null;

  if (!kind) return "";

  return `
    AND EXISTS (
      SELECT 1
      FROM analysis_jobs probe
      WHERE probe.media_id=${mediaAlias}.id
        AND probe.module='file-probe-v1'
        AND probe.status='DONE'
        AND probe.input_sha256=${mediaAlias}.sha256
        AND probe.result_json LIKE '%"detectedKind":"${kind}"%'
    )
  `;
}

function enqueueAnalysisJobs(sourceId: number, module = "file-probe-v1") {
  const mediaKindFilter = detectedMediaKindFilter(module);

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
      ${mediaKindFilter}
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


function getPetDetectionQueueStats(sourceId?: number) {
  const sourceFilter = sourceId === undefined ? "" : "AND m.source_id=?";
  const args = sourceId === undefined ? [] : [sourceId];

  const row = db.prepare(`
    SELECT
      SUM(CASE
        WHEN nano_status='DONE' AND yolox_status='DONE' THEN 1
        ELSE 0
      END) AS done,
      SUM(CASE
        WHEN nano_status='RUNNING' OR yolox_status='RUNNING' THEN 1
        ELSE 0
      END) AS running,
      SUM(CASE
        WHEN nano_status<>'RUNNING'
          AND yolox_status<>'RUNNING'
          AND (nano_status='FAILED' OR yolox_status='FAILED')
        THEN 1 ELSE 0
      END) AS failed,
      SUM(CASE
        WHEN nano_status<>'RUNNING'
          AND yolox_status<>'RUNNING'
          AND nano_status<>'FAILED'
          AND yolox_status<>'FAILED'
          AND (nano_status='UNAVAILABLE' OR yolox_status='UNAVAILABLE')
        THEN 1 ELSE 0
      END) AS unavailable,
      SUM(CASE
        WHEN NOT (nano_status='DONE' AND yolox_status='DONE')
          AND nano_status<>'RUNNING'
          AND yolox_status<>'RUNNING'
          AND nano_status<>'FAILED'
          AND yolox_status<>'FAILED'
          AND nano_status<>'UNAVAILABLE'
          AND yolox_status<>'UNAVAILABLE'
        THEN 1 ELSE 0
      END) AS pending
    FROM (
      SELECT
        m.id,
        COALESCE(MAX(CASE
          WHEN j.module='pet-detect-nanodet-v1' THEN j.status
        END), 'PENDING') AS nano_status,
        COALESCE(MAX(CASE
          WHEN j.module='pet-detect-yolox-v1' THEN j.status
        END), 'PENDING') AS yolox_status
      FROM media_items m
      JOIN analysis_jobs j ON j.media_id=m.id
      WHERE j.module IN ('pet-detect-nanodet-v1','pet-detect-yolox-v1')
        ${sourceFilter}
      GROUP BY m.id
    )
  `).get(...args);

  return {
    pending: Number(row?.pending ?? 0),
    running: Number(row?.running ?? 0),
    done: Number(row?.done ?? 0),
    failed: Number(row?.failed ?? 0),
    unavailable: Number(row?.unavailable ?? 0)
  };
}


function getAnalysisHistory(days = 30) {
  const normalizedDays = Math.max(1, Math.min(90, Math.trunc(Number(days) || 30)));
  const modifier = "-" + Math.max(0, normalizedDays - 1) + " days";

  const rows = db.prepare(`
    SELECT
      date(finished_at, 'localtime') AS day,
      module,
      status,
      COUNT(*) AS count,
      CAST(ROUND(AVG(duration_ms)) AS INTEGER) AS avg_duration_ms
    FROM analysis_job_history
    WHERE date(finished_at, 'localtime') >= date('now', 'localtime', ?)
    GROUP BY date(finished_at, 'localtime'), module, status
    ORDER BY day DESC, module ASC, status ASC
  `).all(modifier);

  return {
    days: normalizedDays,
    rows: rows.map((row: any) => ({
      day: String(row.day ?? ""),
      module: String(row.module ?? ""),
      status: String(row.status ?? ""),
      count: Number(row.count ?? 0),
      avgDurationMs:
        row.avg_duration_ms === null || row.avg_duration_ms === undefined
          ? null
          : Number(row.avg_duration_ms)
    }))
  };
}


function countAnalysisErrors(sourceId?: number): number {
  const sourceFilter = sourceId === undefined ? "" : "AND m.source_id=?";
  const args: number[] = sourceId === undefined ? [] : [sourceId];

  const row = db.prepare(`
    SELECT COUNT(*) AS count
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
  `).get(...args);

  return Number(row?.count ?? 0);
}


function getPipelineQueueStats() {
  const rows = db.prepare(`
    SELECT module, status, COUNT(*) AS count
    FROM analysis_jobs
    GROUP BY module, status
  `).all();

  const byModule: Record<string, {
    pending: number;
    running: number;
    done: number;
    failed: number;
    unavailable: number;
  }> = {};

  for (const row of rows) {
    const module = String(row.module);
    const stats = byModule[module] ?? {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      unavailable: 0
    };

    const count = Number(row.count ?? 0);
    switch (String(row.status)) {
      case "PENDING":
        stats.pending += count;
        break;
      case "RUNNING":
        stats.running += count;
        break;
      case "DONE":
        stats.done += count;
        break;
      case "FAILED":
        stats.failed += count;
        break;
      case "UNAVAILABLE":
        stats.unavailable += count;
        break;
    }

    byModule[module] = stats;
  }

  return {
    byModule,
    petDetection: getPetDetectionQueueStats()
  };
}

function getIdentityEmbeddingCounts() {
  const sources = db.prepare(`
    SELECT id
    FROM media_sources
    WHERE enabled=1
    ORDER BY id ASC
  `).all();

  const faceRows = db.prepare(`
    SELECT m.source_id, COUNT(*) AS count
    FROM face_embeddings fe
    JOIN face_detections fd ON fd.id=fe.face_detection_id
    JOIN media_items m ON m.id=fe.media_id
    WHERE m.availability='AVAILABLE'
      AND fe.model_version='SFace 2021dec'
      AND fe.input_sha256=m.sha256
      AND fd.input_sha256=m.sha256
    GROUP BY m.source_id
  `).all();

  const dogRows = db.prepare(`
    SELECT m.source_id, COUNT(*) AS count
    FROM pet_embeddings pe
    JOIN pet_fused_detections pd ON pd.id=pe.pet_detection_id
    JOIN media_items m ON m.id=pe.media_id
    WHERE m.availability='AVAILABLE'
      AND pd.pet_class='dog'
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pe.input_sha256=m.sha256
      AND pd.input_sha256=m.sha256
    GROUP BY m.source_id
  `).all();

  const faceCounts = new Map(
    faceRows.map((row) => [Number(row.source_id), Number(row.count ?? 0)])
  );
  const dogCounts = new Map(
    dogRows.map((row) => [Number(row.source_id), Number(row.count ?? 0)])
  );

  return sources.map((source) => {
    const sourceId = Number(source.id);
    return {
      sourceId,
      faces: faceCounts.get(sourceId) ?? 0,
      dogs: dogCounts.get(sourceId) ?? 0
    };
  });
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

function claimAnalysisJob(
  module = "file-probe-v1",
  mediaId?: number
) {
  const mediaKindFilter = detectedMediaKindFilter(module);
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
        ${mediaId === undefined ? "" : "AND j.media_id=?"}
        ${mediaKindFilter}
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
      ORDER BY
        j.priority ASC,
        m.first_seen_at DESC,
        j.id ASC
      LIMIT 1
    `).get(...(
      mediaId === undefined
        ? [module]
        : [module, mediaId]
    ));

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
  const job = db.prepare(`
    SELECT id, media_id, module, input_sha256
    FROM analysis_jobs
    WHERE id=? AND status='RUNNING'
  `).get(jobId);
  // A previous run may still return after an explicit requeue. Never let such
  // results update the replacement job's state or enqueue stale modules.
  if (!job) throw new Error("Veraltetes Analyseergebnis nach Neueinreihung verworfen.");

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

  if (job && String(job.module) === "file-probe-v1") {
    const value =
      result && typeof result === "object"
        ? result as Record<string, unknown>
        : {};
    const detectedKind =
      value.detectedKind === "image" || value.detectedKind === "video"
        ? String(value.detectedKind)
        : "unknown";
    const mediaId = Number(job.media_id);
    const sha256 = String(job.input_sha256 ?? "");

    // Veraltete, nur anhand der Endung erzeugte Jobs entfernen. Danach wird
    // ausschließlich die Pipeline des tatsächlich erkannten Dateiinhalts
    // angelegt.
    const removeModules = detectedKind === "image"
      ? [...VIDEO_ANALYSIS_MODULES]
      : detectedKind === "video"
        ? [...IMAGE_ANALYSIS_MODULES]
        : [...IMAGE_ANALYSIS_MODULES, ...VIDEO_ANALYSIS_MODULES];

    const remove = db.prepare(`
      DELETE FROM analysis_jobs
      WHERE media_id=?
        AND module=?
        AND id<>?
    `);
    for (const module of removeModules) {
      remove.run(mediaId, module, jobId);
    }

    const targetModules = detectedKind === "image"
      ? [...IMAGE_ANALYSIS_MODULES]
      : detectedKind === "video"
        ? [...VIDEO_ANALYSIS_MODULES]
        : [];

    for (const module of targetModules) {
      enqueueSingleMediaJob.run(mediaId, module, sha256);
    }

    return {
      completed: true,
      detectedKind,
      queuedModules: targetModules.length
    };
  }

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

const enqueueSingleMediaJob = db.prepare(`
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
  VALUES(?,?,'PENDING',100,0,NULL,?,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
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

function enqueueFastAnalysisJobsForMedia(
  mediaId: number,
  sha256: string
): void {
  // Erst die Signatur prüfen. Die Dateiendung ist keine verlässliche Aussage
  // darüber, ob es sich wirklich um Bild oder Video handelt.
  enqueueSingleMediaJob.run(mediaId, "file-probe-v1", sha256);
}

function enqueueAllAnalysisJobs(sourceId: number): void {
  for (const module of [
    "file-probe-v1",
    "thumbnail-v1",
    "video-analyze-v1",
    "image-metadata-v1",
    "face-detect-yunet-v1",
    "face-embed-sface-v1",
    "pet-detect-nanodet-v1",
    "pet-detect-yolox-v1",
    "pet-fuse-ensemble-v1",
    "pet-embed-dogreid-v1",
    "semantic-embed-siglip2-v1",
    "catalog-semantic-qwen3vl4b-v3"
  ]) {
    enqueueAnalysisJobs(sourceId, module);
  }
}

function normalizeChangedRelativePath(root: string, raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;

  const candidate = path.resolve(root, raw.trim());
  const relative = path.relative(root, candidate);

  if (
    relative === "" ||
    relative === "." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return relative === "" || relative === "." ? "" : null;
  }

  return relative.split(path.sep).join("/");
}

async function discoveredFileFromPath(
  root: string,
  absolutePath: string
): Promise<DiscoveredFile | null> {
  const extension = path.extname(absolutePath).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) return null;

  const info = await stat(absolutePath, { bigint: true });
  if (!info.isFile()) return null;

  return {
    absolutePath,
    relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
    extension,
    sizeBytes: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
    deviceId: info.dev.toString(),
    inode: info.ino.toString()
  };
}

async function reconcileSourceChanges(
  sourceId: number,
  rawPaths: unknown
): Promise<ScanResult> {
  const requestedPaths = Array.isArray(rawPaths)
    ? [...new Set(
        rawPaths
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      )]
    : [];

  // Nur ein Ereignis ohne konkreten Pfad benötigt einen Vollscan. Große
  // Import-Batches bleiben gezielt: So müssen nicht bei jeder Event-Welle
  // sämtliche bereits katalogisierten Dateien erneut durchlaufen werden.
  if (requestedPaths.length === 0) {
    return scanSource(sourceId);
  }

  const root = await resolveSourceRoot(sourceId);
  const relativePaths: string[] = [];

  for (const rawPath of requestedPaths) {
    const relative = normalizeChangedRelativePath(root, rawPath);
    if (relative === null || relative === "") {
      return scanSource(sourceId);
    }
    relativePaths.push(relative);
  }

  // Ein verschwundener katalogisierter Ordner kann ein Rename, Move oder
  // Löschen eines ganzen Teilbaums sein. Dafür ist der bestehende Vollscan
  // bewusst die sichere Wahrheit. Für normale Datei-Events aber nicht mehr den
  // kompletten Ordnerindex laden, sondern nur den betroffenen Pfad prüfen.
  const knownDirectoryAtPath = db.prepare(`
    SELECT 1
    FROM media_directories
    WHERE source_id=? AND relative_path=?
    LIMIT 1
  `);
  let containsDirectoryPath = false;

  for (const relativePath of relativePaths) {
    await waitForProcessingResume();
    const absolutePath = path.join(root, ...relativePath.split("/"));
    try {
      const info = await stat(absolutePath);
      if (info.isDirectory()) {
        containsDirectoryPath = true;
      }
    } catch {
      if (knownDirectoryAtPath.get(sourceId, relativePath)) {
        return scanSource(sourceId);
      }
    }
  }

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
  const changes: CatalogChange[] = [];

  try {
    const started = db.prepare("INSERT INTO scans(source_id) VALUES(?)").run(sourceId);
    scanId = Number(started.lastInsertRowid);

    const token = randomUUID();
    // Normale Datei-Events dürfen nicht mehr den kompletten Medienbestand der
    // Quelle in drei Maps laden. Bei Verzeichnisereignissen bleibt der volle
    // Index bewusst erhalten, weil Directory-Moves ganze Teilbäume umschreiben.
    const { byPath, byHash, byIdentity } = containsDirectoryPath
      ? loadIndex(sourceId)
      : loadIndexForPaths(sourceId, relativePaths);
    const directoryIndex: DirectoryIndex = containsDirectoryPath
      ? loadDirectoryIndex(sourceId)
      : {
          byPath: new Map(),
          byIdentity: new Map(),
          all: new Map()
        };
    const seenIds = new Set<number>();
    const seenDirectoryIds = new Set<number>();
    const readErrorPaths: string[] = [];
    const scannedDirectoryPrefixes = new Set<string>();
    const missingPaths: string[] = [];
    const processedFiles = new Set<string>();
    let needsJobReactivation = false;

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

    const reconcileFile = async (file: DiscoveredFile): Promise<void> => {
      const normalizedAbsolute = normalizeForComparison(file.absolutePath);
      if (processedFiles.has(normalizedAbsolute)) return;
      processedFiles.add(normalizedAbsolute);
      discovered += 1;

      const previous = byPath.get(file.relativePath);

      if (previous) {
        seenIds.add(previous.id);
        if (previous.availability !== "AVAILABLE") {
          needsJobReactivation = true;
        }

        if (
          previous.sizeBytes === file.sizeBytes &&
          previous.mtimeMs === file.mtimeMs &&
          (
            !identityKey(previous.deviceId, previous.inode) ||
            sameIdentity(
              previous.deviceId,
              previous.inode,
              file.deviceId,
              file.inode
            )
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
          previous.availability = "AVAILABLE";
          unchanged += 1;
          return;
        }

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
          previous.availability = "AVAILABLE";
          unchanged += 1;
          return;
        }

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
        previous.availability = "AVAILABLE";
        enqueueFastAnalysisJobsForMedia(previous.id, hash);
        changed += 1;
        changes.push({
          kind: "CHANGED",
          mediaId: previous.id,
          path: file.relativePath,
          previousPath: null
        });
        return;
      }

      const identityCandidate = containsDirectoryPath
        ? await uniqueIdentityMoveCandidate(
            file.deviceId,
            file.inode,
            byIdentity,
            seenIds
          )
        : await uniqueIdentityMoveCandidateFromDb(
            sourceId,
            file.deviceId,
            file.inode,
            seenIds
          );

      if (identityCandidate) {
        const previousPath = identityCandidate.relativePath;
        if (identityCandidate.availability !== "AVAILABLE") {
          needsJobReactivation = true;
        }
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

        byPath.delete(previousPath);
        identityCandidate.relativePath = file.relativePath;
        identityCandidate.absolutePath = file.absolutePath;
        identityCandidate.extension = file.extension;
        identityCandidate.sizeBytes = file.sizeBytes;
        identityCandidate.mtimeMs = file.mtimeMs;
        identityCandidate.deviceId = file.deviceId;
        identityCandidate.inode = file.inode;
        identityCandidate.availability = "AVAILABLE";
        byPath.set(file.relativePath, identityCandidate);
        seenIds.add(identityCandidate.id);
        moved += 1;
        changes.push({
          kind: "MOVED",
          mediaId: identityCandidate.id,
          path: file.relativePath,
          previousPath
        });
        return;
      }

      const hash = await sha256File(file.absolutePath);
      const moveCandidate = containsDirectoryPath
        ? await uniqueMoveCandidate(
            hash,
            file.sizeBytes,
            file.deviceId,
            file.inode,
            byHash,
            seenIds
          )
        : await uniqueMoveCandidateFromDb(
            sourceId,
            hash,
            file.sizeBytes,
            file.deviceId,
            file.inode,
            seenIds
          );

      if (moveCandidate) {
        const previousPath = moveCandidate.relativePath;
        if (moveCandidate.availability !== "AVAILABLE") {
          needsJobReactivation = true;
        }
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

        byPath.delete(previousPath);
        moveCandidate.relativePath = file.relativePath;
        moveCandidate.absolutePath = file.absolutePath;
        moveCandidate.extension = file.extension;
        moveCandidate.sizeBytes = file.sizeBytes;
        moveCandidate.mtimeMs = file.mtimeMs;
        moveCandidate.deviceId = file.deviceId;
        moveCandidate.inode = file.inode;
        moveCandidate.availability = "AVAILABLE";
        byPath.set(file.relativePath, moveCandidate);
        seenIds.add(moveCandidate.id);
        moved += 1;
        changes.push({
          kind: "MOVED",
          mediaId: moveCandidate.id,
          path: file.relativePath,
          previousPath
        });
        return;
      }

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
      const identity = identityKey(file.deviceId, file.inode);
      if (identity) {
        const identityItems = byIdentity.get(identity) ?? [];
        identityItems.push(insertedMedia);
        byIdentity.set(identity, identityItems);
      }

      seenIds.add(insertedMedia.id);
      enqueueFastAnalysisJobsForMedia(
        insertedMedia.id,
        insertedMedia.sha256
      );
      added += 1;
      changes.push({
        kind: "ADDED",
        mediaId: insertedMedia.id,
        path: insertedMedia.relativePath,
        previousPath: null
      });
    };

    // Zuerst alles verarbeiten, was aktuell existiert. Dadurch kann bei einem
    // Datei-Rename die neue Stelle die alte media_id übernehmen, bevor das
    // verschwundene alte Watcher-Ereignis betrachtet wird.
    for (const relativePath of relativePaths) {
      await waitForProcessingResume();
      const absolutePath = path.join(root, ...relativePath.split("/"));

      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        missingPaths.push(relativePath);
        continue;
      }

      if (info.isFile()) {
        const file = await discoveredFileFromPath(root, absolutePath);
        if (file) {
          try {
            await reconcileFile(file);
          } catch {
            errors += 1;
            readErrorPaths.push(absolutePath);
          }
        }
        continue;
      }

      if (!info.isDirectory()) continue;

      scannedDirectoryPrefixes.add(relativePath);
      for await (const file of walkMedia(absolutePath, {
        onError: (readError) => {
          errors += 1;
          readErrorPaths.push(readError.path);
        },
        onDirectory: async (directory) => {
          const sourceRelative = path
            .relative(root, directory.absolutePath)
            .split(path.sep)
            .join("/");
          moved += reconcileDirectory(
            sourceId,
            root,
            {
              ...directory,
              relativePath: sourceRelative
            },
            token,
            directoryIndex,
            seenDirectoryIds,
            byPath,
            changes
          );
        }
      })) {
        await waitForProcessingResume();
        const sourceRelative = path
          .relative(root, file.absolutePath)
          .split(path.sep)
          .join("/");

        try {
          await reconcileFile({
            ...file,
            relativePath: sourceRelative
          });
        } catch {
          errors += 1;
          readErrorPaths.push(file.absolutePath);
        }
      }
    }

    const markMissing = db.prepare(`
      UPDATE media_items
      SET availability='MISSING'
      WHERE id=?
    `);

    const markMissingMedia = (media: IndexedMedia): void => {
      if (media.availability !== "AVAILABLE" || seenIds.has(media.id)) return;
      if (pathAffectedByReadError(media.absolutePath, readErrorPaths)) return;

      markMissing.run(media.id);
      media.availability = "MISSING";
      missing += 1;
      changes.push({
        kind: "MISSING",
        mediaId: media.id,
        path: media.relativePath,
        previousPath: null
      });
    };

    for (const relativePath of missingPaths) {
      const media = byPath.get(relativePath);
      if (media) markMissingMedia(media);
    }

    for (const prefix of scannedDirectoryPrefixes) {
      for (const media of byPath.values()) {
        if (pathIsInside(media.relativePath, prefix)) {
          markMissingMedia(media);
        }
      }
    }

    if (missing > 0) {
      // Die Windows-Papierkorbsuche ist teuer und darf nicht bei jeder neuen
      // oder geänderten Datei laufen. Sie ist nur nötig, wenn tatsächlich
      // Katalogmedien verschwunden sind.
      recycleBin = await refreshRecycleStatus(sourceId);

      const recycleState = db.prepare(`
        SELECT in_recycle_bin, recycle_ambiguous
        FROM media_items
        WHERE id=?
      `);

      for (const change of changes) {
        if (change.kind !== "MISSING") continue;
        const state = recycleState.get(change.mediaId);
        if (state?.in_recycle_bin) change.kind = "RECYCLE";
        else if (state?.recycle_ambiguous) change.kind = "RECYCLE_AMBIGUOUS";
      }
    } else {
      recycleBin = Number(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM media_items
          WHERE source_id=?
            AND availability='MISSING'
            AND (in_recycle_bin=1 OR recycle_ambiguous=1)
        `).get(sourceId)?.count ?? 0
      );
    }

    if (needsJobReactivation) {
      reactivateAvailableMediaJobs(sourceId);
    }

    // Kein globales enqueueAllAnalysisJobs() mehr im Live-Pfad:
    // neue/geänderte Medien erhalten file-probe-v1 bereits direkt in
    // reconcileFile(); completeAnalysisJob() reiht danach exakt die passende
    // Bild- oder Video-Pipeline ein. Der globale Aufruf war bei jeder kleinen
    // Watcher-Welle ein vollständiger 12-Modul-Katalogdurchlauf.

    const result: ScanResult = {
      mode: "INCREMENTAL",
      discovered,
      added,
      moved,
      changed,
      unchanged,
      missing,
      recycleBin,
      errors,
      changes: changes.slice(0, 500)
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
      "Schnellabgleich fertig: " +
      added.toLocaleString("de-DE") + " neu · " +
      moved.toLocaleString("de-DE") + " verschoben · " +
      changed.toLocaleString("de-DE") + " geändert · " +
      missing.toLocaleString("de-DE") + " fehlend."
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
  const changes: CatalogChange[] = [];

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
          byPath,
          changes
        );
      }
    })) {
      await waitForProcessingResume();
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
              enqueueFastAnalysisJobsForMedia(previous.id, hash);
              changed += 1;
              changes.push({
                kind: "CHANGED",
                mediaId: previous.id,
                path: file.relativePath,
                previousPath: null
              });
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
            const previousPath = identityCandidate.relativePath;
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
            changes.push({
              kind: "MOVED",
              mediaId: identityCandidate.id,
              path: file.relativePath,
              previousPath
            });
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
              const previousPath = moveCandidate.relativePath;
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
              changes.push({
                kind: "MOVED",
                mediaId: moveCandidate.id,
                path: file.relativePath,
                previousPath
              });
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
              enqueueFastAnalysisJobsForMedia(
                insertedMedia.id,
                insertedMedia.sha256
              );
              added += 1;
              changes.push({
                kind: "ADDED",
                mediaId: insertedMedia.id,
                path: insertedMedia.relativePath,
                previousPath: null
              });
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
      SELECT id, absolute_path, relative_path
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
        changes.push({
          kind: "MISSING",
          mediaId: Number(row.id),
          path: String(row.relative_path),
          previousPath: null
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    recycleBin = await refreshRecycleStatus(sourceId);

    const recycleState = db.prepare(`
      SELECT in_recycle_bin, recycle_ambiguous
      FROM media_items
      WHERE id=?
    `);
    for (const change of changes) {
      if (change.kind !== "MISSING") continue;
      const state = recycleState.get(change.mediaId);
      if (state?.in_recycle_bin) change.kind = "RECYCLE";
      else if (state?.recycle_ambiguous) change.kind = "RECYCLE_AMBIGUOUS";
    }

    reactivateAvailableMediaJobs(sourceId);
    enqueueAllAnalysisJobs(sourceId);

    const result: ScanResult = {
      mode: "FULL",
      discovered,
      added,
      moved,
      changed,
      unchanged,
      missing,
      recycleBin,
      errors,
      changes: changes.slice(0, 500)
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

  if (value.module !== "face-detect-yunet-v1") {
    throw new Error(
      "Gesichtsdetektions-Ergebnis enthält ein falsches oder fehlendes Modul."
    );
  }

  if (!Array.isArray(value.faces)) {
    throw new Error(
      "Gesichtsdetektions-Ergebnis enthält keine gültige Gesichterliste."
    );
  }

  const rawFaces = value.faces;
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
      if (!face || typeof face !== "object") {
        throw new Error(
          "Gesichtsdetektion #" + (index + 1) + " ist kein gültiges Objekt."
        );
      }

      const item = face as Record<string, unknown>;
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      const score = Number(item.score);
      const landmarks = Array.isArray(item.landmarks) ? item.landmarks : [];

      if (![x, y, width, height, score].every(Number.isFinite)) {
        throw new Error(
          "Gesichtsdetektion #" + (index + 1) +
          " enthält ungültige Zahlenwerte."
        );
      }

      if (width <= 0 || height <= 0) {
        throw new Error(
          "Gesichtsdetektion #" + (index + 1) +
          " hat eine ungültige Größe."
        );
      }

      if (
        landmarks.length !== 5 ||
        landmarks.some((landmark) => {
          if (!landmark || typeof landmark !== "object") return true;
          const point = landmark as Record<string, unknown>;
          return (
            !Number.isFinite(Number(point.x)) ||
            !Number.isFinite(Number(point.y))
          );
        })
      ) {
        throw new Error(
          "Gesichtsdetektion #" + (index + 1) +
          " enthält keine fünf gültigen Landmarken."
        );
      }

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
        JSON.stringify(landmarks)
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

  return { completed: true, faceCount: rawFaces.length };
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
  algorithmVersion: string,
  ignoreDefiniteThreshold: number,
  ignoreDoubtThreshold: number
) {
  const rawRows = db.prepare(`
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
    LEFT JOIN ignored_pet_matches ipm ON ipm.pet_detection_id=pd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pe.input_sha256=m.sha256
      AND pd.input_sha256=m.sha256
      AND pd.pet_class='dog'
      AND pa.pet_detection_id IS NULL
      AND ipm.pet_detection_id IS NULL
    ORDER BY pd.id ASC
  `).all(sourceId);

  const ignoredIdentities = ignoredPetVectorIdentities();
  const insertIgnoredMatch = db.prepare(`
    INSERT INTO ignored_pet_matches(
      pet_detection_id,
      identity_id,
      match_source,
      similarity,
      updated_at
    )
    VALUES(?,?,'AUTO_HIGH_CONFIDENCE',?,CURRENT_TIMESTAMP)
    ON CONFLICT(pet_detection_id) DO UPDATE SET
      identity_id=excluded.identity_id,
      match_source=excluded.match_source,
      similarity=excluded.similarity,
      updated_at=CURRENT_TIMESTAMP
  `);

  const removeCandidateMembership = db.prepare(`
    DELETE FROM pet_candidate_items
    WHERE pet_detection_id=?
  `);

  const rows = rawRows.filter((row) => {
    const vector = vectorFromBlob(row.vector_blob, Number(row.dimension));
    const match = classifyIgnoredVectors(
      [vector],
      ignoredIdentities,
      ignoreDefiniteThreshold,
      ignoreDoubtThreshold,
      String(row.pet_class)
    );

    if (!match?.definite) return true;

    const petDetectionId = Number(row.pet_detection_id);
    insertIgnoredMatch.run(
      petDetectionId,
      match.identityId,
      match.similarity
    );
    removeCandidateMembership.run(petDetectionId);
    return false;
  });

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

  const implicitCannotLinks: Array<{ petAId: number; petBId: number }> = [];
  const petIdsByMedia = new Map<number, number[]>();
  for (const row of rows) {
    const mediaId = Number(row.media_id);
    const idsForMedia = petIdsByMedia.get(mediaId) ?? [];
    idsForMedia.push(Number(row.pet_detection_id));
    petIdsByMedia.set(mediaId, idsForMedia);
  }

  for (const idsForMedia of petIdsByMedia.values()) {
    for (let left = 0; left < idsForMedia.length; left += 1) {
      for (let right = left + 1; right < idsForMedia.length; right += 1) {
        implicitCannotLinks.push({
          petAId: Math.min(idsForMedia[left], idsForMedia[right]),
          petBId: Math.max(idsForMedia[left], idsForMedia[right])
        });
      }
    }
  }

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
    cannotLinkSignature,
    ignoredIdentityRevision("pet")
  ].join(":");

  const previousRun = db.prepare(`
    SELECT embedding_revision, algorithm_version
    FROM pet_cluster_runs
    WHERE source_id=?
  `).get(sourceId);

  const algorithmChanged =
    !previousRun ||
    String(previousRun.algorithm_version) !== algorithmVersion;

  return {
    revision,
    needsRebuild:
      algorithmChanged ||
      String(previousRun?.embedding_revision ?? "") !== revision,
    algorithmChanged,
    pets: rows.map((row) => ({
      petDetectionId: Number(row.pet_detection_id),
      mediaId: Number(row.media_id),
      contentKey: `${String(row.sha256)}:${Number(row.detection_index)}`,
      petClass: String(row.pet_class),
      vector: vectorFromBlob(row.vector_blob, Number(row.dimension))
    })),
    cannotLinks: [
      ...cannotLinkRows.map((row) => ({
        petAId: Number(row.pet_a_id),
        petBId: Number(row.pet_b_id)
      })),
      ...implicitCannotLinks
    ]
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
    SELECT pd.id, pd.detection_index, m.sha256
    FROM pet_fused_detections pd
    JOIN pet_embeddings pe ON pe.pet_detection_id=pd.id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pd.id
    LEFT JOIN ignored_pet_matches ipm ON ipm.pet_detection_id=pd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND pd.pet_class='dog'
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pe.input_sha256=m.sha256
      AND pd.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
      AND ipm.pet_detection_id IS NULL
  `).all(sourceId);

  const eligibleIds = new Set(
    eligibleRows.map((row) => Number(row.id))
  );
  const contentKeyByPetId = new Map(
    eligibleRows.map((row) => [
      Number(row.id),
      `${String(row.sha256)}:${Number(row.detection_index)}`
    ])
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

      const independentContentKeys = new Set(
        members
          .map((member) => contentKeyByPetId.get(member.petDetectionId))
          .filter((value): value is string => Boolean(value))
      );
      if (independentContentKeys.size < 2) continue;

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

type IgnoredVectorIdentity = {
  id: number;
  petClass: string | null;
  vectors: number[][];
  centroid: number[];
};

type IgnoredIdentityMatch = {
  identityId: number;
  similarity: number;
  definite: boolean;
};

function ignoredPersonVectorIdentities(): IgnoredVectorIdentity[] {
  const rows = db.prepare(`
    SELECT
      ii.id AS identity_id,
      ir.dimension,
      ir.vector_blob
    FROM ignored_person_identities ii
    JOIN ignored_person_references ir ON ir.identity_id=ii.id
    WHERE ir.model_version='SFace 2021dec'
    ORDER BY ii.id, ir.id
  `).all();

  const grouped = new Map<number, number[][]>();
  for (const row of rows) {
    const id = Number(row.identity_id);
    const vectors = grouped.get(id) ?? [];
    vectors.push(vectorFromBlob(row.vector_blob, Number(row.dimension)));
    grouped.set(id, vectors);
  }

  const result: IgnoredVectorIdentity[] = [];
  for (const [id, vectors] of grouped) {
    const center = centroid(vectors);
    if (!center) continue;
    result.push({ id, petClass: null, vectors, centroid: center });
  }
  return result;
}

function ignoredPetVectorIdentities(): IgnoredVectorIdentity[] {
  const rows = db.prepare(`
    SELECT
      ii.id AS identity_id,
      ii.pet_class,
      ir.dimension,
      ir.vector_blob
    FROM ignored_pet_identities ii
    JOIN ignored_pet_references ir ON ir.identity_id=ii.id
    WHERE ir.model_version='DogReID DINOv2-B14 0.2.0'
    ORDER BY ii.id, ir.id
  `).all();

  const grouped = new Map<number, {
    petClass: string;
    vectors: number[][];
  }>();

  for (const row of rows) {
    const id = Number(row.identity_id);
    const entry = grouped.get(id) ?? {
      petClass: String(row.pet_class),
      vectors: []
    };
    entry.vectors.push(vectorFromBlob(row.vector_blob, Number(row.dimension)));
    grouped.set(id, entry);
  }

  const result: IgnoredVectorIdentity[] = [];
  for (const [id, entry] of grouped) {
    const center = centroid(entry.vectors);
    if (!center) continue;
    result.push({
      id,
      petClass: entry.petClass,
      vectors: entry.vectors,
      centroid: center
    });
  }
  return result;
}

function classifyIgnoredVectors(
  vectors: number[][],
  identities: IgnoredVectorIdentity[],
  definiteThreshold: number,
  doubtThreshold: number,
  petClass?: string
): IgnoredIdentityMatch | null {
  const candidateCentroid = centroid(vectors);
  if (!candidateCentroid || vectors.length === 0) return null;

  let best: IgnoredIdentityMatch | null = null;

  for (const identity of identities) {
    if (petClass && identity.petClass !== petClass) continue;
    if (identity.vectors.length === 0) continue;

    const centroidSimilarity = cosineSimilarity(
      candidateCentroid,
      identity.centroid
    );
    const allReferenceSimilarities = vectors.flatMap((vector) =>
      identity.vectors.map((reference) =>
        cosineSimilarity(vector, reference)
      )
    );
    const minimumReferenceSimilarity =
      allReferenceSimilarities.length > 0
        ? Math.min(...allReferenceSimilarities)
        : -1;
    const maximumReferenceSimilarity =
      allReferenceSimilarities.length > 0
        ? Math.max(...allReferenceSimilarities)
        : -1;

    const definite =
      centroidSimilarity >= definiteThreshold &&
      minimumReferenceSimilarity >= doubtThreshold;
    const possible =
      definite ||
      centroidSimilarity >= doubtThreshold ||
      maximumReferenceSimilarity >= doubtThreshold;

    if (!possible) continue;

    const score = Math.max(centroidSimilarity, maximumReferenceSimilarity);
    if (
      !best ||
      (definite && !best.definite) ||
      (definite === best.definite && score > best.similarity)
    ) {
      best = {
        identityId: identity.id,
        similarity: score,
        definite
      };
    }
  }

  return best;
}

function ignoredIdentityRevision(kind: "person" | "pet"): string {
  const table =
    kind === "person"
      ? "ignored_person_references"
      : "ignored_pet_references";
  const identityTable =
    kind === "person"
      ? "ignored_person_identities"
      : "ignored_pet_identities";

  const row = db.prepare(`
    SELECT
      COUNT(*) AS reference_count,
      COALESCE(MAX(i.updated_at), '') AS updated_at
    FROM ${identityTable} i
    LEFT JOIN ${table} r ON r.identity_id=i.id
  `).get();

  return `${Number(row?.reference_count ?? 0)}:${String(row?.updated_at ?? "")}`;
}


function completeVideoAnalysisJob(jobId: number, result: unknown) {
  if (!result || typeof result !== "object") {
    throw new Error("Videoanalyse-Ergebnis ist ungültig.");
  }

  const value = result as Record<string, unknown>;
  const job = jobForModule(jobId, "video-analyze-v1");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");
  const media = db.prepare(
    "SELECT source_id, sha256 FROM media_items WHERE id=?"
  ).get(mediaId);

  if (!media || String(media.sha256) !== inputSha256) {
    throw new Error("Video wurde während der Analyse geändert.");
  }

  const sourceId = Number(media.source_id);
  const previousVideoAnalysis = db.prepare(
    "SELECT input_sha256 FROM media_video_analysis WHERE media_id=?"
  ).get(mediaId);
  const videoContentChanged =
    previousVideoAnalysis !== undefined &&
    String(previousVideoAnalysis.input_sha256) !== inputSha256;

  const durationMs = Math.max(0, Math.trunc(Number(value.durationMs) || 0));
  const width = Math.max(0, Math.trunc(Number(value.width) || 0));
  const height = Math.max(0, Math.trunc(Number(value.height) || 0));
  const fps = Math.max(0, Number(value.fps) || 0);
  const sampleIntervalMs = Math.max(
    250,
    Math.trunc(Number(value.sampleIntervalMs) || 1000)
  );
  const rawFrames = Array.isArray(value.frames) ? value.frames : [];
  const rawTags = Array.isArray(value.tags) ? value.tags : [];
  const knownPersons = knownPersonCentroids(sourceId);
  const knownPets = knownPetCentroids(sourceId);

  type FramePerson = {
    detectionIndex: number;
    score: number;
    x: number;
    y: number;
    width: number;
    height: number;
    id: number | null;
    name: string | null;
    similarity: number | null;
    trackEligible: boolean;
  };

  type FramePet = {
    detectionIndex: number;
    petClass: "dog" | "cat";
    score: number;
    x: number;
    y: number;
    width: number;
    height: number;
    id: number | null;
    name: string | null;
    similarity: number | null;
    trackEligible: boolean;
  };

  type FrameMatch = {
    timestampMs: number;
    frameIndex: number | null;
    frameHash: string | null;
    sceneChange: boolean;
    width: number;
    height: number;
    persons: FramePerson[];
    pets: FramePet[];
    objects: string[];
  };

  const finiteNumber = (raw: unknown) => {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : 0;
  };

  const compactFrames: FrameMatch[] = [];

  for (const rawFrame of rawFrames) {
    if (!rawFrame || typeof rawFrame !== "object") continue;
    const frame = rawFrame as Record<string, unknown>;
    const timestampMs = Math.max(
      0,
      Math.min(durationMs, Math.trunc(Number(frame.timestampMs) || 0))
    );
    const frameWidth = Math.max(1, Math.trunc(Number(frame.width) || width || 1));
    const frameHeight = Math.max(1, Math.trunc(Number(frame.height) || height || 1));
    const rawFrameIndex = frame.frameIndex;
    const parsedFrameIndex = Number(rawFrameIndex);
    const frameIndex = rawFrameIndex !== null && rawFrameIndex !== undefined &&
      Number.isSafeInteger(parsedFrameIndex) && parsedFrameIndex >= 0
      ? parsedFrameIndex : null;
    const frameHash = typeof frame.frameHash === "string" &&
      /^[0-9a-f]{32}$/i.test(frame.frameHash)
      ? frame.frameHash.toLowerCase() : null;

    const persons: FramePerson[] = [];
    const rawFaces = Array.isArray(frame.faces) ? frame.faces : [];
    for (let detectionIndex = 0; detectionIndex < rawFaces.length; detectionIndex += 1) {
      const rawFace = rawFaces[detectionIndex];
      if (!rawFace || typeof rawFace !== "object") continue;
      const face = rawFace as Record<string, unknown>;
      const vectorRaw = face.vector;
      let bestId: number | null = null;
      let bestName: string | null = null;
      let bestSimilarity: number | null = null;
      let trackEligible = false;

      if (Array.isArray(vectorRaw) && vectorRaw.length > 0) {
        const vector = vectorRaw.map(Number);
        if (vector.every((entry) => Number.isFinite(entry))) {
          const matches = knownPersons
            .map((known) => ({
              known,
              similarity: cosineSimilarity(vector, known.vector)
            }))
            .sort((left, right) => right.similarity - left.similarity);

          const best = matches[0];
          const second = matches[1]?.similarity ?? -1;
          if (best && best.similarity >= 0.48) {
            bestId = best.known.id;
            bestName = best.known.name;
            bestSimilarity = best.similarity;
            trackEligible =
              best.similarity >= 0.60 &&
              best.similarity - second >= 0.025;
          }
        }
      }

      persons.push({
        detectionIndex,
        score: finiteNumber(face.score),
        x: finiteNumber(face.x),
        y: finiteNumber(face.y),
        width: Math.max(0, finiteNumber(face.width)),
        height: Math.max(0, finiteNumber(face.height)),
        id: bestId,
        name: bestName,
        similarity: bestSimilarity,
        trackEligible
      });
    }

    const pets: FramePet[] = [];
    const rawPets = Array.isArray(frame.pets) ? frame.pets : [];
    for (let detectionIndex = 0; detectionIndex < rawPets.length; detectionIndex += 1) {
      const rawPet = rawPets[detectionIndex];
      if (!rawPet || typeof rawPet !== "object") continue;
      const pet = rawPet as Record<string, unknown>;
      const petClass: "dog" | "cat" =
        String(pet.petClass ?? "") === "cat" ? "cat" : "dog";
      const vectorRaw = pet.vector;
      let bestId: number | null = null;
      let bestName: string | null = null;
      let bestSimilarity: number | null = null;
      let trackEligible = false;

      if (petClass === "dog" && Array.isArray(vectorRaw) && vectorRaw.length > 0) {
        const vector = vectorRaw.map(Number);
        if (vector.every((entry) => Number.isFinite(entry))) {
          const matches = knownPets
            .filter((known) => known.petClass === petClass)
            .map((known) => ({
              known,
              similarity: cosineSimilarity(vector, known.vector)
            }))
            .sort((left, right) => right.similarity - left.similarity);

          const best = matches[0];
          const second = matches[1]?.similarity ?? -1;
          if (best && best.similarity >= 0.52) {
            bestId = best.known.id;
            bestName = best.known.name;
            bestSimilarity = best.similarity;
            trackEligible =
              best.similarity >= 0.72 &&
              best.similarity - second >= 0.04;
          }
        }
      }

      pets.push({
        detectionIndex,
        petClass,
        score: finiteNumber(pet.score),
        x: finiteNumber(pet.x),
        y: finiteNumber(pet.y),
        width: Math.max(0, finiteNumber(pet.width)),
        height: Math.max(0, finiteNumber(pet.height)),
        id: bestId,
        name: bestName,
        similarity: bestSimilarity,
        trackEligible
      });
    }

    const objects = [
      ...new Set(
        (Array.isArray(frame.objects) ? frame.objects : [])
          .map((entry) =>
            entry && typeof entry === "object"
              ? String((entry as Record<string, unknown>).label ?? "").trim()
              : ""
          )
          .filter(Boolean)
      )
    ];

    compactFrames.push({
      timestampMs,
      frameIndex,
      frameHash: frameIndex === null ? null : frameHash,
      sceneChange: Boolean(frame.sceneChange),
      width: frameWidth,
      height: frameHeight,
      persons,
      pets,
      objects
    });
  }

  compactFrames.sort((left, right) => left.timestampMs - right.timestampMs);

  type OpenTrack = {
    kind: "person" | "pet";
    identityId: number;
    petClass: string | null;
    startMs: number;
    endMs: number;
    hitCount: number;
    maxSimilarity: number;
    lastSeenMs: number;
  };

  const finishedTracks: OpenTrack[] = [];
  const activeTracks = new Map<string, OpenTrack>();
  const allowedGap = Math.max(2500, sampleIntervalMs * 3);

  const touchTrack = (
    kind: "person" | "pet",
    identityId: number,
    petClass: string | null,
    timestampMs: number,
    similarity: number
  ) => {
    const key = kind + ":" + identityId;
    const existing = activeTracks.get(key);

    if (existing && timestampMs - existing.lastSeenMs <= allowedGap) {
      existing.endMs = Math.min(durationMs, timestampMs + sampleIntervalMs);
      existing.hitCount += 1;
      existing.maxSimilarity = Math.max(existing.maxSimilarity, similarity);
      existing.lastSeenMs = timestampMs;
      return;
    }

    if (existing) finishedTracks.push(existing);
    activeTracks.set(key, {
      kind,
      identityId,
      petClass,
      startMs: timestampMs,
      endMs: Math.min(durationMs, timestampMs + sampleIntervalMs),
      hitCount: 1,
      maxSimilarity: similarity,
      lastSeenMs: timestampMs
    });
  };

  for (const frame of compactFrames) {
    for (const person of frame.persons) {
      if (
        person.trackEligible &&
        person.id !== null &&
        person.similarity !== null
      ) {
        touchTrack(
          "person",
          person.id,
          null,
          frame.timestampMs,
          person.similarity
        );
      }
    }
    for (const pet of frame.pets) {
      if (
        pet.trackEligible &&
        pet.id !== null &&
        pet.similarity !== null
      ) {
        touchTrack(
          "pet",
          pet.id,
          pet.petClass,
          frame.timestampMs,
          pet.similarity
        );
      }
    }
  }
  finishedTracks.push(...activeTracks.values());

  db.exec("BEGIN IMMEDIATE");
  try {
    if (videoContentChanged) {
      db.prepare(
        "DELETE FROM video_frame_identity_overrides WHERE media_id=?"
      ).run(mediaId);
    }

    db.prepare(
      "INSERT INTO media_video_analysis(" +
      "media_id,input_sha256,duration_ms,width,height,fps,sample_interval_ms," +
      "sampled_frames,scene_count,frames_json,updated_at" +
      ") VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) " +
      "ON CONFLICT(media_id) DO UPDATE SET " +
      "input_sha256=excluded.input_sha256,duration_ms=excluded.duration_ms," +
      "width=excluded.width,height=excluded.height,fps=excluded.fps," +
      "sample_interval_ms=excluded.sample_interval_ms," +
      "sampled_frames=excluded.sampled_frames,scene_count=excluded.scene_count," +
      "frames_json=excluded.frames_json,updated_at=CURRENT_TIMESTAMP"
    ).run(
      mediaId,
      inputSha256,
      durationMs,
      width,
      height,
      fps,
      sampleIntervalMs,
      compactFrames.length,
      Math.max(0, Math.trunc(Number(value.sceneCount) || 0)),
      JSON.stringify(compactFrames)
    );

    db.prepare("DELETE FROM video_identity_tracks WHERE media_id=?").run(mediaId);
    const insertTrack = db.prepare(
      "INSERT INTO video_identity_tracks(" +
      "media_id,identity_kind,identity_id,pet_class,start_ms,end_ms,hit_count,max_similarity" +
      ") VALUES(?,?,?,?,?,?,?,?)"
    );
    for (const track of finishedTracks) {
      insertTrack.run(
        mediaId,
        track.kind,
        track.identityId,
        track.petClass,
        track.startMs,
        track.endMs,
        track.hitCount,
        track.maxSimilarity
      );
    }

    db.prepare("DELETE FROM video_tags WHERE media_id=?").run(mediaId);
    const insertTag = db.prepare(
      "INSERT INTO video_tags(media_id,label,score,hit_count) VALUES(?,?,?,?)"
    );
    for (const rawTag of rawTags) {
      if (!rawTag || typeof rawTag !== "object") continue;
      const tag = rawTag as Record<string, unknown>;
      const label = String(tag.label ?? "").trim();
      const score = Number(tag.score);
      const hitCount = Math.max(1, Math.trunc(Number(tag.hitCount) || 1));
      if (!label || !Number.isFinite(score)) continue;
      insertTag.run(mediaId, label, score, hitCount);
    }

    db.prepare(
      "UPDATE analysis_jobs SET status='DONE',result_json=?,error_message=NULL," +
      "finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).run(
      JSON.stringify({
        durationMs,
        sampledFrames: compactFrames.length,
        sceneCount: Math.max(0, Math.trunc(Number(value.sceneCount) || 0)),
        identityTracks: finishedTracks.length,
        frameIdentityDetections: compactFrames.reduce(
          (sum, frame) => sum + frame.persons.length + frame.pets.length,
          0
        ),
        tags: rawTags.length
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
    mediaId,
    sourceId,
    sampledFrames: compactFrames.length,
    tracks: finishedTracks.length
  };
}

function knownPersonCentroids(sourceId?: number) {
  const sourceFilter = sourceId === undefined ? "" : "AND m.source_id=?";
  const sourceArgs = sourceId === undefined ? [] : [sourceId];

  const rows = db.prepare(`
    SELECT
      p.id AS person_id,
      p.name,
      fd.id AS face_detection_id,
      fe.dimension,
      fe.vector_blob
    FROM persons p
    JOIN person_face_assignments pfa ON pfa.person_id=p.id
    JOIN face_detections fd ON fd.id=pfa.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    JOIN face_embeddings fe ON fe.face_detection_id=fd.id
    WHERE m.availability='AVAILABLE'
      AND pfa.assignment_source='CONFIRMED'
      AND fe.model_version='SFace 2021dec'
      AND fe.input_sha256=m.sha256
      AND fd.input_sha256=m.sha256
      ${sourceFilter}
    ORDER BY p.id, fd.id
  `).all(...sourceArgs);

  const grouped = new Map<number, {
    id: number;
    name: string;
    representativeFaceId: number | null;
    vectors: number[][];
  }>();

  for (const row of rows) {
    const id = Number(row.person_id);
    const entry = grouped.get(id) ?? {
      id,
      name: String(row.name),
      representativeFaceId: null,
      vectors: []
    };

    if (entry.representativeFaceId === null) {
      entry.representativeFaceId = Number(row.face_detection_id);
    }
    entry.vectors.push(
      vectorFromBlob(row.vector_blob, Number(row.dimension))
    );
    grouped.set(id, entry);
  }

  return [...grouped.values()]
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      representativeFaceId: entry.representativeFaceId,
      referenceCount: entry.vectors.length,
      vector: centroid(entry.vectors)
    }))
    .filter(
      (entry): entry is {
        id: number;
        name: string;
        representativeFaceId: number | null;
        referenceCount: number;
        vector: number[];
      } => entry.vector !== null
    );
}

function knownPetCentroids(sourceId?: number) {
  const sourceFilter = sourceId === undefined ? "" : "AND m.source_id=?";
  const sourceArgs = sourceId === undefined ? [] : [sourceId];

  const rows = db.prepare(`
    SELECT
      p.id AS pet_id,
      p.name,
      p.pet_class,
      pd.id AS pet_detection_id,
      pe.dimension,
      pe.vector_blob
    FROM pets p
    JOIN pet_assignments pa ON pa.pet_id=p.id
    JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    JOIN pet_embeddings pe ON pe.pet_detection_id=pd.id
    WHERE m.availability='AVAILABLE'
      AND pa.assignment_source='CONFIRMED'
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pe.input_sha256=m.sha256
      AND pd.input_sha256=m.sha256
      ${sourceFilter}
    ORDER BY p.id, pd.id
  `).all(...sourceArgs);

  const grouped = new Map<number, {
    id: number;
    name: string;
    petClass: string;
    representativePetId: number | null;
    vectors: number[][];
  }>();

  for (const row of rows) {
    const id = Number(row.pet_id);
    const entry = grouped.get(id) ?? {
      id,
      name: String(row.name),
      petClass: String(row.pet_class),
      representativePetId: null,
      vectors: []
    };

    if (entry.representativePetId === null) {
      entry.representativePetId = Number(row.pet_detection_id);
    }
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
      representativePetId: entry.representativePetId,
      referenceCount: entry.vectors.length,
      vector: centroid(entry.vectors)
    }))
    .filter(
      (entry): entry is {
        id: number;
        name: string;
        petClass: string;
        representativePetId: number | null;
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
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    WHERE pci.candidate_id=?
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pe.input_sha256=m.sha256
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

function listUngroupedPetDetections(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(4000, Math.trunc(requestedLimit || 1000)));
  const rows = db.prepare(`
    SELECT
      pd.id AS pet_detection_id,
      pd.media_id,
      pd.pet_class,
      m.relative_path,
      pd.x, pd.y, pd.width, pd.height,
      pe.dimension,
      pe.vector_blob
    FROM pet_fused_detections pd
    JOIN media_items m ON m.id=pd.media_id
    JOIN pet_embeddings pe ON pe.pet_detection_id=pd.id
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pd.id
    LEFT JOIN pet_candidate_items pci ON pci.pet_detection_id=pd.id
    LEFT JOIN ignored_pet_matches ipm ON ipm.pet_detection_id=pd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pe.input_sha256=m.sha256
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND pa.pet_detection_id IS NULL
      AND pci.pet_detection_id IS NULL
      AND ipm.pet_detection_id IS NULL
    ORDER BY pd.id DESC
    LIMIT ?
  `).all(sourceId, limit);

  const knownPets = knownPetCentroids();
  const exclusion = db.prepare(
    "SELECT 1 FROM pet_assignment_exclusions " +
    "WHERE pet_detection_id=? AND pet_id=? LIMIT 1"
  );

  return rows.map((row) => {
    const petDetectionId = Number(row.pet_detection_id);
    const petClass = String(row.pet_class) === "cat" ? "cat" : "dog";
    const vector = vectorFromBlob(row.vector_blob, Number(row.dimension));
    const suggestedPets = knownPets
      .filter((known) =>
        known.petClass === petClass && !exclusion.get(petDetectionId, known.id)
      )
      .map((known) => ({
        petId: known.id,
        petName: known.name,
        similarity: cosineSimilarity(vector, known.vector),
        representativePetId: known.representativePetId
      }))
      .filter((match) => Number.isFinite(match.similarity) && match.similarity >= 0.52)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 5);

    return {
      petDetectionId,
      mediaId: Number(row.media_id),
      relativePath: String(row.relative_path),
      petClass,
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
      suggestedPets
    };
  });
}

function rejectPetDetectionSuggestion(petDetectionId: number, petId: number) {
  const detection = db.prepare(`
    SELECT pd.id
    FROM pet_fused_detections pd
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pd.id
    WHERE pd.id=? AND pa.pet_detection_id IS NULL
  `).get(petDetectionId);
  if (!detection) throw new Error("Die Haustierfundstelle ist nicht mehr unbestätigt verfügbar.");

  const pet = db.prepare("SELECT id FROM pets WHERE id=?").get(petId);
  if (!pet) throw new Error("Das vorgeschlagene Haustier existiert nicht mehr.");

  db.prepare(`
    INSERT INTO pet_assignment_exclusions(pet_id, pet_detection_id, reason)
    VALUES(?,?,'USER_REJECTED_SUGGESTION')
    ON CONFLICT(pet_id, pet_detection_id) DO UPDATE SET
      reason='USER_REJECTED_SUGGESTION'
  `).run(petId, petDetectionId);

  return { changed: true, affectedPets: 1 };
}
function listPetCandidates(
  sourceId: number,
  requestedLimit: number,
  ignoreDefiniteThreshold = 0.68,
  ignoreDoubtThreshold = 0.60,
  summaryOnly = false
) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(requestedLimit || 500)));

  const candidates = summaryOnly
    ? db.prepare(`
        SELECT
          pc.id,
          pc.pet_class,
          pc.representative_pet_id,
          pc.average_similarity,
          pc.min_similarity,
          pc.member_count AS detection_count,
          pc.representative_pet_id AS first_pet_id,
          pc.newest_pet_id
        FROM pet_candidates pc
        WHERE pc.source_id=?
          AND pc.member_count>=2
        ORDER BY
          pc.member_count DESC,
          pc.average_similarity DESC,
          pc.newest_pet_id DESC
        LIMIT ?
      `).all(sourceId, limit)
    : db.prepare(`
        SELECT
          pc.id,
          pc.pet_class,
          pc.representative_pet_id,
          pc.average_similarity,
          pc.min_similarity,
          COUNT(pci.pet_detection_id) AS detection_count,
          MIN(pci.pet_detection_id) AS first_pet_id,
          MAX(pci.pet_detection_id) AS newest_pet_id
        FROM pet_candidates pc
        JOIN pet_candidate_items pci ON pci.candidate_id=pc.id
        JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        LEFT JOIN pet_assignments pa
          ON pa.pet_detection_id=pci.pet_detection_id
        WHERE pc.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.input_sha256=m.sha256
          AND pa.pet_detection_id IS NULL
        GROUP BY pc.id
        HAVING COUNT(DISTINCT m.sha256 || ':' || pd.detection_index) >= 2
        ORDER BY detection_count DESC, pc.average_similarity DESC, newest_pet_id DESC
        LIMIT ?
      `).all(sourceId, limit);

  if (summaryOnly) {
    return candidates.map((candidate) => ({
      id: Number(candidate.id),
      petClass: String(candidate.pet_class),
      detectionCount: Number(candidate.detection_count),
      newestPetId: Number(candidate.newest_pet_id),
      memberSignature: "",
      representativePetId:
        candidate.first_pet_id === null || candidate.first_pet_id === undefined
          ? null
          : Number(candidate.first_pet_id),
      averageSimilarity: Number(candidate.average_similarity),
      minSimilarity: Number(candidate.min_similarity),
      suggestedPetId: null,
      suggestedPetName: null,
      suggestedPetSimilarity: null,
      suggestedPets: [],
      ignoredIdentityId: null,
      ignoredSimilarity: null,
      pets: []
    }));
  }

  const itemQuery = db.prepare(`
    SELECT
      pci.pet_detection_id,
      pd.media_id,
      m.relative_path,
      pci.similarity,
      pd.x,
      pd.y,
      pd.width,
      pd.height
    FROM pet_candidate_items pci
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa
      ON pa.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
    ORDER BY
      CASE WHEN pci.pet_detection_id=? THEN 0 ELSE 1 END,
      pci.similarity DESC,
      pci.pet_detection_id ASC
    LIMIT 200
  `);

  const memberSignatureQuery = db.prepare(`
    SELECT pci.pet_detection_id
    FROM pet_candidate_items pci
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa
      ON pa.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
    ORDER BY pci.pet_detection_id
  `);

  const embeddingQuery = db.prepare(`
    SELECT
      pci.pet_detection_id,
      pe.dimension,
      pe.vector_blob
    FROM pet_candidate_items pci
    JOIN pet_embeddings pe ON pe.pet_detection_id=pci.pet_detection_id
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa
      ON pa.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pe.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
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
  const petExclusionQuery = db.prepare(
    "SELECT 1 FROM pet_assignment_exclusions " +
    "WHERE pet_detection_id=? AND pet_id=? LIMIT 1"
  );

  const knownPets = knownPetCentroids();
  const ignoredIdentities = ignoredPetVectorIdentities();
  const insertIgnoredMatch = db.prepare(`
    INSERT INTO ignored_pet_matches(
      pet_detection_id,
      identity_id,
      match_source,
      similarity,
      updated_at
    )
    VALUES(?,?,'AUTO_HIGH_CONFIDENCE',?,CURRENT_TIMESTAMP)
    ON CONFLICT(pet_detection_id) DO UPDATE SET
      identity_id=excluded.identity_id,
      match_source=excluded.match_source,
      similarity=excluded.similarity,
      updated_at=CURRENT_TIMESTAMP
  `);
  const deleteCandidate = db.prepare("DELETE FROM pet_candidates WHERE id=?");

  return candidates.map((candidate) => {
    const candidateId = Number(candidate.id);
    const memberIds = memberSignatureQuery
      .all(candidateId)
      .map((row) => Number(row.pet_detection_id));
    const storedRepresentativePetId = candidate.representative_pet_id === null
      ? null
      : Number(candidate.representative_pet_id);
    const representativePetId =
      storedRepresentativePetId !== null &&
      memberIds.includes(storedRepresentativePetId)
        ? storedRepresentativePetId
        : (memberIds[0] ?? null);

    const embeddingRows = embeddingQuery.all(candidateId);
    const candidateVectors = embeddingRows.map((row) =>
      vectorFromBlob(row.vector_blob, Number(row.dimension))
    );
    const vectorByPetId = new Map(
      embeddingRows.map((row, index) => [
        Number(row.pet_detection_id),
        candidateVectors[index]
      ])
    );
    const candidateVector = centroid(candidateVectors);

    const ignoredMatch = classifyIgnoredVectors(
      candidateVectors,
      ignoredIdentities,
      ignoreDefiniteThreshold,
      ignoreDoubtThreshold,
      String(candidate.pet_class)
    );

    if (ignoredMatch?.definite) {
      for (const row of embeddingRows) {
        insertIgnoredMatch.run(
          Number(row.pet_detection_id),
          ignoredMatch.identityId,
          ignoredMatch.similarity
        );
      }
      deleteCandidate.run(candidateId);
      return null;
    }

    const suggestedPets = candidateVector
      ? knownPets
          .filter(
            (known) =>
              known.petClass === String(candidate.pet_class) &&
              !exclusionQuery.get(candidateId, known.id)
          )
          .map((known) => ({
            petId: known.id,
            petName: known.name,
            similarity: cosineSimilarity(candidateVector, known.vector),
            representativePetId: known.representativePetId
          }))
          .filter((match) => match.similarity >= 0.60)
          .sort((left, right) => right.similarity - left.similarity)
          .slice(0, 3)
      : [];
    const bestPetSuggestion = suggestedPets[0] ?? null;

    return {
      id: candidateId,
      petClass: String(candidate.pet_class),
      detectionCount: Number(candidate.detection_count),
      newestPetId: Number(candidate.newest_pet_id),
      memberSignature: memberIds.join(","),
      representativePetId,
      averageSimilarity: Number(candidate.average_similarity),
      minSimilarity: Number(candidate.min_similarity),
      suggestedPetId: bestPetSuggestion?.petId ?? null,
      suggestedPetName: bestPetSuggestion?.petName ?? null,
      suggestedPetSimilarity: bestPetSuggestion?.similarity ?? null,
      suggestedPets,
      ignoredIdentityId: ignoredMatch?.identityId ?? null,
      ignoredSimilarity: ignoredMatch?.similarity ?? null,
      pets: itemQuery.all(
        candidateId,
        representativePetId ?? -1
      ).map((row) => ({
        petDetectionId: Number(row.pet_detection_id),
        mediaId: Number(row.media_id),
        relativePath: String(row.relative_path),
        similarity: Number(row.similarity),
        x: Number(row.x),
        y: Number(row.y),
        width: Number(row.width),
        height: Number(row.height),
        suggestedPets: (() => {
          const vector = vectorByPetId.get(Number(row.pet_detection_id));
          if (!vector) return [];
          return knownPets
            .filter(
              (known) =>
                known.petClass === String(candidate.pet_class) &&
                !petExclusionQuery.get(Number(row.pet_detection_id), known.id)
            )
            .map((known) => ({
              petId: known.id,
              petName: known.name,
              similarity: cosineSimilarity(vector, known.vector),
              representativePetId: known.representativePetId
            }))
            .filter((match) => match.similarity >= 0.52)
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, 5);
        })()
      }))
    };
  }).filter((candidate) => candidate !== null);
}

function listPetCandidateItems(
  candidateId: number,
  requestedLimit = 5000,
  requestedOffset = 0
) {
  const limit = Math.max(1, Math.min(5000, Math.trunc(requestedLimit || 5000)));
  const offset = Math.max(0, Math.trunc(requestedOffset || 0));
  const candidate = db.prepare(
    "SELECT representative_pet_id FROM pet_candidates WHERE id=?"
  ).get(candidateId);
  if (!candidate) return [];

  const representativePetId =
    candidate.representative_pet_id === null ||
    candidate.representative_pet_id === undefined
      ? -1
      : Number(candidate.representative_pet_id);

  return db.prepare(`
    SELECT
      pci.pet_detection_id,
      pd.media_id,
      m.relative_path,
      pci.similarity,
      pd.x,
      pd.y,
      pd.width,
      pd.height
    FROM pet_candidate_items pci
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa
      ON pa.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
    ORDER BY
      CASE WHEN pci.pet_detection_id=? THEN 0 ELSE 1 END,
      pci.similarity DESC,
      pci.pet_detection_id ASC
    LIMIT ? OFFSET ?
  `).all(candidateId, representativePetId, limit, offset).map((row) => ({
    petDetectionId: Number(row.pet_detection_id),
    mediaId: Number(row.media_id),
    relativePath: String(row.relative_path),
    similarity: Number(row.similarity),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    suggestedPets: []
  }));
}

function listPets(sourceId: number) {
  const pets = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.pet_class,
      (
        SELECT COUNT(*)
        FROM pet_assignments pa
        JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        WHERE pa.pet_id=p.id
          AND m.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.input_sha256=m.sha256
      ) AS detection_count,
      (
        SELECT COUNT(*)
        FROM pet_assignments pa
        JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        WHERE pa.pet_id=p.id
          AND m.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.input_sha256=m.sha256
          AND pa.assignment_source='CONFIRMED'
      ) AS confirmed_count,
      (
        SELECT COUNT(*)
        FROM pet_assignments pa
        JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        WHERE pa.pet_id=p.id
          AND m.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.input_sha256=m.sha256
          AND pa.assignment_source='AUTO_HIGH_CONFIDENCE'
      ) AS automatic_count,
      (
        SELECT MIN(pd.id)
        FROM pet_assignments pa
        JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
        JOIN media_items m ON m.id=pd.media_id
        WHERE pa.pet_id=p.id
          AND m.source_id=?
          AND m.availability='AVAILABLE'
          AND pd.input_sha256=m.sha256
      ) AS representative_pet_id
    FROM pets p
    WHERE EXISTS (
      SELECT 1
      FROM pet_assignments pa
      JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
      JOIN media_items m ON m.id=pd.media_id
      WHERE pa.pet_id=p.id
        AND m.source_id=?
    )
    OR EXISTS (
      SELECT 1
      FROM video_identity_tracks vit
      JOIN media_items m ON m.id=vit.media_id
      WHERE vit.identity_kind='pet'
        AND vit.identity_id=p.id
        AND m.source_id=?
        AND m.availability='AVAILABLE'
    )
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(sourceId, sourceId, sourceId, sourceId, sourceId, sourceId);

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
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
    ORDER BY
      CASE WHEN pa.assignment_source='AUTO_HIGH_CONFIDENCE' THEN 0 ELSE 1 END,
      pa.pet_detection_id ASC
    LIMIT 48
  `);

  const videoHitQuery = db.prepare(
    "SELECT vit.media_id,m.relative_path,vit.start_ms,vit.end_ms," +
    "vit.hit_count,vit.max_similarity FROM video_identity_tracks vit " +
    "JOIN media_items m ON m.id=vit.media_id " +
    "WHERE vit.identity_kind='pet' AND vit.identity_id=? " +
    "AND m.source_id=? AND m.availability='AVAILABLE' " +
    "ORDER BY vit.start_ms,vit.id"
  );

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
    })),
    videoHits: videoHitQuery.all(Number(row.id), sourceId).map((hit) => ({
      mediaId: Number(hit.media_id),
      relativePath: String(hit.relative_path),
      startMs: Number(hit.start_ms),
      endMs: Number(hit.end_ms),
      hitCount: Number(hit.hit_count),
      maxSimilarity: hit.max_similarity === null ? null : Number(hit.max_similarity)
    }))
  }));
}

function ignorePetCandidate(
  candidateId: number,
  fallbackPetDetectionId?: number,
  expectedDetectionCount?: number,
  expectedMemberSignature?: string,
  requestedIgnoredIdentityId?: number
) {
  let resolvedCandidateId = candidateId;
  let candidate = db.prepare(`
    SELECT id, source_id, pet_class
    FROM pet_candidates
    WHERE id=?
  `).get(resolvedCandidateId);

  const stablePetId =
    Number.isInteger(fallbackPetDetectionId) &&
    Number(fallbackPetDetectionId) > 0
      ? Number(fallbackPetDetectionId)
      : null;

  const candidateStillMatches =
    candidate && stablePetId !== null
      ? Boolean(
          db.prepare(`
            SELECT 1
            FROM pet_candidate_items
            WHERE candidate_id=?
              AND pet_detection_id=?
            LIMIT 1
          `).get(resolvedCandidateId, stablePetId)
        )
      : Boolean(candidate);

  if (!candidateStillMatches && stablePetId !== null) {
    candidate = db.prepare(`
      SELECT pc.id, pc.source_id, pc.pet_class
      FROM pet_candidate_items pci
      JOIN pet_candidates pc ON pc.id=pci.candidate_id
      WHERE pci.pet_detection_id=?
      LIMIT 1
    `).get(stablePetId);

    if (candidate) resolvedCandidateId = Number(candidate.id);
  }

  if (!candidate) {
    throw new Error(
      "Die Hundegruppe wurde während der Analyse neu aufgebaut. Bitte die Ansicht aktualisieren und erneut prüfen."
    );
  }

  const members = db.prepare(`
    SELECT pci.pet_detection_id
    FROM pet_candidate_items pci
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
    ORDER BY pci.pet_detection_id
  `).all(resolvedCandidateId);

  if (members.length === 0) {
    throw new Error("Die Hundegruppe enthält keine unbestätigten Fundstellen mehr.");
  }

  if (
    Number.isInteger(expectedDetectionCount) &&
    Number(expectedDetectionCount) >= 2 &&
    members.length !== Number(expectedDetectionCount)
  ) {
    throw new Error(
      "Die Hundegruppe hat sich während der Analyse geändert. Bitte die Ansicht aktualisieren und erneut prüfen."
    );
  }

  const currentMemberSignature = members
    .map((member) => Number(member.pet_detection_id))
    .join(",");
  if (
    typeof expectedMemberSignature === "string" &&
    expectedMemberSignature.length > 0 &&
    currentMemberSignature !== expectedMemberSignature
  ) {
    throw new Error(
      "Die Zusammensetzung der Hundegruppe hat sich während der Analyse geändert. Bitte die Ansicht aktualisieren und erneut prüfen."
    );
  }

  const embeddingQuery = db.prepare(`
    SELECT
      pe.pet_detection_id,
      pe.model_version,
      pe.dimension,
      pe.vector_blob
    FROM pet_embeddings pe
    WHERE pe.pet_detection_id=?
      AND pe.model_version='DogReID DINOv2-B14 0.2.0'
  `);

  const petClass = String(candidate.pet_class);
  let ignoredIdentityId =
    Number.isInteger(requestedIgnoredIdentityId) &&
    Number(requestedIgnoredIdentityId) > 0
      ? Number(requestedIgnoredIdentityId)
      : null;

  if (ignoredIdentityId !== null) {
    const existing = db.prepare(`
      SELECT id
      FROM ignored_pet_identities
      WHERE id=? AND pet_class=?
    `).get(ignoredIdentityId, petClass);
    if (!existing) ignoredIdentityId = null;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const extendedExisting = ignoredIdentityId !== null;

    if (ignoredIdentityId === null) {
      ignoredIdentityId = Number(
        db.prepare(`
          INSERT INTO ignored_pet_identities(pet_class)
          VALUES(?)
        `).run(petClass).lastInsertRowid
      );
    }

    const insertReference = db.prepare(`
      INSERT OR IGNORE INTO ignored_pet_references(
        identity_id,
        model_version,
        dimension,
        vector_blob,
        source_pet_detection_id
      )
      VALUES(?,?,?,?,?)
    `);
    const insertMatch = db.prepare(`
      INSERT INTO ignored_pet_matches(
        pet_detection_id,
        identity_id,
        match_source,
        similarity,
        updated_at
      )
      VALUES(?,?,'USER_REJECTED',NULL,CURRENT_TIMESTAMP)
      ON CONFLICT(pet_detection_id) DO UPDATE SET
        identity_id=excluded.identity_id,
        match_source='USER_REJECTED',
        similarity=NULL,
        updated_at=CURRENT_TIMESTAMP
    `);

    let detectionCount = 0;
    for (const member of members) {
      const petDetectionId = Number(member.pet_detection_id);
      const embedding = embeddingQuery.get(petDetectionId);
      if (!embedding) continue;

      insertReference.run(
        ignoredIdentityId,
        String(embedding.model_version),
        Number(embedding.dimension),
        embedding.vector_blob,
        petDetectionId
      );
      insertMatch.run(petDetectionId, ignoredIdentityId);
      detectionCount += 1;
    }

    if (detectionCount === 0) {
      throw new Error(
        "Für die Hundegruppe konnten keine Dog-ReID-Merkmale als dauerhafte Ignore-Referenz gespeichert werden."
      );
    }

    db.prepare(`
      UPDATE ignored_pet_identities
      SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(ignoredIdentityId);

    db.prepare("DELETE FROM pet_candidates WHERE id=?").run(resolvedCandidateId);

    db.exec("COMMIT");
    return {
      ignoredIdentityId,
      detectionCount,
      extendedExisting
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function confirmPetCandidate(
  candidateId: number,
  rawName: unknown,
  rejectedPetId?: number,
  fallbackPetDetectionId?: number,
  expectedDetectionCount?: number,
  expectedMemberSignature?: string
) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für das Haustier eingeben.");
  if (name.length > 120) throw new Error("Der Haustiername ist zu lang.");

  let resolvedCandidateId = candidateId;
  let candidate = db.prepare(`
    SELECT id, source_id, pet_class
    FROM pet_candidates
    WHERE id=?
  `).get(resolvedCandidateId);

  const stablePetId =
    Number.isInteger(fallbackPetDetectionId) &&
    Number(fallbackPetDetectionId) > 0
      ? Number(fallbackPetDetectionId)
      : null;

  const candidateStillMatches =
    candidate && stablePetId !== null
      ? Boolean(
          db.prepare(`
            SELECT 1
            FROM pet_candidate_items
            WHERE candidate_id=?
              AND pet_detection_id=?
            LIMIT 1
          `).get(resolvedCandidateId, stablePetId)
        )
      : Boolean(candidate);

  if (!candidateStillMatches && stablePetId !== null) {
    candidate = db.prepare(`
      SELECT pc.id, pc.source_id, pc.pet_class
      FROM pet_candidate_items pci
      JOIN pet_candidates pc ON pc.id=pci.candidate_id
      WHERE pci.pet_detection_id=?
      LIMIT 1
    `).get(stablePetId);

    if (candidate) {
      resolvedCandidateId = Number(candidate.id);
    }
  }

  if (!candidate) {
    throw new Error(
      "Die Hundegruppe wurde während der Analyse neu aufgebaut. Bitte die Haustieransicht aktualisieren und erneut bestätigen."
    );
  }

  const members = db.prepare(`
    SELECT pci.pet_detection_id, pci.similarity
    FROM pet_candidate_items pci
    JOIN pet_fused_detections pd ON pd.id=pci.pet_detection_id
    JOIN media_items m ON m.id=pd.media_id
    LEFT JOIN pet_assignments pa ON pa.pet_detection_id=pci.pet_detection_id
    WHERE pci.candidate_id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
      AND pa.pet_detection_id IS NULL
    ORDER BY pci.pet_detection_id
  `).all(resolvedCandidateId);

  if (members.length === 0) {
    throw new Error("Der Haustiervorschlag enthält keine unbestätigten Fundstellen mehr.");
  }

  if (
    Number.isInteger(expectedDetectionCount) &&
    Number(expectedDetectionCount) >= 2 &&
    members.length !== Number(expectedDetectionCount)
  ) {
    throw new Error(
      "Die Hundegruppe hat sich während der Analyse geändert (" +
      Number(expectedDetectionCount) +
      " → " +
      members.length +
      " Fundstellen). Bitte die Ansicht aktualisieren und die Gruppe erneut prüfen."
    );
  }

  const currentMemberSignature = members
    .map((member) => Number(member.pet_detection_id))
    .join(",");
  if (
    typeof expectedMemberSignature === "string" &&
    expectedMemberSignature.length > 0 &&
    currentMemberSignature !== expectedMemberSignature
  ) {
    throw new Error(
      "Die Zusammensetzung der Hundegruppe hat sich während der Analyse geändert. " +
      "Bitte die Ansicht aktualisieren und die Gruppe erneut prüfen."
    );
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

    db.prepare("DELETE FROM pet_candidates WHERE id=?").run(resolvedCandidateId);
    // Wie bei Personen bleibt der letzte Clusterlauf stehen. Eine Bestätigung
    // soll die UI sofort aktualisieren und nicht synchron ein vollständiges
    // Dog-ReID-Re-Clustering aller bisherigen Fundstellen erzwingen.

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

function resolvePetCandidateSelection(
  candidateId: number,
  rawPetDetectionIds: unknown
) {
  const candidate = db.prepare(
    "SELECT id, source_id, pet_class, algorithm_version FROM pet_candidates WHERE id=?"
  ).get(candidateId);

  if (!candidate) {
    throw new Error("Die Hundegruppe wurde nicht gefunden.");
  }

  const sourceId = Number(candidate.source_id);
  const members = db.prepare(
    "SELECT pet_detection_id, similarity FROM pet_candidate_items " +
    "WHERE candidate_id=? ORDER BY pet_detection_id"
  ).all(candidateId).map((row) => ({
    petDetectionId: Number(row.pet_detection_id),
    similarity: Number(row.similarity)
  }));

  if (members.length === 0) {
    throw new Error("Die Hundegruppe enthält keine Fundstellen mehr.");
  }

  const requested = Array.isArray(rawPetDetectionIds)
    ? [...new Set(
        rawPetDetectionIds
          .map(Number)
          .filter((value) => Number.isInteger(value) && value > 0)
      )]
    : [];

  if (requested.length === 0) {
    throw new Error("Bitte mindestens eine Hundefundstelle auswählen.");
  }

  const memberIds = new Set(members.map((member) => member.petDetectionId));
  const selectedSet = new Set<number>();

  for (const requestedId of requested) {
    if (!memberIds.has(requestedId)) continue;
    const equivalentIds = equivalentPetDetectionIds(requestedId, sourceId);
    if (equivalentIds.length === 0) {
      selectedSet.add(requestedId);
      continue;
    }
    for (const equivalentId of equivalentIds) {
      if (memberIds.has(equivalentId)) selectedSet.add(equivalentId);
    }
  }

  const selected = members.filter((member) =>
    selectedSet.has(member.petDetectionId)
  );
  const remaining = members.filter((member) =>
    !selectedSet.has(member.petDetectionId)
  );

  if (selected.length === 0) {
    throw new Error(
      "Die ausgewählten Fundstellen gehören nicht mehr zu dieser Hundegruppe."
    );
  }

  return { candidate, sourceId, selected, remaining };
}

function insertManualPetCandidate(
  sourceId: number,
  petClass: string,
  algorithmVersion: string,
  members: Array<{ petDetectionId: number; similarity: number }>
): number | null {
  if (members.length === 0) return null;

  const similarities = members
    .map((member) => member.similarity)
    .filter(Number.isFinite);
  const averageSimilarity =
    similarities.length > 0
      ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
      : 1;
  const minSimilarity = similarities.length > 0 ? Math.min(...similarities) : 1;

  const inserted = db.prepare(
    "INSERT INTO pet_candidates(" +
    "source_id,pet_class,algorithm_version,representative_pet_id," +
    "average_similarity,min_similarity" +
    ") VALUES(?,?,?,?,?,?)"
  ).run(
    sourceId,
    petClass,
    algorithmVersion,
    members[0].petDetectionId,
    averageSimilarity,
    minSimilarity
  );

  const candidateId = Number(inserted.lastInsertRowid);
  const insertItem = db.prepare(
    "INSERT INTO pet_candidate_items(candidate_id,pet_detection_id,similarity) " +
    "VALUES(?,?,?)"
  );

  for (const member of members) {
    insertItem.run(candidateId, member.petDetectionId, member.similarity);
  }

  return candidateId;
}

function splitPetCandidate(
  candidateId: number,
  rawPetDetectionIds: unknown
) {
  const resolved = resolvePetCandidateSelection(candidateId, rawPetDetectionIds);

  if (resolved.remaining.length === 0) {
    throw new Error(
      "Zum Aufteilen muss mindestens eine Fundstelle in der ursprünglichen Gruppe verbleiben."
    );
  }

  const selectedIds = resolved.selected.map((member) => member.petDetectionId);
  const remainingIds = resolved.remaining.map((member) => member.petDetectionId);

  db.exec("BEGIN IMMEDIATE");
  try {
    insertPetCannotLinks(selectedIds, remainingIds, "USER_MANUAL_SPLIT");
    db.prepare("DELETE FROM pet_candidates WHERE id=?").run(candidateId);

    const selectedCandidateId = insertManualPetCandidate(
      resolved.sourceId,
      String(resolved.candidate.pet_class),
      String(resolved.candidate.algorithm_version),
      resolved.selected
    );
    const remainingCandidateId = insertManualPetCandidate(
      resolved.sourceId,
      String(resolved.candidate.pet_class),
      String(resolved.candidate.algorithm_version),
      resolved.remaining
    );

    // Den letzten Clusterlauf nicht invalidieren: die UI bleibt stabil.
    // Bei späterem Re-Clustering halten die Cannot-Links beide Gruppen getrennt.
    db.exec("COMMIT");

    return {
      changed: true,
      selectedCount: resolved.selected.length,
      remainingCount: resolved.remaining.length,
      selectedCandidateId,
      remainingCandidateId
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function assignPetCandidateSelection(
  candidateId: number,
  rawPetDetectionIds: unknown,
  rawName: unknown
) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    throw new Error("Bitte einen Namen für die ausgewählten Fundstellen eingeben.");
  }
  if (name.length > 120) throw new Error("Der Haustiername ist zu lang.");

  const resolved = resolvePetCandidateSelection(candidateId, rawPetDetectionIds);
  const petClass = String(resolved.candidate.pet_class);
  const selectedIds = resolved.selected.map((member) => member.petDetectionId);
  const remainingIds = resolved.remaining.map((member) => member.petDetectionId);

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(
      "SELECT id FROM pets WHERE name=? COLLATE NOCASE AND pet_class=? " +
      "ORDER BY id LIMIT 1"
    ).get(name, petClass);

    const petId = existing
      ? Number(existing.id)
      : Number(
          db.prepare("INSERT INTO pets(name,pet_class) VALUES(?,?)")
            .run(name, petClass).lastInsertRowid
        );

    db.prepare(
      "UPDATE pets SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).run(name, petId);

    insertPetCannotLinks(selectedIds, remainingIds, "USER_DIRECT_ASSIGN");

    const clearExplicitExclusion = db.prepare(
      "DELETE FROM pet_assignment_exclusions WHERE pet_id=? AND pet_detection_id=?"
    );
    const assign = db.prepare(
      "INSERT INTO pet_assignments(" +
      "pet_detection_id,pet_id,assignment_source,confidence,updated_at" +
      ") VALUES(?,?,\'CONFIRMED\',?,CURRENT_TIMESTAMP) " +
      "ON CONFLICT(pet_detection_id) DO UPDATE SET " +
      "pet_id=excluded.pet_id,assignment_source=\'CONFIRMED\'," +
      "confidence=excluded.confidence,updated_at=CURRENT_TIMESTAMP"
    );
    const removeFromCandidates = db.prepare(
      "DELETE FROM pet_candidate_items WHERE pet_detection_id=?"
    );

    for (const member of resolved.selected) {
      clearExplicitExclusion.run(petId, member.petDetectionId);
      assign.run(
        member.petDetectionId,
        petId,
        Number.isFinite(member.similarity) ? member.similarity : null
      );
      removeFromCandidates.run(member.petDetectionId);
    }

    db.prepare(
      "DELETE FROM pet_candidates WHERE NOT EXISTS (" +
      "SELECT 1 FROM pet_candidate_items pci WHERE pci.candidate_id=pet_candidates.id" +
      ")"
    ).run();

    if (resolved.remaining.length > 0) {
      const remainingSimilarities = resolved.remaining
        .map((member) => member.similarity)
        .filter(Number.isFinite);
      const averageSimilarity =
        remainingSimilarities.length > 0
          ? remainingSimilarities.reduce((sum, value) => sum + value, 0) /
            remainingSimilarities.length
          : 1;
      const minSimilarity =
        remainingSimilarities.length > 0
          ? Math.min(...remainingSimilarities)
          : 1;

      db.prepare(
        "UPDATE pet_candidates SET representative_pet_id=?," +
        "average_similarity=?,min_similarity=? WHERE id=?"
      ).run(
        resolved.remaining[0].petDetectionId,
        averageSimilarity,
        minSimilarity,
        candidateId
      );
    }

    db.exec("COMMIT");
    return {
      petId,
      name,
      detectionCount: resolved.selected.length,
      remainingCount: resolved.remaining.length
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

function assignPetDetectionName(petDetectionId: number, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für das Haustier eingeben.");
  if (name.length > 120) throw new Error("Der Haustiername ist zu lang.");

  const pet = db.prepare(`
    SELECT pd.id, pd.pet_class, m.source_id
    FROM pet_fused_detections pd
    JOIN media_items m ON m.id=pd.media_id
    WHERE pd.id=?
      AND m.availability='AVAILABLE'
      AND pd.input_sha256=m.sha256
  `).get(petDetectionId);

  if (!pet) throw new Error("Die Haustierfundstelle wurde nicht gefunden.");

  const sourceId = Number(pet.source_id);
  const petClass = String(pet.pet_class);
  const equivalentIds = equivalentPetDetectionIds(petDetectionId, sourceId);
  const ids = equivalentIds.length > 0 ? equivalentIds : [petDetectionId];

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(
      "SELECT id FROM pets WHERE name=? COLLATE NOCASE AND pet_class=? ORDER BY id LIMIT 1"
    ).get(name, petClass);
    const petId = existing
      ? Number(existing.id)
      : Number(
          db.prepare("INSERT INTO pets(name,pet_class) VALUES(?,?)")
            .run(name, petClass).lastInsertRowid
        );

    const assign = db.prepare(`
      INSERT INTO pet_assignments(
        pet_detection_id, pet_id, assignment_source, confidence, updated_at
      )
      VALUES(?,?,'CONFIRMED',NULL,CURRENT_TIMESTAMP)
      ON CONFLICT(pet_detection_id) DO UPDATE SET
        pet_id=excluded.pet_id,
        assignment_source='CONFIRMED',
        confidence=NULL,
        updated_at=CURRENT_TIMESTAMP
    `);
    const clearExclusion = db.prepare(
      "DELETE FROM pet_assignment_exclusions WHERE pet_id=? AND pet_detection_id=?"
    );
    const removeCandidate = db.prepare(
      "DELETE FROM pet_candidate_items WHERE pet_detection_id=?"
    );

    const remainingCandidateIds = db.prepare(`
      SELECT DISTINCT pci.pet_detection_id
      FROM pet_candidate_items pci
      WHERE pci.candidate_id IN (
        SELECT candidate_id
        FROM pet_candidate_items
        WHERE pet_detection_id=?
      )
    `).all(petDetectionId)
      .map((row) => Number(row.pet_detection_id))
      .filter((id) => !ids.includes(id));

    insertPetCannotLinks(ids, remainingCandidateIds, "USER_DIRECT_ASSIGN");

    for (const id of ids) {
      clearExclusion.run(petId, id);
      assign.run(id, petId);
      removeCandidate.run(id);
    }

    db.prepare(`
      DELETE FROM pet_candidates
      WHERE NOT EXISTS (
        SELECT 1 FROM pet_candidate_items pci
        WHERE pci.candidate_id=pet_candidates.id
      )
    `).run();
    db.prepare("DELETE FROM pet_cluster_runs WHERE source_id=?").run(sourceId);
    db.prepare("UPDATE pets SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(petId);

    db.exec("COMMIT");
    return { identityId: petId, name, affected: ids.length };
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
  if (value.module !== "face-embed-sface-v1") {
    throw new Error(
      "Gesichtsmerkmal-Ergebnis enthält ein falsches oder fehlendes Modul."
    );
  }
  if (!Array.isArray(value.embeddings)) {
    throw new Error(
      "Gesichtsmerkmal-Ergebnis enthält keine gültige Embedding-Liste."
    );
  }

  const rawEmbeddings = value.embeddings;
  const modelVersion =
    typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : "SFace 2021dec";

  const job = jobForModule(jobId, "face-embed-sface-v1");
  const mediaId = Number(job.media_id);
  const inputSha256 = String(job.input_sha256 ?? "");

  const expectedFaceCount = Number(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM face_detections
      WHERE media_id=?
        AND input_sha256=?
    `).get(mediaId, inputSha256)?.count ?? 0
  );

  const reportedInputFaceCount = Number(
    value.inputFaceCount ?? expectedFaceCount
  );
  if (
    !Number.isInteger(reportedInputFaceCount) ||
    reportedInputFaceCount !== expectedFaceCount
  ) {
    throw new Error(
      "SFace erhielt einen inkonsistenten Gesichtsstand: " +
      reportedInputFaceCount +
      " statt " +
      expectedFaceCount +
      "."
    );
  }

  if (rawEmbeddings.length !== expectedFaceCount) {
    const skipped = Number(value.skipped ?? 0);
    const firstErrors = Array.isArray(value.firstErrors)
      ? value.firstErrors.map(String).slice(0, 3)
      : [];
    const detail =
      firstErrors.length > 0
        ? " Ursache: " + firstErrors.join(" | ")
        : "";

    throw new Error(
      "Gesichtsmerkmale unvollständig: " +
      rawEmbeddings.length +
      "/" +
      expectedFaceCount +
      " erzeugt (übersprungen: " +
      (Number.isFinite(skipped) ? skipped : 0) +
      ")." +
      detail
    );
  }

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

    for (let index = 0; index < rawEmbeddings.length; index += 1) {
      const raw = rawEmbeddings[index];

      if (!raw || typeof raw !== "object") {
        throw new Error(
          "Gesichtsmerkmal #" + (index + 1) + " ist kein gültiges Objekt."
        );
      }

      const item = raw as Record<string, unknown>;
      const faceDetectionId = Number(item.faceDetectionId);
      if (!Number.isInteger(faceDetectionId) || faceDetectionId <= 0) {
        throw new Error(
          "Gesichtsmerkmal #" + (index + 1) +
          " enthält keine gültige Face-ID."
        );
      }

      const belongsToMedia = db.prepare(`
        SELECT 1
        FROM face_detections
        WHERE id=?
          AND media_id=?
          AND input_sha256=?
      `).get(faceDetectionId, mediaId, inputSha256);

      if (!belongsToMedia) {
        throw new Error(
          "Gesichtsmerkmal #" + (index + 1) +
          " gehört nicht zum aktuellen Bildstand."
        );
      }

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
      JSON.stringify({
        model: modelVersion,
        embeddingCount: written,
        expectedFaceCount
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
    embeddingCount: written,
    expectedFaceCount
  };
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
  algorithmVersion: string,
  ignoreDefiniteThreshold: number,
  ignoreDoubtThreshold: number
) {
  const rawRows = db.prepare(`
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
    LEFT JOIN ignored_person_matches ipm
      ON ipm.face_detection_id=fd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND fe.model_version='SFace 2021dec'
      AND fe.input_sha256=m.sha256
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
      AND ipm.face_detection_id IS NULL
    ORDER BY fd.id ASC
  `).all(sourceId);

  const ignoredIdentities = ignoredPersonVectorIdentities();
  const insertIgnoredMatch = db.prepare(`
    INSERT INTO ignored_person_matches(
      face_detection_id,
      identity_id,
      match_source,
      similarity,
      updated_at
    )
    VALUES(?,?,'AUTO_HIGH_CONFIDENCE',?,CURRENT_TIMESTAMP)
    ON CONFLICT(face_detection_id) DO UPDATE SET
      identity_id=excluded.identity_id,
      match_source=excluded.match_source,
      similarity=excluded.similarity,
      updated_at=CURRENT_TIMESTAMP
  `);

  const removeCandidateMembership = db.prepare(`
    DELETE FROM person_candidate_faces
    WHERE face_detection_id=?
  `);

  const rows = rawRows.filter((row) => {
    const vector = vectorFromBlob(row.vector_blob, Number(row.dimension));
    const match = classifyIgnoredVectors(
      [vector],
      ignoredIdentities,
      ignoreDefiniteThreshold,
      ignoreDoubtThreshold
    );

    if (!match?.definite) return true;

    const faceDetectionId = Number(row.face_detection_id);
    insertIgnoredMatch.run(
      faceDetectionId,
      match.identityId,
      match.similarity
    );
    removeCandidateMembership.run(faceDetectionId);
    return false;
  });

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

  const implicitCannotLinks: Array<{ faceAId: number; faceBId: number }> = [];
  const faceIdsByMedia = new Map<number, number[]>();
  for (const row of rows) {
    const mediaId = Number(row.media_id);
    const idsForMedia = faceIdsByMedia.get(mediaId) ?? [];
    idsForMedia.push(Number(row.face_detection_id));
    faceIdsByMedia.set(mediaId, idsForMedia);
  }

  for (const idsForMedia of faceIdsByMedia.values()) {
    for (let left = 0; left < idsForMedia.length; left += 1) {
      for (let right = left + 1; right < idsForMedia.length; right += 1) {
        implicitCannotLinks.push({
          faceAId: Math.min(idsForMedia[left], idsForMedia[right]),
          faceBId: Math.max(idsForMedia[left], idsForMedia[right])
        });
      }
    }
  }

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
    cannotLinkSignature,
    ignoredIdentityRevision("person")
  ].join(":");

  const previousRun = db.prepare(`
    SELECT embedding_revision, algorithm_version
    FROM person_cluster_runs
    WHERE source_id=?
  `).get(sourceId);

  const algorithmChanged =
    !previousRun ||
    String(previousRun.algorithm_version) !== algorithmVersion;

  return {
    revision,
    needsRebuild:
      algorithmChanged ||
      String(previousRun?.embedding_revision ?? "") !== revision,
    algorithmChanged,
    faces: rows.map((row) => ({
      faceDetectionId: Number(row.face_detection_id),
      mediaId: Number(row.media_id),
      contentKey: `${String(row.sha256)}:${Number(row.detection_index)}`,
      vector: vectorFromBlob(row.vector_blob, Number(row.dimension))
    })),
    cannotLinks: [
      ...cannotLinkRows.map((row) => ({
        faceAId: Number(row.face_a_id),
        faceBId: Number(row.face_b_id)
      })),
      ...implicitCannotLinks
    ]
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
    SELECT fd.id, fd.detection_index, m.sha256
    FROM face_detections fd
    JOIN face_embeddings fe ON fe.face_detection_id=fd.id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa ON pfa.face_detection_id=fd.id
    LEFT JOIN ignored_person_matches ipm ON ipm.face_detection_id=fd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND fe.model_version='SFace 2021dec'
      AND fe.input_sha256=m.sha256
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
      AND ipm.face_detection_id IS NULL
  `).all(sourceId);

  const eligibleIds = new Set(
    eligibleRows.map((row) => Number(row.id))
  );
  const contentKeyByFaceId = new Map(
    eligibleRows.map((row) => [
      Number(row.id),
      `${String(row.sha256)}:${Number(row.detection_index)}`
    ])
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

      // Eine Gruppe braucht mindestens zwei unabhängige Erkennungen.
      // Mehrere Dateikopien derselben Aufnahme/detection_index zählen nicht.
      const independentContentKeys = new Set(
        members
          .map((member) => contentKeyByFaceId.get(member.faceDetectionId))
          .filter((value): value is string => Boolean(value))
      );
      if (independentContentKeys.size < 2) continue;

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

function listUngroupedPersonDetections(sourceId: number, requestedLimit: number) {
  const limit = Math.max(1, Math.min(4000, Math.trunc(requestedLimit || 1000)));
  const rows = db.prepare(`
    SELECT
      fd.id AS face_detection_id,
      fd.media_id,
      m.relative_path,
      fd.x, fd.y, fd.width, fd.height,
      fe.dimension,
      fe.vector_blob
    FROM face_detections fd
    JOIN media_items m ON m.id=fd.media_id
    JOIN face_embeddings fe ON fe.face_detection_id=fd.id
    LEFT JOIN person_face_assignments pfa ON pfa.face_detection_id=fd.id
    LEFT JOIN person_candidate_faces pcf ON pcf.face_detection_id=fd.id
    LEFT JOIN ignored_person_matches ipm ON ipm.face_detection_id=fd.id
    WHERE m.source_id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      AND fe.input_sha256=m.sha256
      AND fe.model_version='SFace 2021dec'
      AND pfa.face_detection_id IS NULL
      AND pcf.face_detection_id IS NULL
      AND ipm.face_detection_id IS NULL
    ORDER BY fd.id DESC
    LIMIT ?
  `).all(sourceId, limit);

  const knownPersons = knownPersonCentroids();
  const exclusion = db.prepare(
    "SELECT 1 FROM person_face_exclusions " +
    "WHERE face_detection_id=? AND person_id=? LIMIT 1"
  );

  return rows.map((row) => {
    const faceDetectionId = Number(row.face_detection_id);
    const vector = vectorFromBlob(row.vector_blob, Number(row.dimension));
    const suggestedPersons = knownPersons
      .filter((known) => !exclusion.get(faceDetectionId, known.id))
      .map((known) => ({
        personId: known.id,
        personName: known.name,
        similarity: cosineSimilarity(vector, known.vector),
        representativeFaceId: known.representativeFaceId
      }))
      .filter((match) => Number.isFinite(match.similarity) && match.similarity >= 0.48)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 5);

    return {
      faceDetectionId,
      mediaId: Number(row.media_id),
      relativePath: String(row.relative_path),
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
      suggestedPersons
    };
  });
}

function rejectPersonDetectionSuggestion(faceDetectionId: number, personId: number) {
  const face = db.prepare(`
    SELECT fd.id
    FROM face_detections fd
    LEFT JOIN person_face_assignments pfa ON pfa.face_detection_id=fd.id
    WHERE fd.id=? AND pfa.face_detection_id IS NULL
  `).get(faceDetectionId);
  if (!face) throw new Error("Das Gesicht ist nicht mehr unbestätigt verfügbar.");

  const person = db.prepare("SELECT id FROM persons WHERE id=?").get(personId);
  if (!person) throw new Error("Die vorgeschlagene Person existiert nicht mehr.");

  db.prepare(`
    INSERT INTO person_face_exclusions(person_id, face_detection_id, reason)
    VALUES(?,?,'USER_REJECTED_SUGGESTION')
    ON CONFLICT(person_id, face_detection_id) DO UPDATE SET
      reason='USER_REJECTED_SUGGESTION'
  `).run(personId, faceDetectionId);

  return { changed: true, affectedFaces: 1 };
}
function listPersonCandidates(
  sourceId: number,
  requestedLimit: number,
  ignoreDefiniteThreshold = 0.62,
  ignoreDoubtThreshold = 0.55,
  summaryOnly = false
) {
  const limit = Math.max(1, Math.min(2000, Math.trunc(requestedLimit || 500)));

  const candidates = summaryOnly
    ? db.prepare(`
        SELECT
          pc.id,
          pc.representative_face_id,
          pc.average_similarity,
          pc.min_similarity,
          pc.member_count AS face_count,
          pc.representative_face_id AS first_face_id,
          pc.newest_face_id
        FROM person_candidates pc
        WHERE pc.source_id=?
          AND pc.member_count>=2
        ORDER BY
          pc.member_count DESC,
          pc.average_similarity DESC,
          pc.newest_face_id DESC
        LIMIT ?
      `).all(sourceId, limit)
    : db.prepare(`
        SELECT
          pc.id,
          pc.representative_face_id,
          pc.average_similarity,
          pc.min_similarity,
          COUNT(pcf.face_detection_id) AS face_count,
          MIN(pcf.face_detection_id) AS first_face_id,
          MAX(pcf.face_detection_id) AS newest_face_id
        FROM person_candidates pc
        JOIN person_candidate_faces pcf ON pcf.candidate_id=pc.id
        JOIN face_detections fd ON fd.id=pcf.face_detection_id
        JOIN media_items m ON m.id=fd.media_id
        LEFT JOIN person_face_assignments pfa
          ON pfa.face_detection_id=pcf.face_detection_id
        WHERE pc.source_id=?
          AND m.availability='AVAILABLE'
          AND fd.input_sha256=m.sha256
          AND pfa.face_detection_id IS NULL
        GROUP BY pc.id
        HAVING COUNT(DISTINCT m.sha256 || ':' || fd.detection_index) >= 2
        ORDER BY face_count DESC, pc.average_similarity DESC, newest_face_id DESC
        LIMIT ?
      `).all(sourceId, limit);

  if (summaryOnly) {
    return candidates.map((candidate) => ({
      id: Number(candidate.id),
      faceCount: Number(candidate.face_count),
      newestFaceId: Number(candidate.newest_face_id),
      memberSignature: "",
      representativeFaceId:
        candidate.first_face_id === null || candidate.first_face_id === undefined
          ? null
          : Number(candidate.first_face_id),
      averageSimilarity: Number(candidate.average_similarity),
      minSimilarity: Number(candidate.min_similarity),
      suggestedPersons: [],
      ignoredIdentityId: null,
      ignoredSimilarity: null,
      faces: []
    }));
  }

  const memberSignatureQuery = db.prepare(`
    SELECT pcf.face_detection_id
    FROM person_candidate_faces pcf
    JOIN face_detections fd ON fd.id=pcf.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
    ORDER BY pcf.face_detection_id
  `);

  const faceQuery = db.prepare(`
    SELECT
      pcf.face_detection_id,
      fd.media_id,
      m.relative_path,
      pcf.similarity,
      fd.x,
      fd.y,
      fd.width,
      fd.height
    FROM person_candidate_faces pcf
    JOIN face_detections fd ON fd.id=pcf.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
    ORDER BY
      CASE WHEN pcf.face_detection_id=? THEN 0 ELSE 1 END,
      pcf.similarity DESC,
      pcf.face_detection_id ASC
    LIMIT 48
  `);

  const embeddingQuery = db.prepare(`
    SELECT
      pcf.face_detection_id,
      fe.dimension,
      fe.vector_blob
    FROM person_candidate_faces pcf
    JOIN face_embeddings fe ON fe.face_detection_id=pcf.face_detection_id
    JOIN face_detections fd ON fd.id=pcf.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND fe.model_version='SFace 2021dec'
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      AND fe.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
    ORDER BY pcf.face_detection_id
  `);

  const exclusionQuery = db.prepare(`
    SELECT 1
    FROM person_candidate_faces pcf
    JOIN person_face_exclusions pfe
      ON pfe.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND pfe.person_id=?
    LIMIT 1
  `);
  const faceExclusionQuery = db.prepare(
    "SELECT 1 FROM person_face_exclusions " +
    "WHERE face_detection_id=? AND person_id=? LIMIT 1"
  );

  const knownPersons = knownPersonCentroids();
  const ignoredIdentities = ignoredPersonVectorIdentities();
  const insertIgnoredMatch = db.prepare(`
    INSERT INTO ignored_person_matches(
      face_detection_id,
      identity_id,
      match_source,
      similarity,
      updated_at
    )
    VALUES(?,?,'AUTO_HIGH_CONFIDENCE',?,CURRENT_TIMESTAMP)
    ON CONFLICT(face_detection_id) DO UPDATE SET
      identity_id=excluded.identity_id,
      match_source=excluded.match_source,
      similarity=excluded.similarity,
      updated_at=CURRENT_TIMESTAMP
  `);
  const deleteCandidate = db.prepare("DELETE FROM person_candidates WHERE id=?");

  return candidates.map((candidate) => {
    const candidateId = Number(candidate.id);
    const memberIds = memberSignatureQuery
      .all(candidateId)
      .map((row) => Number(row.face_detection_id));
    const storedRepresentativeFaceId = candidate.representative_face_id === null
      ? null
      : Number(candidate.representative_face_id);
    const representativeFaceId =
      storedRepresentativeFaceId !== null &&
      memberIds.includes(storedRepresentativeFaceId)
        ? storedRepresentativeFaceId
        : (memberIds[0] ?? null);

    const embeddingRows = embeddingQuery.all(candidateId);
    const vectors = embeddingRows.map((row) =>
      vectorFromBlob(row.vector_blob, Number(row.dimension))
    );
    const ignoredMatch = classifyIgnoredVectors(
      vectors,
      ignoredIdentities,
      ignoreDefiniteThreshold,
      ignoreDoubtThreshold
    );

    if (ignoredMatch?.definite) {
      for (const row of embeddingRows) {
        insertIgnoredMatch.run(
          Number(row.face_detection_id),
          ignoredMatch.identityId,
          ignoredMatch.similarity
        );
      }
      deleteCandidate.run(candidateId);
      return null;
    }

    const vectorByFaceId = new Map(
      embeddingRows.map((row, index) => [
        Number(row.face_detection_id),
        vectors[index]
      ])
    );
    const candidateVector = centroid(vectors);
    const suggestedPersons = candidateVector
      ? knownPersons
          .filter((known) => !exclusionQuery.get(candidateId, known.id))
          .map((known) => ({
            personId: known.id,
            personName: known.name,
            similarity: cosineSimilarity(candidateVector, known.vector),
            representativeFaceId: known.representativeFaceId
          }))
          .filter((match) => match.similarity >= 0.55)
          .sort((left, right) => right.similarity - left.similarity)
          .slice(0, 3)
      : [];

    return {
      id: candidateId,
      faceCount: Number(candidate.face_count),
      newestFaceId: Number(candidate.newest_face_id),
      memberSignature: memberIds.join(","),
      representativeFaceId,
      averageSimilarity: Number(candidate.average_similarity),
      minSimilarity: Number(candidate.min_similarity),
      suggestedPersons,
      ignoredIdentityId: ignoredMatch?.identityId ?? null,
      ignoredSimilarity: ignoredMatch?.similarity ?? null,
      faces: faceQuery.all(
        candidateId,
        representativeFaceId ?? -1
      ).map((row) => ({
        faceDetectionId: Number(row.face_detection_id),
        mediaId: Number(row.media_id),
        relativePath: String(row.relative_path),
        similarity: Number(row.similarity),
        x: Number(row.x),
        y: Number(row.y),
        width: Number(row.width),
        height: Number(row.height),
        suggestedPersons: (() => {
          const vector = vectorByFaceId.get(Number(row.face_detection_id));
          if (!vector) return [];
          return knownPersons
            .filter((known) =>
              !faceExclusionQuery.get(Number(row.face_detection_id), known.id)
            )
            .map((known) => ({
              personId: known.id,
              personName: known.name,
              similarity: cosineSimilarity(vector, known.vector),
              representativeFaceId: known.representativeFaceId
            }))
            .filter((match) => match.similarity >= 0.48)
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, 5);
        })()
      }))
    };
  }).filter((candidate) => candidate !== null);
}

function listPersonCandidateItems(
  candidateId: number,
  requestedLimit = 5000,
  requestedOffset = 0
) {
  const limit = Math.max(1, Math.min(5000, Math.trunc(requestedLimit || 5000)));
  const offset = Math.max(0, Math.trunc(requestedOffset || 0));
  const candidate = db.prepare(
    "SELECT representative_face_id FROM person_candidates WHERE id=?"
  ).get(candidateId);
  if (!candidate) return [];

  const representativeFaceId =
    candidate.representative_face_id === null ||
    candidate.representative_face_id === undefined
      ? -1
      : Number(candidate.representative_face_id);

  return db.prepare(`
    SELECT
      pcf.face_detection_id,
      fd.media_id,
      m.relative_path,
      pcf.similarity,
      fd.x,
      fd.y,
      fd.width,
      fd.height
    FROM person_candidate_faces pcf
    JOIN face_detections fd ON fd.id=pcf.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
    ORDER BY
      CASE WHEN pcf.face_detection_id=? THEN 0 ELSE 1 END,
      pcf.similarity DESC,
      pcf.face_detection_id ASC
    LIMIT ? OFFSET ?
  `).all(candidateId, representativeFaceId, limit, offset).map((row) => ({
    faceDetectionId: Number(row.face_detection_id),
    mediaId: Number(row.media_id),
    relativePath: String(row.relative_path),
    similarity: Number(row.similarity),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    suggestedPersons: []
  }));
}

function listPersons(sourceId: number) {
  const persons = db.prepare(`
    SELECT
      p.id,
      p.name,
      (
        SELECT COUNT(*)
        FROM person_face_assignments pfa
        JOIN face_detections fd ON fd.id=pfa.face_detection_id
        JOIN media_items m ON m.id=fd.media_id
        WHERE pfa.person_id=p.id
          AND m.source_id=?
      ) AS face_count,
      (
        SELECT MIN(fd.id)
        FROM person_face_assignments pfa
        JOIN face_detections fd ON fd.id=pfa.face_detection_id
        JOIN media_items m ON m.id=fd.media_id
        WHERE pfa.person_id=p.id
          AND m.source_id=?
      ) AS representative_face_id
    FROM persons p
    WHERE EXISTS (
      SELECT 1
      FROM person_face_assignments pfa
      JOIN face_detections fd ON fd.id=pfa.face_detection_id
      JOIN media_items m ON m.id=fd.media_id
      WHERE pfa.person_id=p.id
        AND m.source_id=?
    )
    OR EXISTS (
      SELECT 1
      FROM video_identity_tracks vit
      JOIN media_items m ON m.id=vit.media_id
      WHERE vit.identity_kind='person'
        AND vit.identity_id=p.id
        AND m.source_id=?
        AND m.availability='AVAILABLE'
    )
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all(sourceId, sourceId, sourceId, sourceId);

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

  const videoHitQuery = db.prepare(
    "SELECT vit.media_id,m.relative_path,vit.start_ms,vit.end_ms," +
    "vit.hit_count,vit.max_similarity FROM video_identity_tracks vit " +
    "JOIN media_items m ON m.id=vit.media_id " +
    "WHERE vit.identity_kind='person' AND vit.identity_id=? " +
    "AND m.source_id=? AND m.availability='AVAILABLE' " +
    "ORDER BY vit.start_ms,vit.id"
  );

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
    })),
    videoHits: videoHitQuery.all(Number(row.id), sourceId).map((hit) => ({
      mediaId: Number(hit.media_id),
      relativePath: String(hit.relative_path),
      startMs: Number(hit.start_ms),
      endMs: Number(hit.end_ms),
      hitCount: Number(hit.hit_count),
      maxSimilarity: hit.max_similarity === null ? null : Number(hit.max_similarity)
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

function assignFaceDetectionName(faceDetectionId: number, rawName: unknown) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für das Gesicht eingeben.");
  if (name.length > 120) throw new Error("Der Personenname ist zu lang.");

  const face = db.prepare(`
    SELECT fd.id, m.source_id
    FROM face_detections fd
    JOIN media_items m ON m.id=fd.media_id
    WHERE fd.id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
  `).get(faceDetectionId);

  if (!face) throw new Error("Das Gesicht wurde nicht gefunden.");

  const sourceId = Number(face.source_id);
  const equivalentIds = equivalentFaceIds(faceDetectionId, sourceId);
  const ids = equivalentIds.length > 0 ? equivalentIds : [faceDetectionId];

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(
      "SELECT id FROM persons WHERE name=? COLLATE NOCASE ORDER BY id LIMIT 1"
    ).get(name);
    const personId = existing
      ? Number(existing.id)
      : Number(db.prepare("INSERT INTO persons(name) VALUES(?)").run(name).lastInsertRowid);

    const assign = db.prepare(`
      INSERT INTO person_face_assignments(
        face_detection_id, person_id, assignment_source, confidence, updated_at
      )
      VALUES(?,?,'CONFIRMED',NULL,CURRENT_TIMESTAMP)
      ON CONFLICT(face_detection_id) DO UPDATE SET
        person_id=excluded.person_id,
        assignment_source='CONFIRMED',
        confidence=NULL,
        updated_at=CURRENT_TIMESTAMP
    `);
    const clearExclusion = db.prepare(
      "DELETE FROM person_face_exclusions WHERE person_id=? AND face_detection_id=?"
    );
    const removeCandidate = db.prepare(
      "DELETE FROM person_candidate_faces WHERE face_detection_id=?"
    );

    const remainingCandidateIds = db.prepare(`
      SELECT DISTINCT pcf.face_detection_id
      FROM person_candidate_faces pcf
      WHERE pcf.candidate_id IN (
        SELECT candidate_id
        FROM person_candidate_faces
        WHERE face_detection_id IN (?)
      )
    `).all(faceDetectionId)
      .map((row) => Number(row.face_detection_id))
      .filter((id) => !ids.includes(id));

    insertCannotLinks(ids, remainingCandidateIds, "USER_DIRECT_ASSIGN");

    for (const id of ids) {
      clearExclusion.run(personId, id);
      assign.run(id, personId);
      removeCandidate.run(id);
    }

    db.prepare(`
      DELETE FROM person_candidates
      WHERE NOT EXISTS (
        SELECT 1 FROM person_candidate_faces pcf
        WHERE pcf.candidate_id=person_candidates.id
      )
    `).run();
    db.prepare("DELETE FROM person_cluster_runs WHERE source_id=?").run(sourceId);
    db.prepare("UPDATE persons SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(personId);

    db.exec("COMMIT");
    return { identityId: personId, name, affected: ids.length };
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

function ignorePersonCandidate(
  candidateId: number,
  fallbackFaceDetectionId?: number,
  expectedFaceCount?: number,
  expectedMemberSignature?: string,
  requestedIgnoredIdentityId?: number
) {
  let resolvedCandidateId = candidateId;
  let candidate = db.prepare(`
    SELECT id, source_id
    FROM person_candidates
    WHERE id=?
  `).get(resolvedCandidateId);

  const stableFaceId =
    Number.isInteger(fallbackFaceDetectionId) &&
    Number(fallbackFaceDetectionId) > 0
      ? Number(fallbackFaceDetectionId)
      : null;

  const candidateStillMatches =
    candidate && stableFaceId !== null
      ? Boolean(
          db.prepare(`
            SELECT 1
            FROM person_candidate_faces
            WHERE candidate_id=?
              AND face_detection_id=?
            LIMIT 1
          `).get(resolvedCandidateId, stableFaceId)
        )
      : Boolean(candidate);

  if (!candidateStillMatches && stableFaceId !== null) {
    candidate = db.prepare(`
      SELECT pc.id, pc.source_id
      FROM person_candidate_faces pcf
      JOIN person_candidates pc ON pc.id=pcf.candidate_id
      WHERE pcf.face_detection_id=?
      LIMIT 1
    `).get(stableFaceId);

    if (candidate) resolvedCandidateId = Number(candidate.id);
  }

  if (!candidate) {
    throw new Error(
      "Die Personengruppe wurde während der Analyse neu aufgebaut. Bitte die Ansicht aktualisieren und erneut prüfen."
    );
  }

  const members = db.prepare(`
    SELECT pcf.face_detection_id
    FROM person_candidate_faces pcf
    JOIN face_detections fd ON fd.id=pcf.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
    ORDER BY pcf.face_detection_id
  `).all(resolvedCandidateId);

  if (members.length === 0) {
    throw new Error("Die Personengruppe enthält keine unbestätigten Gesichter mehr.");
  }

  if (
    Number.isInteger(expectedFaceCount) &&
    Number(expectedFaceCount) >= 2 &&
    members.length !== Number(expectedFaceCount)
  ) {
    throw new Error(
      "Die Personengruppe hat sich während der Analyse geändert. Bitte die Ansicht aktualisieren und erneut prüfen."
    );
  }

  const currentMemberSignature = members
    .map((member) => Number(member.face_detection_id))
    .join(",");
  if (
    typeof expectedMemberSignature === "string" &&
    expectedMemberSignature.length > 0 &&
    currentMemberSignature !== expectedMemberSignature
  ) {
    throw new Error(
      "Die Zusammensetzung der Personengruppe hat sich während der Analyse geändert. Bitte die Ansicht aktualisieren und erneut prüfen."
    );
  }

  const embeddingQuery = db.prepare(`
    SELECT
      fe.face_detection_id,
      fe.model_version,
      fe.dimension,
      fe.vector_blob
    FROM face_embeddings fe
    WHERE fe.face_detection_id=?
      AND fe.model_version='SFace 2021dec'
  `);

  let ignoredIdentityId =
    Number.isInteger(requestedIgnoredIdentityId) &&
    Number(requestedIgnoredIdentityId) > 0
      ? Number(requestedIgnoredIdentityId)
      : null;

  if (ignoredIdentityId !== null) {
    const existing = db.prepare(`
      SELECT id
      FROM ignored_person_identities
      WHERE id=?
    `).get(ignoredIdentityId);
    if (!existing) ignoredIdentityId = null;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const extendedExisting = ignoredIdentityId !== null;

    if (ignoredIdentityId === null) {
      ignoredIdentityId = Number(
        db.prepare(`
          INSERT INTO ignored_person_identities DEFAULT VALUES
        `).run().lastInsertRowid
      );
    }

    const insertReference = db.prepare(`
      INSERT OR IGNORE INTO ignored_person_references(
        identity_id,
        model_version,
        dimension,
        vector_blob,
        source_face_detection_id
      )
      VALUES(?,?,?,?,?)
    `);
    const insertMatch = db.prepare(`
      INSERT INTO ignored_person_matches(
        face_detection_id,
        identity_id,
        match_source,
        similarity,
        updated_at
      )
      VALUES(?,?,'USER_REJECTED',NULL,CURRENT_TIMESTAMP)
      ON CONFLICT(face_detection_id) DO UPDATE SET
        identity_id=excluded.identity_id,
        match_source='USER_REJECTED',
        similarity=NULL,
        updated_at=CURRENT_TIMESTAMP
    `);

    let faceCount = 0;
    for (const member of members) {
      const faceDetectionId = Number(member.face_detection_id);
      const embedding = embeddingQuery.get(faceDetectionId);
      if (!embedding) continue;

      insertReference.run(
        ignoredIdentityId,
        String(embedding.model_version),
        Number(embedding.dimension),
        embedding.vector_blob,
        faceDetectionId
      );
      insertMatch.run(faceDetectionId, ignoredIdentityId);
      faceCount += 1;
    }

    if (faceCount === 0) {
      throw new Error(
        "Für die Personengruppe konnten keine SFace-Merkmale als dauerhafte Ignore-Referenz gespeichert werden."
      );
    }

    db.prepare(`
      UPDATE ignored_person_identities
      SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(ignoredIdentityId);

    db.prepare("DELETE FROM person_candidates WHERE id=?").run(resolvedCandidateId);

    db.exec("COMMIT");
    return {
      ignoredIdentityId,
      faceCount,
      extendedExisting
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


function assignPersonCandidateSelection(
  candidateId: number,
  rawFaceDetectionIds: unknown,
  rawName: unknown
) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    throw new Error("Bitte einen Namen für die ausgewählten Gesichter eingeben.");
  }
  if (name.length > 120) throw new Error("Der Personenname ist zu lang.");

  const candidate = db.prepare(
    "SELECT id, source_id FROM person_candidates WHERE id=?"
  ).get(candidateId);
  if (!candidate) throw new Error("Die Personengruppe wurde nicht gefunden.");

  const sourceId = Number(candidate.source_id);
  const members = db.prepare(
    "SELECT face_detection_id, similarity FROM person_candidate_faces " +
    "WHERE candidate_id=? ORDER BY face_detection_id"
  ).all(candidateId).map((row) => ({
    faceDetectionId: Number(row.face_detection_id),
    similarity: Number(row.similarity)
  }));

  const requested = Array.isArray(rawFaceDetectionIds)
    ? [...new Set(
        rawFaceDetectionIds
          .map(Number)
          .filter((value) => Number.isInteger(value) && value > 0)
      )]
    : [];
  if (requested.length === 0) {
    throw new Error("Bitte mindestens ein Gesicht auswählen.");
  }

  const memberIds = new Set(members.map((member) => member.faceDetectionId));
  const selectedSet = new Set<number>();
  for (const requestedId of requested) {
    if (!memberIds.has(requestedId)) continue;
    const equivalentIds = equivalentFaceIds(requestedId, sourceId);
    if (equivalentIds.length === 0) {
      selectedSet.add(requestedId);
      continue;
    }
    for (const equivalentId of equivalentIds) {
      if (memberIds.has(equivalentId)) selectedSet.add(equivalentId);
    }
  }

  const selected = members.filter((member) =>
    selectedSet.has(member.faceDetectionId)
  );
  const remaining = members.filter((member) =>
    !selectedSet.has(member.faceDetectionId)
  );
  if (selected.length === 0) {
    throw new Error("Das ausgewählte Gesicht gehört nicht mehr zu dieser Gruppe.");
  }

  const selectedIds = selected.map((member) => member.faceDetectionId);
  const remainingIds = remaining.map((member) => member.faceDetectionId);

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(
      "SELECT id FROM persons WHERE name=? COLLATE NOCASE ORDER BY id LIMIT 1"
    ).get(name);
    const personId = existing
      ? Number(existing.id)
      : Number(
          db.prepare("INSERT INTO persons(name) VALUES(?)")
            .run(name).lastInsertRowid
        );

    db.prepare(
      "UPDATE persons SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).run(name, personId);

    insertCannotLinks(selectedIds, remainingIds, "USER_DIRECT_ASSIGN");

    const clearExclusion = db.prepare(
      "DELETE FROM person_face_exclusions WHERE person_id=? AND face_detection_id=?"
    );
    const assign = db.prepare(
      "INSERT INTO person_face_assignments(" +
      "face_detection_id,person_id,assignment_source,confidence,updated_at" +
      ") VALUES(?,?,\'CONFIRMED\',?,CURRENT_TIMESTAMP) " +
      "ON CONFLICT(face_detection_id) DO UPDATE SET " +
      "person_id=excluded.person_id,assignment_source=\'CONFIRMED\'," +
      "confidence=excluded.confidence,updated_at=CURRENT_TIMESTAMP"
    );
    const removeFromCandidate = db.prepare(
      "DELETE FROM person_candidate_faces WHERE face_detection_id=?"
    );

    for (const member of selected) {
      clearExclusion.run(personId, member.faceDetectionId);
      assign.run(
        member.faceDetectionId,
        personId,
        Number.isFinite(member.similarity) ? member.similarity : null
      );
      removeFromCandidate.run(member.faceDetectionId);
    }

    db.prepare(
      "DELETE FROM person_candidates WHERE NOT EXISTS (" +
      "SELECT 1 FROM person_candidate_faces pcf " +
      "WHERE pcf.candidate_id=person_candidates.id)"
    ).run();

    if (remaining.length > 0) {
      const similarities = remaining
        .map((member) => member.similarity)
        .filter(Number.isFinite);
      const averageSimilarity =
        similarities.length > 0
          ? similarities.reduce((sum, value) => sum + value, 0) /
            similarities.length
          : 1;
      const minSimilarity =
        similarities.length > 0 ? Math.min(...similarities) : 1;

      db.prepare(
        "UPDATE person_candidates SET representative_face_id=?," +
        "average_similarity=?,min_similarity=? WHERE id=?"
      ).run(
        remaining[0].faceDetectionId,
        averageSimilarity,
        minSimilarity,
        candidateId
      );
    }

    db.exec("COMMIT");
    return {
      personId,
      name,
      faceCount: selected.length,
      remainingCount: remaining.length
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function confirmPersonCandidate(
  candidateId: number,
  rawName: unknown,
  fallbackFaceDetectionId?: number,
  expectedFaceCount?: number,
  expectedMemberSignature?: string
) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen für die Person eingeben.");
  if (name.length > 120) throw new Error("Der Personenname ist zu lang.");

  let resolvedCandidateId = candidateId;
  let candidate = db.prepare(`
    SELECT id, source_id
    FROM person_candidates
    WHERE id=?
  `).get(resolvedCandidateId);

  // Kandidaten-IDs ändern sich bei einem Hintergrund-Re-Clustering und
  // können von SQLite später sogar wiederverwendet werden. Deshalb reicht
  // "ID existiert" nicht: Das sichtbare Referenzgesicht muss weiterhin genau
  // zu diesem Kandidaten gehören. Andernfalls wird die aktuelle Gruppe über
  // das stabile Gesicht aufgelöst.
  const stableFaceId =
    Number.isInteger(fallbackFaceDetectionId) &&
    Number(fallbackFaceDetectionId) > 0
      ? Number(fallbackFaceDetectionId)
      : null;

  const candidateStillMatches =
    candidate && stableFaceId !== null
      ? Boolean(
          db.prepare(`
            SELECT 1
            FROM person_candidate_faces
            WHERE candidate_id=?
              AND face_detection_id=?
            LIMIT 1
          `).get(resolvedCandidateId, stableFaceId)
        )
      : Boolean(candidate);

  if (!candidateStillMatches && stableFaceId !== null) {
    candidate = db.prepare(`
      SELECT pc.id, pc.source_id
      FROM person_candidate_faces pcf
      JOIN person_candidates pc ON pc.id=pcf.candidate_id
      WHERE pcf.face_detection_id=?
      LIMIT 1
    `).get(stableFaceId);

    if (candidate) {
      resolvedCandidateId = Number(candidate.id);
    }
  }

  if (!candidate) {
    throw new Error(
      "Die Gruppe wurde während der Analyse neu aufgebaut. Bitte die Personenansicht aktualisieren und erneut bestätigen."
    );
  }

  const members = db.prepare(`
    SELECT pcf.face_detection_id, pcf.similarity
    FROM person_candidate_faces pcf
    JOIN face_detections fd ON fd.id=pcf.face_detection_id
    JOIN media_items m ON m.id=fd.media_id
    LEFT JOIN person_face_assignments pfa
      ON pfa.face_detection_id=pcf.face_detection_id
    WHERE pcf.candidate_id=?
      AND m.availability='AVAILABLE'
      AND fd.input_sha256=m.sha256
      AND pfa.face_detection_id IS NULL
    ORDER BY pcf.face_detection_id
  `).all(resolvedCandidateId);

  if (members.length === 0) {
    throw new Error("Der Personenvorschlag enthält keine unbestätigten Gesichter mehr.");
  }

  if (
    Number.isInteger(expectedFaceCount) &&
    Number(expectedFaceCount) >= 2 &&
    members.length !== Number(expectedFaceCount)
  ) {
    throw new Error(
      "Die Personengruppe hat sich während der Analyse geändert (" +
      Number(expectedFaceCount) +
      " → " +
      members.length +
      " Gesichter). Bitte die Ansicht aktualisieren und die Gruppe erneut prüfen."
    );
  }

  const currentMemberSignature = members
    .map((member) => Number(member.face_detection_id))
    .join(",");
  if (
    typeof expectedMemberSignature === "string" &&
    expectedMemberSignature.length > 0 &&
    currentMemberSignature !== expectedMemberSignature
  ) {
    throw new Error(
      "Die Zusammensetzung der Personengruppe hat sich während der Analyse geändert. " +
      "Bitte die Ansicht aktualisieren und die Gruppe erneut prüfen."
    );
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

    db.prepare("DELETE FROM person_candidates WHERE id=?").run(resolvedCandidateId);
    // Den letzten Clusterlauf absichtlich behalten. Die Revision ist durch
    // die neue Zuordnung zwar veraltet, aber die UI darf nach "Bestätigen"
    // nicht synchron tausende Gesichter neu clustern. Der nächste reguläre
    // Hintergrundlauf bzw. ein explizites Aktualisieren baut sauber neu.

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
      fe.dimension AS embedding_dimension,
      fe.vector_blob AS embedding_vector,
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
      pe.dimension AS embedding_dimension,
      pe.vector_blob AS embedding_vector,
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

  const videoAnalysis = db.prepare(
    "SELECT duration_ms,width,height,fps,sample_interval_ms,sampled_frames,scene_count,frames_json " +
    "FROM media_video_analysis WHERE media_id=? AND input_sha256=?"
  ).get(mediaId, currentSha);

  const videoFrameOverrides = db.prepare(
    "SELECT vfo.timestamp_ms,vfo.identity_kind,vfo.detection_index,vfo.pet_class," +
    "vfo.identity_id," +
    "CASE WHEN vfo.identity_kind='person' THEN p.name " +
    "WHEN vfo.identity_kind='pet' THEN pe.name ELSE NULL END AS identity_name " +
    "FROM video_frame_identity_overrides vfo " +
    "LEFT JOIN persons p ON vfo.identity_kind='person' AND p.id=vfo.identity_id " +
    "LEFT JOIN pets pe ON vfo.identity_kind='pet' AND pe.id=vfo.identity_id " +
    "WHERE vfo.media_id=?"
  ).all(mediaId);
  const videoTags = db.prepare(
    "SELECT label,score,hit_count FROM video_tags WHERE media_id=? " +
    "ORDER BY hit_count DESC,score DESC,label"
  ).all(mediaId);
  const videoIdentityHits = db.prepare(
    "SELECT vit.identity_kind,vit.identity_id,vit.pet_class,vit.start_ms,vit.end_ms," +
    "vit.hit_count,vit.max_similarity," +
    "CASE WHEN vit.identity_kind='person' THEN p.name " +
    "WHEN vit.identity_kind='pet' THEN pe.name ELSE NULL END AS identity_name " +
    "FROM video_identity_tracks vit " +
    "LEFT JOIN persons p ON vit.identity_kind='person' AND p.id=vit.identity_id " +
    "LEFT JOIN pets pe ON vit.identity_kind='pet' AND pe.id=vit.identity_id " +
    "WHERE vit.media_id=? ORDER BY vit.start_ms,vit.id"
  ).all(mediaId);

  const jobs = db.prepare(`
    SELECT
      module,
      status,
      attempts,
      result_json,
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

  const sourceId = Number(media.source_id);
  const knownPersons = faceRows.some(
    (row) => row.embedding_vector && !row.person_id
  )
    ? knownPersonCentroids(sourceId)
    : [];
  const knownPets = petRows.some(
    (row) => row.embedding_vector && !row.pet_id
  )
    ? knownPetCentroids(sourceId)
    : [];

  const personExclusion = db.prepare(
    "SELECT 1 FROM person_face_exclusions " +
    "WHERE face_detection_id=? AND person_id=? LIMIT 1"
  );
  const petExclusion = db.prepare(
    "SELECT 1 FROM pet_assignment_exclusions " +
    "WHERE pet_detection_id=? AND pet_id=? LIMIT 1"
  );

  const suggestedPersonsFor = (row: any) => {
    if (
      row.person_id !== null &&
      row.person_id !== undefined
    ) return [];
    if (!row.embedding_vector || !Number(row.embedding_dimension)) return [];

    const vector = vectorFromBlob(
      row.embedding_vector,
      Number(row.embedding_dimension)
    );
    const faceId = Number(row.id);

    return knownPersons
      .filter((known) => !personExclusion.get(faceId, known.id))
      .map((known) => ({
        personId: known.id,
        personName: known.name,
        similarity: cosineSimilarity(vector, known.vector)
      }))
      .filter((match) => Number.isFinite(match.similarity) && match.similarity >= 0.48)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 5);
  };

  const suggestedPetsFor = (row: any) => {
    if (
      row.pet_id !== null &&
      row.pet_id !== undefined
    ) return [];
    if (!row.embedding_vector || !Number(row.embedding_dimension)) return [];

    const vector = vectorFromBlob(
      row.embedding_vector,
      Number(row.embedding_dimension)
    );
    const petId = Number(row.id);
    const petClass = String(row.pet_class);

    return knownPets
      .filter(
        (known) =>
          known.petClass === petClass &&
          !petExclusion.get(petId, known.id)
      )
      .map((known) => ({
        petId: known.id,
        petName: known.name,
        similarity: cosineSimilarity(vector, known.vector)
      }))
      .filter((match) => Number.isFinite(match.similarity) && match.similarity >= 0.52)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 5);
  };

  const overrideByFrameDetection = new Map<string, any>();
  for (const row of videoFrameOverrides) {
    overrideByFrameDetection.set(
      [
        Number(row.timestamp_ms),
        String(row.identity_kind),
        Number(row.detection_index)
      ].join(":"),
      row
    );
  }

  const videoFrames = videoAnalysis
    ? jsonArray(videoAnalysis.frames_json)
        .map((rawFrame) => {
          if (!rawFrame || typeof rawFrame !== "object") return null;
          const frame = rawFrame as Record<string, unknown>;
          const timestampMs = Math.max(0, Math.trunc(Number(frame.timestampMs) || 0));
          const rawFrameIndex = frame.frameIndex;
          const frameIndex = rawFrameIndex !== null && rawFrameIndex !== undefined &&
            Number.isSafeInteger(Number(rawFrameIndex)) && Number(rawFrameIndex) >= 0
            ? Number(rawFrameIndex) : null;
          const frameHash = typeof frame.frameHash === "string" &&
            /^[0-9a-f]{32}$/i.test(frame.frameHash)
            ? frame.frameHash.toLowerCase() : null;
          const frameWidth = Math.max(1, Math.trunc(Number(frame.width) || Number(videoAnalysis.width) || 1));
          const frameHeight = Math.max(1, Math.trunc(Number(frame.height) || Number(videoAnalysis.height) || 1));
          const detections: Array<Record<string, unknown>> = [];

          const appendDetection = (
            kind: "person" | "pet",
            rawDetection: unknown,
            fallbackIndex: number
          ) => {
            if (!rawDetection || typeof rawDetection !== "object") return;
            const detection = rawDetection as Record<string, unknown>;
            const detectionIndex = Math.max(
              0,
              Math.trunc(Number(detection.detectionIndex) || fallbackIndex)
            );
            const override = overrideByFrameDetection.get(
              [timestampMs, kind, detectionIndex].join(":")
            );
            const suggestedId =
              detection.id === null || detection.id === undefined
                ? null
                : Number(detection.id);
            const suggestedName = detection.name ? String(detection.name) : null;
            const suggestedSimilarity =
              detection.similarity === null || detection.similarity === undefined
                ? null
                : Number(detection.similarity);

            detections.push({
              detectionIndex,
              kind,
              petClass:
                kind === "pet"
                  ? String(detection.petClass) === "cat" ? "cat" : "dog"
                  : null,
              score: Number(detection.score ?? 0),
              x: Number(detection.x ?? 0),
              y: Number(detection.y ?? 0),
              width: Number(detection.width ?? 0),
              height: Number(detection.height ?? 0),
              identityId: override ? Number(override.identity_id) : suggestedId,
              name: override
                ? override.identity_name === null ? null : String(override.identity_name)
                : suggestedName,
              similarity: override ? null : suggestedSimilarity,
              confirmed: Boolean(override)
            });
          };

          const persons = Array.isArray(frame.persons) ? frame.persons : [];
          persons.forEach((entry, index) => appendDetection("person", entry, index));
          const pets = Array.isArray(frame.pets) ? frame.pets : [];
          pets.forEach((entry, index) => appendDetection("pet", entry, index));

          return {
            timestampMs,
            frameIndex,
            frameHash: frameIndex === null ? null : frameHash,
            sceneChange: Boolean(frame.sceneChange),
            width: frameWidth,
            height: frameHeight,
            detections
          };
        })
        .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
        .filter((frame) => frame.detections.length > 0)
    : [];

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
    technicalProbe: (() => {
      const row = jobs.find((job) => String(job.module) === "file-probe-v1");
      return row ? jsonObject(row.result_json) : null;
    })(),
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
          : Number(row.candidate_similarity),
      suggestedPersons: suggestedPersonsFor(row)
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
          : Number(row.candidate_similarity),
      suggestedPets: suggestedPetsFor(row)
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
    })),
    videoAnalysis: videoAnalysis
      ? {
          durationMs: Number(videoAnalysis.duration_ms),
          width: Number(videoAnalysis.width),
          height: Number(videoAnalysis.height),
          fps: Number(videoAnalysis.fps),
          sampleIntervalMs: Number(videoAnalysis.sample_interval_ms),
          sampledFrames: Number(videoAnalysis.sampled_frames),
          sceneCount: Number(videoAnalysis.scene_count),
          tags: videoTags.map((row) => ({
            label: String(row.label),
            score: Number(row.score),
            hitCount: Number(row.hit_count)
          })),
          identityHits: videoIdentityHits.map((row) => ({
            kind: String(row.identity_kind) === "pet" ? "pet" : "person",
            identityId: row.identity_id === null ? null : Number(row.identity_id),
            name: row.identity_name === null ? null : String(row.identity_name),
            petClass: row.pet_class === "dog" || row.pet_class === "cat"
              ? String(row.pet_class)
              : null,
            startMs: Number(row.start_ms),
            endMs: Number(row.end_ms),
            hitCount: Number(row.hit_count),
            maxSimilarity: row.max_similarity === null ? null : Number(row.max_similarity)
          })),
          frames: videoFrames
        }
      : null,
    lifeAreas: lifeAreaStore.assignmentsForMedia(mediaId)
  };
}


function rebuildVideoIdentityTracks(mediaId: number) {
  const analysis = db.prepare(
    "SELECT duration_ms,sample_interval_ms,frames_json " +
    "FROM media_video_analysis WHERE media_id=?"
  ).get(mediaId);
  if (!analysis) return;

  let frames: any[] = [];
  try {
    const parsed = JSON.parse(String(analysis.frames_json ?? "[]"));
    frames = Array.isArray(parsed) ? parsed : [];
  } catch {
    frames = [];
  }

  const overrides = db.prepare(
    "SELECT timestamp_ms,identity_kind,detection_index,pet_class,identity_id " +
    "FROM video_frame_identity_overrides WHERE media_id=?"
  ).all(mediaId);
  const overrideMap = new Map<string, any>();
  for (const row of overrides) {
    overrideMap.set(
      [
        Number(row.timestamp_ms),
        String(row.identity_kind),
        Number(row.detection_index)
      ].join(":"),
      row
    );
  }

  type Track = {
    kind: "person" | "pet";
    identityId: number;
    petClass: string | null;
    startMs: number;
    endMs: number;
    hitCount: number;
    maxSimilarity: number;
    lastSeenMs: number;
  };

  const durationMs = Math.max(0, Number(analysis.duration_ms) || 0);
  const sampleIntervalMs = Math.max(250, Number(analysis.sample_interval_ms) || 1000);
  const allowedGap = Math.max(2500, sampleIntervalMs * 3);
  const active = new Map<string, Track>();
  const finished: Track[] = [];

  const touch = (
    kind: "person" | "pet",
    identityId: number,
    petClass: string | null,
    timestampMs: number,
    similarity: number
  ) => {
    const key = kind + ":" + identityId;
    const existing = active.get(key);
    if (existing && timestampMs - existing.lastSeenMs <= allowedGap) {
      existing.endMs = Math.min(durationMs, timestampMs + sampleIntervalMs);
      existing.hitCount += 1;
      existing.maxSimilarity = Math.max(existing.maxSimilarity, similarity);
      existing.lastSeenMs = timestampMs;
      return;
    }
    if (existing) finished.push(existing);
    active.set(key, {
      kind,
      identityId,
      petClass,
      startMs: timestampMs,
      endMs: Math.min(durationMs, timestampMs + sampleIntervalMs),
      hitCount: 1,
      maxSimilarity: similarity,
      lastSeenMs: timestampMs
    });
  };

  for (const rawFrame of frames) {
    if (!rawFrame || typeof rawFrame !== "object") continue;
    const frame = rawFrame as Record<string, unknown>;
    const timestampMs = Math.max(0, Math.trunc(Number(frame.timestampMs) || 0));

    const addDetections = (
      kind: "person" | "pet",
      rawDetections: unknown[]
    ) => {
      rawDetections.forEach((rawDetection, fallbackIndex) => {
        if (!rawDetection || typeof rawDetection !== "object") return;
        const detection = rawDetection as Record<string, unknown>;
        const detectionIndex = Math.max(
          0,
          Math.trunc(Number(detection.detectionIndex) || fallbackIndex)
        );
        const override = overrideMap.get(
          [timestampMs, kind, detectionIndex].join(":")
        );
        const identityId = override
          ? Number(override.identity_id)
          : detection.trackEligible && detection.id !== null && detection.id !== undefined
            ? Number(detection.id)
            : null;
        if (identityId === null || !Number.isFinite(identityId)) return;

        const similarity = override
          ? 1
          : Math.max(0, Number(detection.similarity) || 0);
        const petClass =
          kind === "pet"
            ? override?.pet_class
              ? String(override.pet_class)
              : String(detection.petClass) === "cat" ? "cat" : "dog"
            : null;
        touch(kind, identityId, petClass, timestampMs, similarity);
      });
    };

    addDetections(
      "person",
      Array.isArray(frame.persons) ? frame.persons : []
    );
    addDetections(
      "pet",
      Array.isArray(frame.pets) ? frame.pets : []
    );
  }

  finished.push(...active.values());

  db.prepare("DELETE FROM video_identity_tracks WHERE media_id=?").run(mediaId);
  const insertTrack = db.prepare(
    "INSERT INTO video_identity_tracks(" +
    "media_id,identity_kind,identity_id,pet_class,start_ms,end_ms,hit_count,max_similarity" +
    ") VALUES(?,?,?,?,?,?,?,?)"
  );
  for (const track of finished) {
    insertTrack.run(
      mediaId,
      track.kind,
      track.identityId,
      track.petClass,
      track.startMs,
      track.endMs,
      track.hitCount,
      track.maxSimilarity
    );
  }
}

function assignVideoFrameIdentityName(
  mediaId: number,
  timestampMs: number,
  rawKind: unknown,
  detectionIndex: number,
  rawPetClass: unknown,
  rawName: unknown
) {
  const kind = rawKind === "pet" ? "pet" : rawKind === "person" ? "person" : null;
  if (!kind) throw new Error("Ungültige Video-Identitätsart.");

  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("Bitte einen Namen eingeben.");
  if (name.length > 120) throw new Error("Der Name ist zu lang.");

  const normalizedTimestamp = Math.max(0, Math.trunc(Number(timestampMs) || 0));
  const normalizedIndex = Math.max(0, Math.trunc(Number(detectionIndex) || 0));
  const petClass = kind === "pet"
    ? String(rawPetClass) === "cat" ? "cat" : "dog"
    : null;

  const media = db.prepare(
    "SELECT m.id,m.sha256,va.frames_json " +
    "FROM media_items m " +
    "JOIN media_video_analysis va ON va.media_id=m.id AND va.input_sha256=m.sha256 " +
    "WHERE m.id=? AND m.availability='AVAILABLE'"
  ).get(mediaId);
  if (!media) throw new Error("Das Video oder seine Frameanalyse wurde nicht gefunden.");

  let frames: any[] = [];
  try {
    const parsed = JSON.parse(String(media.frames_json ?? "[]"));
    frames = Array.isArray(parsed) ? parsed : [];
  } catch {
    frames = [];
  }

  const frame = frames.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      Math.trunc(Number((entry as Record<string, unknown>).timestampMs) || 0) === normalizedTimestamp
  ) as Record<string, unknown> | undefined;
  const detections = frame
    ? kind === "person"
      ? Array.isArray(frame.persons) ? frame.persons : []
      : Array.isArray(frame.pets) ? frame.pets : []
    : [];
  const exists = detections.some((entry, fallbackIndex) => {
    if (!entry || typeof entry !== "object") return false;
    const detection = entry as Record<string, unknown>;
    const index = Math.max(
      0,
      Math.trunc(Number(detection.detectionIndex) || fallbackIndex)
    );
    return index === normalizedIndex;
  });
  if (!exists) throw new Error("Die ausgewählte Erkennung existiert in diesem Szenenbild nicht.");

  db.exec("BEGIN IMMEDIATE");
  try {
    let identityId: number;
    if (kind === "person") {
      const existing = db.prepare(
        "SELECT id FROM persons WHERE name=? COLLATE NOCASE ORDER BY id LIMIT 1"
      ).get(name);
      identityId = existing
        ? Number(existing.id)
        : Number(db.prepare("INSERT INTO persons(name) VALUES(?)").run(name).lastInsertRowid);
      db.prepare("UPDATE persons SET updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(identityId);
    } else {
      const existing = db.prepare(
        "SELECT id FROM pets WHERE name=? COLLATE NOCASE AND pet_class=? ORDER BY id LIMIT 1"
      ).get(name, petClass);
      identityId = existing
        ? Number(existing.id)
        : Number(
            db.prepare("INSERT INTO pets(name,pet_class) VALUES(?,?)")
              .run(name, petClass).lastInsertRowid
          );
      db.prepare("UPDATE pets SET updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(identityId);
    }

    db.prepare(
      "INSERT INTO video_frame_identity_overrides(" +
      "media_id,timestamp_ms,identity_kind,detection_index,pet_class,identity_id,updated_at" +
      ") VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) " +
      "ON CONFLICT(media_id,timestamp_ms,identity_kind,detection_index) DO UPDATE SET " +
      "pet_class=excluded.pet_class,identity_id=excluded.identity_id,updated_at=CURRENT_TIMESTAMP"
    ).run(
      mediaId,
      normalizedTimestamp,
      kind,
      normalizedIndex,
      petClass,
      identityId
    );

    rebuildVideoIdentityTracks(mediaId);
    db.exec("COMMIT");
    return {
      identityId,
      name,
      affected: 1,
      mediaId,
      timestampMs: normalizedTimestamp,
      kind,
      detectionIndex: normalizedIndex
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


function assignVideoFrameIdentityNames(
  mediaId: number,
  rawAssignments: unknown
) {
  const assignments = Array.isArray(rawAssignments) ? rawAssignments : [];
  if (assignments.length === 0) return { mediaId, affected: 0 };

  const media = db.prepare(
    "SELECT m.id,m.sha256,va.frames_json " +
    "FROM media_items m " +
    "JOIN media_video_analysis va ON va.media_id=m.id AND va.input_sha256=m.sha256 " +
    "WHERE m.id=? AND m.availability='AVAILABLE'"
  ).get(mediaId);
  if (!media) throw new Error("Das Video oder seine Frameanalyse wurde nicht gefunden.");

  let frames: any[] = [];
  try {
    const parsed = JSON.parse(String(media.frames_json ?? "[]"));
    frames = Array.isArray(parsed) ? parsed : [];
  } catch {
    frames = [];
  }

  const frameMap = new Map<number, Record<string, unknown>>();
  for (const entry of frames) {
    if (!entry || typeof entry !== "object") continue;
    const frame = entry as Record<string, unknown>;
    frameMap.set(
      Math.max(0, Math.trunc(Number(frame.timestampMs) || 0)),
      frame
    );
  }

  const findIdentity = db.prepare(
    "SELECT id FROM persons WHERE name=? COLLATE NOCASE ORDER BY id LIMIT 1"
  );
  const insertPerson = db.prepare("INSERT INTO persons(name) VALUES(?)");
  const touchPerson = db.prepare(
    "UPDATE persons SET updated_at=CURRENT_TIMESTAMP WHERE id=?"
  );
  const findPet = db.prepare(
    "SELECT id FROM pets WHERE name=? COLLATE NOCASE AND pet_class=? ORDER BY id LIMIT 1"
  );
  const insertPet = db.prepare(
    "INSERT INTO pets(name,pet_class) VALUES(?,?)"
  );
  const touchPet = db.prepare(
    "UPDATE pets SET updated_at=CURRENT_TIMESTAMP WHERE id=?"
  );
  const upsertOverride = db.prepare(
    "INSERT INTO video_frame_identity_overrides(" +
    "media_id,timestamp_ms,identity_kind,detection_index,pet_class,identity_id,updated_at" +
    ") VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) " +
    "ON CONFLICT(media_id,timestamp_ms,identity_kind,detection_index) DO UPDATE SET " +
    "pet_class=excluded.pet_class,identity_id=excluded.identity_id,updated_at=CURRENT_TIMESTAMP"
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    let affected = 0;

    for (const rawAssignment of assignments) {
      if (!rawAssignment || typeof rawAssignment !== "object") continue;
      const assignment = rawAssignment as Record<string, unknown>;
      const kind =
        assignment.kind === "pet"
          ? "pet"
          : assignment.kind === "person"
            ? "person"
            : null;
      if (!kind) continue;

      const name =
        typeof assignment.name === "string" ? assignment.name.trim() : "";
      if (!name || name.length > 120) continue;

      const timestampMs = Math.max(
        0,
        Math.trunc(Number(assignment.timestampMs) || 0)
      );
      const detectionIndex = Math.max(
        0,
        Math.trunc(Number(assignment.detectionIndex) || 0)
      );
      const petClass =
        kind === "pet"
          ? String(assignment.petClass) === "cat" ? "cat" : "dog"
          : null;

      const frame = frameMap.get(timestampMs);
      const detections = frame
        ? kind === "person"
          ? Array.isArray(frame.persons) ? frame.persons : []
          : Array.isArray(frame.pets) ? frame.pets : []
        : [];
      const exists = detections.some((entry, fallbackIndex) => {
        if (!entry || typeof entry !== "object") return false;
        const detection = entry as Record<string, unknown>;
        const index = Math.max(
          0,
          Math.trunc(Number(detection.detectionIndex) || fallbackIndex)
        );
        return index === detectionIndex;
      });
      if (!exists) continue;

      let identityId: number;
      if (kind === "person") {
        const existing = findIdentity.get(name);
        identityId = existing
          ? Number(existing.id)
          : Number(insertPerson.run(name).lastInsertRowid);
        touchPerson.run(identityId);
      } else {
        const existing = findPet.get(name, petClass);
        identityId = existing
          ? Number(existing.id)
          : Number(insertPet.run(name, petClass).lastInsertRowid);
        touchPet.run(identityId);
      }

      upsertOverride.run(
        mediaId,
        timestampMs,
        kind,
        detectionIndex,
        petClass,
        identityId
      );
      affected += 1;
    }

    if (affected > 0) rebuildVideoIdentityTracks(mediaId);
    db.exec("COMMIT");
    return { mediaId, affected };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reanalyzeMedia(mediaId: number) {
  const media = db.prepare(`
    SELECT id, source_id, sha256, availability, extension
    FROM media_items
    WHERE id=?
  `).get(mediaId);

  if (!media) {
    throw new Error("Medium wurde nicht gefunden.");
  }
  if (String(media.availability) !== "AVAILABLE") {
    throw new Error("Nur verfügbare Medien können neu analysiert werden.");
  }

  const sourceId = Number(media.source_id);
  const sha256 = String(media.sha256);
  const videoExtension = VIDEO_EXTENSIONS.has(String(media.extension).toLowerCase());
  const modules = [
    "file-probe-v1",
    "thumbnail-v1",
    "video-analyze-v1",
    "image-metadata-v1",
    "face-detect-yunet-v1",
    "face-embed-sface-v1",
    "pet-detect-nanodet-v1",
    "pet-detect-yolox-v1",
    "pet-fuse-ensemble-v1",
    "pet-embed-dogreid-v1",
    "semantic-embed-siglip2-v1",
    "catalog-semantic-qwen3vl4b-v3"
  ];

  let cleared = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleteFrom = (table: string) => {
      const result = db.prepare(`DELETE FROM ${table} WHERE media_id=?`).run(mediaId);
      cleared += Number(result.changes);
    };

    // Manuelle Lebensbereiche bleiben erhalten. Regelbasierte Zuordnungen
    // hängen dagegen von den alten Erkennungen ab und werden später aus den
    // neuen Analyseergebnissen automatisch wieder aufgebaut.
    cleared += Number(db.prepare(`
      DELETE FROM media_life_areas
      WHERE media_id=?
        AND assignment_source='RULE'
    `).run(mediaId).changes);

    // Alle automatisch aus der Datei gewonnenen Ergebnisse vollständig entfernen.
    for (const table of [
      "media_thumbnails",
      "media_image_metadata",
      "semantic_embeddings",
      "media_semantic_annotations",
      "media_video_analysis",
      "video_identity_tracks",
      "video_frame_identity_overrides",
      "video_tags",
      "object_detections",
      "object_fused_detections",
      "pet_detections",
      "pet_fused_detections",
      "face_detections"
    ]) {
      deleteFrom(table);
    }

    // Videos haben keine normalen face_detections/pet_fused_detections
    // Zuordnungen. Teure globale Kandidatenbereinigung und Gruppen-Refresh
    // sind nur für Bilder notwendig. So blockiert ein Video-Reset nicht die
    // gesamte Personen-/Haustiergruppierung.
    if (!videoExtension) {
      db.prepare(`
        DELETE FROM person_candidates
        WHERE NOT EXISTS (
          SELECT 1 FROM person_candidate_faces pcf
          WHERE pcf.candidate_id=person_candidates.id
        )
      `).run();
      db.prepare(`
        DELETE FROM pet_candidates
        WHERE NOT EXISTS (
          SELECT 1 FROM pet_candidate_items pci
          WHERE pci.candidate_id=pet_candidates.id
        )
      `).run();
      db.prepare("DELETE FROM person_cluster_runs WHERE source_id=?").run(sourceId);
      db.prepare("DELETE FROM pet_cluster_runs WHERE source_id=?").run(sourceId);
    }

    db.prepare("DELETE FROM analysis_jobs WHERE media_id=?").run(mediaId);

    const insert = db.prepare(`
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
      VALUES(?,?,'PENDING',0,0,NULL,?,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `);

    for (const module of modules) {
      insert.run(mediaId, module, sha256);
    }

    db.exec("COMMIT");
    return { mediaId, sourceId, requeued: modules.length, cleared };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

function prepareForShutdown() {
  if (scanRunning) {
    return {
      ready: false,
      requeued: 0,
      reason: "SCAN_RUNNING"
    };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      UPDATE analysis_jobs
      SET
        status='PENDING',
        started_at=NULL,
        error_message=NULL,
        updated_at=CURRENT_TIMESTAMP
      WHERE status='RUNNING'
    `).run();

    db.exec("COMMIT");

    // Alle bis hierhin bestätigten SQLite-Änderungen auch aus dem WAL in die
    // Datenbankdatei überführen, bevor der Katalogprozess beendet wird.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

    return {
      ready: true,
      requeued: Number(result.changes),
      reason: null
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function resetCatalog(): { reset: true } {
  if (scanRunning) {
    throw new Error("Während eines laufenden Scans kann der Katalog nicht zurückgesetzt werden.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    lifeAreaStore.reset();

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
      DELETE FROM ignored_person_matches;
      DELETE FROM ignored_person_references;
      DELETE FROM ignored_person_identities;
      DELETE FROM persons;

      DELETE FROM pet_candidate_items;
      DELETE FROM pet_candidates;
      DELETE FROM pet_cluster_runs;
      DELETE FROM pet_cluster_exclusions;
      DELETE FROM pet_assignment_exclusions;
      DELETE FROM pet_assignments;
      DELETE FROM ignored_pet_matches;
      DELETE FROM ignored_pet_references;
      DELETE FROM ignored_pet_identities;
      DELETE FROM pets;
      DELETE FROM pet_embeddings;
      DELETE FROM pet_fused_detections;
      DELETE FROM pet_detections;

      DELETE FROM object_fused_detections;
      DELETE FROM object_detections;
      DELETE FROM video_identity_tracks;
      DELETE FROM video_tags;
      DELETE FROM media_video_analysis;
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
    const resetTables = [
      "analysis_jobs",
      "person_candidate_faces",
      "person_candidates",
      "person_cluster_runs",
      "person_cluster_exclusions",
      "person_face_exclusions",
      "person_face_assignments",
      "ignored_person_matches",
      "ignored_person_references",
      "ignored_person_identities",
      "persons",
      "pet_candidate_items",
      "pet_candidates",
      "pet_cluster_runs",
      "pet_cluster_exclusions",
      "pet_assignment_exclusions",
      "pet_assignments",
      "ignored_pet_matches",
      "ignored_pet_references",
      "ignored_pet_identities",
      "pets",
      "pet_embeddings",
      "pet_fused_detections",
      "pet_detections",
      "object_fused_detections",
      "object_detections",
      "video_identity_tracks",
      "video_tags",
      "media_video_analysis",
      "media_semantic_annotations",
      "semantic_embeddings",
      "face_embeddings",
      "face_detections",
      "media_image_metadata",
      "media_thumbnails",
      "media_items",
      "media_directories",
      "scans",
      "media_sources"
    ];

    const leftovers = resetTables
      .map((table) => ({
        table,
        count: Number(
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0
        )
      }))
      .filter((entry) => entry.count !== 0);

    if (leftovers.length > 0) {
      throw new Error(
        "Datenbank-Reset unvollständig: " +
        leftovers.map((entry) => entry.table + "=" + entry.count).join(", ")
      );
    }

    const foreignKeyIssues = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyIssues.length > 0) {
      throw new Error(
        "Datenbank-Reset hat Inkonsistenzen in Fremdschlüsseln hinterlassen."
      );
    }

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
    case "disableSource":
      return disableSource(asNumber(payload.sourceId, "sourceId"));
    case "getStats":
      return getStats(asNumber(payload.sourceId, "sourceId"));
    case "getIdentityCandidateSummaryStats":
      return getIdentityCandidateSummaryStats(
        asNumber(payload.sourceId, "sourceId")
      );
    case "getRemoteSummary":
      return getRemoteSummary();
    case "listMedia":
      return listMedia(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 500 : asNumber(payload.limit, "limit"),
        undefined,
        undefined,
        payload.mediaKind === "image" || payload.mediaKind === "video"
          ? payload.mediaKind
          : "all"
      );
    case "listGeoMedia":
      return listGeoMedia(
        payload.sourceId === undefined
          ? undefined
          : asNumber(payload.sourceId, "sourceId")
      );
    case "listLifeAreas":
      return lifeAreaStore.list();
    case "createLifeArea":
      return lifeAreaStore.create(payload.name);
    case "renameLifeArea":
      return lifeAreaStore.rename(
        asNumber(payload.lifeAreaId, "lifeAreaId"),
        payload.name
      );
    case "deleteLifeArea":
      return lifeAreaStore.remove(
        asNumber(payload.lifeAreaId, "lifeAreaId")
      );
    case "addLifeAreaRule":
      return lifeAreaStore.addRule(
        asNumber(payload.lifeAreaId, "lifeAreaId"),
        payload.conditionType,
        payload.conditionValue,
        payload.dateFrom,
        payload.dateTo,
        payload.groupId
      );
    case "deleteLifeAreaRule":
      return lifeAreaStore.deleteRule(
        asNumber(payload.ruleId, "ruleId")
      );
    case "setLifeAreaRuleEnabled":
      return lifeAreaStore.setRuleEnabled(
        asNumber(payload.ruleId, "ruleId"),
        payload.enabled
      );
    case "applyLifeAreaRules":
      return lifeAreaStore.applyRules(
        payload.lifeAreaId === undefined
          ? undefined
          : asNumber(payload.lifeAreaId, "lifeAreaId")
      );
    case "listLifeAreaMedia":
      return lifeAreaStore.listMedia(
        asNumber(payload.lifeAreaId, "lifeAreaId")
      );
    case "setMediaLifeArea":
      return lifeAreaStore.setMedia(
        asNumber(payload.mediaId, "mediaId"),
        asNumber(payload.lifeAreaId, "lifeAreaId"),
        payload.assigned
      );
    case "getSearchFacets":
      return getSearchFacets(
        payload.sourceId === undefined
          ? undefined
          : asNumber(payload.sourceId, "sourceId")
      );
    case "searchMedia":
      return listMedia(
        payload.sourceId === undefined
          ? undefined
          : asNumber(payload.sourceId, "sourceId"),
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
    case "getPipelineQueueStats":
      return getPipelineQueueStats();
    case "getAnalysisHistory":
      return getAnalysisHistory(
        payload.days === undefined ? 30 : asNumber(payload.days, "days")
      );
    case "getPetDetectionQueueStats":
      return getPetDetectionQueueStats(
        payload.sourceId === undefined ? undefined : asNumber(payload.sourceId, "sourceId")
      );
    case "getIdentityEmbeddingCounts":
      return getIdentityEmbeddingCounts();
    case "listAnalysisErrors":
      return listAnalysisErrors(
        payload.sourceId === undefined ? undefined : asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 200 : asNumber(payload.limit, "limit")
      );
    case "countAnalysisErrors":
      return countAnalysisErrors(
        payload.sourceId === undefined ? undefined : asNumber(payload.sourceId, "sourceId")
      );
    case "retryAnalysisJob":
      return retryAnalysisJob(asNumber(payload.jobId, "jobId"));
    case "retryFailedAnalysisJobs":
      return retryFailedAnalysisJobs(
        payload.sourceId === undefined ? undefined : asNumber(payload.sourceId, "sourceId")
      );
    case "claimAnalysisJob":
      return claimAnalysisJob(
        typeof payload.module === "string" ? payload.module : "file-probe-v1",
        payload.mediaId === undefined
          ? undefined
          : asNumber(payload.mediaId, "mediaId")
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
    case "completeVideoAnalysisJob":
      return completeVideoAnalysisJob(
        asNumber(payload.jobId, "jobId"),
        payload.result
      );
    case "getPetEmbeddingsForClustering":
      return getPetEmbeddingsForClustering(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.algorithmVersion === "string"
          ? payload.algorithmVersion
          : "dogreid-complete-link-v4-ignore",
        payload.ignoreDefiniteThreshold === undefined
          ? 0.68
          : Number(payload.ignoreDefiniteThreshold),
        payload.ignoreDoubtThreshold === undefined
          ? 0.60
          : Number(payload.ignoreDoubtThreshold)
      );
    case "replacePetCandidates":
      return replacePetCandidates(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.revision === "string" ? payload.revision : "",
        typeof payload.algorithmVersion === "string"
          ? payload.algorithmVersion
          : "dogreid-complete-link-v4-ignore",
        payload.clusters
      );
    case "autoAssignKnownPetCandidates":
      return autoAssignKnownPetCandidates(
        asNumber(payload.sourceId, "sourceId")
      );
    case "listUngroupedPetDetections":
      return listUngroupedPetDetections(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 1000 : asNumber(payload.limit, "limit")
      );
    case "rejectPetDetectionSuggestion":
      return rejectPetDetectionSuggestion(
        asNumber(payload.petDetectionId, "petDetectionId"),
        asNumber(payload.petId, "petId")
      );
    case "listPetCandidates":
      return listPetCandidates(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 100 : asNumber(payload.limit, "limit"),
        payload.ignoreDefiniteThreshold === undefined
          ? 0.68
          : Number(payload.ignoreDefiniteThreshold),
        payload.ignoreDoubtThreshold === undefined
          ? 0.60
          : Number(payload.ignoreDoubtThreshold),
        payload.summaryOnly === true
      );
    case "listPetCandidateItems":
      return listPetCandidateItems(
        asNumber(payload.candidateId, "candidateId"),
        payload.limit === undefined ? 5000 : asNumber(payload.limit, "limit"),
        payload.offset === undefined ? 0 : asNumber(payload.offset, "offset")
      );
    case "listPets":
      return listPets(asNumber(payload.sourceId, "sourceId"));
    case "confirmPetCandidate":
      return confirmPetCandidate(
        asNumber(payload.candidateId, "candidateId"),
        payload.name,
        payload.rejectedPetId === undefined
          ? undefined
          : asNumber(payload.rejectedPetId, "rejectedPetId"),
        payload.fallbackPetDetectionId === undefined
          ? undefined
          : asNumber(payload.fallbackPetDetectionId, "fallbackPetDetectionId"),
        payload.expectedDetectionCount === undefined
          ? undefined
          : asNumber(payload.expectedDetectionCount, "expectedDetectionCount"),
        typeof payload.expectedMemberSignature === "string"
          ? payload.expectedMemberSignature
          : undefined
      );
    case "ignorePetCandidate":
      return ignorePetCandidate(
        asNumber(payload.candidateId, "candidateId"),
        payload.fallbackPetDetectionId === undefined
          ? undefined
          : asNumber(payload.fallbackPetDetectionId, "fallbackPetDetectionId"),
        payload.expectedDetectionCount === undefined
          ? undefined
          : asNumber(payload.expectedDetectionCount, "expectedDetectionCount"),
        typeof payload.expectedMemberSignature === "string"
          ? payload.expectedMemberSignature
          : undefined,
        payload.ignoredIdentityId === undefined
          ? undefined
          : asNumber(payload.ignoredIdentityId, "ignoredIdentityId")
      );
    case "removePetFromCandidate":
      return removePetFromCandidate(
        asNumber(payload.candidateId, "candidateId"),
        asNumber(payload.petDetectionId, "petDetectionId")
      );
    case "splitPetCandidate":
      return splitPetCandidate(
        asNumber(payload.candidateId, "candidateId"),
        payload.petDetectionIds
      );
    case "assignPetCandidateSelection":
      return assignPetCandidateSelection(
        asNumber(payload.candidateId, "candidateId"),
        payload.petDetectionIds,
        payload.name
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
    case "assignPetDetectionName":
      return assignPetDetectionName(
        asNumber(payload.petDetectionId, "petDetectionId"),
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
          : "person-complete-link-v6-ignore",
        payload.ignoreDefiniteThreshold === undefined
          ? 0.62
          : Number(payload.ignoreDefiniteThreshold),
        payload.ignoreDoubtThreshold === undefined
          ? 0.55
          : Number(payload.ignoreDoubtThreshold)
      );
    case "replacePersonCandidates":
      return replacePersonCandidates(
        asNumber(payload.sourceId, "sourceId"),
        typeof payload.revision === "string" ? payload.revision : "",
        typeof payload.algorithmVersion === "string"
          ? payload.algorithmVersion
          : "person-complete-link-v6-ignore",
        payload.clusters
      );
    case "listUngroupedPersonDetections":
      return listUngroupedPersonDetections(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 1000 : asNumber(payload.limit, "limit")
      );
    case "rejectPersonDetectionSuggestion":
      return rejectPersonDetectionSuggestion(
        asNumber(payload.faceDetectionId, "faceDetectionId"),
        asNumber(payload.personId, "personId")
      );
    case "listPersonCandidates":
      return listPersonCandidates(
        asNumber(payload.sourceId, "sourceId"),
        payload.limit === undefined ? 100 : asNumber(payload.limit, "limit"),
        payload.ignoreDefiniteThreshold === undefined
          ? 0.62
          : Number(payload.ignoreDefiniteThreshold),
        payload.ignoreDoubtThreshold === undefined
          ? 0.55
          : Number(payload.ignoreDoubtThreshold),
        payload.summaryOnly === true
      );
    case "listPersonCandidateItems":
      return listPersonCandidateItems(
        asNumber(payload.candidateId, "candidateId"),
        payload.limit === undefined ? 5000 : asNumber(payload.limit, "limit"),
        payload.offset === undefined ? 0 : asNumber(payload.offset, "offset")
      );
    case "listPersons":
      return listPersons(asNumber(payload.sourceId, "sourceId"));
    case "assignPersonCandidateSelection":
      return assignPersonCandidateSelection(
        asNumber(payload.candidateId, "candidateId"),
        payload.faceDetectionIds,
        payload.name
      );
    case "confirmPersonCandidate":
      return confirmPersonCandidate(
        asNumber(payload.candidateId, "candidateId"),
        payload.name,
        payload.fallbackFaceDetectionId === undefined
          ? undefined
          : asNumber(payload.fallbackFaceDetectionId, "fallbackFaceDetectionId"),
        payload.expectedFaceCount === undefined
          ? undefined
          : asNumber(payload.expectedFaceCount, "expectedFaceCount"),
        typeof payload.expectedMemberSignature === "string"
          ? payload.expectedMemberSignature
          : undefined
      );
    case "ignorePersonCandidate":
      return ignorePersonCandidate(
        asNumber(payload.candidateId, "candidateId"),
        payload.fallbackFaceDetectionId === undefined
          ? undefined
          : asNumber(payload.fallbackFaceDetectionId, "fallbackFaceDetectionId"),
        payload.expectedFaceCount === undefined
          ? undefined
          : asNumber(payload.expectedFaceCount, "expectedFaceCount"),
        typeof payload.expectedMemberSignature === "string"
          ? payload.expectedMemberSignature
          : undefined,
        payload.ignoredIdentityId === undefined
          ? undefined
          : asNumber(payload.ignoredIdentityId, "ignoredIdentityId")
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
    case "assignFaceDetectionName":
      return assignFaceDetectionName(
        asNumber(payload.faceDetectionId, "faceDetectionId"),
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
    case "assignVideoFrameIdentityName":
      return assignVideoFrameIdentityName(
        asNumber(payload.mediaId, "mediaId"),
        asNumber(payload.timestampMs, "timestampMs"),
        payload.kind,
        asNumber(payload.detectionIndex, "detectionIndex"),
        payload.petClass,
        payload.name
      );
    case "assignVideoFrameIdentityNames":
      return assignVideoFrameIdentityNames(
        asNumber(payload.mediaId, "mediaId"),
        payload.assignments
      );
    case "reanalyzeMedia":
      return reanalyzeMedia(asNumber(payload.mediaId, "mediaId"));
    case "getMediaPath":
      return getMediaPath(asNumber(payload.mediaId, "mediaId"));
    case "scanSource":
      return scanSource(asNumber(payload.sourceId, "sourceId"));
    case "setProcessingPaused":
      return setProcessingPaused(payload.paused === true);
    case "reconcileSourceChanges":
      return reconcileSourceChanges(
        asNumber(payload.sourceId, "sourceId"),
        payload.paths
      );
    case "restoreMedia":
      return restoreMedia(asNumber(payload.mediaId, "mediaId"));
    case "prepareForShutdown":
      return prepareForShutdown();
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
