import path from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { readFile, readdir, rm } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell, type OpenDialogOptions } from "electron";
import { CatalogService } from "./catalog-service";
import { AnalysisService } from "./analysis-service";
import { AnalysisCoordinator } from "./analysis-coordinator";
import { ThumbnailService } from "./thumbnail-service";
import { ThumbnailCoordinator } from "./thumbnail-coordinator";
import { getVideoFrameJpeg, pruneVideoFrameCache } from "./video-frame-service";
import { PersonService } from "./person-service";
import { PetService } from "./pet-service";
import { CatalogWatchService } from "./catalog-watch-service";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, IGNORED_DIRECTORY_NAMES } from "../catalog/constants";
import type {
  AnalysisErrorRecord,
  AnalysisQueueStats,
  AssignPersonSelectionResult,
  AnalysisWorkerStatus,
  BackgroundPauseState,
  QwenBenchmarkModel,
  QwenBenchmarkProfile,
  QwenBenchmarkRunResult,
  QwenBenchmarkStageResult,
  CatalogStats,
  CatalogWatchSnapshot,
  ExplorerFolderNode,
  ExplorerRoot,
  FolderTreeNode,
  GeoMediaPoint,
  LifeAreaRecord,
  LifeAreaMediaItem,
  ApplyLifeAreaRulesResult,
  LifeAreaMutationResult,
  ConfirmPersonResult,
  ConfirmPetResult,
  IgnorePersonResult,
  IgnorePetResult,
  DuplicateGroup,
  DirectIdentityAssignmentResult,
  FaceCropInfo,
  MediaPreviewInfo,
  MediaDetails,
  MediaRecord,
  MergePersonsResult,
  MergePetsResult,
  PersonCorrectionResult,
  PetCorrectionResult,
  SplitPetCandidateResult,
  AssignPetSelectionResult,
  PersonOverview,
  PetCropInfo,
  PetOverview,
  RestoreResult,
  ResetCatalogResult,
  ReanalyzeMediaResult,
  RetryAnalysisResult,
  SearchFacets,
  SearchFilter,
  SemanticTextEmbedding,
  ScanResult,
  SourceRecord,
  ThumbnailInfo,
  PipelineStatus,
  ShutdownStatus
} from "../shared/protocol";

let windowRef: BrowserWindow | null = null;
let sourceManagerWindowRef: BrowserWindow | null = null;
let catalog: CatalogService | null = null;
let analysis: AnalysisService | null = null;
let analysisCoordinator: AnalysisCoordinator | null = null;
let thumbnailService: ThumbnailService | null = null;
let thumbnailCoordinator: ThumbnailCoordinator | null = null;
let personService: PersonService | null = null;
let petService: PetService | null = null;
let catalogWatchService: CatalogWatchService | null = null;
let thumbnailCacheRoot = "";
let personRefreshTimer: NodeJS.Timeout | null = null;
let personRefreshRunning = false;
let personRefreshRescheduleRequested = false;
let lifeAreaRuleRefreshTimer: NodeJS.Timeout | null = null;
const groupedFaceEmbeddingCounts = new Map<number, number>();
const groupedPetEmbeddingCounts = new Map<number, number>();
let isQuitting = false;
let shutdownInProgress = false;
let allowQuit = false;
let shutdownPromise: Promise<void> | null = null;
let qwenBenchmarkMode = false;
let qwenBenchmarkPreparing: Promise<void> | null = null;
let backgroundPaused = false;
let backgroundPauseChanging = false;
const mediaStreamPathCache = new Map<number, string>();

const REMOTE_WEB_PORT = 8787;
const REMOTE_WEB_HOST = "::";
let remoteWebServer: HttpServer | null = null;

const REMOTE_START_PAGE = "<!doctype html>\n<html lang=\"de\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <title>Image Sortierer – Remote-Test</title>\n  <style>\n    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; background:#0b0d10; color:#f4f5f7; }\n    * { box-sizing:border-box; }\n    body { margin:0; min-height:100vh; background:radial-gradient(circle at top,#171b21 0,#0b0d10 52%); }\n    main { width:min(980px,calc(100% - 32px)); margin:0 auto; padding:40px 0 64px; }\n    .hero,.panel { border:1px solid #2a3039; background:rgba(20,23,28,.94); border-radius:18px; box-shadow:0 18px 60px rgba(0,0,0,.28); }\n    .hero { padding:28px; }\n    .eyebrow { display:flex; align-items:center; gap:10px; color:#aeb7c4; font-size:14px; }\n    .dot { width:11px; height:11px; border-radius:999px; background:#46d17b; box-shadow:0 0 0 5px rgba(70,209,123,.12); }\n    h1 { margin:14px 0 8px; font-size:clamp(28px,5vw,46px); line-height:1.04; }\n    .sub { margin:0; color:#aeb7c4; }\n    .grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin-top:18px; }\n    .card { padding:17px; border:1px solid #2a3039; border-radius:14px; background:#111419; }\n    .value { font-size:28px; font-weight:750; letter-spacing:-.03em; }\n    .label { margin-top:5px; color:#8f99a8; font-size:13px; }\n    .panel { margin-top:18px; padding:22px; }\n    .row { display:flex; justify-content:space-between; gap:18px; padding:10px 0; border-bottom:1px solid #252a31; }\n    .row:last-child { border-bottom:0; }\n    .key { color:#8f99a8; }\n    .mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:13px; overflow-wrap:anywhere; }\n    button { border:0; border-radius:10px; background:#f4f5f7; color:#0b0d10; padding:11px 15px; font-weight:700; cursor:pointer; }\n    button:disabled { opacity:.55; cursor:wait; }\n    .ping { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:14px; }\n    .ok { color:#69e69a; }\n    .bad { color:#ff8585; }\n    @media (max-width:760px) { .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .hero,.panel { border-radius:14px; } }\n  </style>\n</head>\n<body>\n<main>\n  <section class=\"hero\">\n    <div class=\"eyebrow\"><span class=\"dot\"></span><span id=\"connection\">Verbindung wird geprüft …</span></div>\n    <h1>Image Sortierer</h1>\n    <p class=\"sub\">Live-Test: Browser ↔ Cloudflare Tunnel ↔ lokale App ↔ Katalog-Datenbank</p>\n    <div class=\"grid\">\n      <div class=\"card\"><div class=\"value\" id=\"total\">–</div><div class=\"label\">Medien gesamt</div></div>\n      <div class=\"card\"><div class=\"value\" id=\"available\">–</div><div class=\"label\">Verfügbar</div></div>\n      <div class=\"card\"><div class=\"value\" id=\"persons\">–</div><div class=\"label\">Personen</div></div>\n      <div class=\"card\"><div class=\"value\" id=\"pets\">–</div><div class=\"label\">Haustiere</div></div>\n      <div class=\"card\"><div class=\"value\" id=\"faces\">–</div><div class=\"label\">Erkannte Gesichter</div></div>\n    </div>\n  </section>\n  <section class=\"panel\">\n    <div class=\"row\"><span class=\"key\">Serverzeit</span><span class=\"mono\" id=\"serverTime\">–</span></div>\n    <div class=\"row\"><span class=\"key\">Letzter Katalog-Scan</span><span class=\"mono\" id=\"lastScan\">–</span></div>\n    <div class=\"row\"><span class=\"key\">Hintergrundanalyse</span><span id=\"background\">–</span></div>\n    <div class=\"row\"><span class=\"key\">Letzter Abruf</span><span class=\"mono\" id=\"lastFetch\">–</span></div>\n    <div class=\"ping\">\n      <button id=\"pingButton\" type=\"button\">Testdaten senden</button>\n      <span id=\"pingResult\" class=\"mono\">Noch kein Ping gesendet.</span>\n    </div>\n  </section>\n</main>\n<script>\n  const number = new Intl.NumberFormat(\"de-DE\");\n  const ids = [\"total\",\"available\",\"persons\",\"pets\",\"faces\"];\n  function setText(id,value){ document.getElementById(id).textContent = value; }\n\n  async function refreshStatus(){\n    try {\n      const response = await fetch(\"/api/remote-status\", { cache:\"no-store\" });\n      if (!response.ok) throw new Error(\"HTTP \" + response.status);\n      const payload = await response.json();\n      const stats = payload.stats || {};\n      setText(\"connection\", payload.catalogReady ? \"Remote-Verbindung aktiv · Katalog erreichbar\" : \"Remote-Verbindung aktiv · Katalog startet\");\n      document.getElementById(\"connection\").className = payload.catalogReady ? \"ok\" : \"\";\n      setText(\"total\", Number.isFinite(stats.total) ? number.format(stats.total) : \"–\");\n      setText(\"available\", Number.isFinite(stats.available) ? number.format(stats.available) : \"–\");\n      setText(\"persons\", Number.isFinite(stats.persons) ? number.format(stats.persons) : \"–\");\n      setText(\"pets\", Number.isFinite(stats.pets) ? number.format(stats.pets) : \"–\");\n      setText(\"faces\", Number.isFinite(stats.detectedFaces) ? number.format(stats.detectedFaces) : \"–\");\n      setText(\"serverTime\", payload.serverTime ? new Date(payload.serverTime).toLocaleString(\"de-DE\") : \"–\");\n      setText(\"lastScan\", stats.lastScan ? new Date(stats.lastScan).toLocaleString(\"de-DE\") : \"noch keiner\");\n      setText(\"background\", payload.background && payload.background.paused ? \"pausiert\" : \"läuft\");\n      setText(\"lastFetch\", new Date().toLocaleTimeString(\"de-DE\"));\n    } catch (error) {\n      setText(\"connection\", \"Verbindung unterbrochen\");\n      document.getElementById(\"connection\").className = \"bad\";\n      ids.forEach((id) => setText(id,\"–\"));\n      setText(\"lastFetch\", String(error));\n    }\n  }\n\n  document.getElementById(\"pingButton\").addEventListener(\"click\", async () => {\n    const button = document.getElementById(\"pingButton\");\n    button.disabled = true;\n    const started = performance.now();\n    try {\n      const sentAt = new Date().toISOString();\n      const response = await fetch(\"/api/remote-echo\", {\n        method:\"POST\",\n        headers:{ \"Content-Type\":\"application/json\" },\n        body:JSON.stringify({ sentAt, message:\"Hallo vom Browser\" })\n      });\n      if (!response.ok) throw new Error(\"HTTP \" + response.status);\n      const payload = await response.json();\n      const roundtrip = Math.round(performance.now() - started);\n      const echo = payload.echo && payload.echo.message ? payload.echo.message : \"Antwort erhalten\";\n      setText(\"pingResult\", echo + \" · \" + roundtrip + \" ms · Server \" + new Date(payload.receivedAt).toLocaleTimeString(\"de-DE\"));\n      document.getElementById(\"pingResult\").className = \"mono ok\";\n    } catch (error) {\n      setText(\"pingResult\", \"Fehler: \" + String(error));\n      document.getElementById(\"pingResult\").className = \"mono bad\";\n    } finally {\n      button.disabled = false;\n    }\n  });\n\n  refreshStatus();\n  setInterval(refreshStatus, 3000);\n</script>\n</body>\n</html>";

