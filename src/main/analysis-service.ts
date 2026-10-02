import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type { AnalysisWorkerStatus } from "../shared/protocol";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

type WorkerResponse = {
  id?: string | null;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type PythonCandidate = {
  command: string;
  args: string[];
  label: string;
};

function installedWindowsPythonExecutables(): string[] {
  const roots = [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Python")
      : null,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Python")
      : null
  ].filter((value): value is string => Boolean(value));

  const executables: string[] = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;

    try {
      const candidates = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
        .map((entry) => path.join(root, entry.name, "python.exe"))
        .filter((candidate) => existsSync(candidate))
        .sort((left, right) =>
          right.localeCompare(left, undefined, { numeric: true })
        );

      executables.push(...candidates);
    } catch {
      // Falls ein Installationsordner nicht gelesen werden kann,
      // werden die weiteren Python-Kandidaten trotzdem probiert.
    }
  }

  return [...new Set(executables)];
}

const DEFAULT_STATUS: AnalysisWorkerStatus = {
  state: "STOPPED",
  pid: null,
  python: null,
  processPriority: "below-normal",
  cpuBudgetPercent: 50,
  maxConcurrentJobs: 1,
  queuedJobs: 0,
  activeJobs: 0,
  message: "Analyse-Worker ist noch nicht gestartet."
};

