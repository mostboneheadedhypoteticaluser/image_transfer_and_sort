"""Decode exactly the frame analyzed for person/pet detections.

Input: video path, integer frame index, BLAKE2b-128 fingerprint of the original
OpenCV BGR pixels, output JPEG path, maximum output width.
The fingerprint is mandatory. Never render an unverified neighboring frame.
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import sys

import cv2


def verified_frame(video_path: str, index: int, expected: str):
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError("Video kann mit OpenCV nicht gelesen werden.")
    try:
        # Some codecs implement seek with a keyframe landing point. Reading a
        # short bounded neighborhood and verifying the original pixel digest
        # avoids returning a visually plausible but mismatching frame.
        for start, length in (
            (index, 3),
            (max(0, index - 5), 12),
            (max(0, index - 18), 25),
        ):
            if not capture.set(cv2.CAP_PROP_POS_FRAMES, float(start)):
                continue
            for _ in range(length):
                ok, frame = capture.read()
                if not ok or frame is None:
                    break
                digest = hashlib.blake2b(
                    frame.tobytes(), digest_size=16
                ).hexdigest()
                if digest == expected:
                    return frame
                current_position = capture.get(cv2.CAP_PROP_POS_FRAMES)
                if math.isfinite(current_position) and current_position > index + 6:
                    break
    finally:
        capture.release()
    raise RuntimeError(
        "Das decodierte Frame stimmt nicht mit der Videoanalyse überein. "
        "Bitte die Videoanalyse erneut ausführen; ein falsches Bild wird nicht angezeigt."
    )


def main() -> None:
    if len(sys.argv) != 6:
        raise ValueError("Erwartet Video, Frameindex, Framehash, JPEG-Ziel, Breite.")

    video_path, index_text, expected, output_path, max_width_text = sys.argv[1:]
    index = int(index_text)
    width = int(max_width_text)
    if index < 0 or index > 100_000_000:
        raise ValueError("Ungültige Framenummer.")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", expected):
        raise ValueError("Ungültiger Fingerabdruck für Analyseframe.")
    if width not in (320, 1600):
        raise ValueError("Ungültige Vorschaugröße.")

    cv2.setNumThreads(1)
    frame = verified_frame(video_path, index, expected.lower())
    height, original_width = frame.shape[:2]
    if height <= 0 or original_width <= 0:
        raise RuntimeError("Video lieferte ein ungültiges Frame.")

    if original_width > width:
        scale = width / float(original_width)
        frame = cv2.resize(
            frame,
            (width, max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    temporary = output_path + "." + str(os.getpid()) + ".tmp.jpg"
    try:
        if not cv2.imwrite(
            temporary, frame,
            [int(cv2.IMWRITE_JPEG_QUALITY), 78 if width == 320 else 88],
        ):
            raise RuntimeError("JPEG konnte nicht erzeugt werden.")
        os.replace(temporary, output_path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
