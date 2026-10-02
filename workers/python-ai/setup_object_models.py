from __future__ import annotations

import os
from pathlib import Path

from huggingface_hub import snapshot_download

WORKER_DIR = Path(__file__).resolve().parent
MODEL_DIR = WORKER_DIR / "models"
GROUNDING_DIR = MODEL_DIR / "grounding-dino-base"
RF_DIR = MODEL_DIR / "rfdetr"


def setup_grounding_dino() -> None:
    GROUNDING_DIR.mkdir(parents=True, exist_ok=True)
    required = (
        "config.json",
        "model.safetensors",
        "preprocessor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.txt",
    )

    if all((GROUNDING_DIR / name).is_file() for name in required):
        print(f"Grounding DINO Base bereits vorhanden: {GROUNDING_DIR}")
        return

    print("Lade Grounding DINO Base für die unabhängige Objektprüfung …")
    snapshot_download(
        repo_id="IDEA-Research/grounding-dino-base",
        local_dir=str(GROUNDING_DIR),
        allow_patterns=[
            "config.json",
            "model.safetensors",
            "preprocessor_config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "special_tokens_map.json",
            "vocab.txt",
        ],
    )

    missing = [name for name in required if not (GROUNDING_DIR / name).is_file()]
    if missing:
        raise RuntimeError(
            "Grounding-DINO-Download unvollständig. Fehlend: " + ", ".join(missing)
        )


def setup_rfdetr() -> None:
    RF_DIR.mkdir(parents=True, exist_ok=True)

    # RF-DETR löst veröffentlichte Gewichte über RF_HOME auf. Dadurch bleiben
    # sie projektnah und überleben einen Datenbank-Reset.
    os.environ["RF_HOME"] = str(RF_DIR)

    from rfdetr import RFDETRLarge

    print("Prüfe/lade RF-DETR Large (COCO, 704×704) …")
    model = RFDETRLarge(device="cpu")
    del model

    expected = list(RF_DIR.rglob("rf-detr-large-2026.pth"))
    if not expected:
        raise RuntimeError(
            "RF-DETR Large wurde initialisiert, aber das veröffentlichte Gewicht "
            "rf-detr-large-2026.pth wurde im lokalen Modellcache nicht gefunden."
        )

    print(f"RF-DETR Large bereit: {expected[0]}")


def main() -> None:
    setup_grounding_dino()
    setup_rfdetr()
    print("Präzisionsmodelle für Motiverkennung sind bereit.")


if __name__ == "__main__":
    main()
