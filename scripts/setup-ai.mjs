import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const venv = path.join(root, ".ai-venv");
const requirements = path.join(root, "workers", "python-ai", "requirements.txt");
const modelDir = path.join(root, "workers", "python-ai", "models");
const modelPath = path.join(modelDir, "face_detection_yunet_2023mar.onnx");
const modelUrl =
  "https://huggingface.co/opencv/opencv_zoo/resolve/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx";
const modelSha256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";

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

async function ensureModel() {
  mkdirSync(modelDir, { recursive: true });

  if (existsSync(modelPath)) {
    const digest = createHash("sha256").update(readFileSync(modelPath)).digest("hex");
    if (digest === modelSha256) {
      console.log("YuNet-Modell bereits vorhanden.");
      return;
    }
    console.log("Vorhandenes YuNet-Modell hat einen anderen Hash und wird ersetzt.");
  }

  console.log("Lade offizielles YuNet-Modell aus dem OpenCV Zoo …");
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Modelldownload fehlgeschlagen: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");

  if (digest !== modelSha256) {
    throw new Error(
      `YuNet-Modellprüfung fehlgeschlagen. Erwartet ${modelSha256}, erhalten ${digest}.`
    );
  }

  writeFileSync(modelPath, bytes);
  console.log("YuNet-Modell geprüft und gespeichert.");
}

const python = detectPython();

if (!existsSync(venvPython())) {
  console.log("Erzeuge isolierte AI-Python-Umgebung .ai-venv …");
  run(python.command, [...python.args, "-m", "venv", venv]);
}

console.log("Aktualisiere pip …");
run(venvPython(), ["-m", "pip", "install", "--upgrade", "pip"]);

console.log("Installiere AI-Abhängigkeiten …");
run(venvPython(), ["-m", "pip", "install", "-r", requirements]);

await ensureModel();

console.log("");
console.log("AI-Umgebung ist bereit.");
console.log(`Python: ${venvPython()}`);
console.log(`Modell: ${modelPath}`);