export class AnalysisService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private stopping = false;
  private status: AnalysisWorkerStatus = { ...DEFAULT_STATUS };

  constructor(
    private readonly workerPath: string,
    private readonly onStatus: (status: AnalysisWorkerStatus) => void
  ) {}

  getStatus(): AnalysisWorkerStatus {
    return { ...this.status };
  }

  private publish(patch: Partial<AnalysisWorkerStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.getStatus());
  }

  private candidates(): PythonCandidate[] {
    const projectRoot = path.resolve(this.workerPath, "..", "..", "..");
    const venvPython = process.platform === "win32"
      ? path.join(projectRoot, ".ai-venv", "Scripts", "python.exe")
      : path.join(projectRoot, ".ai-venv", "bin", "python");

    if (existsSync(venvPython)) {
      return [
        {
          command: venvPython,
          args: ["-u", this.workerPath],
          label: "Projekt-AI-Python (.ai-venv)"
        }
      ];
    }

    if (process.platform === "win32") {
      const installed = installedWindowsPythonExecutables().map((command) => ({
        command,
        args: ["-u", this.workerPath],
        label: command
      }));

      return [
        ...installed,
        { command: "py", args: ["-3.12", "-u", this.workerPath], label: "Python 3.12 (py)" },
        { command: "py", args: ["-3", "-u", this.workerPath], label: "Python 3 (py)" },
        { command: "python.exe", args: ["-u", this.workerPath], label: "Python (PATH)" },
        { command: "python", args: ["-u", this.workerPath], label: "Python (PATH)" }
      ];
    }

    return [
      { command: "python3", args: ["-u", this.workerPath], label: "Python 3" },
      { command: "python", args: ["-u", this.workerPath], label: "Python" }
    ];
  }

  async start(): Promise<void> {
    if (this.child) return;

    this.stopping = false;
    this.publish({
      state: "STARTING",
      message: "Separater Analyse-Worker wird gestartet …"
    });

    let lastError: Error | null = null;

    for (const candidate of this.candidates()) {
      try {
        await this.launch(candidate);
        const ping = await this.request<Record<string, unknown>>(
          "ping",
          {},
          20000
        );

        const capabilities =
          ping.capabilities && typeof ping.capabilities === "object"
            ? ping.capabilities as Record<string, unknown>
            : {};

        if (capabilities.pillow !== true) {
          throw new Error(
            "Pillow ist im Analyse-Python nicht verfügbar. " +
            "Bitte 'npm.cmd run setup:ai' ausführen."
          );
        }

        if (capabilities.opencv !== true) {
          throw new Error(
            "OpenCV ist im Analyse-Python nicht verfügbar. " +
            "Bitte 'npm.cmd run setup:ai' ausführen."
          );
        }

        if (capabilities.yunetModel !== true) {
          throw new Error(
            "Das YuNet-Modell für die Gesichtsdetektion fehlt. " +
            "Bitte 'npm.cmd run setup:ai' ausführen."
          );
        }

        if (capabilities.sfaceModel !== true || capabilities.faceEmbeddings !== true) {
          throw new Error(
            "Das SFace-Modell für Gesichtsmerkmale fehlt oder ist nicht verfügbar. " +
            "Bitte 'npm.cmd run setup:ai' ausführen."
          );
        }

        if (
          capabilities.nanodetModel !== true ||
          capabilities.yoloxModel !== true ||
          capabilities.petDetection !== true
        ) {
          throw new Error(
            "Mindestens ein Haustiermodell (NanoDet/YOLOX-S) fehlt oder ist nicht verfügbar. " +
            "Bitte 'npm.cmd run setup:ai' ausführen."
          );
        }

        if (
          capabilities.dogReIdModel !== true ||
          capabilities.onnxRuntime !== true ||
          capabilities.petEmbeddings !== true
        ) {
          throw new Error(
            "Das Dog-ReID-Modell oder ONNX Runtime fehlt. " +
            "Bitte 'npm.cmd run setup:ai' ausführen."
          );
        }

        if (
          capabilities.siglip2Model !== true ||
          capabilities.torch !== true ||
          capabilities.transformers !== true ||
          capabilities.semanticEmbeddings !== true
        ) {
          throw new Error(
            "SigLIP2 So400m NaFlex oder seine Python-Abhängigkeiten fehlen. " +
            "Bitte 'npm.cmd run setup:ai' ausführen. " +
            "Der einmalige SigLIP2-Download ist etwa 4,6 GB groß."
          );
        }

        if (
          capabilities.qwen3vlModel !== true ||
          capabilities.qwen3vlRuntime !== true ||
          capabilities.qwenObjectDetection !== true
        ) {
          throw new Error(
            "Qwen3-VL-8B-Thinking GGUF Q8_0, der FP16-Vision-Projektor oder llama.cpp " +
            "fehlt. Bitte unter Windows zuerst 'winget install llama.cpp' und danach " +
            "'npm.cmd run setup:ai' ausführen."
          );
        }

        const configured = await this.request<Record<string, unknown>>(
          "configure",
          {
            maxConcurrentJobs: 1,
            cpuBudgetPercent: 50,
            profile: "background"
          },
          5000
        );

        this.applyWorkerResult(configured);
        this.publish({
          state: "READY",
          message: "Analyse-Worker läuft getrennt im Hintergrund."
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.killChild();
      }
    }

    this.publish({
      state: "ERROR",
      pid: null,
      python: null,
      message:
        "Python-Analyse-Worker konnte nicht gestartet werden. " +
        (lastError?.message ?? "Keine passende Python-Installation gefunden.")
    });
  }

  private launch(candidate: PythonCandidate): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(candidate.command, candidate.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      child.once("error", fail);

      child.once("spawn", () => {
        if (settled) return;
        settled = true;

        this.child = child;
        this.attachChild(child);

        try {
          if (child.pid !== undefined) {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
          }
        } catch {
          // Prozessisolation und Parallelitätslimit bleiben auch dann aktiv.
        }

        this.publish({
          state: "STARTING",
          pid: child.pid ?? null,
          python: candidate.label,
          processPriority: "below-normal",
          message: "Analyse-Worker antwortet, Konfiguration wird gesetzt …"
        });

        resolve();
      });
    });
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    const lines = readline.createInterface({ input: child.stdout });

    lines.on("line", (line) => {
      let message: WorkerResponse;
      try {
        message = JSON.parse(line) as WorkerResponse;
      } catch {
        return;
      }

      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "Analyse-Worker meldet einen Fehler."));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (!message) return;
      this.publish({ message: `Analyse-Worker: ${message}` });
    });

    child.on("exit", (code, signal) => {
      lines.close();

      const wasCurrentChild = this.child === child;
      const error = new Error(
        signal
          ? `Analyse-Worker wurde beendet (Signal ${signal}).`
          : `Analyse-Worker wurde beendet (Code ${code ?? "unbekannt"}).`
      );

      if (wasCurrentChild) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        this.pending.clear();
        this.child = null;
      }

      // Ein verworfener Startkandidat darf den Status eines später
      // erfolgreich gestarteten Workers nicht mehr überschreiben.
      if (!wasCurrentChild) return;

      if (this.stopping) {
        this.publish({
          state: "STOPPED",
          pid: null,
          activeJobs: 0,
          queuedJobs: 0,
          message: "Analyse-Worker wurde mit der App beendet."
        });
      } else {
        this.publish({
          state: "ERROR",
          pid: null,
          activeJobs: 0,
          message: error.message
        });
      }
    });
  }

  private applyWorkerResult(result: Record<string, unknown>): void {
    this.publish({
      cpuBudgetPercent: Number(result.cpu_budget_percent ?? this.status.cpuBudgetPercent),
      maxConcurrentJobs: Number(result.max_concurrent_jobs ?? this.status.maxConcurrentJobs)
    });
  }

  setQueueState(
    queuedJobs: number,
    activeJobs: number,
    message?: string
  ): void {
    this.publish({
      queuedJobs: Math.max(0, Math.trunc(queuedJobs)),
      activeJobs: Math.max(0, Math.trunc(activeJobs)),
      ...(message ? { message } : {})
    });
  }

  async request<T>(
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<T> {
    const child = this.child;
    if (!child) throw new Error("Analyse-Worker ist nicht aktiv.");

    const id = randomUUID();

    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Zeitüberschreitung bei Analyse-Worker-Methode ${method}.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
    });

    child.stdin.write(JSON.stringify({ id, method, payload }) + "\n");
    return response;
  }

  async refreshStatus(): Promise<AnalysisWorkerStatus> {
    if (!this.child) return this.getStatus();

    try {
      const result = await this.request<Record<string, unknown>>("status", {}, 2000);
      this.applyWorkerResult(result);
    } catch {
      // Der Exit-Handler setzt bei einem Prozessabbruch den eigentlichen Fehlerstatus.
    }

    return this.getStatus();
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.publish({ state: "STOPPED", pid: null });
      return;
    }

    try {
      child.stdin.write(
        JSON.stringify({ id: randomUUID(), method: "shutdown", payload: {} }) + "\n"
      );
    } catch {
      this.killChild();
      return;
    }

    const timer = setTimeout(() => {
      if (this.child === child) this.killChild();
    }, 500);
    timer.unref();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;

    this.child = null;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Analyse-Worker-Startversuch wurde verworfen."));
    }
    this.pending.clear();

    try {
      child.kill();
    } catch {
      // Prozess ist bereits beendet.
    }
  }
}
