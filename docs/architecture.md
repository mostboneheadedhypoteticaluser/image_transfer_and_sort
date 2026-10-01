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
    └── später: separater Python-AI-Worker
            ├── Personen
            ├── Haustiere
            ├── Embeddings
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

Die KI bekommt später eine eigene Queue. Startwert ist ein gleichzeitiger Analysejob. Parallelität kann unabhängig von der Oberfläche geändert werden.

Zusätzlich kann der Python-Prozess unter Windows mit niedrigerer Prozesspriorität gestartet werden. Eine echte harte CPU-Prozentgrenze ist davon zu unterscheiden und müsste betriebssystemspezifisch umgesetzt werden. Entscheidend für die Reaktionsfähigkeit sind Prozessisolation, kleine Queues, begrenzte Parallelität und kein Laden großer Originalbilder im Renderer.

## SQLite

Die Datenbank verwendet WAL-Modus und liegt im Electron-`userData`-Verzeichnis. Der Catalog Worker ist der einzige Prozess, der direkt auf sie zugreift. Andere Module kommunizieren über definierte Nachrichten.

Die Tabelle `analysis_jobs` ist bereits als Anschlussstelle für spätere Analyse-Module vorgesehen, wird im ersten Schritt aber noch nicht aktiv verwendet.
