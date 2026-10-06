from __future__ import annotations

from pathlib import Path

from huggingface_hub import snapshot_download

MODEL_ID = "Qwen/Qwen3-VL-4B-Instruct-GGUF"
WORKER_DIR = Path(__file__).resolve().parent
MODEL_ROOT = WORKER_DIR / "models"
TARGET_DIR = MODEL_ROOT / "qwen3-vl-4b-instruct-gguf"
MODEL_FILE = "Qwen3VL-4B-Instruct-Q4_K_M.gguf"
MMPROJ_FILE = "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf"


def ready() -> bool:
    model = TARGET_DIR / MODEL_FILE
    mmproj = TARGET_DIR / MMPROJ_FILE
    return (
        model.is_file()
        and model.stat().st_size > 2_000_000_000
        and mmproj.is_file()
        and mmproj.stat().st_size > 400_000_000
    )


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)

    if ready():
        print(f"Qwen3-VL 4B bereits vorhanden: {TARGET_DIR}")
        return

    print(
        "Lade offizielles Qwen3-VL-4B-Instruct für llama.cpp: "
        "Q4_K_M (~2,5 GB) + Q8-Vision-Projektor (~454 MB)."
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
        raise RuntimeError("Qwen3-VL-4B-Download ist unvollständig." + detail)

    print(f"Qwen3-VL 4B bereit: {TARGET_DIR}")
    print(f"  LLM:    {TARGET_DIR / MODEL_FILE}")
    print(f"  Vision: {TARGET_DIR / MMPROJ_FILE}")


if __name__ == "__main__":
    main()
