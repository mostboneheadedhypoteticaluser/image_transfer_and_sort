from __future__ import annotations

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
            "imageMetadata": Image is not None,
            "faceDetection": cv2 is not None and os.path.isfile(YUNET_MODEL),
            "faceEmbeddings": (
                cv2 is not None
                and np is not None
                and os.path.isfile(SFACE_MODEL)
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
