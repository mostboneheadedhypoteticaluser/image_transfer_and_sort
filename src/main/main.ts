import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { CatalogService } from "./catalog-service";
import { AnalysisService } from "./analysis-service";
import { AnalysisCoordinator } from "./analysis-coordinator";
import { ThumbnailService } from "./thumbnail-service";
import { ThumbnailCoordinator } from "./thumbnail-coordinator";
import { PersonService } from "./person-service";
import { PetService } from "./pet-service";
import type {
  AnalysisErrorRecord,
  AnalysisQueueStats,
  AnalysisWorkerStatus,
  CatalogStats,
  ConfirmPersonResult,
  ConfirmPetResult,
  DuplicateGroup,
  FaceCropInfo,
  MediaPreviewInfo,
  MediaRecord,
  MergePersonsResult,
  MergePetsResult,
  PersonCorrectionResult,
  PetCorrectionResult,
  PersonOverview,
  PetCropInfo,
  PetOverview,
  RestoreResult,
  ResetCatalogResult,
  RetryAnalysisResult,
  SearchFacets,
  SearchFilter,
  SemanticTextEmbedding,
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
let petService: PetService | null = null;
let thumbnailCacheRoot = "";
let personRefreshTimer: NodeJS.Timeout | null = null;
let personRefreshRunning = false;
let isQuitting = false;

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
  semanticEmbeddings: { ...EMPTY_QUEUE }
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
    pipelineStatus.petDetection,
    pipelineStatus.petFusion,
    pipelineStatus.petEmbeddings
  ].every((stats) => stats.pending === 0 && stats.running === 0);
}

function schedulePersonRefresh(): void {
  if (
    isQuitting ||
    (!personService && !petService) ||
    personRefreshRunning ||
    !pythonAnalysisIdle()
  ) {
    return;
  }

  if (personRefreshTimer) clearTimeout(personRefreshTimer);

  personRefreshTimer = setTimeout(() => {
    personRefreshTimer = null;
    if ((!personService && !petService) || isQuitting || personRefreshRunning) return;

    personRefreshRunning = true;
    void Promise.all([
      personService?.refreshAllSources() ?? Promise.resolve(),
      petService?.refreshAllSources() ?? Promise.resolve()
    ])
      .then(() => {
        sendToRenderer("people:updated", {});
        sendToRenderer("pets:updated", {});
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
    stage === "petDetection" ||
    stage === "petFusion" ||
    stage === "petEmbeddings"
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

  ipcMain.handle("catalog:getSearchFacets", (_event, sourceId: number) =>
    catalog!.request<SearchFacets>("getSearchFacets", { sourceId })
  );

  ipcMain.handle(
    "catalog:searchMedia",
    async (_event, sourceId: number, filter: SearchFilter, limit: number) => {
      const query =
        typeof filter?.semanticQuery === "string"
          ? filter.semanticQuery.trim()
          : "";

      let semantic: SemanticTextEmbedding | null = null;

      if (query) {
        const cacheKey = query.toLocaleLowerCase("de-DE");
        semantic = semanticTextCache.get(cacheKey) ?? null;

        if (!semantic) {
          if (!analysis || analysis.getStatus().state !== "READY") {
            throw new Error(
              "Die semantische Suche ist noch nicht bereit. " +
              "Bitte AI-Setup und Analyse-Worker prüfen."
            );
          }

          semantic = await analysis.request<SemanticTextEmbedding>(
            "extract_semantic_text_embedding",
            { text: query },
            1800000
          );
          semanticTextCache.set(cacheKey, semantic);
        }
      }

      return catalog!.request<MediaRecord[]>("searchMedia", {
        sourceId,
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

  ipcMain.handle("catalog:scanSource", (_event, sourceId: number) =>
    catalog!.request<ScanResult>("scanSource", { sourceId })
  );

  ipcMain.handle("catalog:restoreMedia", (_event, mediaId: number) =>
    catalog!.request<RestoreResult>("restoreMedia", { mediaId })
  );

  ipcMain.handle("catalog:resetCatalog", async () => {
    semanticTextCache.clear();

    // Laufende Analyse-/Thumbnail-Jobs zuerst sauber anhalten. Insbesondere
    // SigLIP2 kann lange rechnen; ein Reset darf nicht parallel einen alten
    // Job nachträglich wieder in die frisch geleerte Datenbank schreiben.
    analysisCoordinator?.stop();
    thumbnailCoordinator?.stop();
    analysis?.stop();
    thumbnailService?.stop();

    if (personRefreshTimer) {
      clearTimeout(personRefreshTimer);
      personRefreshTimer = null;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 800));

    const result = await catalog!.request<ResetCatalogResult>("resetCatalog");

    // Auch abgeleitete Vorschaudateien/Crops entfernen. Die Originalmedien
    // und die großen KI-Modellgewichte bleiben ausdrücklich erhalten.
    if (thumbnailCacheRoot) {
      await rm(thumbnailCacheRoot, { recursive: true, force: true });
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
      semanticEmbeddings: { ...EMPTY_QUEUE }
    };
    sendToRenderer("analysis:pipelineStatus", pipelineStatus);

    thumbnailService?.start();
    void thumbnailCoordinator?.start();

    if (analysis) {
      await analysis.start();
      if (analysis.getStatus().state === "READY") {
        void analysisCoordinator?.start();
      }
    }

    return result;
  });

  ipcMain.handle("analysis:getStatus", (): Promise<AnalysisWorkerStatus> =>
    analysis!.refreshStatus()
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

  ipcMain.handle("analysis:getPipelineStatus", (): PipelineStatus => ({
    technical: { ...pipelineStatus.technical },
    thumbnails: { ...pipelineStatus.thumbnails },
    imageMetadata: { ...pipelineStatus.imageMetadata },
    faces: { ...pipelineStatus.faces },
    faceEmbeddings: { ...pipelineStatus.faceEmbeddings },
    petDetection: { ...pipelineStatus.petDetection },
    petFusion: { ...pipelineStatus.petFusion },
    petEmbeddings: { ...pipelineStatus.petEmbeddings },
    semanticEmbeddings: { ...pipelineStatus.semanticEmbeddings }
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

  ipcMain.handle(
    "pets:getOverview",
    (_event, sourceId: number, forceRefresh = false): Promise<PetOverview> =>
      petService!.getOverview(sourceId, Boolean(forceRefresh))
  );

  ipcMain.handle(
    "pets:confirmCandidate",
    (
      _event,
      candidateId: number,
      name: string,
      rejectedPetId?: number
    ): Promise<ConfirmPetResult> =>
      petService!.confirmCandidate(candidateId, name, rejectedPetId)
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
  petService = new PetService(catalog, analysis);

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

  protocol.handle("image-sorter-pet", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "pet") {
        return new Response("Ungültige Haustieradresse.", { status: 400 });
      }

      const petDetectionId = Number(url.pathname.replace(/^\//, ""));
      if (!Number.isFinite(petDetectionId)) {
        return new Response("Ungültige Haustier-ID.", { status: 400 });
      }

      const info = await catalog!.request<PetCropInfo | null>(
        "getPetCropInfo",
        { petDetectionId }
      );

      if (!info) {
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
          "Cache-Control": "public, max-age=31536000, immutable"
        }
      });
    } catch {
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
          "Cache-Control": "public, max-age=31536000, immutable"
        }
      });
    } catch {
      return new Response("Große Vorschau konnte nicht geladen werden.", {
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
