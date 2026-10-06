from __future__ import annotations

from pathlib import Path

from huggingface_hub import snapshot_download

MODEL_ID = "ggml-org/MiniCPM-V-4.6-GGUF"
WORKER_DIR = Path(__file__).resolve().parent
MODEL_ROOT = WORKER_DIR / "models"
TARGET_DIR = MODEL_ROOT / "minicpm-v-4.6-gguf"
MODEL_FILE = "MiniCPM-V-4.6-Q4_K_M.gguf"
MMPROJ_FILE = "mmproj-MiniCPM-V-4.6-Q8_0.gguf"


def ready() -> bool:
    model = TARGET_DIR / MODEL_FILE
    mmproj = TARGET_DIR / MMPROJ_FILE
    return (
        model.is_file()
        and model.stat().st_size > 500_000_000
        and mmproj.is_file()
        and mmproj.stat().st_size > 700_000_000
    )


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)

    if ready():
        print(f"MiniCPM-V 4.6 bereits vorhanden: {TARGET_DIR}")
        return

    print(
        "Lade MiniCPM-V 4.6 für llama.cpp: "
        "Q4_K_M (~529 MB) + Q8-Vision-Projektor (~728 MB)."
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
        raise RuntimeError("MiniCPM-V-4.6-Download ist unvollständig." + detail)

    print(f"MiniCPM-V 4.6 bereit: {TARGET_DIR}")
    print(f"  LLM:    {TARGET_DIR / MODEL_FILE}")
    print(f"  Vision: {TARGET_DIR / MMPROJ_FILE}")


if __name__ == "__main__":
    main()