const REMOTE_WEB_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
} as const;

function writeRemoteJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  response.writeHead(statusCode, {
    ...REMOTE_WEB_SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function readRemoteJsonBody(
  request: import("node:http").IncomingMessage,
  maxBytes = 4096
): Promise<unknown> {
  let body = "";

  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("Request body too large");
    }
  }

  if (!body.trim()) return {};
  return JSON.parse(body);
}

function startRemoteWebServer(): Promise<void> {
  if (remoteWebServer) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const method = request.method ?? "GET";
      let pathname = "/";

      try {
        pathname = new URL(
          request.url ?? "/",
          "http://localhost"
        ).pathname;
      } catch {
        response.writeHead(400, {
          ...REMOTE_WEB_SECURITY_HEADERS,
          "Content-Type": "text/plain; charset=utf-8"
        });
        response.end("Bad Request");
        return;
      }

      if ((method === "GET" || method === "HEAD") && pathname === "/") {
        response.writeHead(200, {
          ...REMOTE_WEB_SECURITY_HEADERS,
          "Content-Type": "text/html; charset=utf-8"
        });
        response.end(method === "HEAD" ? undefined : REMOTE_START_PAGE);
        return;
      }

      if ((method === "GET" || method === "HEAD") && pathname === "/api/remote-status") {
        try {
          const stats = catalog
            ? await catalog.request<CatalogStats>("getStats")
            : null;

          const payload = {
            ok: true,
            app: "Image Sortierer",
            serverTime: new Date().toISOString(),
            catalogReady: Boolean(catalog),
            stats,
            background: backgroundPauseState(),
            pipeline: pipelineStatus
          };

          if (method === "HEAD") {
            response.writeHead(200, {
              ...REMOTE_WEB_SECURITY_HEADERS,
              "Content-Type": "application/json; charset=utf-8"
            });
            response.end();
          } else {
            writeRemoteJson(response, 200, payload);
          }
        } catch (error) {
          writeRemoteJson(response, 503, {
            ok: false,
            serverTime: new Date().toISOString(),
            catalogReady: Boolean(catalog),
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      if (method === "POST" && pathname === "/api/remote-echo") {
        try {
          const echo = await readRemoteJsonBody(request);
          writeRemoteJson(response, 200, {
            ok: true,
            receivedAt: new Date().toISOString(),
            echo
          });
        } catch (error) {
          writeRemoteJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      response.writeHead(404, {
        ...REMOTE_WEB_SECURITY_HEADERS,
        "Content-Type": "text/plain; charset=utf-8"
      });
      response.end("Not Found");
    });

    let settled = false;

    server.once("error", (error) => {
      if (remoteWebServer === server) remoteWebServer = null;
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    server.listen(
      {
        host: REMOTE_WEB_HOST,
        port: REMOTE_WEB_PORT,
        ipv6Only: false
      },
      () => {
        remoteWebServer = server;
        settled = true;
        analysis?.logDiagnostic("REMOTE_WEB_SERVER_STARTED", {
          host: REMOTE_WEB_HOST,
          port: REMOTE_WEB_PORT
        });
        resolve();
      }
    );
  });
}

function stopRemoteWebServer(): Promise<void> {
  const server = remoteWebServer;
  remoteWebServer = null;
  if (!server) return Promise.resolve();

  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1000).unref();
  });
}

const IDENTITY_FACE_BATCH_SIZE = 250;
const IDENTITY_DOG_BATCH_SIZE = 50;

const EMPTY_QUEUE: AnalysisQueueStats = {
  pending: 0,
  running: 0,
  done: 0,
  failed: 0,
  unavailable: 0
};

let pipelineStatus: PipelineStatus = {
  technical: { ...EMPTY_QUEUE },
  thumbnails: { ...EMPTY_QUEUE },
  imageMetadata: { ...EMPTY_QUEUE },
  faces: { ...EMPTY_QUEUE },
  faceEmbeddings: { ...EMPTY_QUEUE },
  petDetection: { ...EMPTY_QUEUE },
  petFusion: { ...EMPTY_QUEUE },
  petEmbeddings: { ...EMPTY_QUEUE },
  objectVerification: { ...EMPTY_QUEUE },
  semanticEmbeddings: { ...EMPTY_QUEUE },
  videoAnalysis: { ...EMPTY_QUEUE }
};

const semanticTextCache = new Map<string, SemanticTextEmbedding>();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "image-sorter-thumb",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  {
    scheme: "image-sorter-face",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  {
    scheme: "image-sorter-pet",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  {
    scheme: "image-sorter-preview",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  {
    scheme: "image-sorter-frame",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  {
    scheme: "image-sorter-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

function sendToRenderer(channel: string, payload: unknown): void {
  const win = windowRef;
  if (
    isQuitting ||
    !win ||
    win.isDestroyed() ||
    win.webContents.isDestroyed()
  ) {
    return;
  }

  win.webContents.send(channel, payload);
}

function backgroundPauseState(): BackgroundPauseState {
  return {
    paused: backgroundPaused,
    changing: backgroundPauseChanging,
    message: backgroundPauseChanging
      ? (backgroundPaused ? "Hintergrundarbeit wird pausiert …" : "Hintergrundarbeit wird fortgesetzt …")
      : backgroundPaused
        ? "Hintergrundarbeit pausiert · CPU/GPU-Worker gestoppt."
        : "Hintergrundarbeit läuft."
  };
}

function publishBackgroundPauseState(): void {
  sendToRenderer("app:backgroundPauseState", backgroundPauseState());
}

function publishShutdownStatus(
  phase: ShutdownStatus["phase"],
  message: string
): void {
  sendToRenderer("app:shutdownStatus", { phase, message } satisfies ShutdownStatus);
  analysis?.logDiagnostic("APP_SHUTDOWN_STATUS", { phase, message });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      operation.then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getIdentityEmbeddingCounts(): Promise<Array<{
  sourceId: number;
  faces: number;
  dogs: number;
}>> {
  if (!catalog) return [];

  // Der Identity-Refresh braucht nur diese beiden Zähler. Früher wurde dafür
  // pro Quelle getStats() aufgerufen, das zusätzlich Duplikate, Kandidaten,
  // Recycle-Bin und mehrere große JOINs berechnet hat.
  return catalog.request<Array<{
    sourceId: number;
    faces: number;
    dogs: number;
  }>>("getIdentityEmbeddingCounts");
}

async function waitForIdentityRefreshIdle(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (personRefreshRunning && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  if (personRefreshRunning) {
    throw new Error(
      "Personen-/Haustiergruppierung konnte vor dem Datenbank-Reset nicht sauber angehalten werden."
    );
  }
}

function schedulePersonRefresh(): void {
  if (
    isQuitting ||
    shutdownInProgress ||
    backgroundPaused ||
    (!personService && !petService) ||
    personRefreshTimer
  ) {
    return;
  }

  if (personRefreshRunning) {
    // Do not start another global clustering request in parallel. Remember the
    // invalidation instead and run one fresh pass after the active pass ends.
    personRefreshRescheduleRequested = true;
    return;
  }

  // Kandidaten werden weiterhin während der Fast-Lane nachgezogen, aber nicht
  // mehr wegen jedes abgeschlossenen Embedding-Jobs. Jobs ohne Gesicht/Hund
  // erhöhen nur den DONE-Zähler und dürfen kein komplettes Re-Clustering aller
  // vorhandenen Identitäten auslösen.
  personRefreshTimer = setTimeout(() => {
    personRefreshTimer = null;
    if (
      (!personService && !petService) ||
      isQuitting ||
      shutdownInProgress ||
      backgroundPaused
    ) {
      return;
    }

    if (personRefreshRunning) {
      personRefreshRescheduleRequested = true;
      return;
    }

    personRefreshRunning = true;

    void (async () => {
      const counts = await getIdentityEmbeddingCounts();

      // Der Katalogaufruf kann bei großen Importen einige Sekunden warten.
      // Falls in dieser Zeit der App-Shutdown begonnen hat, darf danach weder
      // Clustering noch ein neuer Python-Request gestartet werden.
      if (shutdownInProgress || isQuitting || backgroundPaused) {
        return;
      }

      const faceQueueIdle =
        pipelineStatus.faceEmbeddings.pending === 0 &&
        pipelineStatus.faceEmbeddings.running === 0;
      const petQueueIdle =
        pipelineStatus.petEmbeddings.pending === 0 &&
        pipelineStatus.petEmbeddings.running === 0;

      const faceChangedSources = counts.filter((entry) => {
        const previous = groupedFaceEmbeddingCounts.get(entry.sourceId) ?? 0;
        const delta = entry.faces - previous;
        return (
          delta < 0 ||
          delta >= IDENTITY_FACE_BATCH_SIZE ||
          (faceQueueIdle && delta !== 0)
        );
      });

      const petChangedSources = counts.filter((entry) => {
        const previous = groupedPetEmbeddingCounts.get(entry.sourceId) ?? 0;
        const delta = entry.dogs - previous;
        return (
          delta < 0 ||
          delta >= IDENTITY_DOG_BATCH_SIZE ||
          (petQueueIdle && delta !== 0)
        );
      });

      if (faceChangedSources.length === 0 && petChangedSources.length === 0) {
        return;
      }

      analysis?.setIdentityGroupingActivity(
        faceChangedSources.length > 0,
        petChangedSources.length > 0
      );

      analysis?.logDiagnostic("IDENTITY_REFRESH_BEGIN", {
        faceSources: faceChangedSources.map((entry) => ({
          sourceId: entry.sourceId,
          embeddings: entry.faces,
          previous: groupedFaceEmbeddingCounts.get(entry.sourceId) ?? null
        })),
        dogSources: petChangedSources.map((entry) => ({
          sourceId: entry.sourceId,
          embeddings: entry.dogs,
          previous: groupedPetEmbeddingCounts.get(entry.sourceId) ?? null
        }))
      });

      // Gruppierung läuft jetzt als normaler paralleler Python-Job mit.
      // Sie darf die Bild-/Video-Lanes nicht mehr exklusiv anhalten.
      try {
        if (shutdownInProgress || isQuitting || backgroundPaused) return;

        if (personService) {
          for (const entry of faceChangedSources) {
            // Nur die tatsächlich geänderte Quelle prüfen. forceRefresh=false
            // verhindert beim App-Start einen teuren Neuaufbau, wenn die
            // gespeicherte Cluster-Revision bereits exakt aktuell ist.
            await personService.getOverview(
              entry.sourceId,
              false,
              true,
              true
            );
            groupedFaceEmbeddingCounts.set(entry.sourceId, entry.faces);
            if (shutdownInProgress || isQuitting || backgroundPaused) return;
          }
          if (faceChangedSources.length > 0) {
            sendToRenderer("people:updated", {});
          }
        }

        if (petService) {
          for (const entry of petChangedSources) {
            await petService.getOverview(
              entry.sourceId,
              false,
              true,
              true
            );
            groupedPetEmbeddingCounts.set(entry.sourceId, entry.dogs);
            if (shutdownInProgress || isQuitting || backgroundPaused) return;
          }
          if (petChangedSources.length > 0) {
            sendToRenderer("pets:updated", {});
          }
        }

        const activeSourceIds = new Set(counts.map((entry) => entry.sourceId));
        for (const sourceId of [...groupedFaceEmbeddingCounts.keys()]) {
          if (!activeSourceIds.has(sourceId)) groupedFaceEmbeddingCounts.delete(sourceId);
        }
        for (const sourceId of [...groupedPetEmbeddingCounts.keys()]) {
          if (!activeSourceIds.has(sourceId)) groupedPetEmbeddingCounts.delete(sourceId);
        }
      } finally {
        analysis?.setIdentityGroupingActivity(false, false);
        // Kein exklusiver Maintenance-Stopp mehr nötig.
      }
    })()
      .catch((error) => {
        // Bei einem temporären Clusterfehler bleiben die Embedding-Zähler
        // unverändert. Ein Retry wird explizit vorgemerkt, statt darauf zu
        // hoffen, dass zufällig noch ein weiterer Pipeline-Statuswechsel kommt.
        personRefreshRescheduleRequested = true;
        analysis?.logDiagnostic("IDENTITY_REFRESH_ERROR", {
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        personRefreshRunning = false;

        if (personRefreshRescheduleRequested) {
          personRefreshRescheduleRequested = false;
          schedulePersonRefresh();
        }
      });
  }, 30000);
  personRefreshTimer.unref();
}

function scheduleLifeAreaRuleRefresh(): void {
  if (backgroundPaused) return;

  if (lifeAreaRuleRefreshTimer) {
    clearTimeout(lifeAreaRuleRefreshTimer);
  }

  lifeAreaRuleRefreshTimer = setTimeout(() => {
    lifeAreaRuleRefreshTimer = null;
    if (!catalog || isQuitting || shutdownInProgress || backgroundPaused) return;

    void catalog
      .request<ApplyLifeAreaRulesResult>("applyLifeAreaRules")
      .then(() => {
        sendToRenderer("lifeAreas:updated", {});
      })
      .catch((error) => {
        analysis?.logDiagnostic("LIFE_AREA_RULE_REFRESH_ERROR", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }, 1800);
  lifeAreaRuleRefreshTimer.unref();
}

function updatePipelineStage(
  stage: keyof PipelineStatus,
  stats: AnalysisQueueStats
): void {
  pipelineStatus = {
    ...pipelineStatus,
    [stage]: { ...stats }
  };

  sendToRenderer("analysis:pipelineStatus", pipelineStatus);

  if (
    stage === "faceEmbeddings" ||
    stage === "petEmbeddings"
  ) {
    schedulePersonRefresh();
  }

  if (
    stage === "technical" ||
    stage === "imageMetadata" ||
    stage === "faceEmbeddings" ||
    stage === "petEmbeddings" ||
    stage === "objectVerification" ||
    stage === "videoAnalysis"
  ) {
    scheduleLifeAreaRuleRefresh();
  }
}

function isInsideDirectory(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function buildFolderTree(folderPath: string): Promise<FolderTreeNode> {
  const resolved = path.resolve(folderPath);
  const name = path.basename(resolved) || resolved;
  let entries;

  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (error) {
    return {
      name,
      path: resolved,
      directImages: 0,
      directVideos: 0,
      images: 0,
      videos: 0,
      children: [],
      readError: error instanceof Error ? error.message : String(error)
    };
  }

  let directImages = 0;
  let directVideos = 0;
  const childDirectories = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
      childDirectories.push(path.join(resolved, entry.name));
      continue;
    }

    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) directImages += 1;
    if (VIDEO_EXTENSIONS.has(extension)) directVideos += 1;
  }

  const children: FolderTreeNode[] = [];
  let images = directImages;
  let videos = directVideos;

  for (const childPath of childDirectories.sort((a, b) =>
    a.localeCompare(b, "de", { sensitivity: "base" })
  )) {
    const child = await buildFolderTree(childPath);
    children.push(child);
    images += child.images;
    videos += child.videos;
  }

  return {
    name,
    path: resolved,
    directImages,
    directVideos,
    images,
    videos,
    children,
    readError: null
  };
}

async function inspectExplorerFolder(folderPath: string): Promise<ExplorerFolderNode> {
  const resolved = path.resolve(folderPath);
  const name = path.basename(resolved) || resolved;

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    let directImages = 0;
    let directVideos = 0;
    let hasChildren = false;

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          hasChildren = true;
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(extension)) directImages += 1;
      if (VIDEO_EXTENSIONS.has(extension)) directVideos += 1;
    }

    return {
      name,
      path: resolved,
      directImages,
      directVideos,
      hasChildren,
      readError: null
    };
  } catch (error) {
    return {
      name,
      path: resolved,
      directImages: 0,
      directVideos: 0,
      hasChildren: false,
      readError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function listExplorerRoots(): Promise<ExplorerRoot[]> {
  if (process.platform === "win32") {
    const roots: ExplorerRoot[] = [];
    for (let code = 67; code <= 90; code += 1) {
      const drive = String.fromCharCode(code) + ":\\";
      try {
        const node = await inspectExplorerFolder(drive);
        if (node.readError) continue;
        roots.push({
          name: drive,
          path: drive,
          directImages: node.directImages,
          directVideos: node.directVideos,
          hasChildren: node.hasChildren,
          readError: null
        });
      } catch {
        // Nicht vorhandene oder nicht erreichbare Laufwerke werden ausgelassen.
      }
    }
    return roots;
  }

  const root = await inspectExplorerFolder(path.parse(process.cwd()).root || "/");
  return [{
    name: root.path,
    path: root.path,
    directImages: root.directImages,
    directVideos: root.directVideos,
    hasChildren: root.hasChildren,
    readError: root.readError
  }];
}

async function getExplorerChildren(folderPath: string): Promise<ExplorerFolderNode[]> {
  const resolved = path.resolve(folderPath);
  const entries = await readdir(resolved, { withFileTypes: true });
  const childPaths = entries
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        entry.isDirectory() &&
        !IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())
    )
    .map((entry) => path.join(resolved, entry.name))
    .sort((left, right) =>
      left.localeCompare(right, "de", { sensitivity: "base" })
    );

  const children: ExplorerFolderNode[] = [];
  for (const childPath of childPaths) {
    children.push(await inspectExplorerFolder(childPath));
  }
  return children;
}

function createSourceManagerWindow(): BrowserWindow {
  const existing = sourceManagerWindowRef;
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#f4f6f8",
    parent: windowRef ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  sourceManagerWindowRef = win;
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    const base = devUrl.endsWith("/") ? devUrl : devUrl + "/";
    void win.loadURL(new URL("source-manager.html", base).toString());
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "source-manager.html"));
  }

  win.on("closed", () => {
    if (sourceManagerWindowRef === win) sourceManagerWindowRef = null;
  });

  return win;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  win.on("minimize", () => {
    analysis?.logDiagnostic("WINDOW_STATE", {
      state: "minimized",
      backgroundThrottling: false
    });
  });

  win.on("restore", () => {
    analysis?.logDiagnostic("WINDOW_STATE", {
      state: "restored",
      backgroundThrottling: false
    });
  });

  win.on("close", (event) => {
    if (allowQuit) return;

    event.preventDefault();
    void beginGracefulShutdown();
  });

  win.on("closed", () => {
    if (windowRef === win) windowRef = null;
  });

  return win;
}

async function enterQwenBenchmarkMode(): Promise<void> {
  if (qwenBenchmarkPreparing) {
    await qwenBenchmarkPreparing;
    return;
  }
  if (qwenBenchmarkMode) return;

  qwenBenchmarkMode = true;
  qwenBenchmarkPreparing = (async () => {
    if (analysisCoordinator) {
      await analysisCoordinator.pauseForBenchmark();
    } else {
      analysis?.stopForBenchmark();
    }
  })();

  try {
    await qwenBenchmarkPreparing;
  } catch (error) {
    qwenBenchmarkMode = false;
    throw error;
  } finally {
    qwenBenchmarkPreparing = null;
  }
}

async function leaveQwenBenchmarkMode(): Promise<void> {
  if (qwenBenchmarkPreparing) {
    await qwenBenchmarkPreparing;
  }
  if (!qwenBenchmarkMode) return;

  qwenBenchmarkMode = false;
  analysisCoordinator?.endBenchmarkPause();

  // Auch das Testmodell selbst wieder entladen, bevor die normale Queue
  // fortgesetzt wird. So beginnt der Standardlauf aus einem sauberen Zustand.
  analysis?.stopForBenchmark();

  if (isQuitting || !analysis) return;

  await analysis.start();
  if (analysis.getStatus().state === "READY") {
    await analysisCoordinator?.start();
  }
}

async function setBackgroundPaused(paused: boolean): Promise<BackgroundPauseState> {
  if (backgroundPauseChanging || backgroundPaused === paused) {
    return backgroundPauseState();
  }

  backgroundPauseChanging = true;

  // Den Zielzustand sofort publizieren, damit der große Button während des
  // Übergangs nicht mehrfach geklickt werden kann.
  if (paused) backgroundPaused = true;
  publishBackgroundPauseState();

  try {
    if (paused) {
      if (personRefreshTimer) {
        clearTimeout(personRefreshTimer);
        personRefreshTimer = null;
      }
      if (lifeAreaRuleRefreshTimer) {
        clearTimeout(lifeAreaRuleRefreshTimer);
        lifeAreaRuleRefreshTimer = null;
      }

      // Die globale Pause hat Vorrang vor einem laufenden Einzelbildtest.
      qwenBenchmarkMode = false;
      analysisCoordinator?.endBenchmarkPause();

      await Promise.all([
        catalogWatchService?.pauseForUser() ?? Promise.resolve(),
        analysisCoordinator?.pauseForUser() ?? Promise.resolve(),
        thumbnailCoordinator?.pauseForUser() ?? Promise.resolve()
      ]);
    } else {
      await catalogWatchService?.resumeFromUserPause();
      thumbnailCoordinator?.resumeFromUserPause();
      await analysisCoordinator?.resumeFromUserPause();

      backgroundPaused = false;
      schedulePersonRefresh();
      scheduleLifeAreaRuleRefresh();
    }
  } catch (error) {
    // Bei fehlgeschlagener Pause nicht fälschlich "pausiert" anzeigen.
    if (paused) backgroundPaused = false;
    throw error;
  } finally {
    backgroundPauseChanging = false;
    publishBackgroundPauseState();
  }

  return backgroundPauseState();
}

function registerIpc(): void {
  ipcMain.handle("app:getBackgroundPauseState", () => backgroundPauseState());
  ipcMain.handle("app:setBackgroundPaused", async (_event, paused: boolean) =>
    setBackgroundPaused(paused === true)
  );

  ipcMain.handle("dialog:pickSource", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? windowRef ?? undefined;
    const options: OpenDialogOptions = {
      title: "Festplatte oder Medienordner auswählen",
      properties: ["openDirectory"]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("window:openSourceManager", () => {
    createSourceManagerWindow();
    return { opened: true as const };
  });

  ipcMain.handle("catalog:listSources", () =>
    catalog!.request<SourceRecord[]>("listSources")
  );

  ipcMain.handle("catalog:addSource", async (_event, sourcePath: string) => {
    const source = await catalog!.request<SourceRecord>("addSource", {
      path: sourcePath
    });
    await catalogWatchService?.sourceAdded(source.id);
    return source;
  });

  ipcMain.handle("catalog:disableSource", async (_event, sourceId: number) => {
    const source = await catalog!.request<SourceRecord>("disableSource", { sourceId });
    await catalogWatchService?.syncSources();
    return source;
  });

  ipcMain.handle("catalog:getFolderTree", async (_event, rootPath: string) => {
    if (typeof rootPath !== "string" || rootPath.trim() === "") {
      throw new Error("Ordnerpfad fehlt.");
    }
    return buildFolderTree(rootPath);
  });

  ipcMain.handle("catalog:listExplorerRoots", () => listExplorerRoots());

  ipcMain.handle("catalog:getExplorerChildren", async (_event, folderPath: string) => {
    if (typeof folderPath !== "string" || folderPath.trim() === "") {
      throw new Error("Ordnerpfad fehlt.");
    }
    return getExplorerChildren(folderPath);
  });

  ipcMain.handle("catalog:getStats", (_event, sourceId: number) =>
    catalog!.request<CatalogStats>("getStats", { sourceId })
  );

  ipcMain.handle("catalog:getWatchSnapshot", (): CatalogWatchSnapshot =>
    catalogWatchService?.getSnapshot() ?? { sources: [], history: [] }
  );

  ipcMain.handle(
    "catalog:listMedia",
    async (
      _event,
      sourceId: number,
      limit: number,
      mediaKind: "all" | "image" | "video" = "all"
    ) => {
      const rows = await catalog!.request<MediaRecord[]>("listMedia", {
        sourceId,
        limit,
        mediaKind
      });

      for (const row of rows) {
        if (!row.sourcePath) continue;
        mediaStreamPathCache.set(
          row.id,
          path.resolve(row.sourcePath, row.relativePath)
        );
      }

      return rows;
    }
  );

  ipcMain.handle("catalog:listGeoMedia", (_event, sourceId?: number) =>
    catalog!.request<GeoMediaPoint[]>(
      "listGeoMedia",
      sourceId === undefined ? {} : { sourceId }
    )
  );

  ipcMain.handle("catalog:listLifeAreas", () =>
    catalog!.request<LifeAreaRecord[]>("listLifeAreas")
  );

  ipcMain.handle("catalog:createLifeArea", (_event, name: string) =>
    catalog!.request<{ id: number; name: string }>("createLifeArea", { name })
  );

  ipcMain.handle(
    "catalog:renameLifeArea",
    (_event, lifeAreaId: number, name: string): Promise<LifeAreaMutationResult> =>
      catalog!.request<LifeAreaMutationResult>("renameLifeArea", { lifeAreaId, name })
  );

  ipcMain.handle(
    "catalog:deleteLifeArea",
    (_event, lifeAreaId: number): Promise<LifeAreaMutationResult> =>
      catalog!.request<LifeAreaMutationResult>("deleteLifeArea", { lifeAreaId })
  );

  ipcMain.handle(
    "catalog:addLifeAreaRule",
    (
      _event,
      lifeAreaId: number,
      conditionType: string,
      conditionValue: string | null,
      dateFrom: string | null,
      dateTo: string | null,
      groupId?: number | null
    ) =>
      catalog!.request<{ id: number; groupId: number }>("addLifeAreaRule", {
        lifeAreaId,
        conditionType,
        conditionValue,
        dateFrom,
        dateTo,
        groupId
      })
  );

  ipcMain.handle(
    "catalog:deleteLifeAreaRule",
    (_event, ruleId: number): Promise<LifeAreaMutationResult> =>
      catalog!.request<LifeAreaMutationResult>("deleteLifeAreaRule", { ruleId })
  );

  ipcMain.handle(
    "catalog:setLifeAreaRuleEnabled",
    (_event, ruleId: number, enabled: boolean): Promise<LifeAreaMutationResult> =>
      catalog!.request<LifeAreaMutationResult>(
        "setLifeAreaRuleEnabled",
        { ruleId, enabled }
      )
  );

  ipcMain.handle(
    "catalog:applyLifeAreaRules",
    (_event, lifeAreaId?: number): Promise<ApplyLifeAreaRulesResult> =>
      catalog!.request<ApplyLifeAreaRulesResult>(
        "applyLifeAreaRules",
        lifeAreaId === undefined ? {} : { lifeAreaId }
      )
  );

  ipcMain.handle(
    "catalog:listLifeAreaMedia",
    (_event, lifeAreaId: number): Promise<LifeAreaMediaItem[]> =>
      catalog!.request<LifeAreaMediaItem[]>("listLifeAreaMedia", { lifeAreaId })
  );

  ipcMain.handle(
    "catalog:setMediaLifeArea",
    (
      _event,
      mediaId: number,
      lifeAreaId: number,
      assigned: boolean
    ): Promise<LifeAreaMutationResult> =>
      catalog!.request<LifeAreaMutationResult>(
        "setMediaLifeArea",
        { mediaId, lifeAreaId, assigned }
      )
  );

  ipcMain.handle("catalog:getSearchFacets", (_event, sourceId?: number) =>
    catalog!.request<SearchFacets>(
      "getSearchFacets",
      sourceId === undefined ? {} : { sourceId }
    )
  );

  ipcMain.handle(
    "catalog:searchMedia",
    async (_event, sourceId: number | undefined, filter: SearchFilter, limit: number) => {
      const query =
        typeof filter?.semanticQuery === "string"
          ? filter.semanticQuery.trim()
          : "";

      let semantic: SemanticTextEmbedding | null = null;

      if (query) {
        const cacheKey = query.toLocaleLowerCase("de-DE");
        semantic = semanticTextCache.get(cacheKey) ?? null;

        if (!semantic && analysis) {
          const status = analysis.getStatus();

          // Eine laufende Kataloganalyse darf durch eine Suche nicht
          // unterbrochen werden. In diesem Fall sucht der Katalog sofort nur
          // in den bereits gespeicherten Qwen-4B-Feldern. Ist der Worker frei,
          // kommt zusätzlich SigLIP2 für das hybride Ranking dazu.
          if (
            status.state === "READY" &&
            status.activeJobs === 0 &&
            pipelineStatus.objectVerification.pending === 0 &&
            pipelineStatus.objectVerification.running === 0 &&
            !qwenBenchmarkMode &&
            !qwenBenchmarkPreparing
          ) {
            try {
              semantic = await analysis.request<SemanticTextEmbedding>(
                "extract_semantic_text_embedding",
                { text: query },
                1800000
              );
              semanticTextCache.set(cacheKey, semantic);
            } catch {
              // Qwen-Textindex bleibt als sofortiger Fallback nutzbar.
              semantic = null;
            }
          }
        }
      }

      return catalog!.request<MediaRecord[]>("searchMedia", {
        ...(sourceId === undefined ? {} : { sourceId }),
        filter,
        semantic,
        limit
      });
    }
  );

  ipcMain.handle("catalog:listDuplicateGroups", (_event, sourceId: number, limit: number) =>
    catalog!.request<DuplicateGroup[]>("listDuplicateGroups", { sourceId, limit })
  );

  ipcMain.handle("catalog:listRecycleMedia", (_event, sourceId: number, limit: number) =>
    catalog!.request<MediaRecord[]>("listRecycleMedia", { sourceId, limit })
  );

  ipcMain.handle("catalog:getMediaDetails", (_event, mediaId: number) =>
    catalog!.request<MediaDetails | null>("getMediaDetails", { mediaId })
  );

  ipcMain.handle(
    "catalog:assignVideoFrameIdentityName",
    (
      _event,
      mediaId: number,
      timestampMs: number,
      kind: "person" | "pet",
      detectionIndex: number,
      petClass: "dog" | "cat" | null,
      name: string
    ) =>
      catalog!.request("assignVideoFrameIdentityName", {
        mediaId,
        timestampMs,
        kind,
        detectionIndex,
        petClass,
        name
      })
  );

  ipcMain.handle(
    "catalog:assignVideoFrameIdentityNames",
    (
      _event,
      mediaId: number,
      assignments: Array<{
        timestampMs: number;
        kind: "person" | "pet";
        detectionIndex: number;
        petClass: "dog" | "cat" | null;
        name: string;
      }>
    ) =>
      catalog!.request("assignVideoFrameIdentityNames", {
        mediaId,
        assignments
      })
  );

  ipcMain.handle(
    "catalog:reanalyzeMedia",
    async (_event, mediaId: number): Promise<ReanalyzeMediaResult> => {
      const requeueStartedAt = Date.now();
      analysis?.logDiagnostic("REANALYZE_REQUEST_BEGIN", { mediaId });
      // For video, rebuilding tracks does not touch image identity groups.
      // Avoid waiting for a potentially lengthy global clustering refresh.
      const info = await catalog!.request<MediaPreviewInfo | null>(
        "getMediaPreviewInfo", { mediaId }
      );
      if (!info) throw new Error("Medium wurde nicht gefunden.");
      const isVideo = VIDEO_EXTENSIONS.has(path.extname(info.absolutePath).toLowerCase());

      // Old in-flight jobs keep their own IDs and are rejected if their result
      // arrives after requeue. Only outstanding job claims must settle first.
      await analysisCoordinator?.pauseForMaintenance(mediaId, false);
      thumbnailCoordinator?.stop();

      if (!isVideo && personRefreshTimer) {
        clearTimeout(personRefreshTimer);
        personRefreshTimer = null;
      }

      try {
        // A single-media reset no longer waits for global identity clustering.
        // The clustering snapshot is independent of this maintenance action;
        // after requeue the source counters are invalidated and a fresh pass is
        // guaranteed via personRefreshRescheduleRequested.
        if (!isVideo && personRefreshRunning) {
          personRefreshRescheduleRequested = true;
          analysis?.logDiagnostic("REANALYZE_IDENTITY_REFRESH_DEFERRED", {
            mediaId
          });
        }

        await (
          thumbnailCoordinator?.waitUntilClaimsSettled() ?? Promise.resolve()
        );
        const result = await catalog!.request<ReanalyzeMediaResult>(
          "reanalyzeMedia", { mediaId }
        );

        if (!isVideo) {
          groupedFaceEmbeddingCounts.delete(result.sourceId);
          groupedPetEmbeddingCounts.delete(result.sourceId);
          schedulePersonRefresh();
        }
        scheduleLifeAreaRuleRefresh();
        analysis?.logDiagnostic("REANALYZE_QUEUED", {
          mediaId,
          isVideo,
          stages: result.requeued,
          elapsedMs: Date.now() - requeueStartedAt
        });

        return result;
      } finally {
        analysisCoordinator?.resumeAfterMaintenance();
        // Thumbnail restart can enqueue catalog backfill work; do not make the
        // user's requeue response wait for these unrelated UI updates.
        void thumbnailCoordinator?.start().catch((error) => {
          analysis?.logDiagnostic("THUMBNAIL_RESTART_ERROR", {
            mediaId, error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  );

  ipcMain.handle("catalog:scanSource", async (_event, sourceId: number) => {
    if (catalogWatchService) {
      return catalogWatchService.requestManualScan(sourceId);
    }

    return catalog!.request<ScanResult>("scanSource", { sourceId });
  });

  ipcMain.handle("catalog:restoreMedia", (_event, mediaId: number) =>
    catalog!.request<RestoreResult>("restoreMedia", { mediaId })
  );

  ipcMain.handle("catalog:resetCatalog", async () => {
    semanticTextCache.clear();
    mediaStreamPathCache.clear();
    analysis?.logDiagnostic("CATALOG_RESET_BEGIN");
    catalogWatchService?.stop();

    let resetSucceeded = false;

    // Falls gerade der Einzelbild-Benchmark vorbereitet wird, zuerst dessen
    // Zustandswechsel abschließen. Anschließend Benchmarkmodus und Pauseflag
    // explizit auf Normalbetrieb zurücksetzen.
    if (qwenBenchmarkPreparing) {
      try {
        await qwenBenchmarkPreparing;
      } catch {
        // Der Reset übernimmt ab hier ohnehin den vollständigen Worker-Neustart.
      }
    }

    // Laufende Analyse-/Thumbnail-/Gruppierungsjobs zuerst wirklich zum
    // Stillstand bringen. Ein fester Sleep ist dafür nicht ausreichend:
    // sonst könnte ein alter Job nach dem DELETE wieder Ergebnisse eintragen.
    analysisCoordinator?.stop();
    analysisCoordinator?.endBenchmarkPause();
    qwenBenchmarkMode = false;
    qwenBenchmarkPreparing = null;
    thumbnailCoordinator?.stop();

    if (personRefreshTimer) {
      clearTimeout(personRefreshTimer);
      personRefreshTimer = null;
    }
    personRefreshRescheduleRequested = false;

    // Harter Stopp beendet auch einen eventuell laufenden Qwen/llama.cpp-
    // Prozessbaum und verwirft alle offenen Python-Requests sofort.
    analysis?.stopImmediately();
    thumbnailService?.stop();

    try {
      await Promise.all([
        analysisCoordinator?.waitUntilIdle() ?? Promise.resolve(),
        thumbnailCoordinator?.waitUntilIdle() ?? Promise.resolve(),
        waitForIdentityRefreshIdle(),
        catalogWatchService?.waitUntilIdle() ?? Promise.resolve()
      ]);

      const result = await catalog!.request<ResetCatalogResult>("resetCatalog");
      resetSucceeded = true;

      catalogWatchService?.clearHistory();
      groupedFaceEmbeddingCounts.clear();
      groupedPetEmbeddingCounts.clear();

      // Auch abgeleitete Vorschaudateien/Crops entfernen. Ein Cache-Fehler
      // macht einen bereits verifizierten Datenbank-Reset nicht rückgängig.
      if (thumbnailCacheRoot) {
        try {
          await rm(thumbnailCacheRoot, { recursive: true, force: true });
        } catch (error) {
          analysis?.logDiagnostic("CATALOG_RESET_CACHE_WARNING", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      pipelineStatus = {
        technical: { ...EMPTY_QUEUE },
        thumbnails: { ...EMPTY_QUEUE },
        imageMetadata: { ...EMPTY_QUEUE },
        faces: { ...EMPTY_QUEUE },
        faceEmbeddings: { ...EMPTY_QUEUE },
        petDetection: { ...EMPTY_QUEUE },
        petFusion: { ...EMPTY_QUEUE },
        petEmbeddings: { ...EMPTY_QUEUE },
        objectVerification: { ...EMPTY_QUEUE },
        semanticEmbeddings: { ...EMPTY_QUEUE },
        videoAnalysis: { ...EMPTY_QUEUE }
      };
      sendToRenderer("analysis:pipelineStatus", pipelineStatus);

      analysis?.logDiagnostic("CATALOG_RESET_COMPLETED", {
        verifiedEmpty: true,
        sources: 0
      });

      return result;
    } catch (error) {
      analysis?.logDiagnostic("CATALOG_RESET_ERROR", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      // Auch bei einem abgebrochenen Reset darf die Anwendung nicht in einem
      // halb gestoppten Zustand verbleiben.
      if (!isQuitting) {
        thumbnailService?.start();
        if (thumbnailCoordinator) {
          await thumbnailCoordinator.start();
        }

        if (analysis) {
          await analysis.start();
          if (analysis.getStatus().state === "READY" && analysisCoordinator) {
            await analysisCoordinator.start();
          }
        }

        // Nach erfolgreichem Reset gibt es keine Quellen mehr. Bei einem
        // fehlgeschlagenen Reset wird dagegen ein Sicherheitsabgleich der
        // weiterhin vorhandenen Quellen durchgeführt.
        await catalogWatchService?.start(!resetSucceeded);
      }
    }
  });

  ipcMain.handle("analysis:getStatus", (): Promise<AnalysisWorkerStatus> =>
    analysis!.refreshStatus()
  );

  ipcMain.handle("analysis:setMaxConcurrentJobs", async (_event, value: number) => {
    const requested = Math.max(1, Math.min(8, Math.trunc(Number(value) || 1)));
    analysisCoordinator?.setConcurrency(requested);
    const maxConcurrentJobs = await analysis!.setMaxConcurrentJobs(requested);
    return { maxConcurrentJobs };
  });

  ipcMain.handle("analysis:setBoostEnabled", async (_event, enabled: boolean) =>
    analysis!.setBoostEnabled(enabled === true)
  );

  ipcMain.handle("analysis:openDevLog", async () => {
    const logPath = analysis!.getDevLogPath();
    const result = await shell.openPath(logPath);
    if (result) {
      throw new Error("Dev-Protokoll konnte nicht geöffnet werden: " + result);
    }
    return { opened: true, path: logPath };
  });

  ipcMain.handle("analysis:copyDevLog", async () => {
    const logPath = analysis!.getDevLogPath();
    const text = await readFile(logPath, "utf8");
    clipboard.writeText(text);
    return {
      copied: true,
      path: logPath,
      characters: text.length
    };
  });

  ipcMain.handle("analysis:clearDevLog", () =>
    analysis!.clearDevLog()
  );

  ipcMain.handle("analysis:getAutomaticQwenState", () => ({
    enabled:
      (analysisCoordinator?.isAutomaticQwenEnabled() ?? false) &&
      (analysis?.isQwen3vl4bAvailable() ?? false)
  }));

  ipcMain.handle("analysis:startAutomaticQwen", async () => {
    if (qwenBenchmarkMode || qwenBenchmarkPreparing) {
      throw new Error(
        "Qwen-Serienanalyse kann nicht gestartet werden, solange der Einzelbildtest aktiv ist."
      );
    }

    if (!analysis || !analysisCoordinator) {
      throw new Error("Analyse-Worker ist noch nicht initialisiert.");
    }

    if (analysis.getStatus().state !== "READY") {
      await analysis.start();
    }

    if (!analysis.isQwen3vl4bAvailable()) {
      throw new Error(
        analysis.getQwen3vl4bIssue() ??
        "Qwen3-VL 4B ist derzeit nicht verfügbar."
      );
    }

    analysisCoordinator.enableAutomaticQwen();

    if (analysis.getStatus().state === "READY") {
      await analysisCoordinator.start();
    }

    return { enabled: true };
  });

  ipcMain.handle("analysis:prepareQwenBenchmark", async () => {
    await enterQwenBenchmarkMode();
    return { paused: true };
  });

  ipcMain.handle("analysis:finishQwenBenchmark", async () => {
    await leaveQwenBenchmarkMode();
    return { resumed: true };
  });

  ipcMain.handle("analysis:pickQwenBenchmarkImage", async () => {
    // Sicherheitsnetz: selbst bei direktem IPC-Aufruf ist der normale Qwen-
    // Lauf beendet und llama.cpp entladen, bevor Windows den Dateidialog zeigt.
    await enterQwenBenchmarkMode();

    const options: OpenDialogOptions = {
      title: "Bild für Vision-Einzeltest auswählen",
      properties: ["openFile"],
      filters: [
        {
          name: "Bilder",
          extensions: ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"]
        }
      ]
    };

    const result = windowRef
      ? await dialog.showOpenDialog(windowRef, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "analysis:runQwenBenchmark",
    async (
      _event,
      filePath: string,
      model: QwenBenchmarkModel,
      profiles: QwenBenchmarkProfile[]
    ): Promise<QwenBenchmarkRunResult> => {
      const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
      if (!normalizedPath) {
        throw new Error("Bitte zuerst ein Bild für den Vision-Test auswählen.");
      }

      const allowedModels: QwenBenchmarkModel[] = [
        "minicpm",
        "qwen3vl2b",
        "qwen3vl4b"
      ];
      const selectedModel = allowedModels.includes(model) ? model : "minicpm";

      const allowed: QwenBenchmarkProfile[] = [
        "whole",
        "tiles4",
        "tiles9",
        "tiles16"
      ];
      const selected = [...new Set(profiles)].filter(
        (profile): profile is QwenBenchmarkProfile =>
          allowed.includes(profile as QwenBenchmarkProfile)
      );

      if (selected.length === 0) {
        throw new Error("Bitte mindestens eine Teststufe auswählen.");
      }

      await enterQwenBenchmarkMode();

      if (!analysis) throw new Error("Analyse-Worker ist nicht initialisiert.");
      if (analysis.getStatus().state !== "READY") {
        await analysis.start();
      }
      if (analysis.getStatus().state !== "READY") {
        throw new Error("Analyse-Worker ist für den Vision-Test nicht bereit.");
      }

      const workerMethod =
        selectedModel === "qwen3vl4b"
          ? "benchmark_qwen3vl4b"
          : selectedModel === "qwen3vl2b"
            ? "benchmark_qwen3vl2b"
            : "benchmark_minicpm";
      const results: QwenBenchmarkStageResult[] = [];

      for (const profile of selected) {
        const stage = await analysis.request<QwenBenchmarkStageResult>(
          workerMethod,
          {
            path: normalizedPath,
            profile
          },
          600000
        );

        results.push(stage);
        sendToRenderer("analysis:qwenBenchmarkStage", stage);
      }

      return {
        path: normalizedPath,
        model: selectedModel,
        results
      };
    }
  );

  ipcMain.handle(
    "analysis:listErrors",
    (_event, sourceId?: number, limit = 200): Promise<AnalysisErrorRecord[]> =>
      catalog!.request<AnalysisErrorRecord[]>("listAnalysisErrors", {
        sourceId,
        limit
      })
  );

  ipcMain.handle(
    "analysis:countErrors",
    (_event, sourceId?: number): Promise<number> =>
      catalog!.request<number>("countAnalysisErrors", { sourceId })
  );

  ipcMain.handle(
    "analysis:retryJob",
    (_event, jobId: number): Promise<RetryAnalysisResult> =>
      catalog!.request<RetryAnalysisResult>("retryAnalysisJob", { jobId })
  );

  ipcMain.handle(
    "analysis:retryAll",
    (_event, sourceId?: number): Promise<RetryAnalysisResult> =>
      catalog!.request<RetryAnalysisResult>("retryFailedAnalysisJobs", {
        sourceId
      })
  );

  ipcMain.handle("analysis:openFile", async (_event, mediaId: number) => {
    const info = await catalog!.request<{
      absolutePath: string;
      relativePath: string;
      availability: string;
    } | null>("getMediaPath", { mediaId });

    if (!info) throw new Error("Datei wurde im Katalog nicht gefunden.");

    const result = await shell.openPath(info.absolutePath);
    if (result) {
      throw new Error(
        "Datei konnte nicht geöffnet werden: " + result
      );
    }

    return { opened: true };
  });

  ipcMain.handle("analysis:openFolder", async (_event, mediaId: number) => {
    const info = await catalog!.request<{
      absolutePath: string;
      relativePath: string;
      availability: string;
    } | null>("getMediaPath", { mediaId });

    if (!info) throw new Error("Datei wurde im Katalog nicht gefunden.");

    const folder = path.dirname(info.absolutePath);
    const result = await shell.openPath(folder);
    if (result) {
      throw new Error(
        "Ordner konnte nicht geöffnet werden: " + result
      );
    }

    return { opened: true };
  });

  ipcMain.handle(
    "analysis:getPipelineStatus",
    async (_event, sourceId?: number): Promise<PipelineStatus> => {
      const queue = (module: string) =>
        catalog!.request<AnalysisQueueStats>("getAnalysisQueueStats", {
          ...(sourceId === undefined ? {} : { sourceId }),
          module
        });

      const [
        technical,
        thumbnails,
        imageMetadata,
        faces,
        faceEmbeddings,
        petDetection,
        petFusion,
        petEmbeddings,
        semanticEmbeddings,
        objectVerification,
        videoAnalysis
      ] = await Promise.all([
        queue("file-probe-v1"),
        queue("thumbnail-v1"),
        queue("image-metadata-v1"),
        queue("face-detect-yunet-v1"),
        queue("face-embed-sface-v1"),
        catalog!.request<AnalysisQueueStats>(
          "getPetDetectionQueueStats",
          sourceId === undefined ? {} : { sourceId }
        ),
        queue("pet-fuse-ensemble-v1"),
        queue("pet-embed-dogreid-v1"),
        queue("semantic-embed-siglip2-v1"),
        queue("catalog-semantic-qwen3vl4b-v3"),
        queue("video-analyze-v1")
      ]);

      return {
        technical,
        thumbnails,
        imageMetadata,
        faces,
        faceEmbeddings,
        petDetection,
        petFusion,
        petEmbeddings,
        objectVerification,
        semanticEmbeddings,
        videoAnalysis
      };
    }
  );

  ipcMain.handle(
    "people:getOverview",
    (_event, _sourceId: number, forceRefresh = false): Promise<PersonOverview> =>
      personService!.getCombinedOverview(Boolean(forceRefresh))
  );

  ipcMain.handle(
    "people:confirmCandidate",
    (
      _event,
      candidateId: number,
      name: string,
      fallbackFaceDetectionId?: number,
      expectedFaceCount?: number,
      expectedMemberSignature?: string
    ): Promise<ConfirmPersonResult> =>
      personService!.confirmCandidate(
        candidateId,
        name,
        fallbackFaceDetectionId,
        expectedFaceCount,
        expectedMemberSignature
      )
  );

  ipcMain.handle(
    "people:assignCandidateSelection",
    (
      _event,
      candidateId: number,
      faceDetectionIds: number[],
      name: string
    ): Promise<AssignPersonSelectionResult> =>
      personService!.assignCandidateSelection(candidateId, faceDetectionIds, name)
  );

  ipcMain.handle(
    "people:ignoreCandidate",
    (
      _event,
      candidateId: number,
      fallbackFaceDetectionId?: number,
      expectedFaceCount?: number,
      expectedMemberSignature?: string,
      ignoredIdentityId?: number
    ): Promise<IgnorePersonResult> =>
      personService!.ignoreCandidate(
        candidateId,
        fallbackFaceDetectionId,
        expectedFaceCount,
        expectedMemberSignature,
        ignoredIdentityId
      )
  );

  ipcMain.handle(
    "people:rejectDetectionSuggestion",
    (
      _event,
      faceDetectionId: number,
      personId: number
    ): Promise<PersonCorrectionResult> =>
      personService!.rejectDetectionSuggestion(faceDetectionId, personId)
  );

  ipcMain.handle(
    "people:removeCandidateFace",
    (
      _event,
      candidateId: number,
      faceDetectionId: number
    ): Promise<PersonCorrectionResult> =>
      personService!.removeCandidateFace(candidateId, faceDetectionId)
  );

  ipcMain.handle(
    "people:removePersonFace",
    (
      _event,
      personId: number,
      faceDetectionId: number
    ): Promise<PersonCorrectionResult> =>
      personService!.removePersonFace(personId, faceDetectionId)
  );

  ipcMain.handle(
    "people:mergePersons",
    (
      _event,
      targetPersonId: number,
      sourcePersonId: number
    ): Promise<MergePersonsResult> =>
      personService!.mergePersons(targetPersonId, sourcePersonId)
  );

  ipcMain.handle(
    "people:assignDetectionName",
    (
      _event,
      faceDetectionId: number,
      name: string
    ): Promise<DirectIdentityAssignmentResult> =>
      personService!.assignDetectionName(faceDetectionId, name)
  );

  ipcMain.handle(
    "people:renamePerson",
    (
      _event,
      personId: number,
      name: string
    ): Promise<PersonCorrectionResult> =>
      personService!.renamePerson(personId, name)
  );

  ipcMain.handle(
    "pets:getOverview",
    (_event, _sourceId: number, forceRefresh = false): Promise<PetOverview> =>
      petService!.getCombinedOverview(Boolean(forceRefresh))
  );

  ipcMain.handle(
    "pets:confirmCandidate",
    (
      _event,
      candidateId: number,
      name: string,
      rejectedPetId?: number,
      fallbackPetDetectionId?: number,
      expectedDetectionCount?: number,
      expectedMemberSignature?: string
    ): Promise<ConfirmPetResult> =>
      petService!.confirmCandidate(
        candidateId,
        name,
        rejectedPetId,
        fallbackPetDetectionId,
        expectedDetectionCount,
        expectedMemberSignature
      )
  );

  ipcMain.handle(
    "pets:ignoreCandidate",
    (
      _event,
      candidateId: number,
      fallbackPetDetectionId?: number,
      expectedDetectionCount?: number,
      expectedMemberSignature?: string,
      ignoredIdentityId?: number
    ): Promise<IgnorePetResult> =>
      petService!.ignoreCandidate(
        candidateId,
        fallbackPetDetectionId,
        expectedDetectionCount,
        expectedMemberSignature,
        ignoredIdentityId
      )
  );

  ipcMain.handle(
    "pets:rejectDetectionSuggestion",
    (
      _event,
      petDetectionId: number,
      petId: number
    ): Promise<PetCorrectionResult> =>
      petService!.rejectDetectionSuggestion(petDetectionId, petId)
  );

  ipcMain.handle(
    "pets:removeCandidatePet",
    (
      _event,
      candidateId: number,
      petDetectionId: number
    ): Promise<PetCorrectionResult> =>
      petService!.removeCandidatePet(candidateId, petDetectionId)
  );

  ipcMain.handle(
    "pets:splitCandidate",
    (
      _event,
      candidateId: number,
      petDetectionIds: number[]
    ): Promise<SplitPetCandidateResult> =>
      petService!.splitCandidate(candidateId, petDetectionIds)
  );

  ipcMain.handle(
    "pets:assignCandidateSelection",
    (
      _event,
      candidateId: number,
      petDetectionIds: number[],
      name: string
    ): Promise<AssignPetSelectionResult> =>
      petService!.assignCandidateSelection(candidateId, petDetectionIds, name)
  );

  ipcMain.handle(
    "pets:removePetDetection",
    (
      _event,
      petId: number,
      petDetectionId: number
    ): Promise<PetCorrectionResult> =>
      petService!.removePetDetection(petId, petDetectionId)
  );

  ipcMain.handle(
    "pets:confirmPetDetection",
    (
      _event,
      petId: number,
      petDetectionId: number
    ): Promise<PetCorrectionResult> =>
      petService!.confirmPetDetection(petId, petDetectionId)
  );

  ipcMain.handle(
    "pets:mergePets",
    (
      _event,
      targetPetId: number,
      sourcePetId: number
    ): Promise<MergePetsResult> =>
      petService!.mergePets(targetPetId, sourcePetId)
  );

  ipcMain.handle(
    "pets:assignDetectionName",
    (
      _event,
      petDetectionId: number,
      name: string
    ): Promise<DirectIdentityAssignmentResult> =>
      petService!.assignDetectionName(petDetectionId, name)
  );

  ipcMain.handle(
    "pets:renamePet",
    (
      _event,
      petId: number,
      name: string
    ): Promise<PetCorrectionResult> =>
      petService!.renamePet(petId, name)
  );
}

app.whenReady().then(() => {
  const workerPath = path.join(__dirname, "..", "workers", "catalog", "catalog-worker.js");
  const dbPath = path.join(app.getPath("userData"), "catalog.sqlite3");
  const analysisWorkerPath = path.join(
    app.getAppPath(),
    "workers",
    "python-ai",
    "worker.py"
  );
  const thumbnailWorkerPath = path.join(
    __dirname,
    "..",
    "workers",
    "thumbnail",
    "thumbnail-worker.js"
  );
  thumbnailCacheRoot = path.join(app.getPath("userData"), "thumbnails");
  // Clean older, previously unlimited scene JPEGs as well as new on-demand
  // entries. This runs independently of the normal image thumbnail cache.
  void pruneVideoFrameCache(thumbnailCacheRoot).catch(() => {});

  catalog = new CatalogService(workerPath, dbPath, (progress) => {
    sendToRenderer("catalog:progress", progress);
  });

  const analysisDevLogPath = path.join(
    app.getPath("userData"),
    "analysis-dev.log"
  );

  analysis = new AnalysisService(
    analysisWorkerPath,
    (status) => {
      sendToRenderer("analysis:status", status);
    },
    analysisDevLogPath
  );

  thumbnailService = new ThumbnailService(
    thumbnailWorkerPath,
    thumbnailCacheRoot,
    (event, fields = {}) => analysis?.logDiagnostic(event, fields)
  );

  analysisCoordinator = new AnalysisCoordinator(
    catalog,
    analysis,
    (stage, stats) => updatePipelineStage(stage, stats)
  );

  thumbnailCoordinator = new ThumbnailCoordinator(
    catalog,
    thumbnailService,
    (stats) => updatePipelineStage("thumbnails", stats),
    (event, fields = {}) => analysis?.logDiagnostic(event, fields)
  );

  personService = new PersonService(catalog, analysis);
  petService = new PetService(catalog, analysis);
  catalogWatchService = new CatalogWatchService(
    catalog,
    (event) => {
      sendToRenderer("catalog:watchEvent", event);
    },
    (event, fields = {}) => analysis?.logDiagnostic(event, fields),
    () => {
      const status = analysis?.getStatus();
      return (
        personRefreshRunning ||
        Boolean(status && (status.queuedJobs > 0 || status.activeJobs > 0))
      );
    }
  );

  catalog.start();
  thumbnailService.start();
  registerIpc();

  void startRemoteWebServer().catch((error) => {
    analysis?.logDiagnostic("REMOTE_WEB_SERVER_START_ERROR", {
      host: REMOTE_WEB_HOST,
      port: REMOTE_WEB_PORT,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  protocol.handle("image-sorter-thumb", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "media") {
        return new Response("Ungültige Thumbnail-Adresse.", { status: 400 });
      }

      const mediaId = Number(url.pathname.replace(/^\//, ""));
      if (!Number.isFinite(mediaId)) {
        return new Response("Ungültige Medien-ID.", { status: 400 });
      }

      const info = await catalog!.request<ThumbnailInfo | null>(
        "getThumbnailInfo",
        { mediaId }
      );

      if (!info) return new Response("Thumbnail nicht gefunden.", { status: 404 });

      if (!isInsideDirectory(info.path, thumbnailCacheRoot)) {
        return new Response("Thumbnail-Pfad abgelehnt.", { status: 403 });
      }

      const bytes = await readFile(info.path);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable"
        }
      });
    } catch {
      return new Response("Thumbnail konnte nicht geladen werden.", { status: 404 });
    }
  });

  protocol.handle("image-sorter-face", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "face") {
        return new Response("Ungültige Gesichtsadresse.", { status: 400 });
      }

      const faceDetectionId = Number(url.pathname.replace(/^\//, ""));
      if (!Number.isFinite(faceDetectionId)) {
        return new Response("Ungültige Gesichts-ID.", { status: 400 });
      }

      const info = await catalog!.request<FaceCropInfo | null>(
        "getFaceCropInfo",
        { faceDetectionId }
      );

      if (!info) {
        analysis?.logDiagnostic("FACE_CROP_INFO_MISSING", {
          faceDetectionId
        });
        return new Response("Gesichtsausschnitt nicht gefunden.", { status: 404 });
      }

      const crop = await thumbnailService!.generateFaceCrop(
        info.absolutePath,
        info.inputSha256,
        info.faceDetectionId,
        {
          x: info.x,
          y: info.y,
          width: info.width,
          height: info.height
        }
      );

      if (!isInsideDirectory(crop.path, thumbnailCacheRoot)) {
        return new Response("Gesichtsausschnitt-Pfad abgelehnt.", { status: 403 });
      }

      const bytes = await readFile(crop.path);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      analysis?.logDiagnostic("FACE_CROP_GENERATION_ERROR", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Response("Gesichtsausschnitt konnte nicht geladen werden.", {
        status: 404
      });
    }
  });

  protocol.handle("image-sorter-pet", async (request) => {
    let petDetectionId: number | null = null;
    try {
      const url = new URL(request.url);
      if (url.hostname !== "pet") {
        return new Response("Ungültige Haustieradresse.", { status: 400 });
      }

      petDetectionId = Number(url.pathname.replace(/^\//, ""));
      if (!Number.isFinite(petDetectionId)) {
        return new Response("Ungültige Haustier-ID.", { status: 400 });
      }

      const info = await catalog!.request<PetCropInfo | null>(
        "getPetCropInfo",
        { petDetectionId }
      );

      if (!info) {
        analysis?.logDiagnostic("PET_CROP_INFO_MISSING", {
          petDetectionId
        });
        return new Response("Haustierausschnitt nicht gefunden.", { status: 404 });
      }

      const crop = await thumbnailService!.generatePetCrop(
        info.absolutePath,
        info.inputSha256,
        info.petDetectionId,
        {
          x: info.x,
          y: info.y,
          width: info.width,
          height: info.height
        }
      );

      if (!isInsideDirectory(crop.path, thumbnailCacheRoot)) {
        return new Response("Haustierausschnitt-Pfad abgelehnt.", { status: 403 });
      }

      const bytes = await readFile(crop.path);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      analysis?.logDiagnostic("PET_CROP_GENERATION_ERROR", {
        petDetectionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return new Response("Haustierausschnitt konnte nicht geladen werden.", {
        status: 404
      });
    }
  });

  protocol.handle("image-sorter-preview", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "media") {
        return new Response("Ungültige Vorschauadresse.", { status: 400 });
      }

      const mediaId = Number(url.pathname.replace(/^\//, ""));
      if (!Number.isFinite(mediaId)) {
        return new Response("Ungültige Medien-ID.", { status: 400 });
      }

      const info = await catalog!.request<MediaPreviewInfo | null>(
        "getMediaPreviewInfo",
        { mediaId }
      );

      if (!info) {
        analysis?.logDiagnostic("PREVIEW_INFO_MISSING", { mediaId });
        return new Response("Medium nicht gefunden.", { status: 404 });
      }

      const preview = await thumbnailService!.generatePreview(
        info.absolutePath,
        info.inputSha256
      );

      if (!isInsideDirectory(preview.path, thumbnailCacheRoot)) {
        return new Response("Vorschau-Pfad abgelehnt.", { status: 403 });
      }

      const bytes = await readFile(preview.path);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      analysis?.logDiagnostic("PREVIEW_GENERATION_ERROR", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Response("Große Vorschau konnte nicht geladen werden.", {
        status: 404
      });
    }
  });

  protocol.handle("image-sorter-frame", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "media") return new Response("Ungültige Szenenbild-Adresse", { status: 400 });
      const mediaId = Number(url.pathname.slice(1));
      const msParam = url.searchParams.get("ms");
      const timestampMs = msParam === null ? NaN : Number(msParam);
      const requestedWidth = Number(url.searchParams.get("width") || "320");
      const indexParam = url.searchParams.get("i");
      const frameIndex = indexParam === null ? null : Number(indexParam);
      const frameHash = url.searchParams.get("h");
      if (!Number.isSafeInteger(mediaId) || mediaId <= 0 ||
          !Number.isSafeInteger(timestampMs) || timestampMs < 0 ||
          !Number.isFinite(requestedWidth) || requestedWidth <= 0 ||
          (frameIndex !== null && (!Number.isSafeInteger(frameIndex) || frameIndex < 0)) ||
          (frameHash !== null && !/^[a-f0-9]{32}$/i.test(frameHash))) {
        return new Response("Ungültige Szenenbild-Parameter", { status: 400 });
      }
      const info = await catalog!.request<MediaPreviewInfo | null>("getMediaPreviewInfo", { mediaId });
      if (!info) return new Response("Video nicht gefunden", { status: 404 });
      const jpg = await getVideoFrameJpeg(
        info.absolutePath, info.inputSha256, timestampMs,
        frameIndex, frameHash, requestedWidth, thumbnailCacheRoot
      );
      return new Response(jpg, {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      analysis?.logDiagnostic("VIDEO_FRAME_GENERATION_ERROR", { error: message });
      return new Response(message, { status: 500 });
    }
  });

  protocol.handle("image-sorter-media", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "media") {
        return new Response("Ungültige Medienadresse.", { status: 400 });
      }

      const mediaId = Number(url.pathname.replace(/^\//, ""));
      if (!Number.isFinite(mediaId)) {
        return new Response("Ungültige Medien-ID.", { status: 400 });
      }

      let absolutePath = mediaStreamPathCache.get(mediaId) ?? null;
      if (!absolutePath) {
        const info = await catalog!.request<MediaPreviewInfo | null>(
          "getMediaPreviewInfo",
          { mediaId }
        );
        if (!info) return new Response("Medium nicht gefunden.", { status: 404 });
        absolutePath = info.absolutePath;
        mediaStreamPathCache.set(mediaId, absolutePath);
      }

      // Für Medien aus der sichtbaren Bibliothek ist kein zusätzlicher
      // Katalog-IPC nötig. Dadurch startet der Player auch dann sofort, wenn
      // gerade eine größere Listenabfrage läuft.
      const fileUrl = pathToFileURL(absolutePath).toString();
      const range = request.headers.get("range");
      const headers = range ? { Range: range } : undefined;
      return net.fetch(fileUrl, {
        method: request.method,
        headers
      });
    } catch (error) {
      analysis?.logDiagnostic("MEDIA_STREAM_ERROR", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Response("Medium konnte nicht gestreamt werden.", { status: 404 });
    }
  });


  windowRef = createWindow();

  void catalogWatchService.start(true);
  void thumbnailCoordinator.start();

  void analysis.start().then(() => {
    if (analysis?.getStatus().state === "READY") {
      void analysisCoordinator?.start();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) windowRef = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && allowQuit) app.quit();
});

async function prepareCatalogForShutdown(): Promise<boolean> {
  if (!catalog) return true;

  const deadline = Date.now() + 12000;

  while (Date.now() < deadline) {
    const resultPromise = catalog.request<{
      ready: boolean;
      requeued: number;
      reason: string | null;
    }>("prepareForShutdown");

    const settled = await Promise.race([
      resultPromise
        .then((result) => ({ settled: true as const, result }))
        .catch(() => ({ settled: false as const, result: null })),
      delay(1500).then(() => ({ settled: false as const, result: null }))
    ]);

    if (!settled.settled) {
      await delay(150);
      continue;
    }

    if (settled.result?.ready) {
      analysis?.logDiagnostic("APP_SHUTDOWN_CATALOG_READY", {
        requeued: settled.result.requeued
      });
      return true;
    }

    if (settled.result?.reason !== "SCAN_RUNNING") {
      return false;
    }

    publishShutdownStatus(
      "WAITING",
      "Ein laufender Dateiscan wird noch sauber abgeschlossen …"
    );
    await delay(250);
  }

  return false;
}

async function performGracefulShutdown(): Promise<void> {
  shutdownInProgress = true;
  await stopRemoteWebServer();
  publishShutdownStatus(
    "PREPARING",
    "App wird sicher beendet. Neue Analysejobs und Dateiscans werden angehalten …"
  );

  if (personRefreshTimer) {
    clearTimeout(personRefreshTimer);
    personRefreshTimer = null;
  }

  // Eine Benutzerpause kann einen laufenden Katalogscan kooperativ im
  // Wartestatus halten. Vor dem geordneten App-Shutdown muss dieser eine
  // aktuelle Datei noch fertigstellen dürfen, sonst würde prepareForShutdown()
  // dauerhaft SCAN_RUNNING melden.
  if (backgroundPaused && catalog) {
    try {
      await catalog.request("setProcessingPaused", { paused: false });
    } catch {
      // Der nachfolgende Shutdown-Fallback behandelt einen bereits beendeten Worker.
    }
  }

  catalogWatchService?.stop();
  analysisCoordinator?.prepareForShutdown();
  thumbnailCoordinator?.prepareForShutdown();
  analysisCoordinator?.endBenchmarkPause();
  qwenBenchmarkMode = false;

  publishShutdownStatus(
    "WAITING",
    "Laufende Ergebnisse und Datenbank-Schreibvorgänge werden abgeschlossen …"
  );

  const [analysisIdle, thumbnailsIdle, identitiesIdle, watchIdle] =
    await Promise.all([
      analysisCoordinator
        ? settlesWithin(analysisCoordinator.waitUntilIdle(5000), 5200)
        : Promise.resolve(true),
      thumbnailCoordinator
        ? settlesWithin(thumbnailCoordinator.waitUntilIdle(5000), 5200)
        : Promise.resolve(true),
      settlesWithin(waitForIdentityRefreshIdle(5000), 5200),
      catalogWatchService
        ? settlesWithin(catalogWatchService.waitUntilIdle(5000), 5200)
        : Promise.resolve(true)
    ]);

  if (!analysisIdle || !identitiesIdle) {
    publishShutdownStatus(
      "STOPPING_WORKERS",
      "Lange KI-Berechnung wird angehalten und für den nächsten Start vorgemerkt …"
    );
    analysis?.stopImmediately();

    if (analysisCoordinator) {
      await settlesWithin(analysisCoordinator.waitUntilIdle(5000), 5200);
    }
    await settlesWithin(waitForIdentityRefreshIdle(5000), 5200);
  }

  if (!thumbnailsIdle) {
    thumbnailService?.stop();
    if (thumbnailCoordinator) {
      await settlesWithin(thumbnailCoordinator.waitUntilIdle(3000), 3200);
    }
  }

  if (!watchIdle) {
    publishShutdownStatus(
      "WAITING",
      "Dateikatalog wird in einen wiederaufnehmbaren Zustand gebracht …"
    );
  }

  publishShutdownStatus(
    "SAVING",
    "Datenbank wird gesichert und laufende Jobs werden für den nächsten Start vorgemerkt …"
  );

  const catalogReady = await prepareCatalogForShutdown();
  if (!catalogReady) {
    publishShutdownStatus(
      "FALLBACK",
      "Ein Restvorgang konnte nicht rechtzeitig abgeschlossen werden. Er wird beim nächsten Start automatisch wieder aufgenommen."
    );
    analysis?.logDiagnostic("APP_SHUTDOWN_CATALOG_FALLBACK");
  }

  // Ab hier darf nichts mehr neue Arbeit erzeugen. Die Analyse wird auch dann
  // beendet, wenn sie während der Grace-Phase bereits natürlich fertig wurde.
  analysis?.stopImmediately();
  thumbnailService?.stop();

  publishShutdownStatus(
    "DONE",
    "Alle gespeicherten Daten sind gesichert. App wird geschlossen …"
  );

  // Ein kurzer Paint-Zyklus macht den finalen Status noch sichtbar und
  // gibt dem Renderer Zeit, seine automatischen Refreshes zu stoppen.
  await delay(120);

  // Bereits gestartete IPC-/Katalogabfragen dürfen noch sauber antworten.
  // Beim normalen Shutdown werden verbleibende Promises danach nicht mehr
  // künstlich rejected, weil der Renderer unmittelbar mit beendet wird.
  if (catalog) {
    const catalogIdle = await catalog.waitUntilIdle(1800);
    if (!catalogIdle) {
      analysis?.logDiagnostic("APP_SHUTDOWN_CATALOG_REQUESTS_STILL_PENDING");
    }
  }
  isQuitting = true;
  catalog?.stop(false);

  allowQuit = true;
  app.quit();
}

function beginGracefulShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = performGracefulShutdown().catch((error) => {
    analysis?.logDiagnostic("APP_SHUTDOWN_ERROR", {
      error: error instanceof Error ? error.message : String(error)
    });

    // Auch bei einem unerwarteten Shutdownfehler bleiben RUNNING-Jobs durch
    // die Startmigration wiederaufnehmbar. Als letztes Sicherheitsnetz werden
    // nur unsere eigenen Worker hart beendet.
    analysis?.stopImmediately();
    thumbnailService?.stop();
    catalog?.stop();
    isQuitting = true;
    allowQuit = true;
    app.quit();
  });

  return shutdownPromise;
}

function shutdownServicesImmediately(): void {
  if (isQuitting) {
    analysis?.stopImmediately();
    return;
  }

  isQuitting = true;

  if (personRefreshTimer) {
    clearTimeout(personRefreshTimer);
    personRefreshTimer = null;
  }

  remoteWebServer?.close();
  remoteWebServer = null;
  catalogWatchService?.stop();
  analysisCoordinator?.stop();
  thumbnailCoordinator?.stop();
  analysis?.stopImmediately();
  thumbnailService?.stop();
  catalog?.stop();
}

app.on("before-quit", (event) => {
  if (allowQuit) return;

  event.preventDefault();
  void beginGracefulShutdown();
});

app.on("will-quit", () => {
  shutdownServicesImmediately();
});

// Dev-Prozess und Betriebssystem-Signale nutzen ebenfalls den sicheren Pfad.
// Ein zweites Signal beendet Node notfalls weiterhin über das Betriebssystem.
process.once("SIGINT", () => {
  void beginGracefulShutdown();
});

process.once("SIGTERM", () => {
  void beginGracefulShutdown();
});
