$ErrorActionPreference = "Stop"
if (-not (Test-Path ".venv\Scripts\python.exe")) {
    throw "Die Umgebung fehlt. Bitte zuerst setup_windows.ps1 ausführen."
}
.\.venv\Scripts\python.exe -m image_sortierer.main
