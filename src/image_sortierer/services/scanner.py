from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Callable

from image_sortierer.db.catalog_repository import CatalogRepository
from image_sortierer.domain.models import ScanResult
from image_sortierer.services.hash_service import sha256_file
from image_sortierer.services.image_metadata import image_dimensions

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".avif"}

ProgressCallback = Callable[[str], None]


class MediaScanner:
    def __init__(self, repository: CatalogRepository):
        self.repository = repository

    def scan_source(self, source_id: int, progress: ProgressCallback | None = None) -> ScanResult:
        source = self.repository.get_source(source_id)
        root = source.path
        if not root.exists():
            raise FileNotFoundError(f"Quelle ist nicht erreichbar: {root}")

        scan_id = self.repository.begin_scan(source_id)
        token = uuid.uuid4().hex
        index = self.repository.media_index(source_id)
        discovered = new = changed = unchanged = errors = 0

        def report(message: str) -> None:
            if progress:
                progress(message)

        try:
            for dirpath, _, filenames in os.walk(root, onerror=lambda e: report(f"Übersprungen: {e}")):
                for filename in filenames:
                    path = Path(dirpath) / filename
                    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                        continue
                    discovered += 1
                    try:
                        stat = path.stat()
                        relative = path.relative_to(root).as_posix()
                        absolute = str(path.resolve())
                        previous = index.get(relative)
                        if previous and int(previous["size_bytes"]) == stat.st_size and int(previous["mtime_ns"]) == stat.st_mtime_ns:
                            self.repository.touch_unchanged(int(previous["id"]), absolute, token)
                            unchanged += 1
                            continue

                        file_hash = sha256_file(path)
                        if previous and previous["sha256"] == file_hash:
                            self.repository.update_stat_only(int(previous["id"]), absolute, stat.st_size, stat.st_mtime_ns, token)
                            unchanged += 1
                            continue

                        width, height = image_dimensions(path)
                        is_changed = previous is not None
                        self.repository.upsert_media(
                            source_id=source_id,
                            relative_path=relative,
                            absolute_path=absolute,
                            extension=path.suffix.lower(),
                            size_bytes=stat.st_size,
                            mtime_ns=stat.st_mtime_ns,
                            sha256=file_hash,
                            width=width,
                            height=height,
                            scan_token=token,
                            changed=is_changed,
                        )
                        if is_changed:
                            changed += 1
                        else:
                            new += 1
                        if discovered % 100 == 0:
                            report(f"{discovered} Bilder gefunden …")
                    except (OSError, PermissionError) as exc:
                        errors += 1
                        report(f"Datei übersprungen: {path} – {exc}")

            missing = self.repository.mark_missing(source_id, token)
            result = ScanResult(discovered, new, changed, unchanged, missing, errors)
            self.repository.finish_scan(scan_id, result)
            report(f"Fertig: {discovered} gefunden, {new} neu, {changed} geändert, {missing} fehlen")
            return result
        except Exception as exc:
            result = ScanResult(discovered, new, changed, unchanged, 0, errors + 1)
            self.repository.finish_scan(scan_id, result, str(exc))
            raise
