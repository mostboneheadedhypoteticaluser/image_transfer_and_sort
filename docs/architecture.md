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
            ├── später Personen-/Haustier-Embeddings
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

Die Tabelle `analysis_jobs` steuert inzwischen technische Prüfung, Thumbnails, EXIF-Metadaten und YuNet-Gesichtsdetektion persistent. Ergebnisse landen getrennt in `media_thumbnails`, `media_image_metadata` und `face_detections`. Personenidentität bleibt bewusst noch getrennt; sie wird später über Embeddings und Bestätigung aufgebaut.
