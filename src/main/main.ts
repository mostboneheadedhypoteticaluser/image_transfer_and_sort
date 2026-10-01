import path from "node:path";
import { readFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { CatalogService } from "./catalog-service";
import { AnalysisService } from "./analysis-service";
import { AnalysisCoordinator } from "./analysis-coordinator";
import { ThumbnailService } from "./thumbnail-service";
import { ThumbnailCoordinator } from "./thumbnail-coordinator";
import { PersonService } from "./person-service";
import type {
  AnalysisQueueStats,
  AnalysisWorkerStatus,
  CatalogStats,
  ConfirmPersonResult,
  DuplicateGroup,
  FaceCropInfo,
  MediaRecord,
  MergePersonsResult,
  PersonCorrectionResult,
  PersonOverview,
  RestoreResult,
  ResetCatalogResult,
  ScanResult,
  SourceRecord,
  ThumbnailInfo,
  PipelineStatus
} from "../shared/protocol";

let windowRef: BrowserWindow | null = null;
let catalog: CatalogService | null = null;
let analysis: AnalysisService | null = null;
let analysisCoordinator: AnalysisCoordinator | null = null;
let thumbnailService: ThumbnailService | null = null;
let thumbnailCoordinator: ThumbnailCoordinator | null = null;
let personService: PersonService | null = null;
let thumbnailCacheRoot = "";
let personRefreshTimer: NodeJS.Timeout | null = null;
let personRefreshRunning = false;
let isQuitting = false;

const EMPTY_QUEUE: AnalysisQueueStats = {
  pending: 0,
  running: 0,
  done: 0,
  failed: 0
};

let pipelineStatus: PipelineStatus = {
  technical: { ...EMPTY_QUEUE },
  thumbnails: { ...EMPTY_QUEUE },
  imageMetadata: { ...EMPTY_QUEUE },
  faces: { ...EMPTY_QUEUE },
  faceEmbeddings: { ...EMPTY_QUEUE },
  petDetection: { ...EMPTY_QUEUE }
};

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

function pythonAnalysisIdle(): boolean {
  return [
    pipelineStatus.technical,
    pipelineStatus.imageMetadata,
    pipelineStatus.faces,
    pipelineStatus.faceEmbeddings,
    pipelineStatus.petDetection
  ].every((stats) => stats.pending === 0 && stats.running === 0);
}

function schedulePersonRefresh(): void {
  if (
    isQuitting ||
    !personService ||
    personRefreshRunning ||
    !pythonAnalysisIdle()
  ) {
    return;
  }

  if (personRefreshTimer) clearTimeout(personRefreshTimer);

  personRefreshTimer = setTimeout(() => {
    personRefreshTimer = null;
    if (!personService || isQuitting || personRefreshRunning) return;

    personRefreshRunning = true;
    void personService
      .refreshAllSources()
      .then(() => {
        sendToRenderer("people:updated", {});
      })
      .catch(() => {
        // Kandidaten sind Komfortdaten; Analyse- und Medienansicht bleiben unabhängig.
      })
      .finally(() => {
        personRefreshRunning = false;
      });
  }, 900);
  personRefreshTimer.unref();
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
    stage === "technical" ||
    stage === "imageMetadata" ||
    stage === "faces" ||
    stage === "faceEmbeddings" ||
    stage === "petDetection"
  ) {
    schedulePersonRefresh();
  }
}

function isInsideDirectory(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(root + path.sep);
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
      sandbox: true
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  win.on("closed", () => {
    if (windowRef === win) windowRef = null;
  });

  return win;
}

