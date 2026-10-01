# Architektur

## Ziel

Die Oberfläche soll auch dann bedienbar bleiben, wenn Festplatten-Scans oder spätere KI-Analysen über Stunden laufen.

## Prozessgrenzen

```text
Electron Renderer
    │
    │ IPC
    ▼
Electron Main
    │
    ├── Utility Process: Catalog Worker
    │       ├── Dateiscan
    │       ├── SHA-256
    │       └── SQLite (einziger Besitzer der Katalog-DB)
    │
    ├── Utility Process: Thumbnail Worker
    │       └── Sharp + SHA-256-Cache
    │
    └── Python-AI-Worker (eigener Hintergrundprozess)
            ├── eigener Prozess, keine sichtbare zweite App
            ├── niedrige Prozesspriorität
            ├── 1 gleichzeitiger Analysejob
            ├── technische Prüfung
            ├── EXIF-Metadaten
            ├── YuNet-Gesichtsdetektion
            ├── SFace-Gesichtsmerkmale
            ├── später Personen-Clustering/Bestätigung und Haustier-Embeddings
            └── weitere Analyse-Module
```

## Regeln

1. Im Renderer laufen keine Dateiscans, Hashes, Datenbankabfragen oder KI-Berechnungen.
2. Der Electron-Main-Prozess orchestriert nur Fenster, Dialoge und IPC.
3. Der Catalog Worker besitzt die SQLite-Verbindung exklusiv.
4. Der Renderer lädt nur begrenzte Ergebnismengen; aktuell maximal 500 Medien gleichzeitig.
5. Unveränderte Dateien werden anhand Größe + Änderungszeit erkannt und nicht erneut gehasht.
6. Nur wenn sich Metadaten geändert haben, wird SHA-256 erneut berechnet.
7. Fehlende Dateien werden nicht gelöscht, sondern als `MISSING` markiert.
8. Spätere KI-Ergebnisse hängen über Jobs/IDs am Katalog, nicht direkt an UI-Komponenten.
9. Ordner und Medien erhalten zusätzlich ihre Dateisystem-Identität aus Gerät/Volume + Inode/File-ID.
10. Eine Ordnerumbenennung auf demselben Dateisystem wird zuerst über die Ordner-ID erkannt. Dann werden die Pfade der enthaltenen Katalogeinträge aktualisiert, die Medien-IDs selbst bleiben erhalten.
11. Einzelne verschobene Dateien werden zuerst über ihre Dateisystem-ID erkannt. Erst wenn diese Identität nicht verfügbar oder durch einen Laufwerkswechsel verloren ist, dient SHA-256 zusammen mit Größe und Pfadkontext als Fallback.
12. Gleiche SHA-256-Werte allein gelten ausdrücklich nicht als Verschiebebeweis. Bei mehreren identischen Kandidaten wird nicht geraten; echte Duplikate bleiben getrennte Katalogeinträge.

## Ressourcensteuerung für KI

Der Python-AI-Worker wird beim Start des Image Sortierers automatisch als eigener Prozess gestartet und beim Beenden der App wieder beendet. Für den Nutzer bleibt es eine einzige Anwendung.

Aktive Startkonfiguration:

- Prozesspriorität: **Below Normal**
- maximale Parallelität: **1 Analysejob**
- CPU-Zielbudget: **50 %**
- Profil: **background**

Das CPU-Zielbudget ist bewusst keine behauptete harte Betriebssystemgrenze. Eine echte feste CPU-Prozentbegrenzung wäre plattformspezifisch. Für die Reaktionsfähigkeit der App sind bereits wirksam: Prozessisolation, niedrige Priorität, begrenzte Parallelität und eine später separat geführte Job-Queue.

Die Oberfläche zeigt den Zustand des Analyse-Workers unabhängig vom Katalog-Worker an. Ein Ausfall des Python-Prozesses soll daher nicht die Medienansicht blockieren.

## SQLite

Die Datenbank verwendet WAL-Modus und liegt im Electron-`userData`-Verzeichnis. Der Catalog Worker ist der einzige Prozess, der direkt auf sie zugreift. Andere Module kommunizieren über definierte Nachrichten.

Die Tabelle `analysis_jobs` steuert inzwischen technische Prüfung, Thumbnails, EXIF-Metadaten, YuNet-Gesichtsdetektion und SFace-Gesichtsmerkmale persistent. Ergebnisse landen getrennt in `media_thumbnails`, `media_image_metadata`, `face_detections` und `face_embeddings`. Die SFace-Vektoren werden normalisiert als Float32-BLOB gespeichert. Personenidentität bleibt bewusst noch getrennt; sie wird im nächsten Schritt durch Ähnlichkeits-Clustering und Nutzerbestätigung aufgebaut.


