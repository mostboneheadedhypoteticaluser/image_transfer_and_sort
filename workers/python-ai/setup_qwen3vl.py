from __future__ import annotations

import shutil
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL_ID = "Qwen/Qwen3-VL-8B-Thinking-GGUF"
WORKER_DIR = Path(__file__).resolve().parent
MODEL_ROOT = WORKER_DIR / "models"

# Alter, zu großer Transformers/BF16-Checkpoint aus der vorherigen Iteration.
LEGACY_DIR = MODEL_ROOT / "qwen3-vl-8b-thinking"

# Neue lokale llama.cpp/GGUF-Variante.
TARGET_DIR = MODEL_ROOT / "qwen3-vl-8b-thinking-gguf"
MODEL_FILE = "Qwen3VL-8B-Thinking-Q8_0.gguf"
MMPROJ_FILE = "mmproj-Qwen3VL-8B-Thinking-F16.gguf"


def remove_legacy_model() -> None:
    if not LEGACY_DIR.exists():
        return

    print(
        "Entferne den nicht mehr verwendeten 17,5-GB-BF16-Checkpoint: "
        f"{LEGACY_DIR}"
    )
    shutil.rmtree(LEGACY_DIR)
    print("Alter Qwen3-VL-Transformers-Checkpoint wurde entfernt.")


def ready() -> bool:
    model = TARGET_DIR / MODEL_FILE
    mmproj = TARGET_DIR / MMPROJ_FILE

    if not model.is_file() or not mmproj.is_file():
        return False

    # Größenprüfung schützt vor abgebrochenen Downloads.
    return (
        model.stat().st_size > 8_000_000_000
        and mmproj.stat().st_size > 1_000_000_000
    )


def main() -> None:
    remove_legacy_model()
    TARGET_DIR.mkdir(parents=True, exist_ok=True)

    if ready():
        print(f"Qwen3-VL GGUF bereits vorhanden: {TARGET_DIR}")
        return

    print(
        "Lade Qwen3-VL-8B-Thinking GGUF für llama.cpp: "
        "Q8_0 (~8,71 GB) + FP16-Vision-Projektor (~1,16 GB)."
    )

    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=str(TARGET_DIR),
        allow_patterns=[MODEL_FILE, MMPROJ_FILE],
    )

    if not ready():
        missing = [
            name
            for name in (MODEL_FILE, MMPROJ_FILE)
            if not (TARGET_DIR / name).is_file()
        ]
        detail = (
            " Fehlend: " + ", ".join(missing)
            if missing
            else " Dateien vorhanden, aber unerwartet klein."
        )
        raise RuntimeError(
            "Qwen3-VL-GGUF-Download ist unvollständig." + detail
        )

    print(f"Qwen3-VL GGUF bereit: {TARGET_DIR}")
    print(f"  LLM:    {TARGET_DIR / MODEL_FILE}")
    print(f"  Vision: {TARGET_DIR / MMPROJ_FILE}")


if __name__ == "__main__":
    main()
