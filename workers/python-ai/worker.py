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
NANODET_MODEL = os.path.join(
    WORKER_DIR,
    "models",
    "object_detection_nanodet_2022nov.onnx",
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
            "nanodetModel": os.path.isfile(NANODET_MODEL),
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
