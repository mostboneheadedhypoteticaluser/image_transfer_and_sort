from __future__ import annotations

import sys

from image_sortierer.config import database_path
from image_sortierer.db.catalog_repository import CatalogRepository


def main() -> int:
    from PySide6.QtWidgets import QApplication
    from image_sortierer.ui.main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("Image Sortierer")
    repository = CatalogRepository(database_path())
    window = MainWindow(repository)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