function registerIpc(): void {
  ipcMain.handle("dialog:pickSource", async () => {
    const result = await dialog.showOpenDialog(windowRef!, {
      title: "Festplatte oder Medienordner auswählen",
      properties: ["openDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("catalog:listSources", () =>
    catalog!.request<SourceRecord[]>("listSources")
  );

  ipcMain.handle("catalog:addSource", (_event, sourcePath: string) =>
    catalog!.request<SourceRecord>("addSource", { path: sourcePath })
  );

  ipcMain.handle("catalog:getStats", (_event, sourceId: number) =>
    catalog!.request<CatalogStats>("getStats", { sourceId })
  );

  ipcMain.handle("catalog:listMedia", (_event, sourceId: number, limit: number) =>
    catalog!.request<MediaRecord[]>("listMedia", { sourceId, limit })
  );

  ipcMain.handle("catalog:listDuplicateGroups", (_event, sourceId: number, limit: number) =>
    catalog!.request<DuplicateGroup[]>("listDuplicateGroups", { sourceId, limit })
  );

  ipcMain.handle("catalog:listRecycleMedia", (_event, sourceId: number, limit: number) =>
    catalog!.request<MediaRecord[]>("listRecycleMedia", { sourceId, limit })
  );

  ipcMain.handle("catalog:scanSource", (_event, sourceId: number) =>
    catalog!.request<ScanResult>("scanSource", { sourceId })
  );

  ipcMain.handle("catalog:restoreMedia", (_event, mediaId: number) =>
    catalog!.request<RestoreResult>("restoreMedia", { mediaId })
  );

  ipcMain.handle("catalog:resetCatalog", () =>
    catalog!.request<ResetCatalogResult>("resetCatalog")
  );

  ipcMain.handle("analysis:getStatus", (): Promise<AnalysisWorkerStatus> =>
    analysis!.refreshStatus()
  );

  ipcMain.handle("analysis:getPipelineStatus", (): PipelineStatus => ({
    technical: { ...pipelineStatus.technical },
    thumbnails: { ...pipelineStatus.thumbnails },
    imageMetadata: { ...pipelineStatus.imageMetadata },
    faces: { ...pipelineStatus.faces },
    faceEmbeddings: { ...pipelineStatus.faceEmbeddings },
    petDetection: { ...pipelineStatus.petDetection }
  }));

  ipcMain.handle(
    "people:getOverview",
    (_event, sourceId: number, forceRefresh = false): Promise<PersonOverview> =>
      personService!.getOverview(sourceId, Boolean(forceRefresh))
  );

  ipcMain.handle(
    "people:confirmCandidate",
    (
      _event,
      candidateId: number,
      name: string
    ): Promise<ConfirmPersonResult> =>
      personService!.confirmCandidate(candidateId, name)
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
    "people:renamePerson",
    (
      _event,
      personId: number,
      name: string
    ): Promise<PersonCorrectionResult> =>
      personService!.renamePerson(personId, name)
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

  catalog = new CatalogService(workerPath, dbPath, (progress) => {
    sendToRenderer("catalog:progress", progress);
  });

  analysis = new AnalysisService(analysisWorkerPath, (status) => {
    sendToRenderer("analysis:status", status);
  });

  thumbnailService = new ThumbnailService(
    thumbnailWorkerPath,
    thumbnailCacheRoot
  );

  analysisCoordinator = new AnalysisCoordinator(
    catalog,
    analysis,
    (stage, stats) => updatePipelineStage(stage, stats)
  );

  thumbnailCoordinator = new ThumbnailCoordinator(
    catalog,
    thumbnailService,
    (stats) => updatePipelineStage("thumbnails", stats)
  );

  personService = new PersonService(catalog, analysis);

  catalog.start();
  thumbnailService.start();
  registerIpc();

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
          "Cache-Control": "public, max-age=31536000, immutable"
        }
      });
    } catch {
      return new Response("Gesichtsausschnitt konnte nicht geladen werden.", {
        status: 404
      });
    }
  });

  windowRef = createWindow();

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
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (personRefreshTimer) {
    clearTimeout(personRefreshTimer);
    personRefreshTimer = null;
  }
  analysisCoordinator?.stop();
  thumbnailCoordinator?.stop();
  analysis?.stop();
  thumbnailService?.stop();
  catalog?.stop();
});
