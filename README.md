# Image Sortierer – Neustart

Komplett neue Codebasis mit klar getrennten Prozessen für Bilder und Videos.

## Aktueller Stand

Der erste Schritt macht bewusst nur:

1. lokale Medienquelle (Festplatte/Ordner) auswählen
2. Bilder und Videos rekursiv katalogisieren
3. Änderungen erkennen
4. Katalog lokal in SQLite speichern
5. fehlende Bilder markieren, aber nicht löschen

**Aktiv:** technische Prüfung, Bild-Thumbnails, EXIF-Metadaten, YuNet-Gesichtsdetektion, SFace-Gesichtsmerkmale, konservative Personenvorschläge, Namensbestätigung sowie dauerhafte Korrekturen: Gesichter aus Gruppen lösen, aus bestätigten Personen entfernen, Personen umbenennen und zusammenführen. **Aktiv ist jetzt auch die erste Haustierstufe:** NanoDet erkennt Hunde und Katzen samt Position und Konfidenz. **Noch nicht aktiv:** individuelle Haustier-Embeddings/Namenszuordnung und Motiverkennung. Videos werden katalogisiert und technisch geprüft; Video-Thumbnails folgen später.

## Architektur

- **Electron + TypeScript:** Oberfläche
- **Catalog Worker:** eigener Utility-Prozess für Dateiscan, Hashing und SQLite
- **Python-AI-Worker:** startet automatisch als eigener Hintergrundprozess; die technische Analyse-Queue läuft bereits, Personen-/Haustiermodelle folgen später
- **Thumbnail Worker:** eigener Utility-Prozess erzeugt Bildvorschauen und cached sie nach SHA-256
- **SQLite:** wird ausschließlich vom Catalog Worker direkt beschrieben

Dadurch können Scanner und spätere KI unter Last laufen, ohne die Renderer-Oberfläche zu blockieren.

Der Analyse-Worker läuft mit niedriger Prozesspriorität, standardmäßig nur einem parallelen Job und einem konfigurierten CPU-Zielbudget von 50 %. Das Zielbudget ist keine harte Betriebssystemgrenze.

Details: `docs/architecture.md`

## Windows – erster Start

Voraussetzung: Node.js 24.

Im Projektordner:

```powershell
npm install
npm run setup:ai
npm start
```

`setup:ai` erzeugt die lokale `.ai-venv`, installiert Pillow/OpenCV und lädt die geprüften OpenCV-Modelle YuNet (Gesichter), SFace (Gesichtsmerkmale) und NanoDet (Hund/Katze). Das Skript kann bei neuen Modellen erneut ausgeführt werden.

Danach genügt für normale Starts ebenfalls:

```powershell
npm start
```

Für Entwicklung mit Vite:

```powershell
npm run dev
```

Typprüfung:

```powershell
npm run check
```

## Scanner-Verhalten

- rekursiver Scan
- Bildtypen: JPG/JPEG, PNG, WEBP, BMP, GIF, TIFF, HEIC/HEIF, AVIF
- Videotypen: MP4, MOV, M4V, AVI, MKV, WEBM, MPG/MPEG, MTS/M2TS, 3GP, WMV
- neue und tatsächlich geänderte Dateien werden per SHA-256 katalogisiert
- unveränderte Dateien werden nicht erneut gehasht
- verschwundene Dateien werden als `MISSING` markiert
- wieder auftauchende Dateien werden automatisch wieder verfügbar
- Dateifehler brechen nicht den Gesamtscan ab
- im Renderer werden maximal 500 Einträge gleichzeitig geladen
- Entwicklungsfunktion **„Datenbank zurücksetzen“** löscht Quellen, Katalogeinträge, Scan-Historie und Analysejobs, aber niemals Originaldateien

Die Datenbank liegt im Electron-`userData`-Verzeichnis als `catalog.sqlite3`.

## Branch

Aktueller Architektur-Neustart:

`2026-10-01-videos-datenbank-reset`
