from __future__ import annotations

import os
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL_ID = "google/siglip2-so400m-patch16-naflex"
WORKER_DIR = Path(__file__).resolve().parent
TARGET_DIR = WORKER_DIR / "models" / "siglip2-so400m-patch16-naflex"
REQUIRED = (
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
)


def ready() -> bool:
    return all((TARGET_DIR / name).is_file() for name in REQUIRED)


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)

    if ready():
        print(f"SigLIP2-Modell bereits vorhanden: {TARGET_DIR}")
        return

    print(
        "Lade SigLIP2 So400m NaFlex (~4,6 GB) für die semantische Analyse. "
        "Der Download erfolgt einmalig und wird lokal gespeichert."
    )

    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=str(TARGET_DIR),
        allow_patterns=list(REQUIRED),
    )

    missing = [name for name in REQUIRED if not (TARGET_DIR / name).is_file()]
    if missing:
        raise RuntimeError(
            "SigLIP2-Download unvollständig. Fehlend: " + ", ".join(missing)
        )

    size = os.path.getsize(TARGET_DIR / "model.safetensors")
    if size < 4_000_000_000:
        raise RuntimeError(
            "SigLIP2-Modellgewicht ist unerwartet klein; Download scheint unvollständig."
        )

    print(f"SigLIP2-Modell bereit: {TARGET_DIR}")


if __name__ == "__main__":
    main()
