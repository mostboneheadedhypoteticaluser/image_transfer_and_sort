import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const venv = path.join(root, ".ai-venv");
const requirements = path.join(root, "workers", "python-ai", "requirements.txt");
const modelDir = path.join(root, "workers", "python-ai", "models");

const models = [
  {
    name: "YuNet",
    path: path.join(modelDir, "face_detection_yunet_2023mar.onnx"),
    url:
      "https://huggingface.co/opencv/opencv_zoo/resolve/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
  },
  {
    name: "SFace",
    path: path.join(modelDir, "face_recognition_sface_2021dec.onnx"),
    url:
      "https://huggingface.co/opencv/opencv_zoo/resolve/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
  },
  {
    name: "NanoDet",
    path: path.join(modelDir, "object_detection_nanodet_2022nov.onnx"),
    url:
      "https://huggingface.co/opencv/opencv_zoo/resolve/main/models/object_detection_nanodet/object_detection_nanodet_2022nov.onnx",
    sha256: "4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186"
  },
  {
    name: "YOLOX-S",
    path: path.join(modelDir, "object_detection_yolox_2022nov.onnx"),
    url:
      "https://huggingface.co/opencv/opencv_zoo/resolve/main/models/object_detection_yolox/object_detection_yolox_2022nov.onnx",
    sha256: "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063"
  },
  {
    name: "Dog-ReID DINOv2-B/14",
    path: path.join(modelDir, "dog_reid_dinov2_b14_0_2_0.onnx"),
    url:
      "https://github.com/rtp4jc/immich-animals/releases/download/sidecar-v0.2.0/embedding.onnx",
    sha256: "9e0bcfbea4003185538e07ea8c36368818525a8e6650a2fb2d478f27e5a39830"
  }
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} fehlgeschlagen (Code ${result.status}).`);
  }
}

function detectPython() {
  const direct = [];

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      direct.push(
        path.join(local, "Programs", "Python", "Python312", "python.exe"),
        path.join(local, "Programs", "Python", "Python313", "python.exe")
      );
    }

    for (const candidate of direct) {
      if (existsSync(candidate)) return { command: candidate, args: [] };
    }

    for (const args of [["-3.12"], ["-3"]]) {
      const probe = spawnSync("py", [...args, "--version"], {
        encoding: "utf8",
        windowsHide: true
      });
      if (probe.status === 0) return { command: "py", args };
    }

    const probe = spawnSync("python", ["--version"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (probe.status === 0) return { command: "python", args: [] };
  } else {
    for (const command of ["python3", "python"]) {
      const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
      if (probe.status === 0) return { command, args: [] };
    }
  }

  throw new Error("Keine Python-Installation gefunden.");
}

function venvPython() {
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
}

async function ensureModel(model) {
  mkdirSync(modelDir, { recursive: true });

  if (existsSync(model.path)) {
    const digest = createHash("sha256").update(readFileSync(model.path)).digest("hex");
    if (digest === model.sha256) {
      console.log(`${model.name}-Modell bereits vorhanden.`);
      return;
    }
    console.log(`Vorhandenes ${model.name}-Modell hat einen anderen Hash und wird ersetzt.`);
  }

  console.log(`Lade offizielles ${model.name}-Modell aus dem OpenCV Zoo …`);
  const response = await fetch(model.url);
  if (!response.ok) {
    throw new Error(`${model.name}-Download fehlgeschlagen: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");

  if (digest !== model.sha256) {
    throw new Error(
      `${model.name}-Modellprüfung fehlgeschlagen. Erwartet ${model.sha256}, erhalten ${digest}.`
    );
  }

  writeFileSync(model.path, bytes);
  console.log(`${model.name}-Modell geprüft und gespeichert.`);
}

const python = detectPython();

if (!existsSync(venvPython())) {
  console.log("Erzeuge isolierte AI-Python-Umgebung .ai-venv …");
  run(python.command, [...python.args, "-m", "venv", venv]);
}

console.log("Prüfe pip …");
run(venvPython(), ["-m", "pip", "--version"]);

console.log("Installiere/prüfe AI-Abhängigkeiten …");
run(venvPython(), [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "--no-input",
  "-r",
  requirements
]);

for (const model of models) {
  await ensureModel(model);
}

console.log("");
console.log("AI-Umgebung ist bereit.");
console.log(`Python: ${venvPython()}`);
for (const model of models) {
  console.log(`${model.name}: ${model.path}`);
}
