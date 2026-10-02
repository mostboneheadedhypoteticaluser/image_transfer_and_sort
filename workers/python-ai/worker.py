from __future__ import annotations

import base64
import gc
import importlib.util
import io
import json
import math
import mimetypes
import os
import shutil
import socket
from pathlib import Path
import subprocess
import sys
import time
from urllib import error as urllib_error
from urllib import request as urllib_request
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

try:
    from PIL import Image, ImageDraw, ImageOps
except Exception:
    Image = None
    ImageDraw = None
    ImageOps = None

# PyTorch/Transformers werden bewusst erst bei der SigLIP2-Stufe geladen.
# Der Worker muss auf ping sofort antworten können; insbesondere unter Windows
# kann der Import dieser großen Bibliotheken sonst bereits den Start-Timeout
# überschreiten.
torch = None
AutoModel = None
AutoProcessor = None
_torch_transformers_import_error = None

try:
    import cv2
    import numpy as np
except Exception:
    cv2 = None
    np = None

WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
YUNET_MODEL = os.path.join(
    WORKER_DIR,
    "models",
    "face_detection_yunet_2023mar.onnx",
)
SFACE_MODEL = os.path.join(
    WORKER_DIR,
    "models",
    "face_recognition_sface_2021dec.onnx",
)
NANODET_MODEL = os.path.join(
    WORKER_DIR,
    "models",
    "object_detection_nanodet_2022nov.onnx",
)
YOLOX_MODEL = os.path.join(
    WORKER_DIR,
    "models",
    "object_detection_yolox_2022nov.onnx",
)
DOG_REID_MODEL = os.path.join(
    WORKER_DIR,
    "models",
    "dog_reid_dinov2_b14_0_2_0.onnx",
)

SIGLIP2_MODEL_DIR = os.path.join(
    WORKER_DIR,
    "models",
    "siglip2-so400m-patch16-naflex",
)
SIGLIP2_MODEL_VERSION = "SigLIP2 So400m/16 NaFlex FP32 1024patch-v1"
SIGLIP2_MAX_NUM_PATCHES = 1024


QWEN3VL_MODEL_DIR = os.path.join(
    WORKER_DIR,
    "models",
    "qwen3-vl-8b-thinking-gguf",
)
QWEN3VL_MODEL_FILE = os.path.join(
    QWEN3VL_MODEL_DIR,
    "Qwen3VL-8B-Thinking-Q8_0.gguf",
)
QWEN3VL_MMPROJ_FILE = os.path.join(
    QWEN3VL_MODEL_DIR,
    "mmproj-Qwen3VL-8B-Thinking-F16.gguf",
)
QWEN3VL_MODEL_VERSION = (
    "Qwen3-VL-8B-Thinking GGUF Q8_0 + mmproj F16 open-vocabulary v2"
)
QWEN3VL_CONTEXT_SIZE = 16384

COCO_CLASS_NAMES = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
)

_dog_reid_session = None
_onnxruntime_module = None
_siglip2_model = None
_siglip2_processor = None
_siglip2_coco_text_features = None
_qwen_server_process = None
_qwen_server_port = None
_qwen_server_log_handle = None
QWEN_SERVER_LOG = os.path.join(WORKER_DIR, "llama-qwen3vl.log")


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


def find_llama_server() -> str | None:
    configured = os.environ.get("IMAGE_SORTER_LLAMA_SERVER", "").strip()
    if configured and os.path.isfile(configured):
        return configured

    # Normaler PATH/Alias-Fall.
    for name in ("llama-server.exe", "llama-server"):
        found = shutil.which(name)
        if found and os.path.isfile(found):
            return found

    # WinGet-Portable-Pakete sind nicht in jedem bereits laufenden Prozess
    # sofort im PATH sichtbar. Deshalb zusätzlich direkt an den bekannten
    # WinGet-Orten suchen.
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        if local_app_data:
            local = Path(local_app_data)

            direct_candidates = (
                local / "Microsoft" / "WinGet" / "Links" / "llama-server.exe",
                local / "Microsoft" / "WindowsApps" / "llama-server.exe",
            )
            for candidate in direct_candidates:
                if candidate.is_file():
                    return str(candidate)

            packages = local / "Microsoft" / "WinGet" / "Packages"
            if packages.is_dir():
                package_dirs = sorted(
                    packages.glob("ggml.llamacpp_*"),
                    key=lambda path: path.stat().st_mtime if path.exists() else 0,
                    reverse=True,
                )
                for package_dir in package_dirs:
                    try:
                        matches = list(package_dir.rglob("llama-server.exe"))
                    except OSError:
                        matches = []
                    if matches:
                        return str(matches[0])

    return None


def qwen_gguf_ready() -> bool:
    return (
        os.path.isfile(QWEN3VL_MODEL_FILE)
        and os.path.getsize(QWEN3VL_MODEL_FILE) > 8_000_000_000
        and os.path.isfile(QWEN3VL_MMPROJ_FILE)
        and os.path.getsize(QWEN3VL_MMPROJ_FILE) > 1_000_000_000
    )


def snapshot() -> dict:
    return {
        **asdict(config),
        **asdict(runtime),
        "worker": "python-ai",
        "status": "ready",
        "capabilities": {
            "pillow": Image is not None,
            "opencv": cv2 is not None,
            "yunetModel": os.path.isfile(YUNET_MODEL),
            "sfaceModel": os.path.isfile(SFACE_MODEL),
            "nanodetModel": os.path.isfile(NANODET_MODEL),
            "yoloxModel": os.path.isfile(YOLOX_MODEL),
            "dogReIdModel": os.path.isfile(DOG_REID_MODEL),
            "siglip2Model": os.path.isfile(
                os.path.join(SIGLIP2_MODEL_DIR, "model.safetensors")
            ),
            "qwen3vlModel": qwen_gguf_ready(),
            "qwen3vlRuntime": find_llama_server() is not None,
            "torch": importlib.util.find_spec("torch") is not None,
            "transformers": importlib.util.find_spec("transformers") is not None,
            "onnxRuntime": importlib.util.find_spec("onnxruntime") is not None,
            "imageMetadata": Image is not None,
            "faceDetection": cv2 is not None and os.path.isfile(YUNET_MODEL),
            "faceEmbeddings": (
                cv2 is not None
                and np is not None
                and os.path.isfile(SFACE_MODEL)
            ),
            "petDetection": (
                cv2 is not None
                and np is not None
                and os.path.isfile(NANODET_MODEL)
                and os.path.isfile(YOLOX_MODEL)
            ),
            "petEmbeddings": (
                cv2 is not None
                and np is not None
                and importlib.util.find_spec("onnxruntime") is not None
                and os.path.isfile(DOG_REID_MODEL)
            ),
            "semanticEmbeddings": (
                Image is not None
                and importlib.util.find_spec("torch") is not None
                and importlib.util.find_spec("transformers") is not None
                and os.path.isfile(
                    os.path.join(SIGLIP2_MODEL_DIR, "model.safetensors")
                )
            ),
            "qwenObjectDetection": (
                Image is not None
                and ImageDraw is not None
                and ImageOps is not None
                and qwen_gguf_ready()
                and find_llama_server() is not None
            ),
        },
    }


def respond(request_id: str | None, *, result=None, error: str | None = None) -> None:
    message = {"id": request_id, "ok": error is None}
    if error is None:
        message["result"] = result
    else:
        message["error"] = error
    print(json.dumps(message, ensure_ascii=False), flush=True)


def report_progress(
    request_id: str | None,
    message: str,
    *,
    phase: str | None = None,
    current: int | None = None,
    total: int | None = None,
) -> None:
    if not request_id:
        return

    event = {
        "event": "progress",
        "requestId": request_id,
        "message": str(message),
    }
    if phase:
        event["phase"] = phase
    if current is not None:
        event["current"] = int(current)
    if total is not None:
        event["total"] = int(total)

    print(json.dumps(event, ensure_ascii=False), flush=True)


def require_file(payload: dict) -> str:
    file_path = os.path.abspath(str(payload.get("path", "")))
    if not file_path:
        raise RuntimeError("Dateipfad fehlt.")

    # Externe/rotierende Windows-Laufwerke können nach längerer Inaktivität
    # einige Sekunden zum Aufwachen benötigen. Ein einzelnes isfile() würde
    # dann fälschlich einen dauerhaften Fehler erzeugen.
    delays = (0.0, 0.5, 1.0, 2.0, 4.0)
    last_error: Exception | None = None

    for delay in delays:
        if delay > 0:
            time.sleep(delay)

        try:
            info = os.stat(file_path)
            if not os.path.isfile(file_path):
                continue

            # Ein kurzer echter Lesezugriff stellt sicher, dass nicht nur der
            # Verzeichniseintrag, sondern auch die Datei selbst erreichbar ist.
            with open(file_path, "rb") as handle:
                handle.read(1)

            if info.st_size >= 0:
                return file_path
        except Exception as exc:
            last_error = exc

    detail = f" ({last_error})" if last_error is not None else ""
    raise RuntimeError(
        f"Datei ist nach mehreren Zugriffsversuchen nicht erreichbar: "
        f"{file_path}{detail}"
    )


def verify_expected_size(file_path: str, payload: dict) -> None:
    expected_size = payload.get("expectedSizeBytes")
    if expected_size is None:
        return

    actual_size = os.path.getsize(file_path)
    if int(expected_size) != int(actual_size):
        raise RuntimeError(
            f"Dateigröße hat sich seit dem Katalogscan geändert: "
            f"{actual_size} statt {expected_size} Byte."
        )


def rational_to_float(value: Any) -> float | None:
    try:
        result = float(value)
        if math.isfinite(result):
            return result
    except Exception:
        pass
    return None


def gps_coordinate(values: Any, reference: Any) -> float | None:
    if not values or len(values) < 3:
        return None

    degrees = rational_to_float(values[0])
    minutes = rational_to_float(values[1])
    seconds = rational_to_float(values[2])

    if degrees is None or minutes is None or seconds is None:
        return None

    coordinate = degrees + minutes / 60.0 + seconds / 3600.0
    ref = str(reference or "").upper()

    if ref in {"S", "W"}:
        coordinate *= -1

    return coordinate


def normalize_exif_datetime(value: Any) -> str | None:
    if not value:
        return None

    text = str(value).strip()
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).isoformat(timespec="seconds")
        except ValueError:
            continue

    return text[:100] if text else None


