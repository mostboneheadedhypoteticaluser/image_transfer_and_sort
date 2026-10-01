$ErrorActionPreference = "Stop"

function Get-Python312 {
    $candidates = @(
        @{ Cmd = "py"; Args = @("-3.12") },
        @{ Cmd = "python"; Args = @() }
    )
    foreach ($candidate in $candidates) {
        try {
            & $candidate.Cmd @($candidate.Args) -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3,12) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch {}
    }
    return $null
}

$python = Get-Python312
if (-not $python) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Python 3.12 fehlt und winget ist nicht verfügbar. Bitte Python 3.12 installieren und das Skript erneut starten."
    }
    Write-Host "Installiere Python 3.12..."
    winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    $python = Get-Python312
    if (-not $python) { throw "Python 3.12 wurde installiert, ist aber noch nicht erreichbar. PowerShell neu öffnen und setup_windows.ps1 erneut starten." }
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    & $python.Cmd @($python.Args) -m venv .venv
}

.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m image_sortierer.main
