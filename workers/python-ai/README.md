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
- Personen-, Haustier-, Embedding- und weitere Analyse-Module werden hier modular ergänzt

Das CPU-Zielbudget ist aktuell eine Steuerungsgröße für die späteren Analysejobs und **keine harte betriebssystemseitige 50-%-CPU-Grenze**. Die wirksamen Schutzmaßnahmen sind bereits aktiv: eigener Prozess, niedrige Prozesspriorität und nur ein gleichzeitiger Analysejob.

## Protokoll

Aktuell unterstützt der Worker:

- `ping`
- `status`
- `configure`
- `shutdown`

Die Oberfläche zeigt Zustand, verwendete Python-Laufzeit, Priorität, CPU-Zielbudget, Parallelität, Warteschlange und aktive Jobs an.

Damit können Analysemodelle später ersetzt oder erweitert werden, ohne Katalog-Worker oder Renderer neu zu koppeln.
