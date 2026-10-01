# Python-AI-Worker

Der Analyse-Worker läuft jetzt als **eigener Hintergrundprozess**, wird aber vollständig durch den Image Sortierer gestartet und beendet.

## Verhalten

- Start automatisch mit der Electron-App
- Ende automatisch mit der Electron-App
- Kommunikation: JSON Lines über stdin/stdout
- keine UI-Logik im Worker
- keine direkte Abhängigkeit des Renderers von Python
- Prozesspriorität wird vom Electron-Main-Prozess auf **Below Normal** gesetzt
- Standard-Parallelität: **1 Analysejob**
- konfiguriertes CPU-Zielbudget: **50 %**
- technische Dateiprüfung, EXIF-Metadaten, YuNet-Gesichtsdetektion, SFace-Gesichtsmerkmale und NanoDet-Hund-/Katzendetektion laufen bereits modular
- Personen-Embeddings, Haustiere und weitere Analyse-Module werden darauf aufgebaut

Das CPU-Zielbudget ist aktuell eine Steuerungsgröße für die späteren Analysejobs und **keine harte betriebssystemseitige 50-%-CPU-Grenze**. Die wirksamen Schutzmaßnahmen sind bereits aktiv: eigener Prozess, niedrige Prozesspriorität und nur ein gleichzeitiger Analysejob.

## Protokoll

Aktuell unterstützt der Worker:

- `ping`
- `status`
- `configure`
- `probe_media`
- `extract_image_metadata`
- `detect_faces`
- `extract_face_embeddings`
- `detect_pets`
- `shutdown`

Die externen Python-Abhängigkeiten liegen bewusst in `.ai-venv`. Einrichtung: `npm run setup:ai`.

Die Oberfläche zeigt Zustand, verwendete Python-Laufzeit, Priorität, CPU-Zielbudget, Parallelität, Warteschlange und aktive Jobs an.

Damit können Analysemodelle später ersetzt oder erweitert werden, ohne Katalog-Worker oder Renderer neu zu koppeln.
