from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from image_sortierer.db.catalog_repository import CatalogRepository
from image_sortierer.services.scanner import MediaScanner


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.repo = CatalogRepository(self.root / "catalog.sqlite3")
        self.source = self.repo.add_source(self.media)
        self.scanner = MediaScanner(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_new_unchanged_changed_and_missing(self):
        image = self.media / "urlaub" / "bild.jpg"
        image.parent.mkdir()
        image.write_bytes(b"first")

        first = self.scanner.scan_source(self.source.id)
        self.assertEqual((first.discovered, first.new, first.changed, first.missing), (1, 1, 0, 0))

        second = self.scanner.scan_source(self.source.id)
        self.assertEqual((second.new, second.changed, second.unchanged, second.missing), (0, 0, 1, 0))

        time.sleep(0.01)
        image.write_bytes(b"second-content")
        third = self.scanner.scan_source(self.source.id)
        self.assertEqual((third.new, third.changed, third.missing), (0, 1, 0))

        image.unlink()
        fourth = self.scanner.scan_source(self.source.id)
        self.assertEqual(fourth.missing, 1)
        self.assertEqual(self.repo.stats(self.source.id)["missing"], 1)

    def test_non_images_are_ignored(self):
        (self.media / "note.txt").write_text("ignore me", encoding="utf-8")
        result = self.scanner.scan_source(self.source.id)
        self.assertEqual(result.discovered, 0)
        self.assertEqual(self.repo.stats(self.source.id)["total"], 0)


if __name__ == "__main__":
    unittest.main()