## Personenvorschläge und Bestätigung

Nach abgeschlossener SFace-Analyse werden unbestätigte Gesichter automatisch mit `person-centroid-v1` gruppiert. Das Clustering läuft im Python-AI-Worker und verwendet eine konservative Cosine-Schwelle, damit falsches Zusammenführen seltener ist als eine zu starke Aufteilung.

Exakte Dateidubletten werden beim Aufbau der Cluster über `SHA-256 + detection_index` als gleiche Evidenz behandelt, damit identische Kopien den Cluster-Schwerpunkt nicht mehrfach gewichten. Die tatsächlichen Fundstellen bleiben trotzdem einzeln erhalten.

Unbestätigte Gruppen liegen in `person_candidates` und `person_candidate_faces`. Erst eine Nutzerbestätigung erzeugt eine dauerhafte Person in `persons` und feste Zuordnungen in `person_face_assignments`. Bestätigte Gesichter werden bei späteren automatischen Neuberechnungen nicht überschrieben.

Gesichtsausschnitte für die Bestätigungsansicht werden nicht im Renderer berechnet. Der Thumbnail-Utility-Prozess erzeugt gecachte Face-Crops, die über das eingeschränkte interne Protokoll `image-sorter-face://` an die Oberfläche geliefert werden.


## Dauerhafte Personenkorrekturen

Korrekturen werden nicht nur an der aktuellen UI-Gruppe vorgenommen. Beim manuellen Trennen zweier Gesichter werden dauerhafte `cannot-link`-Beziehungen in `person_cluster_exclusions` gespeichert. Das Python-Clustering erhält diese Regeln bei jeder späteren Neuberechnung und darf die betroffenen Gesichter nicht wieder in dieselbe automatische Gruppe legen.

Wird ein Gesicht aus einer bestätigten Person entfernt, wird zusätzlich die Negativzuordnung in `person_face_exclusions` gespeichert. Die feste Zuordnung in `person_face_assignments` wird entfernt; die Person selbst und ihre übrigen bestätigten Gesichter bleiben unverändert. Eine spätere explizite Nutzerbestätigung darf eine solche frühere Sperre bewusst wieder aufheben.

Bestätigte Personen können umbenannt oder zusammengeführt werden. Beim Zusammenführen werden bestehende bestätigte Gesichtszuordnungen und Negativregeln konsistent auf die Zielperson übertragen. Exakte Dateidubletten desselben Gesichtes werden bei Korrekturen gemeinsam behandelt.


## Haustierdetektion

Die erste Haustierstufe verwendet das CPU-taugliche OpenCV-Zoo-Modell **NanoDet 2022nov**. Aus den COCO-Klassen werden bewusst nur `dog` und `cat` übernommen. Pro Fundstelle speichert `pet_detections` Klasse, Konfidenz, Bounding Box, Eingabe-SHA-256 und Detektorversion.

Diese Stufe erkennt zunächst nur **Tierart und Position**, nicht die Identität eines einzelnen Tieres. Individuelle Tiere (z. B. derselbe Hund auf verschiedenen Bildern) werden in einer separaten nächsten Stufe über Crop-Embeddings und Nutzerbestätigung aufgebaut. So bleiben Detektion und Identität wie bei Personen getrennt.


## Haustier-Ensemble

Die Haustierdetektion verwendet jetzt zwei unabhängige OpenCV-DNN-Modelle: **NanoDet 2022nov** und **YOLOX-S 2022nov**. Beide schreiben ihre Rohfundstellen getrennt nach `pet_detections`; dadurch bleiben Modellvergleich und spätere Qualitätsauswertung möglich.

Nach Abschluss beider Detektoren startet `pet-fuse-ensemble-v1`. Gleichartige Boxen werden ab IoU 0,45 zusammengeführt. Bei Übereinstimmung beider Modelle wird die Box konfidenzgewichtet gemittelt und als Mehrmodell-Fund gespeichert. Einzelmodell-Funde bleiben nur oberhalb einer strengeren Mindestkonfidenz erhalten. Das fusionierte Resultat liegt in `pet_fused_detections` und ist die einzige Haustierquelle für die normale Medienanzeige.

Die Modelle laufen absichtlich nacheinander im bestehenden Hintergrund-Worker statt gleichzeitig CPU-Spitzen zu erzeugen. Der Ensemble-Nutzen entsteht durch die Kombination der Ergebnisse, nicht durch zeitgleiche Ausführung.
