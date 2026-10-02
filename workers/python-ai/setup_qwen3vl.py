from __future__ import annotations

from pathlib import Path

from huggingface_hub import snapshot_download

MODEL_ID = "Qwen/Qwen3-VL-8B-Thinking"
WORKER_DIR = Path(__file__).resolve().parent
TARGET_DIR = WORKER_DIR / "models" / "qwen3-vl-8b-thinking"

REQUIRED = (
    "config.json",
    "chat_template.json",
    "generation_config.json",
    "model.safetensors.index.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "video_preprocessor_config.json",
    "vocab.json",
    "merges.txt",
    "model-00001-of-00004.safetensors",
    "model-00002-of-00004.safetensors",
    "model-00003-of-00004.safetensors",
    "model-00004-of-00004.safetensors",
)


def ready() -> bool:
    return all((TARGET_DIR / name).is_file() for name in REQUIRED)


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)

    if ready():
        print(f"Qwen3-VL-8B-Thinking bereits vorhanden: {TARGET_DIR}")
        return

    print(
        "Lade Qwen3-VL-8B-Thinking (~17,5 GB). "
        "Das Modell wird einmalig lokal gespeichert."
    )

    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=str(TARGET_DIR),
        allow_patterns=[
            "*.json",
            "*.txt",
            "*.safetensors",
        ],
    )

    missing = [name for name in REQUIRED if not (TARGET_DIR / name).is_file()]
    if missing:
        raise RuntimeError(
            "Qwen3-VL-Download unvollständig. Fehlend: " + ", ".join(missing)
        )

    total = sum(
        path.stat().st_size
        for path in TARGET_DIR.glob("model-*.safetensors")
    )
    if total < 16_000_000_000:
        raise RuntimeError(
            "Qwen3-VL-Modellgewichte sind unerwartet klein; "
            "Download scheint unvollständig."
        )

    print(f"Qwen3-VL-8B-Thinking bereit: {TARGET_DIR}")


if __name__ == "__main__":
    main()
