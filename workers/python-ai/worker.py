from __future__ import annotations

import json
import mimetypes
import os
import sys
from dataclasses import asdict, dataclass


@dataclass
class WorkerConfig:
    max_concurrent_jobs: int = 1
    cpu_budget_percent: int = 50
    profile: str = "background"


@dataclass
class WorkerRuntime:
    queued_jobs: int = 0
    active_jobs: int = 0


config = WorkerConfig()
runtime = WorkerRuntime()


def snapshot() -> dict:
    return {
        **asdict(config),
        **asdict(runtime),
        "worker": "python-ai",
        "status": "ready",
    }


def respond(request_id: str | None, *, result=None, error: str | None = None) -> None:
    message = {"id": request_id, "ok": error is None}
    if error is None:
        message["result"] = result
    else:
        message["error"] = error
    print(json.dumps(message, ensure_ascii=False), flush=True)


def handle(message: dict) -> bool:
    request_id = message.get("id")
    method = message.get("method")
    payload = message.get("payload") or {}

    if method == "ping":
        respond(request_id, result=snapshot())
        return True

    if method == "status":
        respond(request_id, result=snapshot())
        return True

    if method == "configure":
        jobs = int(payload.get("maxConcurrentJobs", config.max_concurrent_jobs))
        cpu_budget = int(payload.get("cpuBudgetPercent", config.cpu_budget_percent))
        profile = str(payload.get("profile", config.profile)).strip().lower()

        config.max_concurrent_jobs = max(1, min(8, jobs))
        config.cpu_budget_percent = max(10, min(100, cpu_budget))
        config.profile = profile if profile in {"background", "balanced", "full"} else "background"

        respond(request_id, result=snapshot())
        return True

    if method == "probe_media":
        file_path = os.path.abspath(str(payload.get("path", "")))
        if not file_path:
            respond(request_id, error="Dateipfad fehlt.")
            return True

        if not os.path.isfile(file_path):
            respond(request_id, error=f"Datei ist nicht erreichbar: {file_path}")
            return True

        info = os.stat(file_path)
        expected_size = payload.get("expectedSizeBytes")

        if expected_size is not None and int(expected_size) != int(info.st_size):
            respond(
                request_id,
                error=(
                    f"Dateigröße hat sich seit dem Katalogscan geändert: "
                    f"{info.st_size} statt {expected_size} Byte."
                ),
            )
            return True

        mime_type, _encoding = mimetypes.guess_type(file_path)

        respond(
            request_id,
            result={
                "module": "file-probe-v1",
                "path": file_path,
                "exists": True,
                "sizeBytes": int(info.st_size),
                "mtimeNs": int(info.st_mtime_ns),
                "mimeType": mime_type,
                "extension": str(payload.get("extension", "")),
                "expectedSha256": str(payload.get("expectedSha256", "")),
            },
        )
        return True

    if method == "shutdown":
        respond(request_id, result={"status": "bye"})
        return False

    respond(request_id, error=f"Unbekannte Methode: {method}")
    return True


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if not handle(message):
                break
        except Exception as exc:
            respond(None, error=str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
