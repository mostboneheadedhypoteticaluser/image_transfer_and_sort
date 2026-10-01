from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any

from image_sortierer.db.schema import connect, initialize
from image_sortierer.domain.models import MediaSource, ScanResult


class CatalogRepository:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        initialize(self.db_path)

    @staticmethod
    def _canonical(path: Path) -> str:
        return str(Path(path).expanduser().resolve())

    def add_source(self, path: Path) -> MediaSource:
        canonical = self._canonical(path)
        with connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO media_sources(path, enabled) VALUES(?,1) "
                "ON CONFLICT(path) DO UPDATE SET enabled=1, updated_at=CURRENT_TIMESTAMP",
                (canonical,),
            )
            row = conn.execute("SELECT id,path,enabled FROM media_sources WHERE path=?", (canonical,)).fetchone()
        return MediaSource(int(row["id"]), Path(row["path"]), bool(row["enabled"]))

    def list_sources(self) -> list[MediaSource]:
        with connect(self.db_path) as conn:
            rows = conn.execute("SELECT id,path,enabled FROM media_sources ORDER BY id").fetchall()
        return [MediaSource(int(r["id"]), Path(r["path"]), bool(r["enabled"])) for r in rows]

    def get_source(self, source_id: int) -> MediaSource:
        with connect(self.db_path) as conn:
            row = conn.execute("SELECT id,path,enabled FROM media_sources WHERE id=?", (source_id,)).fetchone()
        if row is None:
            raise KeyError(f"Quelle {source_id} existiert nicht")
        return MediaSource(int(row["id"]), Path(row["path"]), bool(row["enabled"]))

    def begin_scan(self, source_id: int) -> int:
        with connect(self.db_path) as conn:
            cur = conn.execute("INSERT INTO scans(source_id) VALUES(?)", (source_id,))
            return int(cur.lastrowid)

    def finish_scan(self, scan_id: int, result: ScanResult, error_message: str | None = None) -> None:
        with connect(self.db_path) as conn:
            conn.execute(
                """UPDATE scans SET finished_at=CURRENT_TIMESTAMP, status=?, discovered_count=?, new_count=?,
                   changed_count=?, unchanged_count=?, missing_count=?, error_count=?, error_message=? WHERE id=?""",
                ("FAILED" if error_message else "DONE", result.discovered, result.new, result.changed,
                 result.unchanged, result.missing, result.errors, error_message, scan_id),
            )

    def media_index(self, source_id: int) -> dict[str, dict[str, Any]]:
        with connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id,relative_path,size_bytes,mtime_ns,sha256,availability FROM media_items WHERE source_id=?",
                (source_id,),
            ).fetchall()
        return {r["relative_path"]: dict(r) for r in rows}

    def touch_unchanged(self, media_id: int, absolute_path: str, scan_token: str) -> None:
        with connect(self.db_path) as conn:
            conn.execute(
                "UPDATE media_items SET absolute_path=?, availability='AVAILABLE', scan_token=?, last_seen_at=CURRENT_TIMESTAMP WHERE id=?",
                (absolute_path, scan_token, media_id),
            )

    def update_stat_only(self, media_id: int, absolute_path: str, size_bytes: int, mtime_ns: int, scan_token: str) -> None:
        with connect(self.db_path) as conn:
            conn.execute(
                """UPDATE media_items SET absolute_path=?, size_bytes=?, mtime_ns=?, availability='AVAILABLE',
                   scan_token=?, last_seen_at=CURRENT_TIMESTAMP WHERE id=?""",
                (absolute_path, size_bytes, mtime_ns, scan_token, media_id),
            )

    def upsert_media(self, *, source_id: int, relative_path: str, absolute_path: str, extension: str,
                     size_bytes: int, mtime_ns: int, sha256: str, width: int | None, height: int | None,
                     scan_token: str, changed: bool) -> None:
        with connect(self.db_path) as conn:
            conn.execute(
                """INSERT INTO media_items(source_id,relative_path,absolute_path,extension,size_bytes,mtime_ns,sha256,width,height,availability,scan_token)
                   VALUES(?,?,?,?,?,?,?,?,?,'AVAILABLE',?)
                   ON CONFLICT(source_id,relative_path) DO UPDATE SET
                     absolute_path=excluded.absolute_path,
                     extension=excluded.extension,
                     size_bytes=excluded.size_bytes,
                     mtime_ns=excluded.mtime_ns,
                     sha256=excluded.sha256,
                     width=excluded.width,
                     height=excluded.height,
                     availability='AVAILABLE',
                     scan_token=excluded.scan_token,
                     last_seen_at=CURRENT_TIMESTAMP,
                     last_changed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE media_items.last_changed_at END""",
                (source_id, relative_path, absolute_path, extension, size_bytes, mtime_ns, sha256, width, height,
                 scan_token, 1 if changed else 0),
            )

    def mark_missing(self, source_id: int, scan_token: str) -> int:
        with connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id FROM media_items WHERE source_id=? AND scan_token<>? AND availability='AVAILABLE'",
                (source_id, scan_token),
            ).fetchall()
            ids = [int(r["id"]) for r in rows]
            if ids:
                conn.executemany("UPDATE media_items SET availability='MISSING' WHERE id=?", [(x,) for x in ids])
            return len(ids)

    def stats(self, source_id: int) -> dict[str, int]:
        with connect(self.db_path) as conn:
            row = conn.execute(
                """SELECT COUNT(*) total,
                   SUM(CASE WHEN availability='AVAILABLE' THEN 1 ELSE 0 END) available,
                   SUM(CASE WHEN availability='MISSING' THEN 1 ELSE 0 END) missing
                   FROM media_items WHERE source_id=?""",
                (source_id,),
            ).fetchone()
        return {"total": int(row["total"] or 0), "available": int(row["available"] or 0), "missing": int(row["missing"] or 0)}

    def latest_scan(self, source_id: int) -> dict[str, Any] | None:
        with connect(self.db_path) as conn:
            row = conn.execute(
                """SELECT finished_at,status,discovered_count,new_count,changed_count,missing_count,error_count
                   FROM scans WHERE source_id=? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1""",
                (source_id,),
            ).fetchone()
        return dict(row) if row else None

    def list_media(self, source_id: int, limit: int = 5000) -> list[dict[str, Any]]:
        with connect(self.db_path) as conn:
            rows = conn.execute(
                """SELECT relative_path,extension,size_bytes,width,height,availability,last_seen_at
                   FROM media_items WHERE source_id=? ORDER BY relative_path COLLATE NOCASE LIMIT ?""",
                (source_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]
