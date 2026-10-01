from __future__ import annotations

import importlib.util
import json
import math
import mimetypes
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

try:
    from PIL import Image
except Exception:
    Image = None

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

_dog_reid_session = None
_onnxruntime_module = None


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
        "capabilities": {
            "pillow": Image is not None,
            "opencv": cv2 is not None,
            "yunetModel": os.path.isfile(YUNET_MODEL),
            "sfaceModel": os.path.isfile(SFACE_MODEL),
            "nanodetModel": os.path.isfile(NANODET_MODEL),
            "yoloxModel": os.path.isfile(YOLOX_MODEL),
            "dogReIdModel": os.path.isfile(DOG_REID_MODEL),
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
        },
    }


def respond(request_id: str | None, *, result=None, error: str | None = None) -> None:
    message = {"id": request_id, "ok": error is None}
    if error is None:
        message["result"] = result
    else:
        message["error"] = error
    print(json.dumps(message, ensure_ascii=False), flush=True)


def require_file(payload: dict) -> str:
    file_path = os.path.abspath(str(payload.get("path", "")))
    if not file_path:
        raise RuntimeError("Dateipfad fehlt.")
    if not os.path.isfile(file_path):
        raise RuntimeError(f"Datei ist nicht erreichbar: {file_path}")
    return file_path


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
    boxes: list[list[float]] = []
    scores: list[float] = []
    class_ids: list[int] = []

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

            # COCO: cat=15, dog=16.
            if class_id not in (15, 16) or confidence < 0.38:
                continue

            x1 = max(0.0, float(anchor[0] - distance[0]))
            y1 = max(0.0, float(anchor[1] - distance[1]))
            x2 = min(416.0, float(anchor[0] + distance[2]))
            y2 = min(416.0, float(anchor[1] + distance[3]))

            boxes.append([x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1)])
            scores.append(confidence)
            class_ids.append(class_id)

    pets: list[dict] = []

    if boxes:
        indices = cv2.dnn.NMSBoxes(boxes, scores, 0.38, 0.60)

        for raw_index in indices:
            index = int(raw_index)
            x, y, width, height = boxes[index]

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

            class_id = class_ids[index]
            pets.append({
                "class": "cat" if class_id == 15 else "dog",
                "classId": class_id,
                "score": float(scores[index]),
                "x": original_x,
                "y": original_y,
                "width": original_width_box,
                "height": original_height_box,
            })

    pets.sort(key=lambda pet: float(pet["score"]), reverse=True)

    return {
        "module": "pet-detect-nanodet-v1",
        "detector": "NanoDet 2022nov",
        "imageWidth": int(original_width),
        "imageHeight": int(original_height),
        "pets": pets,
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

    for class_id, pet_class in ((15, "cat"), (16, "dog")):
        scores = class_scores[:, class_id]
        indices = np.where(scores >= 0.35)[0]
        if indices.size == 0:
            continue

        boxes = [boxes_xywh[index].tolist() for index in indices]
        confidences = [float(scores[index]) for index in indices]

        keep = cv2.dnn.NMSBoxes(
            boxes,
            confidences,
            0.35,
            0.50,
        )

        for raw_index in keep:
            local_index = int(raw_index)
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

            pet_candidates.append({
                "class": pet_class,
                "classId": class_id,
                "score": float(scores[source_index]),
                "x": original_x,
                "y": original_y,
                "width": original_width_box,
                "height": original_height_box,
            })

    pet_candidates.sort(key=lambda pet: float(pet["score"]), reverse=True)

    return {
        "module": "pet-detect-yolox-v1",
        "detector": "YOLOX-S 2022nov",
        "imageWidth": int(original_width),
        "imageHeight": int(original_height),
        "pets": pet_candidates,
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


def fuse_pet_detections(detections: list[dict]) -> dict:
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

    clusters: list[dict] = []

    for item in canonical:
        vector = item["vector"]
        best_index = None
        best_similarity = -1.0

        for index, cluster in enumerate(clusters):
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
        if not isinstance(detections, list):
            raise RuntimeError("Haustierdetektionen für die Fusion sind ungültig.")
        respond(request_id, result=fuse_pet_detections(detections))
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

    if method == "cluster_pet_embeddings":
        pets = payload.get("pets") or []
        if not isinstance(pets, list):
            raise RuntimeError("Haustiermerkmale für die Gruppierung sind ungültig.")
        respond(
            request_id,
            result=cluster_pet_embeddings(
                pets,
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
            request_id = None
            try:
                request_id = message.get("id")  # type: ignore[name-defined]
            except Exception:
                pass
            respond(request_id, error=str(exc))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
