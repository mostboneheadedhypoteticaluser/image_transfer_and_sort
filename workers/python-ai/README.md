# Python-AI-Worker

Dieser Prozess ist absichtlich **nicht** Teil des ersten Bildkatalog-Schritts und wird beim App-Start noch nicht benötigt.

Die Prozessgrenze steht aber bereits fest:

- Kommunikation: JSON Lines über stdin/stdout
- keine UI-Logik im Worker
- keine direkte Abhängigkeit des Renderers von Python
- Standard-Parallelität später: 1 Analysejob
- Module für Personen, Haustiere, Embeddings usw. werden hier separat ergänzt

Aktuell unterstützt der Stub nur `ping`, `configure` und `shutdown`.

Damit kann die KI später ergänzt oder ersetzt werden, ohne den Katalog-Worker oder die Electron-Oberfläche umzubauen.
