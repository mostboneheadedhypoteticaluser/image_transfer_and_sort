import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell, type OpenDialogOptions } from "electron";
import { CatalogService } from "./catalog-service";
import { AnalysisService } from "./analysis-service";
import { AnalysisCoordinator } from "./analysis-coordinator";
import { ThumbnailService } from "./thumbnail-service";
import { ThumbnailCoordinator } from "./thumbnail-coordinator";
import { PersonService } from "./person-service";
import { PetService } from "./pet-service";
import { CatalogWatchService } from "./catalog-watch-service";
import type {
  AnalysisErrorRecord,
  AnalysisQueueStats,
  AnalysisWorkerStatus,
  QwenBenchmarkModel,
  QwenBenchmarkProfile,
  QwenBenchmarkRunResult,
  QwenBenchmarkStageResult,
  CatalogStats,
  CatalogWatchSnapshot,
  ConfirmPersonResult,
  ConfirmPetResult,
  DuplicateGroup,
  FaceCropInfo,
  MediaPreviewInfo,
  MediaDetails,
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
let catalogWatchService: CatalogWatchService | null = null;
let thumbnailCacheRoot = "";
let personRefreshTimer: NodeJS.Timeout | null = null;
let personRefreshRunning = false;
let isQuitting = false;
let qwenBenchmarkMode = false;
let qwenBenchmarkPreparing: Promise<void> | null = null;

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
    pipelineStatus.petEmbeddings,
    pipelineStatus.objectVerification
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
    stage === "petEmbeddings" ||
    stage === "objectVerification"
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

  ipcMain.handle("catalog:addSource", async (_event, sourcePath: string) => {
    const source = await catalog!.request<SourceRecord>("addSource", {
      path: sourcePath
    });
    await catalogWatchService?.sourceAdded(source.id);
    return source;
  });

  ipcMain.handle("catalog:getStats", (_event, sourceId: number) =>
    catalog!.request<CatalogStats>("getStats", { sourceId })
  );

  ipcMain.handle("catalog:getWatchSnapshot", (): CatalogWatchSnapshot =>
    catalogWatchService?.getSnapshot() ?? { sources: [], history: [] }
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

  ipcMain.handle("catalog:getMediaDetails", (_event, mediaId: number) =>
    catalog!.request<MediaDetails | null>("getMediaDetails", { mediaId })
  );

  ipcMain.handle("catalog:scanSource", async (_event, sourceId: number) => {
    const result = await catalog!.request<ScanResult>("scanSource", { sourceId });
    await catalogWatchService?.syncSources();
    return result;
  });

  ipcMain.handle("catalog:restoreMedia", (_event, mediaId: number) =>
    catalog!.request<RestoreResult>("restoreMedia", { mediaId })
  );

  ipcMain.handle("catalog:resetCatalog", async () => {
    semanticTextCache.clear();
    catalogWatchService?.stop();

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
      objectVerification: { ...EMPTY_QUEUE },
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

    await catalogWatchService?.start(false);
    return result;
  });

  ipcMain.handle("analysis:getStatus", (): Promise<AnalysisWorkerStatus> =>
    analysis!.refreshStatus()
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

  ipcMain.handle("analysis:getAutomaticQwenState", () => ({
    enabled: analysisCoordinator?.isAutomaticQwenEnabled() ?? false
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

    analysisCoordinator.enableAutomaticQwen();

    if (analysis.getStatus().state !== "READY") {
      await analysis.start();
    }
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

  ipcMain.handle("analysis:getPipelineStatus", (): PipelineStatus => ({
    technical: { ...pipelineStatus.technical },
    thumbnails: { ...pipelineStatus.thumbnails },
    imageMetadata: { ...pipelineStatus.imageMetadata },
    faces: { ...pipelineStatus.faces },
    faceEmbeddings: { ...pipelineStatus.faceEmbeddings },
    petDetection: { ...pipelineStatus.petDetection },
    petFusion: { ...pipelineStatus.petFusion },
    petEmbeddings: { ...pipelineStatus.petEmbeddings },
    objectVerification: { ...pipelineStatus.objectVerification },
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
  catalogWatchService = new CatalogWatchService(catalog, (event) => {
    sendToRenderer("catalog:watchEvent", event);
  });

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
  if (process.platform !== "darwin") app.quit();
});

function shutdownServicesImmediately(): void {
  if (isQuitting) {
    // Der Analyse-Service ist idempotent; ein zweiter Aufruf ist als
    // Sicherheitsnetz erlaubt, falls will-quit nach before-quit folgt.
    analysis?.stopImmediately();
    return;
  }

  isQuitting = true;

  if (personRefreshTimer) {
    clearTimeout(personRefreshTimer);
    personRefreshTimer = null;
  }

  catalogWatchService?.stop();
  analysisCoordinator?.stop();
  thumbnailCoordinator?.stop();

  // Wichtig: zuerst den speicherintensiven Python/Qwen-Prozessbaum synchron
  // beenden. Erst danach dürfen Electron/Katalog/Thumbnail-Prozesse schließen.
  analysis?.stopImmediately();

  thumbnailService?.stop();
  catalog?.stop();
}

app.on("before-quit", () => {
  shutdownServicesImmediately();
});

app.on("will-quit", () => {
  shutdownServicesImmediately();
});

// Auch beim Beenden des Dev-Prozesses per Ctrl+C/SIGTERM muss llama.cpp
// verschwinden. Sonst bleibt dessen GGUF-Modell im Hauptspeicher liegen.
process.once("SIGINT", () => {
  shutdownServicesImmediately();
  app.quit();
});

process.once("SIGTERM", () => {
  shutdownServicesImmediately();
  app.quit();
});