def extract_image_metadata(file_path: str) -> dict:
    if Image is None:
        raise RuntimeError(
            "Pillow fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    with Image.open(file_path) as image:
        exif = image.getexif()

        captured_at = (
            exif.get(36867)
            or exif.get(36868)
            or exif.get(306)
        )

        gps_latitude = None
        gps_longitude = None

        try:
            gps = exif.get_ifd(34853)
            if gps:
                gps_latitude = gps_coordinate(gps.get(2), gps.get(1))
                gps_longitude = gps_coordinate(gps.get(4), gps.get(3))
        except Exception:
            gps_latitude = None
            gps_longitude = None

        return {
            "module": "image-metadata-v1",
            "width": int(image.width),
            "height": int(image.height),
            "format": str(image.format or ""),
            "mode": str(image.mode or ""),
            "orientation": int(exif.get(274) or 1),
            "capturedAt": normalize_exif_datetime(captured_at),
            "cameraMake": str(exif.get(271) or "").strip() or None,
            "cameraModel": str(exif.get(272) or "").strip() or None,
            "lensModel": str(exif.get(42036) or "").strip() or None,
            "gpsLatitude": gps_latitude,
            "gpsLongitude": gps_longitude,
        }


def detect_faces(file_path: str) -> dict:
    if cv2 is None:
        raise RuntimeError(
            "OpenCV fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    if not os.path.isfile(YUNET_MODEL):
        raise RuntimeError(
            "YuNet-Modell fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    image = cv2.imread(file_path, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Bild konnte von OpenCV nicht gelesen werden.")

    original_height, original_width = image.shape[:2]

    if original_width <= 0 or original_height <= 0:
        raise RuntimeError("Bild hat ungültige Abmessungen.")

    max_dimension = 1600
    scale = min(1.0, max_dimension / float(max(original_width, original_height)))

    if scale < 1.0:
        work_width = max(1, int(round(original_width * scale)))
        work_height = max(1, int(round(original_height * scale)))
        working = cv2.resize(
            image,
            (work_width, work_height),
            interpolation=cv2.INTER_AREA,
        )
    else:
        working = image
        work_height, work_width = working.shape[:2]

    detector = cv2.FaceDetectorYN.create(
        YUNET_MODEL,
        "",
        (work_width, work_height),
        0.80,
        0.30,
        5000,
    )

    detector.setInputSize((work_width, work_height))
    _retval, detections = detector.detect(working)

    faces: list[dict] = []

    if detections is not None:
        inverse_scale = 1.0 / scale

        for index, row in enumerate(detections):
            x = max(0.0, float(row[0]) * inverse_scale)
            y = max(0.0, float(row[1]) * inverse_scale)
            width = max(0.0, float(row[2]) * inverse_scale)
            height = max(0.0, float(row[3]) * inverse_scale)
            score = float(row[14])

            x = min(x, float(original_width))
            y = min(y, float(original_height))
            width = min(width, float(original_width) - x)
            height = min(height, float(original_height) - y)

            landmarks = []
            for landmark_index in range(5):
                lx = float(row[4 + landmark_index * 2]) * inverse_scale
                ly = float(row[5 + landmark_index * 2]) * inverse_scale
                landmarks.append({
                    "x": max(0.0, min(lx, float(original_width))),
                    "y": max(0.0, min(ly, float(original_height))),
                })

            faces.append({
                "index": index,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "score": score,
                "landmarks": landmarks,
            })

    return {
        "module": "face-detect-yunet-v1",
        "detector": "YuNet 2023mar",
        "imageWidth": int(original_width),
        "imageHeight": int(original_height),
        "faces": faces,
    }


def extract_face_embeddings(file_path: str, faces: list[dict]) -> dict:
    if cv2 is None or np is None:
        raise RuntimeError(
            "OpenCV/Numpy fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    if not os.path.isfile(SFACE_MODEL):
        raise RuntimeError(
            "SFace-Modell fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    image = cv2.imread(file_path, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Bild konnte von OpenCV nicht gelesen werden.")

    recognizer = cv2.FaceRecognizerSF.create(SFACE_MODEL, "")
    embeddings: list[dict] = []

    for face in faces:
        if not isinstance(face, dict):
            continue

        landmarks = face.get("landmarks") or []
        if not isinstance(landmarks, list) or len(landmarks) != 5:
            continue

        values = [
            float(face.get("x", 0.0)),
            float(face.get("y", 0.0)),
            float(face.get("width", 0.0)),
            float(face.get("height", 0.0)),
        ]

        valid_landmarks = True
        for landmark in landmarks:
            if not isinstance(landmark, dict):
                valid_landmarks = False
                break
            values.extend([
                float(landmark.get("x", 0.0)),
                float(landmark.get("y", 0.0)),
            ])

        if not valid_landmarks:
            continue

        detection = np.asarray(values, dtype=np.float32)

        try:
            aligned = recognizer.alignCrop(image, detection)
            feature = recognizer.feature(aligned)
        except Exception:
            continue

        vector = np.asarray(feature, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(vector))
        if not math.isfinite(norm) or norm <= 0.0:
            continue

        vector = vector / norm

        embeddings.append({
            "faceDetectionId": int(face.get("id", 0)),
            "vector": [float(value) for value in vector.tolist()],
        })

    return {
        "module": "face-embed-sface-v1",
        "model": "SFace 2021dec",
        "embeddings": embeddings,
    }


def nanodet_letterbox(image, target_size: tuple[int, int] = (416, 416)):
    target_h, target_w = target_size
    source_h, source_w = image.shape[:2]

    if source_h <= 0 or source_w <= 0:
        raise RuntimeError("Bild hat ungültige Abmessungen.")

    scale = min(target_w / float(source_w), target_h / float(source_h))
    new_w = max(1, int(round(source_w * scale)))
    new_h = max(1, int(round(source_h * scale)))

    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
    left = (target_w - new_w) // 2
    top = (target_h - new_h) // 2
    right = target_w - new_w - left
    bottom = target_h - new_h - top

    padded = cv2.copyMakeBorder(
        resized,
        top,
        bottom,
        left,
        right,
        cv2.BORDER_CONSTANT,
        value=0,
    )

    return padded, scale, left, top


def detect_pets(file_path: str) -> dict:
    if cv2 is None or np is None:
        raise RuntimeError(
            "OpenCV/Numpy fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    if not os.path.isfile(NANODET_MODEL):
        raise RuntimeError(
            "NanoDet-Modell fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    image = cv2.imread(file_path, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Bild konnte von OpenCV nicht gelesen werden.")

    original_height, original_width = image.shape[:2]
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    work, scale, left, top = nanodet_letterbox(rgb)

    net = cv2.dnn.readNet(NANODET_MODEL)

    work_float = work.astype(np.float32)
    mean = np.array([103.53, 116.28, 123.675], dtype=np.float32).reshape(1, 1, 3)
    std = np.array([57.375, 57.12, 58.395], dtype=np.float32).reshape(1, 1, 3)
    normalized = (work_float - mean) / std

    blob = cv2.dnn.blobFromImage(normalized)
    net.setInput(blob)
    outputs = net.forward(net.getUnconnectedOutLayersNames())

    strides = (8, 16, 32, 64)
    reg_max = 7
    project = np.arange(reg_max + 1, dtype=np.float32)
    candidates_by_class: dict[int, list[tuple[list[float], float]]] = {}

    # Bewusst etwas niedriger Roh-Schwellwert: schwächere echte Treffer dürfen
    # in die spätere Zwei-Modell-Fusion gelangen. Erst dort wird entschieden,
    # ob ein Motiv belastbar genug für Anzeige und Suche ist.
    raw_threshold = 0.25

    for stride, cls_score, bbox_pred in zip(
        strides,
        outputs[::2],
        outputs[1::2],
    ):
        if cls_score.ndim == 3:
            cls_score = cls_score.squeeze(axis=0)
        if bbox_pred.ndim == 3:
            bbox_pred = bbox_pred.squeeze(axis=0)

        feat_h = 416 // stride
        feat_w = 416 // stride
        shift_x = np.arange(0, feat_w, dtype=np.float32) * stride
        shift_y = np.arange(0, feat_h, dtype=np.float32) * stride
        xv, yv = np.meshgrid(shift_x, shift_y)
        anchors = np.column_stack((
            xv.reshape(-1) + 0.5 * (stride - 1),
            yv.reshape(-1) + 0.5 * (stride - 1),
        ))

        exp_values = np.exp(bbox_pred.reshape(-1, reg_max + 1))
        probabilities = exp_values / np.sum(exp_values, axis=1, keepdims=True)
        distances = np.dot(probabilities, project).reshape(-1, 4) * stride

        max_scores = cls_score.max(axis=1)
        if cls_score.shape[0] > 1000:
            top_indices = max_scores.argsort()[::-1][:1000]
            anchors = anchors[top_indices]
            distances = distances[top_indices]
            cls_score = cls_score[top_indices]

        classes = np.argmax(cls_score, axis=1)
        confidences = np.max(cls_score, axis=1)

        for anchor, distance, class_id, confidence in zip(
            anchors,
            distances,
            classes,
            confidences,
        ):
            class_id = int(class_id)
            confidence = float(confidence)

            if (
                class_id < 0
                or class_id >= len(COCO_CLASS_NAMES)
                or confidence < raw_threshold
            ):
                continue

            x1 = max(0.0, float(anchor[0] - distance[0]))
            y1 = max(0.0, float(anchor[1] - distance[1]))
            x2 = min(416.0, float(anchor[0] + distance[2]))
            y2 = min(416.0, float(anchor[1] + distance[3]))

            box = [x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1)]
            candidates_by_class.setdefault(class_id, []).append((box, confidence))

    pets: list[dict] = []
    objects: list[dict] = []

    # NMS klassenweise ausführen. So verdrängt z. B. eine Person kein
    # überlappendes Fahrrad oder einen Hund.
    for class_id, candidates in candidates_by_class.items():
        boxes = [box for box, _score in candidates]
        scores = [score for _box, score in candidates]
        keep = cv2.dnn.NMSBoxes(boxes, scores, raw_threshold, 0.50)

        for raw_index in keep:
            local_index = int(np.asarray(raw_index).reshape(-1)[0])
            x, y, width, height = boxes[local_index]
            confidence = float(scores[local_index])

            original_x = max(0.0, (x - left) / scale)
            original_y = max(0.0, (y - top) / scale)
            original_width_box = max(0.0, width / scale)
            original_height_box = max(0.0, height / scale)

            original_x = min(original_x, float(original_width))
            original_y = min(original_y, float(original_height))
            original_width_box = min(
                original_width_box,
                float(original_width) - original_x,
            )
            original_height_box = min(
                original_height_box,
                float(original_height) - original_y,
            )

            if original_width_box <= 1.0 or original_height_box <= 1.0:
                continue

            item = {
                "label": COCO_CLASS_NAMES[class_id],
                "classId": class_id,
                "score": confidence,
                "x": original_x,
                "y": original_y,
                "width": original_width_box,
                "height": original_height_box,
            }
            objects.append(item)

            # Für die bestehende Haustier-Fusion bleibt die bisherige
            # Mindestqualität erhalten.
            if class_id in (15, 16) and confidence >= 0.38:
                pets.append({
                    "class": "cat" if class_id == 15 else "dog",
                    "classId": class_id,
                    "score": confidence,
                    "x": original_x,
                    "y": original_y,
                    "width": original_width_box,
                    "height": original_height_box,
                })

    objects.sort(key=lambda item: float(item["score"]), reverse=True)
    pets.sort(key=lambda pet: float(pet["score"]), reverse=True)

    return {
        "module": "pet-detect-nanodet-v1",
        "detector": "NanoDet 2022nov",
        "imageWidth": int(original_width),
        "imageHeight": int(original_height),
        "pets": pets,
        "objects": objects,
    }

def yolox_letterbox(image, target_size: tuple[int, int] = (640, 640)):
    target_h, target_w = target_size
    source_h, source_w = image.shape[:2]

    if source_h <= 0 or source_w <= 0:
        raise RuntimeError("Bild hat ungültige Abmessungen.")

    ratio = min(target_h / float(source_h), target_w / float(source_w))
    resized_w = max(1, int(source_w * ratio))
    resized_h = max(1, int(source_h * ratio))

    resized = cv2.resize(
        image,
        (resized_w, resized_h),
        interpolation=cv2.INTER_LINEAR,
    ).astype(np.float32)

    padded = np.ones((target_h, target_w, 3), dtype=np.float32) * 114.0
    padded[:resized_h, :resized_w] = resized

    return padded, ratio


def yolox_grids_and_strides():
    grids = []
    expanded_strides = []

    for stride in (8, 16, 32):
        height = 640 // stride
        width = 640 // stride
        xv, yv = np.meshgrid(np.arange(width), np.arange(height))
        grid = np.stack((xv, yv), axis=2).reshape(1, -1, 2)
        grids.append(grid)
        expanded_strides.append(
            np.full((1, grid.shape[1], 1), stride, dtype=np.float32)
        )

    return (
        np.concatenate(grids, axis=1).astype(np.float32),
        np.concatenate(expanded_strides, axis=1).astype(np.float32),
    )


def detect_pets_yolox(file_path: str) -> dict:
    if cv2 is None or np is None:
        raise RuntimeError(
            "OpenCV/Numpy fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    if not os.path.isfile(YOLOX_MODEL):
        raise RuntimeError(
            "YOLOX-S-Modell fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    image = cv2.imread(file_path, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Bild konnte von OpenCV nicht gelesen werden.")

    original_height, original_width = image.shape[:2]
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    work, ratio = yolox_letterbox(rgb)

    blob = np.transpose(work, (2, 0, 1))[np.newaxis, :, :, :].astype(np.float32)

    net = cv2.dnn.readNet(YOLOX_MODEL)
    net.setInput(blob)
    outputs = net.forward(net.getUnconnectedOutLayersNames())

    if not outputs:
        raise RuntimeError("YOLOX-S hat keine Ausgabedaten geliefert.")

    raw = outputs[0]
    if raw.ndim == 3:
        detections = raw[0].copy()
    elif raw.ndim == 2:
        detections = raw.copy()
    else:
        raise RuntimeError(f"Unerwartete YOLOX-S-Ausgabeform: {raw.shape}")

    grids, expanded_strides = yolox_grids_and_strides()
    grid = grids[0]
    strides = expanded_strides[0]

    if detections.shape[0] != grid.shape[0]:
        raise RuntimeError(
            f"YOLOX-S-Ausgabe passt nicht zum 640x640-Raster: "
            f"{detections.shape[0]} statt {grid.shape[0]}."
        )

    detections[:, 0:2] = (detections[:, 0:2] + grid) * strides
    detections[:, 2:4] = np.exp(detections[:, 2:4]) * strides

    boxes_xywh = np.empty_like(detections[:, 0:4])
    boxes_xywh[:, 0] = detections[:, 0] - detections[:, 2] / 2.0
    boxes_xywh[:, 1] = detections[:, 1] - detections[:, 3] / 2.0
    boxes_xywh[:, 2] = detections[:, 2]
    boxes_xywh[:, 3] = detections[:, 3]

    class_scores = detections[:, 4:5] * detections[:, 5:]
    pet_candidates: list[dict] = []
    object_candidates: list[dict] = []

    class_count = min(class_scores.shape[1], len(COCO_CLASS_NAMES))

    for class_id in range(class_count):
        scores = class_scores[:, class_id]
        indices = np.where(scores >= 0.25)[0]
        if indices.size == 0:
            continue

        boxes = [boxes_xywh[index].tolist() for index in indices]
        confidences = [float(scores[index]) for index in indices]

        keep = cv2.dnn.NMSBoxes(
            boxes,
            confidences,
            0.25,
            0.50,
        )

        for raw_index in keep:
            local_index = int(np.asarray(raw_index).reshape(-1)[0])
            source_index = int(indices[local_index])
            x, y, width, height = boxes_xywh[source_index]

            original_x = max(0.0, float(x) / ratio)
            original_y = max(0.0, float(y) / ratio)
            original_width_box = max(0.0, float(width) / ratio)
            original_height_box = max(0.0, float(height) / ratio)

            original_x = min(original_x, float(original_width))
            original_y = min(original_y, float(original_height))
            original_width_box = min(
                original_width_box,
                float(original_width) - original_x,
            )
            original_height_box = min(
                original_height_box,
                float(original_height) - original_y,
            )

            if original_width_box <= 1.0 or original_height_box <= 1.0:
                continue

            item = {
                "label": COCO_CLASS_NAMES[class_id],
                "classId": class_id,
                "score": float(scores[source_index]),
                "x": original_x,
                "y": original_y,
                "width": original_width_box,
                "height": original_height_box,
            }
            object_candidates.append(item)

            if class_id in (15, 16):
                pet_candidates.append({
                    "class": "cat" if class_id == 15 else "dog",
                    "classId": class_id,
                    "score": item["score"],
                    "x": item["x"],
                    "y": item["y"],
                    "width": item["width"],
                    "height": item["height"],
                })

    object_candidates.sort(
        key=lambda item: float(item["score"]),
        reverse=True,
    )
    pet_candidates.sort(key=lambda pet: float(pet["score"]), reverse=True)

    return {
        "module": "pet-detect-yolox-v1",
        "detector": "YOLOX-S 2022nov",
        "imageWidth": int(original_width),
        "imageHeight": int(original_height),
        "pets": pet_candidates,
        "objects": object_candidates,
    }


def box_iou(a: dict, b: dict) -> float:
    ax1 = float(a["x"])
    ay1 = float(a["y"])
    ax2 = ax1 + float(a["width"])
    ay2 = ay1 + float(a["height"])

    bx1 = float(b["x"])
    by1 = float(b["y"])
    bx2 = bx1 + float(b["width"])
    by2 = by1 + float(b["height"])

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    intersection = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (
        max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
        + max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
        - intersection
    )

    return intersection / union if union > 0.0 else 0.0


def fuse_object_detections(detections: list[dict]) -> list[dict]:
    cleaned: list[dict] = []

    for raw in detections:
        if not isinstance(raw, dict):
            continue

        label = str(raw.get("label", "")).strip()
        detector = str(raw.get("detector", "")).strip()
        score = float(raw.get("score", 0.0))
        class_id = int(raw.get("classId", -1))

        if (
            not label
            or not detector
            or class_id < 0
            or class_id >= len(COCO_CLASS_NAMES)
            or label != COCO_CLASS_NAMES[class_id]
        ):
            continue

        item = {
            "label": label,
            "classId": class_id,
            "detector": detector,
            "score": score,
            "x": float(raw.get("x", 0.0)),
            "y": float(raw.get("y", 0.0)),
            "width": float(raw.get("width", 0.0)),
            "height": float(raw.get("height", 0.0)),
        }

        if (
            item["width"] <= 1.0
            or item["height"] <= 1.0
            or not math.isfinite(item["score"])
        ):
            continue

        cleaned.append(item)

    cleaned.sort(key=lambda item: float(item["score"]), reverse=True)
    groups: list[list[dict]] = []

    for item in cleaned:
        best_group = None
        best_iou = 0.0

        for group in groups:
            if str(group[0]["label"]) != str(item["label"]):
                continue
            if any(
                str(member["detector"]) == str(item["detector"])
                for member in group
            ):
                continue

            weights = np.array(
                [max(0.01, float(member["score"])) for member in group],
                dtype=np.float32,
            )
            centroid = {
                key: float(np.average(
                    [float(member[key]) for member in group],
                    weights=weights,
                ))
                for key in ("x", "y", "width", "height")
            }

            overlap = box_iou(item, centroid)
            if overlap >= 0.35 and overlap > best_iou:
                best_iou = overlap
                best_group = group

        if best_group is None:
            groups.append([item])
        else:
            best_group.append(item)

    fused: list[dict] = []
    common_large_classes = {
        "person", "bicycle", "car", "motorcycle", "bus", "train",
        "truck", "dog", "cat", "horse",
    }

    for group in groups:
        sources = sorted({str(member["detector"]) for member in group})
        scores = [float(member["score"]) for member in group]
        agreement_count = len(sources)
        label = str(group[0]["label"])
        best_score = max(scores)

        if agreement_count == 1:
            detector = sources[0]
            if label in common_large_classes:
                minimum = 0.58 if detector.startswith("YOLOX") else 0.68
            else:
                minimum = 0.64 if detector.startswith("YOLOX") else 0.72

            if best_score < minimum:
                continue
        else:
            # Zwei unabhängige Modelle dürfen schwächere Einzelwerte retten.
            # Extrem schwache Doppeltreffer werden trotzdem verworfen.
            if best_score < 0.32 or (sum(scores) / len(scores)) < 0.28:
                continue

        weights = np.array(
            [max(0.01, score) for score in scores],
            dtype=np.float32,
        )
        box = {
            key: float(np.average(
                [float(member[key]) for member in group],
                weights=weights,
            ))
            for key in ("x", "y", "width", "height")
        }

        fused_score = (
            min(0.99, best_score + 0.10 * (1.0 - best_score))
            if agreement_count >= 2
            else best_score
        )

        fused.append({
            "label": label,
            "classId": int(group[0]["classId"]),
            "score": float(fused_score),
            "x": box["x"],
            "y": box["y"],
            "width": box["width"],
            "height": box["height"],
            "agreementCount": agreement_count,
            "sources": sources,
        })

    fused.sort(
        key=lambda item: (
            -int(item["agreementCount"]),
            -float(item["score"]),
            str(item["label"]),
        )
    )
    return fused


def fuse_pet_detections(
    detections: list[dict],
    objects: list[dict] | None = None,
) -> dict:
    cleaned: list[dict] = []

    for raw in detections:
        if not isinstance(raw, dict):
            continue

        pet_class = raw.get("petClass")
        detector = str(raw.get("detector", "")).strip()
        score = float(raw.get("score", 0.0))

        if pet_class not in ("dog", "cat") or not detector:
            continue

        item = {
            "petClass": pet_class,
            "classId": 16 if pet_class == "dog" else 15,
            "detector": detector,
            "score": score,
            "x": float(raw.get("x", 0.0)),
            "y": float(raw.get("y", 0.0)),
            "width": float(raw.get("width", 0.0)),
            "height": float(raw.get("height", 0.0)),
        }

        if (
            item["width"] <= 1.0
            or item["height"] <= 1.0
            or not math.isfinite(item["score"])
        ):
            continue

        cleaned.append(item)

    cleaned.sort(key=lambda item: float(item["score"]), reverse=True)
    groups: list[list[dict]] = []

    for item in cleaned:
        best_group = None
        best_iou = 0.0

        for group in groups:
            if any(
                str(member["detector"]) == str(item["detector"])
                for member in group
            ):
                continue

            if str(group[0]["petClass"]) != str(item["petClass"]):
                continue

            weights = np.array(
                [max(0.01, float(member["score"])) for member in group],
                dtype=np.float32,
            )
            centroid = {
                key: float(np.average(
                    [float(member[key]) for member in group],
                    weights=weights,
                ))
                for key in ("x", "y", "width", "height")
            }

            overlap = box_iou(item, centroid)
            if overlap >= 0.45 and overlap > best_iou:
                best_iou = overlap
                best_group = group

        if best_group is None:
            groups.append([item])
        else:
            best_group.append(item)

    fused: list[dict] = []

    for group in groups:
        sources = sorted({str(member["detector"]) for member in group})
        scores = [float(member["score"]) for member in group]
        agreement_count = len(sources)

        if agreement_count == 1:
            detector = sources[0]
            minimum = 0.45 if detector.startswith("YOLOX") else 0.50
            if max(scores) < minimum:
                continue

        weights = np.array(
            [max(0.01, score) for score in scores],
            dtype=np.float32,
        )

        box = {
            key: float(np.average(
                [float(member[key]) for member in group],
                weights=weights,
            ))
            for key in ("x", "y", "width", "height")
        }

        best_score = max(scores)
        fused_score = (
            min(0.99, best_score + 0.08 * (1.0 - best_score))
            if agreement_count >= 2
            else best_score
        )

        fused.append({
            "class": str(group[0]["petClass"]),
            "classId": int(group[0]["classId"]),
            "score": float(fused_score),
            "x": box["x"],
            "y": box["y"],
            "width": box["width"],
            "height": box["height"],
            "agreementCount": agreement_count,
            "sources": sources,
        })

    fused.sort(
        key=lambda pet: (
            -int(pet["agreementCount"]),
            -float(pet["score"]),
        )
    )

    return {
        "module": "pet-fuse-ensemble-v1",
        "fusion": "NanoDet+YOLOX-S weighted-box-v1",
        "pets": fused,
        "objectFusion": "NanoDet+YOLOX-S consensus-v1",
        "objects": fuse_object_detections(objects or []),
    }

def dog_reid_session():
    global _dog_reid_session, _onnxruntime_module

    if not os.path.isfile(DOG_REID_MODEL):
        raise RuntimeError(
            "Dog-ReID-Modell fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    if _onnxruntime_module is None:
        try:
            import onnxruntime as runtime
        except Exception as exc:
            raise RuntimeError(
                "ONNX Runtime konnte für Dog-ReID nicht geladen werden: "
                f"{exc}"
            ) from exc

        _onnxruntime_module = runtime

    runtime = _onnxruntime_module

    if _dog_reid_session is None:
        options = runtime.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = runtime.ExecutionMode.ORT_SEQUENTIAL
        _dog_reid_session = runtime.InferenceSession(
            DOG_REID_MODEL,
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    return _dog_reid_session


def dog_crop_with_margin(image, box: dict, margin_fraction: float = 0.10):
    image_height, image_width = image.shape[:2]

    x = float(box.get("x", 0.0))
    y = float(box.get("y", 0.0))
    width = max(1.0, float(box.get("width", 0.0)))
    height = max(1.0, float(box.get("height", 0.0)))

    margin_x = width * margin_fraction
    margin_y = height * margin_fraction

    left = max(0, int(math.floor(x - margin_x)))
    top = max(0, int(math.floor(y - margin_y)))
    right = min(image_width, int(math.ceil(x + width + margin_x)))
    bottom = min(image_height, int(math.ceil(y + height + margin_y)))

    if right <= left or bottom <= top:
        raise RuntimeError("Hundeausschnitt hat ungültige Abmessungen.")

    return image[top:bottom, left:right]


def extract_dog_embeddings(file_path: str, pets: list[dict]) -> dict:
    if cv2 is None or np is None:
        raise RuntimeError(
            "OpenCV/Numpy fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    dog_pets = [
        pet
        for pet in pets
        if isinstance(pet, dict) and pet.get("petClass") == "dog"
    ]

    if not dog_pets:
        return {
            "module": "pet-embed-dogreid-v1",
            "model": "DogReID DINOv2-B14 0.2.0",
            "embeddings": [],
        }

    image = cv2.imread(file_path, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Bild konnte von OpenCV nicht gelesen werden.")

    session = dog_reid_session()
    input_info = session.get_inputs()[0]
    input_name = input_info.name
    output_name = session.get_outputs()[0].name

    mean = np.asarray([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
    std = np.asarray([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)

    embeddings: list[dict] = []

    for pet in dog_pets:

        pet_detection_id = int(pet.get("id", 0))
        if pet_detection_id <= 0:
            continue

        try:
            crop = dog_crop_with_margin(image, pet, 0.10)
            crop = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            crop = cv2.resize(crop, (224, 224), interpolation=cv2.INTER_AREA)
            normalized = crop.astype(np.float32) / 255.0
            normalized = (normalized - mean) / std
            tensor = np.transpose(normalized, (2, 0, 1))[np.newaxis, :, :, :]
            tensor = np.ascontiguousarray(tensor, dtype=np.float32)

            result = session.run([output_name], {input_name: tensor})[0]
            vector = np.asarray(result, dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(vector))

            if not math.isfinite(norm) or norm <= 0.0:
                continue

            vector = vector / norm

            embeddings.append({
                "petDetectionId": pet_detection_id,
                "vector": [float(value) for value in vector.tolist()],
            })
        except Exception:
            continue

    return {
        "module": "pet-embed-dogreid-v1",
        "model": "DogReID DINOv2-B14 0.2.0",
        "embeddings": embeddings,
    }


def cluster_pet_embeddings(
    pets: list[dict],
    cannot_links: list[dict] | None = None,
    cluster_threshold: float = 0.68,
    verification_threshold: float = 0.60,
    min_cluster_size: int = 2,
) -> dict:
    if np is None:
        raise RuntimeError(
            "Numpy fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    cluster_threshold = max(
        verification_threshold,
        min(0.95, float(cluster_threshold)),
    )
    verification_threshold = max(
        0.0,
        min(cluster_threshold, float(verification_threshold)),
    )
    min_cluster_size = max(2, min(20, int(min_cluster_size)))

    canonical_by_content: dict[str, dict] = {}
    duplicates_by_content: dict[str, list[dict]] = {}

    for raw in pets:
        if not isinstance(raw, dict) or raw.get("petClass") != "dog":
            continue

        pet_id = int(raw.get("petDetectionId", 0))
        content_key = str(raw.get("contentKey", "")).strip()
        vector_values = raw.get("vector")

        if pet_id <= 0 or not content_key or not isinstance(vector_values, list):
            continue

        vector = np.asarray(vector_values, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(vector))
        if vector.size == 0 or not math.isfinite(norm) or norm <= 0.0:
            continue

        vector = vector / norm
        item = {
            "petDetectionId": pet_id,
            "contentKey": content_key,
            "vector": vector,
        }

        duplicates_by_content.setdefault(content_key, []).append(item)
        canonical_by_content.setdefault(content_key, item)

    canonical = sorted(
        canonical_by_content.values(),
        key=lambda item: int(item["petDetectionId"]),
    )

    pet_to_content: dict[int, str] = {}
    for content_key, duplicates in duplicates_by_content.items():
        for duplicate in duplicates:
            pet_to_content[int(duplicate["petDetectionId"])] = content_key

    blocked_content_pairs: set[tuple[str, str]] = set()
    for raw_link in cannot_links or []:
        if not isinstance(raw_link, dict):
            continue

        pet_a_id = int(raw_link.get("petAId", 0))
        pet_b_id = int(raw_link.get("petBId", 0))
        content_a = pet_to_content.get(pet_a_id)
        content_b = pet_to_content.get(pet_b_id)

        if not content_a or not content_b or content_a == content_b:
            continue

        blocked_content_pairs.add(tuple(sorted((content_a, content_b))))

    clusters: list[dict] = []

    for item in canonical:
        vector = item["vector"]
        best_index = None
        best_similarity = -1.0

        for index, cluster in enumerate(clusters):
            item_content = str(item["contentKey"])
            blocked = any(
                tuple(sorted((item_content, str(member["contentKey"]))))
                in blocked_content_pairs
                for member in cluster["canonicalMembers"]
            )
            if blocked:
                continue

            centroid_similarity = float(np.dot(vector, cluster["centroid"]))
            representative_similarity = float(
                np.dot(vector, cluster["representativeVector"])
            )

            if (
                centroid_similarity >= cluster_threshold
                and representative_similarity >= verification_threshold
                and centroid_similarity > best_similarity
            ):
                best_index = index
                best_similarity = centroid_similarity

        if best_index is None:
            clusters.append({
                "centroid": vector.copy(),
                "representativeVector": vector.copy(),
                "canonicalMembers": [item],
            })
            continue

        cluster = clusters[best_index]
        cluster["canonicalMembers"].append(item)

        stacked = np.vstack([
            member["vector"]
            for member in cluster["canonicalMembers"]
        ])
        centroid = np.mean(stacked, axis=0)
        centroid_norm = float(np.linalg.norm(centroid))
        if centroid_norm > 0.0:
            centroid = centroid / centroid_norm
        cluster["centroid"] = centroid

        representative = max(
            cluster["canonicalMembers"],
            key=lambda member: float(np.dot(member["vector"], centroid)),
        )
        cluster["representativeVector"] = representative["vector"]

    result_clusters: list[dict] = []

    for cluster in clusters:
        canonical_members = cluster["canonicalMembers"]
        if len(canonical_members) < min_cluster_size:
            continue

        centroid = cluster["centroid"]
        representative = max(
            canonical_members,
            key=lambda member: float(np.dot(member["vector"], centroid)),
        )

        members: list[dict] = []
        similarities: list[float] = []

        for canonical_member in canonical_members:
            content_key = canonical_member["contentKey"]
            similarity = float(np.dot(canonical_member["vector"], centroid))
            similarity = max(-1.0, min(1.0, similarity))

            for duplicate in duplicates_by_content.get(content_key, []):
                members.append({
                    "petDetectionId": int(duplicate["petDetectionId"]),
                    "similarity": similarity,
                })
                similarities.append(similarity)

        if not members:
            continue

        result_clusters.append({
            "representativePetId": int(representative["petDetectionId"]),
            "averageSimilarity": float(sum(similarities) / len(similarities)),
            "minSimilarity": float(min(similarities)),
            "members": members,
        })

    result_clusters.sort(
        key=lambda cluster: (
            -len(cluster["members"]),
            -float(cluster["averageSimilarity"]),
            int(cluster["representativePetId"]),
        )
    )

    return {
        "algorithm": "dogreid-centroid-v1",
        "clusterThreshold": cluster_threshold,
        "verificationThreshold": verification_threshold,
        "minClusterSize": min_cluster_size,
        "clusterCount": len(result_clusters),
        "clusters": result_clusters,
    }


def cluster_face_embeddings(
    faces: list[dict],
    cannot_links: list[dict] | None = None,
    cluster_threshold: float = 0.50,
    verification_threshold: float = 0.363,
) -> dict:
    if np is None:
        raise RuntimeError(
            "Numpy fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    cluster_threshold = max(verification_threshold, min(0.95, float(cluster_threshold)))
    verification_threshold = max(0.0, min(cluster_threshold, float(verification_threshold)))

    canonical_by_content: dict[str, dict] = {}
    duplicates_by_content: dict[str, list[dict]] = {}

    for raw in faces:
        if not isinstance(raw, dict):
            continue

        face_id = int(raw.get("faceDetectionId", 0))
        content_key = str(raw.get("contentKey", "")).strip()
        vector_values = raw.get("vector")

        if face_id <= 0 or not content_key or not isinstance(vector_values, list):
            continue

        vector = np.asarray(vector_values, dtype=np.float32).reshape(-1)
        if vector.size == 0:
            continue

        norm = float(np.linalg.norm(vector))
        if not math.isfinite(norm) or norm <= 0.0:
            continue

        vector = vector / norm
        item = {
            "faceDetectionId": face_id,
            "contentKey": content_key,
            "vector": vector,
        }

        duplicates_by_content.setdefault(content_key, []).append(item)
        canonical_by_content.setdefault(content_key, item)

    canonical = sorted(
        canonical_by_content.values(),
        key=lambda item: int(item["faceDetectionId"]),
    )

    face_to_content: dict[int, str] = {}
    for content_key, duplicates in duplicates_by_content.items():
        for duplicate in duplicates:
            face_to_content[int(duplicate["faceDetectionId"])] = content_key

    blocked_content_pairs: set[tuple[str, str]] = set()
    for raw_link in cannot_links or []:
        if not isinstance(raw_link, dict):
            continue

        face_a_id = int(raw_link.get("faceAId", 0))
        face_b_id = int(raw_link.get("faceBId", 0))
        content_a = face_to_content.get(face_a_id)
        content_b = face_to_content.get(face_b_id)

        if not content_a or not content_b or content_a == content_b:
            continue

        blocked_content_pairs.add(tuple(sorted((content_a, content_b))))

    clusters: list[dict] = []

    for item in canonical:
        vector = item["vector"]
        best_index = None
        best_similarity = -1.0

        for index, cluster in enumerate(clusters):
            item_content = str(item["contentKey"])
            blocked = any(
                tuple(sorted((item_content, str(member["contentKey"]))))
                in blocked_content_pairs
                for member in cluster["canonicalMembers"]
            )
            if blocked:
                continue

            centroid_similarity = float(np.dot(vector, cluster["centroid"]))
            representative_similarity = float(
                np.dot(vector, cluster["representativeVector"])
            )

            if (
                centroid_similarity >= cluster_threshold
                and representative_similarity >= verification_threshold
                and centroid_similarity > best_similarity
            ):
                best_index = index
                best_similarity = centroid_similarity

        if best_index is None:
            clusters.append({
                "centroid": vector.copy(),
                "representativeVector": vector.copy(),
                "canonicalMembers": [item],
            })
            continue

        cluster = clusters[best_index]
        cluster["canonicalMembers"].append(item)

        stacked = np.vstack([
            member["vector"]
            for member in cluster["canonicalMembers"]
        ])
        centroid = np.mean(stacked, axis=0)
        centroid_norm = float(np.linalg.norm(centroid))
        if centroid_norm > 0.0:
            centroid = centroid / centroid_norm
        cluster["centroid"] = centroid

        representative = max(
            cluster["canonicalMembers"],
            key=lambda member: float(np.dot(member["vector"], centroid)),
        )
        cluster["representativeVector"] = representative["vector"]

    result_clusters: list[dict] = []

    for cluster in clusters:
        centroid = cluster["centroid"]
        canonical_members = cluster["canonicalMembers"]

        representative = max(
            canonical_members,
            key=lambda member: float(np.dot(member["vector"], centroid)),
        )

        members: list[dict] = []
        similarities: list[float] = []

        for canonical_member in canonical_members:
            content_key = canonical_member["contentKey"]
            similarity = float(np.dot(canonical_member["vector"], centroid))
            similarity = max(-1.0, min(1.0, similarity))

            for duplicate in duplicates_by_content.get(content_key, []):
                members.append({
                    "faceDetectionId": int(duplicate["faceDetectionId"]),
                    "similarity": similarity,
                })
                similarities.append(similarity)

        members.sort(key=lambda member: int(member["faceDetectionId"]))

        if not members:
            continue

        result_clusters.append({
            "representativeFaceId": int(representative["faceDetectionId"]),
            "averageSimilarity": float(sum(similarities) / len(similarities)),
            "minSimilarity": float(min(similarities)),
            "members": members,
        })

    result_clusters.sort(
        key=lambda cluster: (
            -len(cluster["members"]),
            -float(cluster["averageSimilarity"]),
            int(cluster["representativeFaceId"]),
        )
    )

    return {
        "algorithm": "person-centroid-v1",
        "clusterThreshold": cluster_threshold,
        "verificationThreshold": verification_threshold,
        "clusterCount": len(result_clusters),
        "clusters": result_clusters,
    }


def ensure_torch_transformers() -> None:
    global torch, AutoModel, AutoProcessor, _torch_transformers_import_error

    if torch is not None and AutoModel is not None and AutoProcessor is not None:
        return

    if _torch_transformers_import_error is not None:
        raise RuntimeError(
            "PyTorch/Transformers konnte zuvor nicht geladen werden: "
            + _torch_transformers_import_error
        )

    try:
        import torch as torch_module
        from transformers import AutoModel as AutoModelClass
        from transformers import AutoProcessor as AutoProcessorClass

        torch = torch_module
        AutoModel = AutoModelClass
        AutoProcessor = AutoProcessorClass
    except Exception as exc:
        _torch_transformers_import_error = str(exc)
        raise RuntimeError(
            "PyTorch/Transformers konnte für SigLIP2 nicht geladen werden: "
            + str(exc)
        ) from exc


def release_torch_memory() -> None:
    gc.collect()
    if torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()


def unload_siglip2() -> None:
    global _siglip2_model, _siglip2_processor, _siglip2_coco_text_features
    _siglip2_model = None
    _siglip2_processor = None
    _siglip2_coco_text_features = None
    release_torch_memory()


def unload_qwen3vl() -> None:
    global _qwen_server_process, _qwen_server_port, _qwen_server_log_handle

    process = _qwen_server_process
    _qwen_server_process = None
    _qwen_server_port = None

    if process is not None and process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=8)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    if _qwen_server_log_handle is not None:
        try:
            _qwen_server_log_handle.close()
        except Exception:
            pass
        _qwen_server_log_handle = None

    release_torch_memory()


def prepare_for_qwen() -> None:
    global _dog_reid_session, _onnxruntime_module

    # Qwen ist die letzte und speicherintensivste Pipeline-Stufe. Alle großen
    # zuvor verwendeten Modellinstanzen werden deshalb explizit freigegeben.
    unload_siglip2()

    _dog_reid_session = None
    _onnxruntime_module = None

    release_torch_memory()
    gc.collect()


def siglip2_runtime():
    global _siglip2_model, _siglip2_processor

    if Image is None or ImageOps is None:
        raise RuntimeError(
            "Pillow fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    ensure_torch_transformers()

    weights = os.path.join(SIGLIP2_MODEL_DIR, "model.safetensors")
    if not os.path.isfile(weights):
        raise RuntimeError(
            "SigLIP2 So400m NaFlex fehlt. Einmal 'npm.cmd run setup:ai' ausführen. "
            "Der einmalige Modell-Download ist etwa 4,6 GB groß."
        )

    if _siglip2_processor is None:
        _siglip2_processor = AutoProcessor.from_pretrained(
            SIGLIP2_MODEL_DIR,
            local_files_only=True,
            use_fast=False,
        )

    if _siglip2_model is None:
        # Qwen3-VL ist deutlich größer. Die beiden großen Modelle werden
        # absichtlich nicht gleichzeitig im RAM gehalten.
        unload_qwen3vl()

        # Genauigkeit ist hier wichtiger als Laufzeit: kein INT8/INT4 und keine
        # aggressive Quantisierung. FP32 ist auch auf CPU reproduzierbar.
        _siglip2_model = AutoModel.from_pretrained(
            SIGLIP2_MODEL_DIR,
            local_files_only=True,
            torch_dtype=torch.float32,
        )
        _siglip2_model.eval()

    return _siglip2_processor, _siglip2_model


def siglip2_feature_tensor(features):
    # Transformers liefert bei SigLIP2 je nach Version entweder direkt einen
    # Tensor oder ein BaseModelOutputWithPooling. Für Ähnlichkeitssuche ist
    # dessen trainierter pooler_output der richtige einzelne Bild-/Textvektor.
    if torch.is_tensor(features):
        return features

    pooled = getattr(features, "pooler_output", None)
    if torch.is_tensor(pooled):
        return pooled

    # Kompatibilität mit return_dict=False bzw. älteren Transformers-Versionen.
    if isinstance(features, (tuple, list)):
        for candidate in reversed(features):
            if torch.is_tensor(candidate) and candidate.ndim == 2:
                return candidate

    raise RuntimeError(
        "SigLIP2 hat keinen auswertbaren gepoolten Merkmalsvektor geliefert "
        f"(Typ: {type(features).__name__})."
    )


def normalized_torch_vector(features) -> list[float]:
    tensor = siglip2_feature_tensor(features)

    if tensor.ndim == 2:
        if int(tensor.shape[0]) != 1:
            raise RuntimeError(
                "SigLIP2 hat unerwartet mehrere Merkmalsvektoren geliefert: "
                f"{tuple(tensor.shape)}."
            )
        tensor = tensor[0]

    if tensor.ndim != 1:
        raise RuntimeError(
            "SigLIP2-Merkmalsvektor hat eine unerwartete Form: "
            f"{tuple(tensor.shape)}."
        )

    vector = tensor.detach().to(device="cpu", dtype=torch.float32).reshape(-1)
    norm = torch.linalg.vector_norm(vector)
    norm_value = float(norm.item())

    if not math.isfinite(norm_value) or norm_value <= 0.0:
        raise RuntimeError("SigLIP2 hat einen ungültigen Merkmalsvektor erzeugt.")

    vector = vector / norm
    return [float(value) for value in vector.tolist()]


def extract_semantic_image_embedding(file_path: str) -> dict:
    processor, model = siglip2_runtime()

    try:
        with Image.open(file_path) as source:
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGB")
    except Exception as exc:
        raise RuntimeError(
            f"Bild konnte für SigLIP2 nicht gelesen werden: {exc}"
        ) from exc

    try:
        inputs = processor(
            images=image,
            max_num_patches=SIGLIP2_MAX_NUM_PATCHES,
            return_tensors="pt",
        )

        with torch.inference_mode():
            features = model.get_image_features(**inputs)

        vector = normalized_torch_vector(features)
    finally:
        image.close()

    return {
        "module": "semantic-embed-siglip2-v1",
        "model": SIGLIP2_MODEL_VERSION,
        "dimension": len(vector),
        "maxNumPatches": SIGLIP2_MAX_NUM_PATCHES,
        "precision": "float32",
        "vector": vector,
    }


def extract_semantic_text_embedding(text: str) -> dict:
    query = " ".join(str(text).strip().split())
    if not query:
        raise RuntimeError("Semantischer Suchtext ist leer.")

    processor, model = siglip2_runtime()

    # SigLIP2 wurde mit kleingeschriebenem Text trainiert. Die Vorlage
    # entspricht der von Transformers dokumentierten Zero-Shot-Pipeline.
    normalized_query = query.lower()
    prompt = f"this is a photo of {normalized_query}."

    inputs = processor(
        text=[prompt],
        padding="max_length",
        max_length=64,
        truncation=True,
        return_tensors="pt",
    )

    with torch.inference_mode():
        features = model.get_text_features(**inputs)

    vector = normalized_torch_vector(features)

    raw_logit_scale = getattr(model, "logit_scale", None)
    raw_logit_bias = getattr(model, "logit_bias", None)

    if raw_logit_scale is None or raw_logit_bias is None:
        raise RuntimeError(
            "SigLIP2 stellt Logit-Skalierung für die semantische Suche nicht bereit."
        )

    logit_scale = float(torch.exp(raw_logit_scale.detach().cpu()).item())
    logit_bias = float(raw_logit_bias.detach().cpu().item())

    if not math.isfinite(logit_scale) or not math.isfinite(logit_bias):
        raise RuntimeError("SigLIP2-Logitparameter sind ungültig.")

    return {
        "model": SIGLIP2_MODEL_VERSION,
        "query": query,
        "prompt": prompt,
        "dimension": len(vector),
        "vector": vector,
        "logitScale": logit_scale,
        "logitBias": logit_bias,
    }




def xyxy_iou(left: list[float], right: list[float]) -> float:
    x1 = max(float(left[0]), float(right[0]))
    y1 = max(float(left[1]), float(right[1]))
    x2 = min(float(left[2]), float(right[2]))
    y2 = min(float(left[3]), float(right[3]))

    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, float(left[2]) - float(left[0])) * max(
        0.0, float(left[3]) - float(left[1])
    )
    right_area = max(0.0, float(right[2]) - float(right[0])) * max(
        0.0, float(right[3]) - float(right[1])
    )
    union = left_area + right_area - intersection
    return intersection / union if union > 0.0 else 0.0


def qwen_server_log_tail(max_bytes: int = 6000) -> str:
    try:
        with open(QWEN_SERVER_LOG, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes), os.SEEK_SET)
            data = handle.read()
        return data.decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def qwen_server_healthy(port: int, timeout: float = 1.0) -> bool:
    try:
        with urllib_request.urlopen(
            f"http://127.0.0.1:{port}/health",
            timeout=timeout,
        ) as response:
            return int(response.status) == 200
    except Exception:
        return False


def qwen3vl_runtime() -> int:
    global _qwen_server_process, _qwen_server_port, _qwen_server_log_handle

    if Image is None or ImageDraw is None or ImageOps is None:
        raise RuntimeError(
            "Pillow fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    if not qwen_gguf_ready():
        raise RuntimeError(
            "Qwen3-VL-8B-Thinking GGUF Q8_0 oder der FP16-Vision-Projektor "
            "fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    executable = find_llama_server()
    if executable is None:
        raise RuntimeError(
            "llama-server wurde nicht gefunden. Unter Windows bitte "
            "'winget install llama.cpp' ausführen und die App neu starten."
        )

    if (
        _qwen_server_process is not None
        and _qwen_server_process.poll() is None
        and _qwen_server_port is not None
        and qwen_server_healthy(int(_qwen_server_port))
    ):
        return int(_qwen_server_port)

    unload_qwen3vl()
    unload_siglip2()

    port = free_local_port()
    os.makedirs(os.path.dirname(QWEN_SERVER_LOG), exist_ok=True)
    _qwen_server_log_handle = open(
        QWEN_SERVER_LOG,
        "w",
        encoding="utf-8",
        buffering=1,
    )

    args = [
        executable,
        "-m",
        QWEN3VL_MODEL_FILE,
        "--mmproj",
        QWEN3VL_MMPROJ_FILE,
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "-c",
        str(QWEN3VL_CONTEXT_SIZE),
        "-ngl",
        "0",
        "--no-mmproj-offload",
    ]

    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    _qwen_server_process = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=_qwen_server_log_handle,
        stderr=subprocess.STDOUT,
        creationflags=creationflags,
    )
    _qwen_server_port = port

    deadline = time.monotonic() + 240.0
    while time.monotonic() < deadline:
        if _qwen_server_process.poll() is not None:
            detail = qwen_server_log_tail()
            unload_qwen3vl()
            raise RuntimeError(
                "llama.cpp konnte Qwen3-VL nicht starten."
                + (f" Log: {detail}" if detail else "")
            )

        if qwen_server_healthy(port, timeout=1.0):
            return port

        time.sleep(0.75)

    detail = qwen_server_log_tail()
    unload_qwen3vl()
    raise RuntimeError(
        "llama.cpp hat Qwen3-VL nicht innerhalb von 240 Sekunden geladen."
        + (f" Log: {detail}" if detail else "")
    )


def image_data_uri(image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return "data:image/png;base64," + encoded


def qwen3vl_generate(image, prompt: str, max_new_tokens: int) -> str:
    port = qwen3vl_runtime()

    payload = {
        "model": "Qwen3-VL-8B-Thinking",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": image_data_uri(image)},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "temperature": 1.0,
        "top_p": 0.95,
        "top_k": 20,
        "max_tokens": int(max_new_tokens),
        "stream": False,
    }

    body = json.dumps(payload).encode("utf-8")
    request = urllib_request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=7200.0) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"llama.cpp/Qwen3-VL HTTP {exc.code}: {detail[:1200]}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(
            f"llama.cpp/Qwen3-VL Anfrage fehlgeschlagen: {exc}"
        ) from exc

    try:
        value = json.loads(raw)
        choices = value.get("choices") or []
        message = choices[0].get("message") if choices else None
        if not isinstance(message, dict):
            raise ValueError("choices[0].message fehlt")

        content = message.get("content")
        reasoning = message.get("reasoning_content")

        parts = []
        if isinstance(reasoning, str) and reasoning.strip():
            parts.append(reasoning)
        if isinstance(content, str) and content.strip():
            parts.append(content)

        result = "\n".join(parts).strip()
        if not result:
            raise ValueError("leere Modellantwort")
        return result
    except Exception as exc:
        raise RuntimeError(
            "llama.cpp hat keine auswertbare Chat-Antwort geliefert: "
            f"{raw[:1000]}"
        ) from exc


def last_json_value(text: str, expected_type):
    decoder = json.JSONDecoder()
    values = []

    for index, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            value, _end = decoder.raw_decode(text[index:])
        except Exception:
            continue
        if isinstance(value, expected_type):
            values.append(value)

    if values:
        return values[-1]

    raise RuntimeError(
        "Qwen3-VL hat keine auswertbare JSON-Antwort geliefert. "
        f"Antwortanfang: {text[:300]!r}"
    )


def normalize_qwen_label(raw: str) -> str:
    value = " ".join(str(raw).strip().lower().split())
    value = value.strip(" .,:;!?\"'()[]{}")

    for article in ("a ", "an ", "the "):
        if value.startswith(article):
            value = value[len(article):].strip()

    aliases = {
        "human": "person",
        "man": "person",
        "woman": "person",
        "boy": "person",
        "girl": "person",
        "child": "person",
        "adult": "person",
        "puppy": "dog",
        "puppy dog": "dog",
        "canine": "dog",
        "kitten": "cat",
        "feline": "cat",
        "teddy": "teddy bear",
        "stuffed bear": "teddy bear",
        "plush bear": "teddy bear",
        "stuffed animal": "plush toy",
        "stuffed toy": "plush toy",
        "mobile phone": "cell phone",
        "smartphone": "cell phone",
        "motorbike": "motorcycle",
        "sofa": "couch",
    }
    return aliases.get(value, value)


def qwen_detection_regions(
    image,
    tile_size: int = 1600,
    overlap_fraction: float = 0.22,
    max_tiles: int = 12,
) -> list[tuple[int, int, int, int, str]]:
    width, height = image.size
    regions: list[tuple[int, int, int, int, str]] = [
        (0, 0, width, height, "whole-image")
    ]

    if max(width, height) <= 1800:
        return regions

    tile_width = min(tile_size, width)
    tile_height = min(tile_size, height)
    step_x = max(512, int(tile_width * (1.0 - overlap_fraction)))
    step_y = max(512, int(tile_height * (1.0 - overlap_fraction)))

    def starts(length: int, tile: int, step: int) -> list[int]:
        if length <= tile:
            return [0]
        values = list(range(0, max(1, length - tile + 1), step))
        end = length - tile
        if not values or values[-1] != end:
            values.append(end)
        return sorted(set(values))

    tile_regions = []
    for top in starts(height, tile_height, step_y):
        for left in starts(width, tile_width, step_x):
            tile_regions.append((
                left,
                top,
                min(width, left + tile_width),
                min(height, top + tile_height),
                "tile",
            ))

    # Bei sehr großen Bildern werden gleichmäßig verteilte Kacheln gewählt,
    # statt hunderte Durchläufe zu erzeugen.
    if len(tile_regions) > max_tiles:
        if max_tiles == 1:
            tile_regions = [tile_regions[len(tile_regions) // 2]]
        else:
            indices = [
                round(index * (len(tile_regions) - 1) / (max_tiles - 1))
                for index in range(max_tiles)
            ]
            tile_regions = [tile_regions[index] for index in sorted(set(indices))]

    regions.extend(tile_regions)
    return regions


def qwen_bbox_to_pixels(
    bbox,
    region_width: int,
    region_height: int,
) -> list[float] | None:
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None

    try:
        values = [float(value) for value in bbox]
    except Exception:
        return None

    if not all(math.isfinite(value) for value in values):
        return None

    # Qwen3-VL-Grounding wird auf relative 0..1000-Koordinaten gepromptet.
    # Falls es trotzdem Pixelkoordinaten >1000 liefert, werden diese robust
    # als lokale Pixelkoordinaten interpretiert.
    if max(values) <= 1000.0 and min(values) >= -10.0:
        x1 = values[0] / 1000.0 * region_width
        y1 = values[1] / 1000.0 * region_height
        x2 = values[2] / 1000.0 * region_width
        y2 = values[3] / 1000.0 * region_height
    else:
        x1, y1, x2, y2 = values

    x1 = max(0.0, min(float(region_width), x1))
    y1 = max(0.0, min(float(region_height), y1))
    x2 = max(0.0, min(float(region_width), x2))
    y2 = max(0.0, min(float(region_height), y2))

    if x2 <= x1 + 2.0 or y2 <= y1 + 2.0:
        return None

    return [x1, y1, x2, y2]


def qwen_discover_region(
    image,
    region_name: str,
    progress_request_id: str | None = None,
) -> list[dict]:
    prompt = """
Inspect this image extremely carefully and locate every clearly visible physical
object. This is an archival image-indexing task where false positives are more
harmful than omissions.

Important rules:
- Work independently; do not assume any COCO class list.
- Include ordinary objects, animals, vehicles, equipment and people.
- Do not output scene concepts such as "outdoors", "forest", "grass" or "sky".
- Never infer an object merely because a texture or shape resembles it.
- Be especially conservative with bird, teddy bear, plush toy and small distant
  objects. A dog is not a teddy bear. Leaves, signs and patterns are not birds.
- Use a short singular English noun as label.
- bbox_2d must be [x1,y1,x2,y2] in relative coordinates 0..1000 for THIS image.
- certainty must be "high" or "medium". Omit low-certainty guesses.
- Return every separate instance as its own item.

Return ONLY a JSON array:
[
  {"label":"dog","bbox_2d":[100,120,450,800],"certainty":"high"}
]
If no physical object can be identified, return [].
""".strip()

    output = qwen3vl_generate(image, prompt, max_new_tokens=6144)
    raw = last_json_value(output, list)
    result: list[dict] = []

    for item in raw:
        if not isinstance(item, dict):
            continue

        label = normalize_qwen_label(item.get("label", ""))
        certainty = str(item.get("certainty", "")).strip().lower()
        box = qwen_bbox_to_pixels(item.get("bbox_2d"), image.width, image.height)

        if (
            not label
            or label in ("none", "unknown", "object")
            or certainty not in ("high", "medium")
            or box is None
        ):
            continue

        result.append({
            "label": label,
            "box": box,
            "certainty": certainty,
            "source": region_name,
        })

    return result


def qwen_add_global_candidate(
    candidates: list[dict],
    label: str,
    box: list[float],
    source: str,
    certainty: str,
) -> None:
    label = normalize_qwen_label(label)
    if not label or label in ("none", "unknown", "object"):
        return

    for existing in candidates:
        if existing["label"] != label:
            continue
        if xyxy_iou(existing["box"], box) < 0.45:
            continue

        # Mehrere unabhängige Sichtfenster desselben Modells erhöhen die
        # Evidenz, ohne automatisch einen Treffer zu bestätigen.
        existing["votes"] += 1
        existing["sources"].add(source)

        if certainty == "high" and existing["certainty"] != "high":
            existing["certainty"] = "high"

        # Die größere Box wird beibehalten, damit die spätere Crop-Prüfung
        # ausreichend Objektkontext erhält.
        old_area = (
            (existing["box"][2] - existing["box"][0])
            * (existing["box"][3] - existing["box"][1])
        )
        new_area = (box[2] - box[0]) * (box[3] - box[1])
        if new_area > old_area:
            existing["box"] = box
        return

    candidates.append({
        "label": label,
        "box": box,
        "certainty": certainty,
        "votes": 1,
        "sources": {source},
    })


def qwen_annotated_candidate_crop(
    image,
    box: list[float],
    margin_fraction: float = 0.65,
):
    x1, y1, x2, y2 = [float(value) for value in box]
    width = max(1.0, x2 - x1)
    height = max(1.0, y2 - y1)
    margin_x = max(48.0, width * margin_fraction)
    margin_y = max(48.0, height * margin_fraction)

    left = max(0, int(math.floor(x1 - margin_x)))
    top = max(0, int(math.floor(y1 - margin_y)))
    right = min(image.width, int(math.ceil(x2 + margin_x)))
    bottom = min(image.height, int(math.ceil(y2 + margin_y)))

    crop = image.crop((left, top, right, bottom)).copy()
    local = [
        int(round(x1 - left)),
        int(round(y1 - top)),
        int(round(x2 - left)),
        int(round(y2 - top)),
    ]

    draw = ImageDraw.Draw(crop)
    stroke = max(3, int(round(min(crop.size) / 140.0)))
    for offset in range(stroke):
        draw.rectangle(
            (
                local[0] - offset,
                local[1] - offset,
                local[2] + offset,
                local[3] + offset,
            ),
            outline=(255, 0, 0),
            width=1,
        )

    return crop


def qwen_presence_check(
    crop,
    candidate_label: str,
    progress_request_id: str | None = None,
) -> dict:
    prompt = f"""
The red rectangle marks a candidate object. Verify it conservatively.

Candidate label: {candidate_label}

Decide whether the red rectangle clearly contains a real {candidate_label}.
Do not accept resemblance, background texture, printed pictures, shadows or
ambiguous shapes. In particular, do not call a dog a teddy bear and do not call
foliage, signs or random details a bird.

Return ONLY one JSON object:
{{"present":true,"label":"{candidate_label}","confidence":"high"}}

Rules:
- present is true only when the object is visibly identifiable in the red box.
- If false, label should be the actual clearly identifiable object, or "none".
- confidence is "high", "medium" or "low".
""".strip()

    output = qwen3vl_generate(crop, prompt, max_new_tokens=2048)
    value = last_json_value(output, dict)

    return {
        "present": bool(value.get("present", False)),
        "label": normalize_qwen_label(value.get("label", "")),
        "confidence": str(value.get("confidence", "")).strip().lower(),
    }


def qwen_blind_box_classification(
    crop,
    progress_request_id: str | None = None,
) -> dict:
    prompt = """
Ignore any previous classification. Look only at the object inside the red
rectangle and identify what it actually is.

Be conservative. If the rectangle does not contain one clearly identifiable
physical object, answer "none". Do not turn dogs into teddy bears and do not
invent birds from foliage, signs or background patterns.

Return ONLY one JSON object:
{"label":"dog","confidence":"high"}

Use a short singular English noun. confidence must be "high", "medium" or "low".
""".strip()

    output = qwen3vl_generate(crop, prompt, max_new_tokens=2048)
    value = last_json_value(output, dict)
    return {
        "label": normalize_qwen_label(value.get("label", "")),
        "confidence": str(value.get("confidence", "")).strip().lower(),
    }


def legacy_object_hints(hints: list[dict], image) -> list[dict]:
    result = []

    for raw in hints:
        if not isinstance(raw, dict):
            continue

        label = normalize_qwen_label(raw.get("label", ""))
        try:
            x = float(raw.get("x", 0.0))
            y = float(raw.get("y", 0.0))
            width = float(raw.get("width", 0.0))
            height = float(raw.get("height", 0.0))
            score = float(raw.get("score", 0.0))
        except Exception:
            continue

        if (
            not label
            or width <= 2.0
            or height <= 2.0
            or not math.isfinite(score)
            or score < 0.35
        ):
            continue

        box = [
            max(0.0, x),
            max(0.0, y),
            min(float(image.width), x + width),
            min(float(image.height), y + height),
        ]
        if box[2] <= box[0] + 2.0 or box[3] <= box[1] + 2.0:
            continue

        result.append({
            "label": label,
            "box": box,
            "certainty": "medium",
            "source": "legacy-detector-hint",
        })

    return result


def detect_qwen3vl_objects(
    file_path: str,
    hints: list[dict] | None = None,
    progress_request_id: str | None = None,
) -> dict:
    if Image is None or ImageOps is None:
        raise RuntimeError(
            "Pillow fehlt. Einmal 'npm.cmd run setup:ai' ausführen."
        )

    report_progress(
        progress_request_id,
        "Qwen3-VL: andere große Modellinstanzen werden aus dem Speicher entfernt …",
        phase="memory-cleanup",
    )
    prepare_for_qwen()

    try:
        with Image.open(file_path) as source:
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGB")
    except Exception as exc:
        raise RuntimeError(
            f"Bild konnte für Qwen3-VL nicht gelesen werden: {exc}"
        ) from exc

    try:
        candidates: list[dict] = []
        regions = qwen_detection_regions(image)
        region_count = len(regions)
        file_name = os.path.basename(file_path)

        report_progress(
            progress_request_id,
            (
                f"Qwen3-VL: Modell wird vorbereitet · {region_count} "
                f"{'Bildbereich' if region_count == 1 else 'Bildbereiche'} · {file_name}"
            ),
            phase="model-load",
            current=0,
            total=region_count,
        )

        # 1) Qwen sucht selbstständig im Gesamtbild UND in hochauflösenden
        # Kacheln. Es gibt dabei immer nur genau EIN Bild an llama.cpp.
        for region_index, (left, top, right, bottom, kind) in enumerate(
            regions,
            start=1,
        ):
            region_name = (
                "qwen-whole-image"
                if kind == "whole-image"
                else f"qwen-tile-{left}-{top}-{right}-{bottom}"
            )
            display_kind = "Gesamtbild" if kind == "whole-image" else "Kachel"

            report_progress(
                progress_request_id,
                (
                    f"Qwen3-VL: {display_kind} {region_index}/{region_count} "
                    f"wird analysiert · {file_name}"
                ),
                phase="regions",
                current=region_index,
                total=region_count,
            )

            # Beim Gesamtbild keine zusätzliche Vollbildkopie erzeugen.
            owns_region = kind != "whole-image"
            region = image.crop((left, top, right, bottom)) if owns_region else image

            try:
                found_items = qwen_discover_region(
                    region,
                    region_name,
                    progress_request_id,
                )
            finally:
                if owns_region:
                    region.close()
                gc.collect()

            for found in found_items:
                local = found["box"]
                global_box = [
                    float(local[0]) + left,
                    float(local[1]) + top,
                    float(local[2]) + left,
                    float(local[3]) + top,
                ]
                qwen_add_global_candidate(
                    candidates,
                    str(found["label"]),
                    global_box,
                    region_name,
                    str(found["certainty"]),
                )

        # 2) Alte schnelle Detektoren dürfen zusätzliche Kandidaten vorschlagen,
        # aber nichts mehr selbst bestätigen. So geht Recall nicht verloren.
        for hint in legacy_object_hints(hints or [], image):
            qwen_add_global_candidate(
                candidates,
                str(hint["label"]),
                list(hint["box"]),
                str(hint["source"]),
                str(hint["certainty"]),
            )

        verified: list[dict] = []
        rejected = 0
        candidate_count = len(candidates)

        if candidate_count == 0:
            report_progress(
                progress_request_id,
                f"Qwen3-VL: keine Objektkandidaten zur Detailprüfung · {file_name}",
                phase="candidates",
                current=0,
                total=0,
            )

        # 3) JEDER Kandidat wird einzeln ausgeschnitten und zweimal seriell
        # geprüft. Der Crop wird unmittelbar danach geschlossen.
        for candidate_index, candidate in enumerate(candidates, start=1):
            candidate_label = normalize_qwen_label(candidate["label"])
            crop = qwen_annotated_candidate_crop(image, candidate["box"])

            try:
                report_progress(
                    progress_request_id,
                    (
                        f"Qwen3-VL: Objekt {candidate_index}/{candidate_count} · "
                        f"Prüfung 1/2 · {candidate_label}"
                    ),
                    phase="candidate-presence",
                    current=candidate_index,
                    total=candidate_count,
                )
                presence = qwen_presence_check(
                    crop,
                    str(candidate["label"]),
                    progress_request_id,
                )

                report_progress(
                    progress_request_id,
                    (
                        f"Qwen3-VL: Objekt {candidate_index}/{candidate_count} · "
                        f"Prüfung 2/2 · blind klassifizieren"
                    ),
                    phase="candidate-blind",
                    current=candidate_index,
                    total=candidate_count,
                )
                blind = qwen_blind_box_classification(
                    crop,
                    progress_request_id,
                )
            finally:
                crop.close()
                gc.collect()

            presence_label = normalize_qwen_label(presence["label"])
            blind_label = normalize_qwen_label(blind["label"])

            labels_agree = (
                presence["present"]
                and presence_label == candidate_label
                and blind_label == candidate_label
            )

            high_high = (
                presence["confidence"] == "high"
                and blind["confidence"] == "high"
            )
            repeated_medium = (
                int(candidate["votes"]) >= 2
                and presence["confidence"] in ("high", "medium")
                and blind["confidence"] in ("high", "medium")
            )

            if not labels_agree or not (high_high or repeated_medium):
                rejected += 1
                continue

            # Hund/Katze bleiben absichtlich Sache der bewährten Haustierpipeline.
            # Qwen dient hier nur dazu, Fehlklassen wie "teddy bear" zu verwerfen.
            if candidate_label in ("dog", "cat"):
                continue

            x1, y1, x2, y2 = [float(value) for value in candidate["box"]]
            class_id = (
                int(COCO_CLASS_NAMES.index(candidate_label))
                if candidate_label in COCO_CLASS_NAMES
                else -1
            )

            score = 0.98 if high_high else 0.90
            verified.append({
                "label": candidate_label,
                "classId": class_id,
                "score": score,
                "x": x1,
                "y": y1,
                "width": x2 - x1,
                "height": y2 - y1,
                "agreementCount": 2 + min(3, int(candidate["votes"])),
                "sources": sorted({
                    QWEN3VL_MODEL_VERSION,
                    *candidate["sources"],
                    "qwen-crop-presence-check",
                    "qwen-blind-box-classification",
                }),
            })

        # Gleiche Qwen-Funde aus überlappenden Kacheln nach der Verifikation
        # noch einmal zusammenführen.
        verified.sort(key=lambda item: float(item["score"]), reverse=True)
        final: list[dict] = []

        for item in verified:
            box = [
                float(item["x"]),
                float(item["y"]),
                float(item["x"]) + float(item["width"]),
                float(item["y"]) + float(item["height"]),
            ]

            duplicate = False
            for existing in final:
                if existing["label"] != item["label"]:
                    continue
                existing_box = [
                    float(existing["x"]),
                    float(existing["y"]),
                    float(existing["x"]) + float(existing["width"]),
                    float(existing["y"]) + float(existing["height"]),
                ]
                if xyxy_iou(box, existing_box) >= 0.50:
                    existing["agreementCount"] = max(
                        int(existing["agreementCount"]),
                        int(item["agreementCount"]),
                    )
                    existing["sources"] = sorted(set(
                        list(existing["sources"]) + list(item["sources"])
                    ))
                    duplicate = True
                    break

            if not duplicate:
                final.append(item)

        report_progress(
            progress_request_id,
            (
                f"Qwen3-VL: Bild fertig · {candidate_count} Kandidaten geprüft · "
                f"{len(final)} Motive bestätigt · {file_name}"
            ),
            phase="done",
            current=candidate_count,
            total=candidate_count,
        )

        return {
            "module": "object-detect-qwen3vl-gguf-v2",
            "detector": QWEN3VL_MODEL_VERSION,
            "imageWidth": int(image.width),
            "imageHeight": int(image.height),
            "regionCount": region_count,
            "candidateCount": candidate_count,
            "verifiedCount": len(final),
            "rejectedCount": rejected,
            "objects": final,
        }
    finally:
        image.close()
        gc.collect()


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
        file_path = require_file(payload)
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

    if method == "extract_image_metadata":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        respond(request_id, result=extract_image_metadata(file_path))
        return True

    if method == "detect_faces":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        respond(request_id, result=detect_faces(file_path))
        return True

    if method == "detect_pets":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        respond(request_id, result=detect_pets(file_path))
        return True

    if method == "detect_pets_yolox":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        respond(request_id, result=detect_pets_yolox(file_path))
        return True

    if method == "fuse_pet_detections":
        detections = payload.get("detections") or []
        objects = payload.get("objects") or []
        if not isinstance(detections, list):
            raise RuntimeError("Haustierdetektionen für die Fusion sind ungültig.")
        if not isinstance(objects, list):
            raise RuntimeError("Motivdetektionen für die Fusion sind ungültig.")
        respond(
            request_id,
            result=fuse_pet_detections(detections, objects),
        )
        return True

    if method == "extract_face_embeddings":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        faces = payload.get("faces") or []
        if not isinstance(faces, list):
            raise RuntimeError("Gesichtsdetektionen sind ungültig.")
        respond(
            request_id,
            result=extract_face_embeddings(file_path, faces),
        )
        return True

    if method == "extract_dog_embeddings":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        pets = payload.get("pets") or []
        if not isinstance(pets, list):
            raise RuntimeError("Haustierfundstellen für Dog-ReID sind ungültig.")
        respond(
            request_id,
            result=extract_dog_embeddings(file_path, pets),
        )
        return True

    if method == "extract_semantic_image_embedding":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        respond(
            request_id,
            result=extract_semantic_image_embedding(file_path),
        )
        return True

    if method == "extract_semantic_text_embedding":
        query = str(payload.get("text", ""))
        respond(
            request_id,
            result=extract_semantic_text_embedding(query),
        )
        return True


    if method == "detect_qwen3vl_objects":
        file_path = require_file(payload)
        verify_expected_size(file_path, payload)
        hints = payload.get("hints") or []
        if not isinstance(hints, list):
            raise RuntimeError("Objekthinweise für Qwen3-VL sind ungültig.")
        respond(
            request_id,
            result=detect_qwen3vl_objects(
                file_path,
                hints,
                progress_request_id=request_id,
            ),
        )
        return True

    if method == "cluster_pet_embeddings":
        pets = payload.get("pets") or []
        if not isinstance(pets, list):
            raise RuntimeError("Haustiermerkmale für die Gruppierung sind ungültig.")
        respond(
            request_id,
            result=cluster_pet_embeddings(
                pets,
                payload.get("cannotLinks") or [],
                float(payload.get("clusterThreshold", 0.68)),
                float(payload.get("verificationThreshold", 0.60)),
                int(payload.get("minClusterSize", 2)),
            ),
        )
        return True

    if method == "cluster_face_embeddings":
        faces = payload.get("faces") or []
        if not isinstance(faces, list):
            raise RuntimeError("Gesichtsmerkmale sind ungültig.")
        respond(
            request_id,
            result=cluster_face_embeddings(
                faces,
                payload.get("cannotLinks") or [],
                float(payload.get("clusterThreshold", 0.50)),
                float(payload.get("verificationThreshold", 0.363)),
            ),
        )
        return True

    if method == "shutdown":
        unload_qwen3vl()
        respond(request_id, result={"status": "bye"})
        return False

    respond(request_id, error=f"Unbekannte Methode: {method}")
    return True


def main() -> int:
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                message = json.loads(line)
                if not handle(message):
                    break
            except Exception as exc:
                request_id = None
                try:
                    request_id = message.get("id")  # type: ignore[name-defined]
                except Exception:
                    pass
                respond(request_id, error=str(exc))
    finally:
        unload_qwen3vl()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
