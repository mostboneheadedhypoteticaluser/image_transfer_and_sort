# Image Sortierer – Neustart

Komplett neue Codebasis mit klar getrennten Prozessen für Bilder und Videos.

## Aktueller Stand

Der erste Schritt macht bewusst nur:

1. lokale Medienquelle (Festplatte/Ordner) auswählen
2. Bilder und Videos rekursiv katalogisieren
3. Änderungen erkennen
4. Katalog lokal in SQLite speichern
5. fehlende Bilder markieren, aber nicht löschen

**Aktiv:** technische Prüfung, Bild-Thumbnails, EXIF-Metadaten, YuNet-Gesichtsdetektion, SFace-Gesichtsmerkmale, konservative Personenvorschläge, Namensbestätigung sowie dauerhafte Korrekturen: Gesichter aus Gruppen lösen, aus bestätigten Personen entfernen, Personen umbenennen und zusammenführen. **Aktiv ist jetzt auch ein Haustier-Ensemble:** NanoDet und YOLOX-S erkennen Hunde/Katzen getrennt; anschließend werden überlappende Fundstellen zu einem gemeinsamen Ergebnis fusioniert. Die Medienliste zeigt zusätzlich, ob eine Fundstelle von beiden Modellen oder nur einem Modell getragen wird. **Neu aktiv:** fusionierte Hundefundstellen erhalten ein spezialisiertes Dog-ReID-Embedding und werden konservativ zu individuellen Hundegruppen zusammengefasst. Im Reiter „Haustiere bestätigen“ können diese Gruppen benannt werden. Katzen bleiben derzeit bei der Art-/Positionsdetektion. **Noch nicht aktiv:** individuelle Katzen-ID und Motiverkennung. Videos werden katalogisiert und technisch geprüft; Video-Thumbnails folgen später.

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

`setup:ai` erzeugt die lokale `.ai-venv`, installiert Pillow/OpenCV und lädt die geprüften OpenCV-Modelle YuNet (Gesichter), SFace (Gesichtsmerkmale), NanoDet und YOLOX-S (Hund/Katze). Das Skript kann bei neuen Modellen erneut ausgeführt werden.

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


### Individuelle Hundeerkennung

Für die Wiedererkennung desselben Hundes verwendet die App optional das veröffentlichte **Dog-ReID DINOv2-B/14 0.2.0**-ONNX-Modell aus dem Projekt `rtp4jc/immich-animals`. Das Modell ist von der allgemeinen Hund-/Katzendetektion getrennt und wird erst auf fusionierte Hundefundstellen angewendet.

Die externe Modellquelle ist für den aktuellen persönlichen/lokalen Einsatz vorgesehen. Das Quellprojekt ist AGPL-3.0; die dort dokumentierten Trainingsdaten enthalten außerdem Nutzungsbedingungen für persönliche/nichtkommerzielle Verwendung. Deshalb bleibt das Modell als austauschbarer externer Analysebaustein gekapselt und wird nicht in das Repository eingecheckt.
