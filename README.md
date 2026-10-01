# Image Sortierer – Neustart 0.1

Komplett neue Codebasis. Der erste Stand macht bewusst nur zwei Dinge:

1. lokale Medienquelle (Festplatte/Ordner) verwalten
2. Bilder rekursiv in SQLite katalogisieren und Änderungen erkennen

**Noch nicht enthalten:** KI, Personen-, Gesichts- oder Haustiererkennung, Videos.

## Architektur

- `db/`: SQLite-Schema und Datenzugriff
- `services/`: Scanner, Hashing, Bildmetadaten
- `ui/`: Desktop-Oberfläche
- `domain/`: gemeinsame Datenmodelle

Die Module kennen sich nur über kleine Schnittstellen. Spätere KI-Worker können an den Katalog angehängt werden, ohne Scanner oder UI neu zu bauen.

## Windows – erster Start

PowerShell im Projektordner öffnen und ausführen:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup_windows.ps1
```

Das Skript installiert bei Bedarf Python 3.12 über `winget`, legt `.venv` an, installiert die Abhängigkeiten und startet das Tool.

Spätere Starts:

```powershell
.\start.ps1
```

## Verhalten des Scanners

- rekursiv ab der gewählten Quelle
- Bildtypen: JPG/JPEG, PNG, WEBP, BMP, GIF, TIFF, HEIC/HEIF, AVIF
- neue oder tatsächlich geänderte Dateien werden per SHA-256 erkannt
- unveränderte Dateien werden nicht erneut gehasht
- verschwundene Dateien werden **nicht gelöscht**, sondern als `MISSING` markiert
- wieder auftauchende Dateien werden automatisch wieder `AVAILABLE`
- Fehler bei einzelnen Dateien brechen den Gesamtscan nicht ab

Die Datenbank liegt unter Windows in:

`%LOCALAPPDATA%\ImageSortierer\catalog.sqlite3`

## Tests

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```
