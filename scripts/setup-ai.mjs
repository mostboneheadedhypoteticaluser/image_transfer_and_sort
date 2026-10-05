import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function findWinGetLlamaServer() {
  if (process.platform !== "win32") return null;

  const local = process.env.LOCALAPPDATA;
  if (!local) return null;

  const direct = [
    path.join(local, "Microsoft", "WinGet", "Links", "llama-server.exe"),
    path.join(local, "Microsoft", "WindowsApps", "llama-server.exe")
  ];

  for (const candidate of direct) {
    if (existsSync(candidate)) return candidate;
  }

  const packagesRoot = path.join(local, "Microsoft", "WinGet", "Packages");
  if (!existsSync(packagesRoot)) return null;

  const packageDirs = readdirSync(packagesRoot)
    .filter((name) => name.startsWith("ggml.llamacpp_"))
    .map((name) => path.join(packagesRoot, name))
    .filter((candidate) => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });

  const findRecursive = (root) => {
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === "llama-server.exe") {
          return full;
        }
        if (entry.isDirectory()) stack.push(full);
      }
    }

    return null;
  };

  for (const packageDir of packageDirs) {
    const found = findRecursive(packageDir);
    if (found) return found;
  }

  return null;
}

function requireLlamaCpp() {
  const configured = process.env.IMAGE_SORTER_LLAMA_SERVER;
  if (configured && existsSync(configured)) {
    console.log(`llama.cpp gefunden: ${configured}`);
    return configured;
  }

  const candidates =
    process.platform === "win32"
      ? ["llama-server.exe", "llama-server"]
      : ["llama-server"];

  for (const candidate of candidates) {
    if (hasCommand(candidate)) {
      console.log(`llama.cpp gefunden: ${candidate}`);
      return candidate;
    }
  }

  const wingetServer = findWinGetLlamaServer();
  if (wingetServer) {
    console.log(`llama.cpp über WinGet gefunden: ${wingetServer}`);
    return wingetServer;
  }

  const installHint =
    process.platform === "win32"
      ? "winget install llama.cpp"
      : "Bitte eine aktuelle llama.cpp-Version mit llama-server installieren.";

  throw new Error(
    "llama.cpp / llama-server wurde nicht gefunden. " +
    "Installiere es zuerst mit: " + installHint +
    " Danach dieses Setup erneut ausführen."
  );
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
console.log("Prüfe/lade SigLIP2 So400m NaFlex für die semantische Analyse …");
run(venvPython(), [
  path.join(root, "workers", "python-ai", "setup_siglip2.py")
]);

console.log("");
console.log("Prüfe/lade MiniCPM-V 4.6 Q4_K_M für den schnellen Einzelbildtest …");
run(venvPython(), [
  path.join(root, "workers", "python-ai", "setup_minicpm.py")
]);

console.log("");
console.log("Prüfe/lade Qwen3-VL-2B-Instruct Q4_K_M für den Vergleichstest …");
run(venvPython(), [
  path.join(root, "workers", "python-ai", "setup_qwen3vl2b.py")
]);

console.log("");
console.log("Prüfe llama.cpp …");
const llamaServer = requireLlamaCpp();

console.log("");
console.log("AI-Umgebung ist bereit.");
console.log(`Python: ${venvPython()}`);
for (const model of models) {
  console.log(`${model.name}: ${model.path}`);
}
console.log(
  "SigLIP2 So400m NaFlex: " +
  path.join(modelDir, "siglip2-so400m-patch16-naflex")
);
console.log(
  "MiniCPM-V 4.6 Q4_K_M: " +
  path.join(modelDir, "minicpm-v-4.6-gguf")
);
console.log(
  "Qwen3-VL-2B-Instruct Q4_K_M: " +
  path.join(modelDir, "qwen3-vl-2b-instruct-gguf")
);
console.log(
  "Qwen3-VL 8B Legacy: optional; vorhandene Dateien bleiben erhalten."
);
console.log("llama.cpp Server: " + llamaServer);
