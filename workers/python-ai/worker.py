from __future__ import annotations

import json
import sys
from dataclasses import dataclass, asdict


@dataclass
class WorkerConfig:
    max_concurrent_jobs: int = 1


config = WorkerConfig()


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
        respond(request_id, result={"worker": "python-ai", "status": "ready", "config": asdict(config)})
        return True

    if method == "configure":
        value = int(payload.get("maxConcurrentJobs", config.max_concurrent_jobs))
        config.max_concurrent_jobs = max(1, min(8, value))
        respond(request_id, result=asdict(config))
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
