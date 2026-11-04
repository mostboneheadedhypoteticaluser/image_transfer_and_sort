"""Extract a stable JPEG preview from a video, independent of Chromium codecs."""
import os
import sys
import cv2

def main():
    if len(sys.argv) != 5:
        raise ValueError("expected video path, timestamp in ms, output path, max width")
    video_path, timestamp_text, output_path, width_text = sys.argv[1:]
    timestamp_ms = max(0, int(timestamp_text))
    max_width = max(64, min(1920, int(width_text)))
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("OpenCV konnte die Videodatei nicht öffnen")
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(timestamp_ms))
        success, frame = cap.read()
        if not success or frame is None:
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
            if fps > 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, round(timestamp_ms / 1000 * fps)))
                success, frame = cap.read()
        if not success or frame is None:
            raise RuntimeError(f"Videoframe bei {timestamp_ms} ms nicht lesbar")
        height, width = frame.shape[:2]
        if width <= 0 or height <= 0:
            raise RuntimeError("Videoframe mit ungültiger Auflösung")
        if width > max_width:
            scale = max_width / float(width)
            frame = cv2.resize(frame, (max_width, max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        tmp = output_path + "." + str(os.getpid()) + ".tmp.jpg"
        if not cv2.imwrite(tmp, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82]):
            raise RuntimeError("Szenenbild konnte nicht gespeichert werden")
        os.replace(tmp, output_path)
    finally:
        cap.release()

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
