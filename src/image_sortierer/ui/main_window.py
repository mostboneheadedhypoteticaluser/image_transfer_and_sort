from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QObject, QThread, Signal, Slot
from PySide6.QtWidgets import (
    QAbstractItemView, QFileDialog, QGridLayout, QHBoxLayout, QLabel, QMainWindow,
    QMessageBox, QPushButton, QComboBox, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget
)

from image_sortierer.db.catalog_repository import CatalogRepository
from image_sortierer.services.scanner import MediaScanner


class ScanWorker(QObject):
    progress = Signal(str)
    finished = Signal(object)
    failed = Signal(str)

    def __init__(self, scanner: MediaScanner, source_id: int):
        super().__init__()
        self.scanner = scanner
        self.source_id = source_id

    @Slot()
    def run(self) -> None:
        try:
            result = self.scanner.scan_source(self.source_id, self.progress.emit)
            self.finished.emit(result)
        except Exception as exc:
            self.failed.emit(str(exc))


class MainWindow(QMainWindow):
    def __init__(self, repository: CatalogRepository):
        super().__init__()
        self.repository = repository
        self.scanner = MediaScanner(repository)
        self._thread: QThread | None = None
        self._worker: ScanWorker | None = None
        self.setWindowTitle("Image Sortierer")
        self.resize(1180, 760)
        self._build_ui()
        self._reload_sources()

    def _build_ui(self) -> None:
        root = QWidget()
        outer = QVBoxLayout(root)
        outer.setContentsMargins(18, 18, 18, 18)
        outer.setSpacing(14)

        title = QLabel("Bildkatalog")
        title.setStyleSheet("font-size: 24px; font-weight: 700;")
        subtitle = QLabel("Lokale Quellen katalogisieren. KI-Analyse ist in diesem ersten Modul bewusst noch nicht aktiv.")
        subtitle.setStyleSheet("color: #666;")
        outer.addWidget(title)
        outer.addWidget(subtitle)

        controls = QHBoxLayout()
        self.source_combo = QComboBox()
        self.source_combo.currentIndexChanged.connect(self._source_changed)
        self.add_button = QPushButton("Quelle hinzufügen")
        self.add_button.clicked.connect(self._add_source)
        self.scan_button = QPushButton("Jetzt scannen")
        self.scan_button.clicked.connect(self._start_scan)
        controls.addWidget(QLabel("Medienquelle:"))
        controls.addWidget(self.source_combo, 1)
        controls.addWidget(self.add_button)
        controls.addWidget(self.scan_button)
        outer.addLayout(controls)

        stats = QGridLayout()
        self.total_value = self._stat_card(stats, 0, "Katalogisiert")
        self.available_value = self._stat_card(stats, 1, "Verfügbar")
        self.missing_value = self._stat_card(stats, 2, "Fehlend")
        self.last_scan_value = self._stat_card(stats, 3, "Letzter Scan")
        outer.addLayout(stats)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["Pfad", "Typ", "Größe", "Auflösung", "Status"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setColumnWidth(0, 620)
        outer.addWidget(self.table, 1)

        self.status_label = QLabel("Bereit")
        self.status_label.setStyleSheet("color: #666;")
        outer.addWidget(self.status_label)
        self.setCentralWidget(root)

    def _stat_card(self, layout: QGridLayout, column: int, caption: str) -> QLabel:
        box = QWidget()
        box.setStyleSheet("QWidget { background: #f5f5f5; border-radius: 8px; } QLabel { background: transparent; }")
        v = QVBoxLayout(box)
        value = QLabel("—")
        value.setStyleSheet("font-size: 22px; font-weight: 700;")
        cap = QLabel(caption)
        cap.setStyleSheet("color: #666;")
        v.addWidget(value)
        v.addWidget(cap)
        layout.addWidget(box, 0, column)
        return value

    def _reload_sources(self) -> None:
        current_id = self.source_combo.currentData()
        self.source_combo.blockSignals(True)
        self.source_combo.clear()
        for source in self.repository.list_sources():
            self.source_combo.addItem(str(source.path), source.id)
        if current_id is not None:
            idx = self.source_combo.findData(current_id)
            if idx >= 0:
                self.source_combo.setCurrentIndex(idx)
        self.source_combo.blockSignals(False)
        self._source_changed()

    def _add_source(self) -> None:
        selected = QFileDialog.getExistingDirectory(self, "Festplatte oder Bildordner auswählen")
        if not selected:
            return
        try:
            source = self.repository.add_source(Path(selected))
            self._reload_sources()
            idx = self.source_combo.findData(source.id)
            self.source_combo.setCurrentIndex(idx)
            self.status_label.setText(f"Quelle hinzugefügt: {source.path}")
        except Exception as exc:
            QMessageBox.critical(self, "Quelle konnte nicht gespeichert werden", str(exc))

    def _source_changed(self) -> None:
        source_id = self.source_combo.currentData()
        self.scan_button.setEnabled(source_id is not None and self._thread is None)
        self._refresh_catalog()

    def _refresh_catalog(self) -> None:
        source_id = self.source_combo.currentData()
        self.table.setRowCount(0)
        if source_id is None:
            self.total_value.setText("0")
            self.available_value.setText("0")
            self.missing_value.setText("0")
            self.last_scan_value.setText("—")
            return
        stats = self.repository.stats(int(source_id))
        self.total_value.setText(str(stats["total"]))
        self.available_value.setText(str(stats["available"]))
        self.missing_value.setText(str(stats["missing"]))
        rows = self.repository.list_media(int(source_id))
        self.table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            resolution = f'{row["width"]} × {row["height"]}' if row["width"] and row["height"] else "—"
            values = [
                row["relative_path"], row["extension"].lstrip(".").upper(), self._format_bytes(row["size_bytes"]),
                resolution, "Verfügbar" if row["availability"] == "AVAILABLE" else "Fehlt"
            ]
            for col, value in enumerate(values):
                self.table.setItem(i, col, QTableWidgetItem(str(value)))
        latest = self.repository.latest_scan(int(source_id))
        self.last_scan_value.setText(str(latest["finished_at"]) if latest else "—")

    @staticmethod
    def _format_bytes(value: int) -> str:
        size = float(value)
        for unit in ("B", "KB", "MB", "GB", "TB"):
            if size < 1024 or unit == "TB":
                return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
            size /= 1024
        return f"{size:.1f} TB"

    def _start_scan(self) -> None:
        source_id = self.source_combo.currentData()
        if source_id is None or self._thread is not None:
            return
        self.scan_button.setEnabled(False)
        self.add_button.setEnabled(False)
        self.status_label.setText("Scan läuft …")
        thread = QThread(self)
        worker = ScanWorker(self.scanner, int(source_id))
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.progress.connect(self.status_label.setText)
        worker.finished.connect(self._scan_finished)
        worker.failed.connect(self._scan_failed)
        worker.finished.connect(thread.quit)
        worker.failed.connect(thread.quit)
        thread.finished.connect(self._scan_cleanup)
        self._thread = thread
        self._worker = worker
        thread.start()

    def _scan_finished(self, result) -> None:
        self.status_label.setText(
            f"Scan fertig: {result.discovered} gefunden · {result.new} neu · {result.changed} geändert · "
            f"{result.missing} fehlen · {result.errors} Fehler"
        )
        self._refresh_catalog()

    def _scan_failed(self, message: str) -> None:
        self.status_label.setText("Scan fehlgeschlagen")
        QMessageBox.critical(self, "Scan fehlgeschlagen", message)

    def _scan_cleanup(self) -> None:
        if self._worker is not None:
            self._worker.deleteLater()
        if self._thread is not None:
            self._thread.deleteLater()
        self._worker = None
        self._thread = None
        self.add_button.setEnabled(True)
        self.scan_button.setEnabled(self.source_combo.currentData() is not None)
