import { randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type {
  AnalysisWorkerProgress,
  AnalysisWorkerStatus
} from "../shared/protocol";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  timeoutMs: number;
  method: string;
  startedAtMs: number;
  target: string | null;
};

type WorkerResponse = {
  id?: string | null;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: string;
  requestId?: string | null;
  message?: string;
  phase?: string;
  current?: number;
  total?: number;
  processKind?: string;
  processState?: string;
  pid?: number;
  port?: number;
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
  message: "Analyse-Worker ist noch nicht gestartet.",
  progress: null
};

export class AnalysisService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private stopping = false;
  private qwenServerPid: number | null = null;
  private status: AnalysisWorkerStatus = { ...DEFAULT_STATUS };

  constructor(
    private readonly workerPath: string,
    private readonly onStatus: (status: AnalysisWorkerStatus) => void,
    private readonly devLogPath: string
  ) {
    this.prepareDevLog();
    this.devLog("ELECTRON_SERVICE_CREATED", {
      workerPath: this.workerPath,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    });
  }

  getDevLogPath(): string {
    return this.devLogPath;
  }

  private prepareDevLog(): void {
    try {
      mkdirSync(path.dirname(this.devLogPath), { recursive: true });

      if (existsSync(this.devLogPath)) {
        const maxBytes = 8 * 1024 * 1024;
        const size = statSync(this.devLogPath).size;

        if (size >= maxBytes) {
          const rotated = this.devLogPath + ".1";
          try {
            if (existsSync(rotated)) unlinkSync(rotated);
          } catch {
            // Rotation ist nur Komfort; Logging selbst soll weiterlaufen.
          }
          try {
            renameSync(this.devLogPath, rotated);
          } catch {
            // Falls AV/Editor die Datei kurz blockiert, hängen wir weiter an.
          }
        }
      }
    } catch {
      // Ein Diagnoseprotokoll darf den eigentlichen Worker niemals verhindern.
    }
  }

  private devLog(
    event: string,
    fields: Record<string, unknown> = {}
  ): void {
    try {
      const memory = process.memoryUsage();
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        source: "electron-analysis",
        pid: process.pid,
        event,
        electronRssMiB: Math.round(memory.rss / 1024 / 1024),
        systemFreeMiB: Math.round(os.freemem() / 1024 / 1024),
        systemTotalMiB: Math.round(os.totalmem() / 1024 / 1024),
        ...fields
      });
      appendFileSync(this.devLogPath, line + "\n", "utf8");
    } catch {
      // Diagnose darf die Anwendung nicht beeinflussen.
    }
  }

  private requestTarget(payload: Record<string, unknown>): string | null {
    const value = payload.path;
    return typeof value === "string" && value.trim() ? value : null;
  }

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
    if (this.child) {
      this.devLog("START_SKIPPED_CHILD_ALREADY_PRESENT", {
        childPid: this.child.pid ?? null
      });
      return;
    }

    const startAt = Date.now();
    this.devLog("START_BEGIN");

    this.stopping = false;
    this.publish({
      state: "STARTING",
      message: "Separater Analyse-Worker wird gestartet …"
    });

    let lastError: Error | null = null;

    for (const candidate of this.candidates()) {
      const candidateAt = Date.now();
      this.devLog("PYTHON_CANDIDATE_BEGIN", {
        label: candidate.label,
        command: candidate.command
      });
      try {
        await this.launch(candidate);
        this.devLog("PYTHON_SPAWN_READY", {
          label: candidate.label,
          childPid: this.status.pid,
          elapsedMs: Date.now() - candidateAt
        });

        const pingAt = Date.now();
        const ping = await this.request<Record<string, unknown>>(
          "ping",
          {},
          60000
        );
        this.devLog("PING_OK", {
          elapsedMs: Date.now() - pingAt
        });

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

        // Qwen3-VL 4B ist jetzt reguläre automatische Katalogstufe.
        // Ohne das 4B-GGUF oder llama.cpp wäre die Queue dauerhaft fehlerhaft,
        // deshalb wird die Verfügbarkeit bereits beim Worker-Start geprüft.
        if (
          capabilities.qwen3vl4bModel !== true ||
          capabilities.qwen3vl4bRuntime !== true ||
          capabilities.qwen3vl4bBenchmark !== true
        ) {
          throw new Error(
            "Qwen3-VL 4B Instruct Q4_K_M oder llama.cpp fehlt für die automatische " +
            "Kataloganalyse. Bitte 'npm.cmd run setup:ai' ausführen."
          );
        }

        // Das frühere 8B-Modell bleibt nur Legacy/optional. Es wird von der
        // Katalogpipeline nicht mehr verwendet.
        if (capabilities.qwen3vlModel !== true) {
          this.devLog("QWEN8B_LEGACY_UNAVAILABLE", {
            qwen3vlModel: false
          });
        }

        const configureAt = Date.now();
        const configured = await this.request<Record<string, unknown>>(
          "configure",
          {
            maxConcurrentJobs: 1,
            cpuBudgetPercent: 50,
            profile: "background"
          },
          15000
        );
        this.devLog("CONFIGURE_OK", {
          elapsedMs: Date.now() - configureAt
        });

        this.applyWorkerResult(configured);
        this.publish({
          state: "READY",
          message: "Analyse-Worker läuft getrennt im Hintergrund."
        });
        this.devLog("START_READY", {
          totalElapsedMs: Date.now() - startAt,
          childPid: this.status.pid,
          python: candidate.label
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.devLog("PYTHON_CANDIDATE_ERROR", {
          label: candidate.label,
          elapsedMs: Date.now() - candidateAt,
          error: lastError.message
        });
        this.killChild();
      }
    }

    this.devLog("START_FAILED", {
      totalElapsedMs: Date.now() - startAt,
      error: lastError?.message ?? "Keine passende Python-Installation gefunden."
    });

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
      const launchAt = Date.now();
      this.devLog("SPAWN_BEGIN", {
        label: candidate.label,
        command: candidate.command
      });

      const child = spawn(candidate.command, candidate.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          IMAGE_SORTER_DEV_LOG: this.devLogPath,
          // Windows-Python darf die IPC-Pipes nicht über die lokale ANSI-
          // Codepage behandeln. MiniCPM kann beliebige Unicode-Zeichen
          // zurückgeben; Electron liest die Pipes ebenfalls als UTF-8.
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1"
        }
      });

      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.devLog("SPAWN_ERROR", {
          label: candidate.label,
          elapsedMs: Date.now() - launchAt,
          error: error.message
        });
        reject(error);
      };

      child.once("error", fail);

      child.once("spawn", () => {
        if (settled) return;
        settled = true;

        this.child = child;
        this.attachChild(child);
        this.devLog("SPAWN_EVENT", {
          label: candidate.label,
          childPid: child.pid ?? null,
          elapsedMs: Date.now() - launchAt
        });

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

      if (
        message.event === "process" &&
        message.processKind === "qwen-server"
      ) {
        if (
          message.processState === "started" &&
          typeof message.pid === "number" &&
          Number.isInteger(message.pid) &&
          message.pid > 0
        ) {
          this.qwenServerPid = message.pid;
          this.devLog("QWEN_SERVER_TRACKED", {
            qwenServerPid: message.pid,
            port: message.port ?? null
          });
        } else if (message.processState === "stopped") {
          if (
            typeof message.pid !== "number" ||
            this.qwenServerPid === message.pid
          ) {
            this.devLog("QWEN_SERVER_UNTRACKED", {
              qwenServerPid: this.qwenServerPid
            });
            this.qwenServerPid = null;
          }
        }
        return;
      }

      if (message.event === "progress") {
        const requestId = message.requestId ?? null;

        // Fortschritt nur anzeigen, solange die zugehörige Anfrage wirklich
        // noch aktiv ist. So kann ein verspätetes Event keinen neueren Status
        // überschreiben.
        if (
          requestId &&
          this.pending.has(requestId) &&
          typeof message.message === "string" &&
          message.message.trim()
        ) {
          const current =
            typeof message.current === "number" && Number.isFinite(message.current)
              ? Math.max(0, Math.trunc(message.current))
              : null;
          const total =
            typeof message.total === "number" && Number.isFinite(message.total)
              ? Math.max(0, Math.trunc(message.total))
              : null;

          const pending = this.pending.get(requestId);
          const progress: AnalysisWorkerProgress = {
            kind:
              pending?.method === "benchmark_minicpm"
                ? "minicpm"
                : pending?.method === "benchmark_qwen3vl2b"
                  ? "qwen3vl2b"
                  : pending?.method === "benchmark_qwen3vl4b" ||
                    pending?.method === "analyze_catalog_qwen3vl4b"
                    ? "qwen3vl4b"
                    : "qwen3vl",
            phase:
              typeof message.phase === "string" && message.phase.trim()
                ? message.phase.trim()
                : "working",
            current,
            total,
            message: message.message.trim()
          };

          if (pending) this.armPendingTimeout(requestId, pending);

          this.devLog("WORKER_PROGRESS", {
            requestId,
            phase: progress.phase,
            current: progress.current,
            total: progress.total,
            message: progress.message
          });

          this.publish({
            message: progress.message,
            progress
          });
        }
        return;
      }

      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      const elapsedMs = Date.now() - pending.startedAtMs;
      if (message.ok) {
        this.devLog("REQUEST_OK", {
          requestId: message.id,
          method: pending.method,
          target: pending.target,
          elapsedMs
        });
        pending.resolve(message.result);
      } else {
        const error = message.error ?? "Analyse-Worker meldet einen Fehler.";
        this.devLog("REQUEST_ERROR", {
          requestId: message.id,
          method: pending.method,
          target: pending.target,
          elapsedMs,
          error
        });
        pending.reject(new Error(error));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (!message) return;
      this.devLog("WORKER_STDERR", { message });
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

      this.devLog("WORKER_EXIT", {
        childPid: child.pid ?? null,
        code: code ?? null,
        signal: signal ?? null,
        wasCurrentChild
      });

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
          message: "Analyse-Worker wurde mit der App beendet.",
          progress: null
        });
      } else {
        this.publish({
          state: "ERROR",
          pid: null,
          activeJobs: 0,
          message: error.message,
          progress: null
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
      progress: null,
      ...(message ? { message } : {})
    });
  }

  private armPendingTimeout(id: string, pending: Pending): void {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      const current = this.pending.get(id);
      if (!current) return;

      this.pending.delete(id);
      const error = new Error(
        `Zeitüberschreitung bei Analyse-Worker-Methode ${current.method}.`
      );
      this.devLog("REQUEST_TIMEOUT", {
        requestId: id,
        method: current.method,
        target: current.target,
        elapsedMs: Date.now() - current.startedAtMs,
        inactivityTimeoutMs: current.timeoutMs
      });
      current.reject(error);

      // Ein abgelaufener Qwen-Aufruf darf nicht im Python-Prozess weiterlaufen
      // und alle folgenden Jobs blockieren. Worker + llama.cpp-Prozessbaum
      // werden beendet und anschließend frisch gestartet.
      if (
        current.method === "detect_qwen3vl_objects" ||
        current.method === "analyze_catalog_qwen3vl4b" ||
        current.method === "benchmark_qwen3vl" ||
        current.method === "benchmark_minicpm" ||
        current.method === "benchmark_qwen3vl2b" ||
        current.method === "benchmark_qwen3vl4b"
      ) {
        this.publish({
          state: "STARTING",
          progress: null,
          message:
            "Das Vision-Modell hat zu lange keine Aktivität gemeldet. " +
            "Analyse-Worker wird sauber neu gestartet …"
        });

        this.killChild();

        const restart = setTimeout(() => {
          void this.start();
        }, 1200);
        restart.unref();
      }
    }, pending.timeoutMs);
    pending.timeout.unref();
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
      const pending: Pending = {
        resolve: (value) => resolve(value as T),
        reject,
        timeout: setTimeout(() => {}, 1),
        timeoutMs,
        method,
        startedAtMs: Date.now(),
        target: this.requestTarget(payload)
      };

      this.pending.set(id, pending);
      this.armPendingTimeout(id, pending);

      this.devLog("REQUEST_BEGIN", {
        requestId: id,
        method,
        target: pending.target,
        timeoutMs
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
    this.devLog("STOP_GRACEFUL_BEGIN", {
      childPid: this.status.pid
    });
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.publish({ state: "STOPPED", pid: null, progress: null });
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

  private isTrackedQwenProcessRunning(): boolean {
    const pid = this.qwenServerPid;
    if (!pid) return false;

    if (process.platform !== "win32") {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    try {
      const probe = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000
        }
      );

      const output =
        typeof probe.stdout === "string" ? probe.stdout : "";

      return /llama-server(?:\.exe)?/i.test(output);
    } catch {
      return false;
    }
  }

  private killTrackedQwenServerSync(): void {
    const pid = this.qwenServerPid;
    if (!pid) return;

    const running = this.isTrackedQwenProcessRunning();
    this.devLog("QWEN_SERVER_SHUTDOWN_CHECK", {
      qwenServerPid: pid,
      running
    });

    if (!running) {
      this.qwenServerPid = null;
      return;
    }

    try {
      if (process.platform === "win32") {
        const killed = spawnSync(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          {
            stdio: "ignore",
            windowsHide: true,
            timeout: 15000
          }
        );
        this.devLog("QWEN_SERVER_FALLBACK_KILL", {
          qwenServerPid: pid,
          status: killed.status
        });
      } else {
        process.kill(pid, "SIGKILL");
        this.devLog("QWEN_SERVER_FALLBACK_KILL", {
          qwenServerPid: pid,
          status: 0
        });
      }
    } catch (error) {
      this.devLog("QWEN_SERVER_FALLBACK_KILL_ERROR", {
        qwenServerPid: pid,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.qwenServerPid = null;
    }
  }

  /**
   * Stoppt den Analyse-Worker samt llama.cpp synchron, bevor der
   * Qwen-Einzelbildtest geöffnet wird. Dadurch ist der Arbeitsspeicher bereits
   * frei, wenn der Windows-Dateidialog erscheint. Laufende Queue-Jobs werden
   * vom AnalysisCoordinator kontrolliert wieder auf PENDING gesetzt.
   */
  stopForBenchmark(): void {
    const stopAt = Date.now();
    this.devLog("BENCHMARK_STOP_BEGIN", {
      childPid: this.status.pid,
      qwenServerPid: this.qwenServerPid
    });
    this.stopping = true;
    const child = this.child;

    if (child) {
      this.child = null;

      const interruption = new Error(
        "Analyse-Worker wurde für den Einzelbildtest pausiert."
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(interruption);
      }
      this.pending.clear();

      try {
        if (process.platform === "win32" && child.pid) {
          spawnSync(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            {
              stdio: "ignore",
              windowsHide: true,
              timeout: 15000
            }
          );
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Prozess ist bereits beendet.
        }
      }
    }

    // taskkill /T nimmt llama.cpp normalerweise mit. Die separat verfolgte
    // PID ist das Sicherheitsnetz, damit vor dem Dateidialog garantiert kein
    // Qwen-Modell mehr im Hauptspeicher liegt.
    this.killTrackedQwenServerSync();

    this.devLog("BENCHMARK_STOP_DONE", {
      elapsedMs: Date.now() - stopAt
    });

    this.publish({
      state: "STOPPED",
      pid: null,
      activeJobs: 0,
      progress: null,
      message: "Standardanalyse pausiert · Vision-Modell/llama.cpp für Einzeltest entladen."
    });
  }

  /**
   * Harte, synchrone Beendigung für den App-Shutdown.
   *
   * Ein laufender Qwen-Aufruf blockiert den Python-Worker in urllib und kann
   * deshalb kein "shutdown" mehr aus stdin lesen. Beim normalen App-Ende darf
   * Electron außerdem nicht verschwinden, bevor taskkill den von uns gestarteten
   * Prozessbaum wirklich beendet hat. Unter Windows wird deshalb synchron
   * Python + dessen llama-server-Kindprozess beendet.
   */
  stopImmediately(): void {
    const stopAt = Date.now();
    this.devLog("STOP_IMMEDIATE_BEGIN", {
      childPid: this.status.pid
    });
    this.stopping = true;
    const child = this.child;

    if (!child) {
      this.killTrackedQwenServerSync();
      this.publish({
        state: "STOPPED",
        pid: null,
        activeJobs: 0,
        queuedJobs: 0,
        progress: null,
        message: "Analyse-Worker und Qwen sind beendet."
      });
      return;
    }

    this.child = null;

    const shutdownError = new Error(
      "Analyse-Worker wurde wegen App-Beendigung gestoppt."
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(shutdownError);
    }
    this.pending.clear();

    try {
      if (process.platform === "win32" && child.pid) {
        // /T beendet nur den Prozessbaum dieses konkreten Python-Workers.
        // Dadurch wird kein fremder llama-server auf dem System angefasst.
        spawnSync(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            stdio: "ignore",
            windowsHide: true,
            timeout: 15000
          }
        );
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Prozess ist bereits beendet.
      }
    }

    // /T sollte llama.cpp bereits mitnehmen. Der separat verfolgte PID ist ein
    // Sicherheitsnetz für den seltenen Fall, dass der Server sich vom
    // Python-Prozess gelöst hat oder der Worker vorher abgestürzt ist.
    this.killTrackedQwenServerSync();

    this.devLog("STOP_IMMEDIATE_DONE", {
      elapsedMs: Date.now() - stopAt
    });

    this.publish({
      state: "STOPPED",
      pid: null,
      activeJobs: 0,
      queuedJobs: 0,
      progress: null,
      message: "Analyse-Worker und Qwen wurden vollständig beendet."
    });
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;

    this.devLog("KILL_CHILD_BEGIN", {
      childPid: child.pid ?? null
    });

    this.child = null;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Analyse-Worker-Startversuch wurde verworfen."));
    }
    this.pending.clear();

    try {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            stdio: "ignore",
            windowsHide: true
          }
        );
        killer.unref();
      } else {
        child.kill();
      }
    } catch {
      try {
        child.kill();
      } catch {
        // Prozess ist bereits beendet.
      }
    }

    this.killTrackedQwenServerSync();
  }
}
