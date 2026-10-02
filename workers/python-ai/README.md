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
- technische Dateiprüfung, EXIF-Metadaten, YuNet-Gesichtsdetektion, SFace-Gesichtsmerkmale sowie NanoDet- und YOLOX-S-Hund-/Katzendetektion mit anschließender Ensemble-Fusion laufen bereits modular
- SigLIP2 So400m NaFlex erzeugt zusätzlich hochauflösende semantische Bild-Embeddings für freie Inhaltsabfragen wie „Hund im Schnee“, „Wald“ oder „Person mit Hund neben einem Fahrzeug“
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
- `detect_pets_yolox`
- `fuse_pet_detections`
- `extract_dog_embeddings`
- `cluster_pet_embeddings`
- `shutdown`

Die externen Python-Abhängigkeiten liegen bewusst in `.ai-venv`. Einrichtung: `npm run setup:ai`.

Die Oberfläche zeigt Zustand, verwendete Python-Laufzeit, Priorität, CPU-Zielbudget, Parallelität, Warteschlange und aktive Jobs an.

Damit können Analysemodelle später ersetzt oder erweitert werden, ohne Katalog-Worker oder Renderer neu zu koppeln.


### Dog-ReID

`pet-embed-dogreid-v1` nutzt das externe ONNX-Modell **DogReID DINOv2-B14 0.2.0**. Die Session wird lazy geladen; Bilder ohne fusionierten Hundefund schließen den Job ohne Bilddekodierung und ohne Modellinferenz ab. Eingabe: RGB 224×224, ImageNet-Normalisierung, NCHW. Ausgabe: L2-normalisierter Merkmalsvektor.


## Semantikanalyse mit SigLIP2 So400m NaFlex

Die Semantikanalyse nutzt `google/siglip2-so400m-patch16-naflex` lokal. Die Priorität liegt ausdrücklich auf Erkennungsqualität statt Laufzeit:

- FP32, keine INT8-/INT4-Quantisierung
- NaFlex mit bis zu 1024 Bild-Patches
- ein normalisierter Bildvektor pro aktuellem SHA-256-Inhalt
- Freitext wird zur Suche mit demselben Modell in einen Textvektor umgewandelt
- Semantik kann mit bestätigten Personen, bestätigten Haustieren, konkreten Motiven und Mindestanzahlen per UND kombiniert werden
- Modellgewichte werden lokal gehalten und nicht in Git eingecheckt

`npm run setup:ai` installiert die Python-Abhängigkeiten und lädt das SigLIP2-Modell einmalig (mehrere GB) nach
`workers/python-ai/models/siglip2-so400m-patch16-naflex`.

### Entwicklungsdatenbank sauber neu beginnen

Der Button **Datenbank zurücksetzen** löscht auch alle abgeleiteten KI-Daten: Gesichts- und Haustierzuordnungen, Motivroh- und Fusionsergebnisse, SigLIP2-Semantikvektoren, Analysejobs, Kandidaten, Scan-Historie und SQLite-ID-Sequenzen. Anschließend werden WAL und freie SQLite-Seiten bereinigt und der Thumbnail-/Crop-Cache entfernt.

Nicht gelöscht werden die Originalbilder/-videos und die lokal installierten KI-Modellgewichte. Dadurch kann nach einem Reset ohne Altlasten neu katalogisiert und analysiert werden, ohne das große SigLIP2-Modell erneut herunterladen zu müssen.
