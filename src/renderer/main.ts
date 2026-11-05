import { initEmbeddedSourceExplorer } from "./source-explorer";
import { activateMapView, invalidateMapData } from "./map-view";
import { activateLifeAreasView, invalidateLifeAreas } from "./life-areas";
import type {
  AnalysisErrorRecord,
  AnalysisWorkerStatus,
  BackgroundPauseState,
  CatalogStats,
  CatalogWatchEvent,
  CatalogWatchSnapshot,
  QwenBenchmarkModel,
  QwenBenchmarkProfile,
  QwenBenchmarkStageResult,
  DuplicateGroup,
  MediaDetails,
  MediaRecord,
  PersonOverview,
  PetOverview,
  PipelineStatus,
  SearchFacets,
  SearchFilter,
  SourceRecord
} from "../shared/protocol";

type CatalogView = "media" | "search" | "duplicates" | "people" | "pets" | "recycle";

type IdentityTabStats = Pick<
  CatalogStats,
  | "personCandidates"
  | "personCandidateFaces"
  | "detectedFaces"
  | "embeddedFaces"
  | "unassignedFaceEmbeddings"
  | "persons"
  | "assignedPersonFaces"
  | "petCandidates"
  | "petCandidateDetections"
  | "fusedDogs"
  | "embeddedDogs"
  | "unassignedDogEmbeddings"
  | "pets"
  | "assignedPetDetections"
>;

const sourceSelect = document.querySelector<HTMLSelectElement>("#sourceSelect")!;
const addSourceButton = document.querySelector<HTMLButtonElement>("#addSource")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scanSource")!;
const resetButton = document.querySelector<HTMLButtonElement>("#resetCatalog")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const mediaRows = document.querySelector<HTMLTableSectionElement>("#mediaRows")!;
const libraryToolbar = document.querySelector<HTMLElement>("#libraryToolbar")!;
const libraryMediaType = document.querySelector<HTMLSelectElement>("#libraryMediaType")!;
const libraryStatus = document.querySelector<HTMLSelectElement>("#libraryStatus")!;
const libraryTextFilter = document.querySelector<HTMLInputElement>("#libraryTextFilter")!;
const librarySort = document.querySelector<HTMLSelectElement>("#librarySort")!;
const libraryGroup = document.querySelector<HTMLSelectElement>("#libraryGroup")!;
const libraryReset = document.querySelector<HTMLButtonElement>("#libraryReset")!;
const libraryMarksFilter = document.querySelector<HTMLDetailsElement>("#libraryMarksFilter")!;
const libraryMarksCount = document.querySelector<HTMLSpanElement>("#libraryMarksCount")!;
const libraryMarksOptions = document.querySelector<HTMLDivElement>("#libraryMarksOptions")!;
const librarySummary = document.querySelector<HTMLSpanElement>("#librarySummary")!;
const duplicateGroups = document.querySelector<HTMLDivElement>("#duplicateGroups")!;
const mediaView = document.querySelector<HTMLDivElement>("#mediaView")!;
const duplicateView = document.querySelector<HTMLDivElement>("#duplicateView")!;
const personView = document.querySelector<HTMLDivElement>("#personView")!;
const petView = document.querySelector<HTMLDivElement>("#petView")!;
const personCandidates = document.querySelector<HTMLDivElement>("#personCandidates")!;
const petCandidates = document.querySelector<HTMLDivElement>("#petCandidates")!;
const confirmedPets = document.querySelector<HTMLDivElement>("#confirmedPets")!;
const petStatus = document.querySelector<HTMLParagraphElement>("#petStatus")!;
const refreshPetsButton = document.querySelector<HTMLButtonElement>("#refreshPets")!;
const petConfirmAllMedia = document.querySelector<HTMLButtonElement>("#petConfirmAllMedia")!;
const petConfirmImagesOnly = document.querySelector<HTMLButtonElement>("#petConfirmImagesOnly")!;
const petConfirmVideosOnly = document.querySelector<HTMLButtonElement>("#petConfirmVideosOnly")!;
const confirmedPersons = document.querySelector<HTMLDivElement>("#confirmedPersons")!;
const personStatus = document.querySelector<HTMLParagraphElement>("#personStatus")!;
const refreshPeopleButton = document.querySelector<HTMLButtonElement>("#refreshPeople")!;
const personConfirmAllMedia = document.querySelector<HTMLButtonElement>("#personConfirmAllMedia")!;
const personConfirmImagesOnly = document.querySelector<HTMLButtonElement>("#personConfirmImagesOnly")!;
const personConfirmVideosOnly = document.querySelector<HTMLButtonElement>("#personConfirmVideosOnly")!;
const mediaTab = document.querySelector<HTMLButtonElement>("#mediaTab")!;
const searchTab = document.querySelector<HTMLButtonElement>("#searchTab")!;
const duplicateTab = document.querySelector<HTMLButtonElement>("#duplicateTab")!;
const peopleTab = document.querySelector<HTMLButtonElement>("#peopleTab")!;
const petsTab = document.querySelector<HTMLButtonElement>("#petsTab")!;
const recycleTab = document.querySelector<HTMLButtonElement>("#recycleTab")!;
const mediaTabCount = document.querySelector<HTMLSpanElement>("#mediaTabCount")!;
const searchTabCount = document.querySelector<HTMLSpanElement>("#searchTabCount")!;
const duplicateTabCount = document.querySelector<HTMLSpanElement>("#duplicateTabCount")!;
const peopleTabCount = document.querySelector<HTMLSpanElement>("#peopleTabCount")!;
const petsTabCount = document.querySelector<HTMLSpanElement>("#petsTabCount")!;
const recycleTabCount = document.querySelector<HTMLSpanElement>("#recycleTabCount")!;
const progressText = document.querySelector<HTMLSpanElement>("#progressText")!;
const progressBar = document.querySelector<HTMLDivElement>("#progressBar")!;
const watchState = document.querySelector<HTMLSpanElement>("#watchState")!;
const watchDetail = document.querySelector<HTMLElement>("#watchDetail")!;
const watchHistory = document.querySelector<HTMLDivElement>("#watchHistory")!;
const workerState = document.querySelector<HTMLSpanElement>("#workerState")!;
const backgroundPauseButton = document.querySelector<HTMLButtonElement>("#backgroundPauseButton")!;
const backgroundPauseIcon = document.querySelector<HTMLElement>("#backgroundPauseIcon")!;
const backgroundPauseLabel = document.querySelector<HTMLElement>("#backgroundPauseLabel")!;
const backgroundPauseHint = document.querySelector<HTMLElement>("#backgroundPauseHint")!;
const totalCount = document.querySelector<HTMLSpanElement>("#totalCount")!;
const availableCount = document.querySelector<HTMLSpanElement>("#availableCount")!;
const missingCount = document.querySelector<HTMLSpanElement>("#missingCount")!;
const recycleCount = document.querySelector<HTMLSpanElement>("#recycleCount")!;
const lastScan = document.querySelector<HTMLSpanElement>("#lastScan")!;
const analysisWorkerState = document.querySelector<HTMLSpanElement>("#analysisWorkerState")!;
const analysisPython = document.querySelector<HTMLElement>("#analysisPython")!;
const analysisPriority = document.querySelector<HTMLElement>("#analysisPriority")!;
const analysisCpuBudget = document.querySelector<HTMLElement>("#analysisCpuBudget")!;
const analysisParallelSelect = document.querySelector<HTMLSelectElement>("#analysisParallelSelect")!;
const analysisQueue = document.querySelector<HTMLElement>("#analysisQueue")!;
const analysisActive = document.querySelector<HTMLElement>("#analysisActive")!;
const analysisMessage = document.querySelector<HTMLSpanElement>("#analysisMessage")!;
const analysisLiveActivity = document.querySelector<HTMLElement>("#analysisLiveActivity")!;
const analysisLiveActivityText = document.querySelector<HTMLElement>("#analysisLiveActivityText")!;
const technicalStageState = document.querySelector<HTMLSpanElement>("#technicalStageState")!;
const technicalStageCounts = document.querySelector<HTMLElement>("#technicalStageCounts")!;
const thumbnailStageState = document.querySelector<HTMLSpanElement>("#thumbnailStageState")!;
const thumbnailStageCounts = document.querySelector<HTMLElement>("#thumbnailStageCounts")!;
const metadataStageState = document.querySelector<HTMLSpanElement>("#metadataStageState")!;
const metadataStageCounts = document.querySelector<HTMLElement>("#metadataStageCounts")!;
const faceStageState = document.querySelector<HTMLSpanElement>("#faceStageState")!;
const faceStageCounts = document.querySelector<HTMLElement>("#faceStageCounts")!;
const faceEmbeddingStageState = document.querySelector<HTMLSpanElement>("#faceEmbeddingStageState")!;
const faceEmbeddingStageCounts = document.querySelector<HTMLElement>("#faceEmbeddingStageCounts")!;
const petStageState = document.querySelector<HTMLSpanElement>("#petStageState")!;
const petStageCounts = document.querySelector<HTMLElement>("#petStageCounts")!;
const petFusionStageState = document.querySelector<HTMLSpanElement>("#petFusionStageState")!;
const petFusionStageCounts = document.querySelector<HTMLElement>("#petFusionStageCounts")!;
const petEmbeddingStageState = document.querySelector<HTMLSpanElement>("#petEmbeddingStageState")!;
const petEmbeddingStageCounts = document.querySelector<HTMLElement>("#petEmbeddingStageCounts")!;
const objectVerificationStageState = document.querySelector<HTMLSpanElement>("#objectVerificationStageState")!;
const objectVerificationStageCounts = document.querySelector<HTMLElement>("#objectVerificationStageCounts")!;
const semanticStageState = document.querySelector<HTMLSpanElement>("#semanticStageState")!;
const semanticStageCounts = document.querySelector<HTMLElement>("#semanticStageCounts")!;
const videoAnalysisStageState = document.querySelector<HTMLSpanElement>("#videoAnalysisStageState")!;
const videoAnalysisStageCounts = document.querySelector<HTMLElement>("#videoAnalysisStageCounts")!;
const analysisErrorsButton = document.querySelector<HTMLButtonElement>("#analysisErrorsButton")!;
const analysisDevLogButton = document.querySelector<HTMLButtonElement>("#analysisDevLogButton")!;
const analysisCopyDevLogButton = document.querySelector<HTMLButtonElement>("#analysisCopyDevLogButton")!;
const analysisClearDevLogButton = document.querySelector<HTMLButtonElement>("#analysisClearDevLogButton")!;
const qwenAutomaticButton = document.querySelector<HTMLButtonElement>("#qwenAutomaticButton")!;
const qwenBenchmarkButton = document.querySelector<HTMLButtonElement>("#qwenBenchmarkButton")!;
const qwenBenchmarkDialog = document.querySelector<HTMLDialogElement>("#qwenBenchmarkDialog")!;
const closeQwenBenchmarkButton = document.querySelector<HTMLButtonElement>("#closeQwenBenchmark")!;
const pickQwenBenchmarkImageButton = document.querySelector<HTMLButtonElement>("#pickQwenBenchmarkImage")!;
const runQwenBenchmarkButton = document.querySelector<HTMLButtonElement>("#runQwenBenchmark")!;
const copyQwenBenchmarkButton = document.querySelector<HTMLButtonElement>("#copyQwenBenchmark")!;
const qwenBenchmarkFilePath = document.querySelector<HTMLElement>("#qwenBenchmarkFilePath")!;
const qwenBenchmarkLive = document.querySelector<HTMLDivElement>("#qwenBenchmarkLive")!;
const qwenBenchmarkResults = document.querySelector<HTMLDivElement>("#qwenBenchmarkResults")!;
const qwenBenchmarkSearchProbe = document.querySelector<HTMLInputElement>("#qwenBenchmarkSearchProbe")!;
const qwenBenchmarkModelInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="qwenBenchmarkModel"]')
);
const qwenBenchmarkProfileInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="qwenBenchmarkProfile"]')
);
const analysisErrorCount = document.querySelector<HTMLSpanElement>("#analysisErrorCount")!;
const analysisErrorDialog = document.querySelector<HTMLDialogElement>("#analysisErrorDialog")!;
const closeAnalysisErrorsButton = document.querySelector<HTMLButtonElement>("#closeAnalysisErrors")!;
const retryAllAnalysisErrorsButton = document.querySelector<HTMLButtonElement>("#retryAllAnalysisErrors")!;
const copyAllAnalysisErrorsButton = document.querySelector<HTMLButtonElement>("#copyAllAnalysisErrors")!;
const analysisErrorSummary = document.querySelector<HTMLSpanElement>("#analysisErrorSummary")!;
const analysisErrorList = document.querySelector<HTMLDivElement>("#analysisErrorList")!;
const lifeAreaAssignDialog = document.querySelector<HTMLDialogElement>("#lifeAreaAssignDialog")!;
const closeLifeAreaAssignButton = document.querySelector<HTMLButtonElement>("#closeLifeAreaAssign")!;
const lifeAreaAssignPath = document.querySelector<HTMLParagraphElement>("#lifeAreaAssignPath")!;
const lifeAreaAssignList = document.querySelector<HTMLDivElement>("#lifeAreaAssignList")!;
const imagePreviewDialog = document.querySelector<HTMLDialogElement>("#imagePreviewDialog")!;
const closeImagePreviewButton = document.querySelector<HTMLButtonElement>("#closeImagePreview")!;
const imagePreviewImage = document.querySelector<HTMLImageElement>("#imagePreviewImage")!;
const imagePreviewVideo = document.querySelector<HTMLVideoElement>("#imagePreviewVideo")!;
const imagePreviewVideoError = document.querySelector<HTMLDivElement>("#imagePreviewVideoError")!;
const imagePreviewBackToVideo = document.querySelector<HTMLButtonElement>("#imagePreviewBackToVideo")!;
const imagePreviewImageWrap = document.querySelector<HTMLDivElement>("#imagePreviewImageWrap")!;
const imagePreviewOverlay = document.querySelector<HTMLDivElement>("#imagePreviewOverlay")!;
const imagePreviewPersonNames = document.querySelector<HTMLDataListElement>("#imagePreviewPersonNames")!;
const imagePreviewPetNames = document.querySelector<HTMLDataListElement>("#imagePreviewPetNames")!;
const imagePreviewCaption = document.querySelector<HTMLDivElement>("#imagePreviewCaption")!;
const imagePreviewDetails = document.querySelector<HTMLDivElement>("#imagePreviewDetails")!;
const candidateReviewDialog = document.querySelector<HTMLDialogElement>("#candidateReviewDialog")!;
const closeCandidateReviewButton = document.querySelector<HTMLButtonElement>("#closeCandidateReview")!;
const candidateReviewTitle = document.querySelector<HTMLElement>("#candidateReviewTitle")!;
const candidateReviewMeta = document.querySelector<HTMLElement>("#candidateReviewMeta")!;
const candidateReviewImageWrap = document.querySelector<HTMLDivElement>("#candidateReviewImageWrap")!;
const candidateReviewImage = document.querySelector<HTMLImageElement>("#candidateReviewImage")!;
const candidateReviewBox = document.querySelector<HTMLDivElement>("#candidateReviewBox")!;
const candidateReviewPrev = document.querySelector<HTMLButtonElement>("#candidateReviewPrev")!;
const candidateReviewNext = document.querySelector<HTMLButtonElement>("#candidateReviewNext")!;
const candidateReviewPosition = document.querySelector<HTMLElement>("#candidateReviewPosition")!;
const candidateReviewPath = document.querySelector<HTMLElement>("#candidateReviewPath")!;
const candidateReviewThumbnails = document.querySelector<HTMLDivElement>("#candidateReviewThumbnails")!;
const candidateReviewSuggestions = document.querySelector<HTMLDivElement>("#candidateReviewSuggestions")!;
const candidateReviewName = document.querySelector<HTMLInputElement>("#candidateReviewName")!;
const candidateReviewNames = document.querySelector<HTMLDataListElement>("#candidateReviewNames")!;
const candidateReviewAssign = document.querySelector<HTMLButtonElement>("#candidateReviewAssign")!;
const shutdownOverlay = document.querySelector<HTMLDivElement>("#shutdownOverlay")!;
const shutdownMessage = document.querySelector<HTMLParagraphElement>("#shutdownMessage")!;
const searchPanel = document.querySelector<HTMLElement>("#searchPanel")!;
const searchPersons = document.querySelector<HTMLDivElement>("#searchPersons")!;
const searchPets = document.querySelector<HTMLDivElement>("#searchPets")!;
const searchObjects = document.querySelector<HTMLDivElement>("#searchObjects")!;
const searchSemanticQuery = document.querySelector<HTMLInputElement>("#searchSemanticQuery")!;
const searchSemanticMinProbability = document.querySelector<HTMLInputElement>("#searchSemanticMinProbability")!;
const searchMinDogs = document.querySelector<HTMLInputElement>("#searchMinDogs")!;
const searchMinCats = document.querySelector<HTMLInputElement>("#searchMinCats")!;
const runSearchButton = document.querySelector<HTMLButtonElement>("#runSearch")!;
const resetSearchButton = document.querySelector<HTMLButtonElement>("#resetSearch")!;
const searchSummary = document.querySelector<HTMLSpanElement>("#searchSummary")!;
const searchScope = document.querySelector<HTMLSelectElement>("#searchScope")!;
const identityBrowserPeopleTab = document.querySelector<HTMLButtonElement>("#identityBrowserPeopleTab")!;
const identityBrowserPetsTab = document.querySelector<HTMLButtonElement>("#identityBrowserPetsTab")!;
const identityBrowserAllMedia = document.querySelector<HTMLButtonElement>("#identityBrowserAllMedia")!;
const identityBrowserImagesOnly = document.querySelector<HTMLButtonElement>("#identityBrowserImagesOnly")!;
const identityBrowserVideosOnly = document.querySelector<HTMLButtonElement>("#identityBrowserVideosOnly")!;
const identityBrowserListTitle = document.querySelector<HTMLElement>("#identityBrowserListTitle")!;
const identityBrowserCount = document.querySelector<HTMLElement>("#identityBrowserCount")!;
const identityBrowserList = document.querySelector<HTMLDivElement>("#identityBrowserList")!;
const identityBrowserPlaceholder = document.querySelector<HTMLDivElement>("#identityBrowserPlaceholder")!;
const identityBrowserDetail = document.querySelector<HTMLDivElement>("#identityBrowserDetail")!;
const identityBrowserKind = document.querySelector<HTMLElement>("#identityBrowserKind")!;
const identityBrowserName = document.querySelector<HTMLElement>("#identityBrowserName")!;
const identityBrowserMeta = document.querySelector<HTMLElement>("#identityBrowserMeta")!;
const identityWordCloud = document.querySelector<HTMLDivElement>("#identityWordCloud")!;
const identityCloudHint = document.querySelector<HTMLElement>("#identityCloudHint")!;
const identityTimelineCount = document.querySelector<HTMLElement>("#identityTimelineCount")!;
const identityTimeline = document.querySelector<HTMLDivElement>("#identityTimeline")!;
const identityDateFrom = document.querySelector<HTMLInputElement>("#identityDateFrom")!;
const identityDateTo = document.querySelector<HTMLInputElement>("#identityDateTo")!;
const identityDateRangeLabel = document.querySelector<HTMLElement>("#identityDateRangeLabel")!;
const identityDateFromLabel = document.querySelector<HTMLElement>("#identityDateFromLabel")!;
const identityDateToLabel = document.querySelector<HTMLElement>("#identityDateToLabel")!;
const identityRangeFill = document.querySelector<HTMLDivElement>("#identityRangeFill")!;

let sources: SourceRecord[] = [];
let currentView: CatalogView = "media";

const LIBRARY_IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff",
  ".heic", ".heif", ".avif", ".dng", ".cr2", ".cr3", ".nef", ".arw"
]);
const LIBRARY_VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".mts", ".m2ts"
]);
let libraryRows: MediaRecord[] = [];
let libraryLoadToken = 0;
const selectedLibraryMarks = new Set<string>();
let identityBrowserMode: "people" | "pets" = "people";
let identityBrowserMediaFilter: "all" | "image" | "video" = "all";
type ConfirmationMediaFilter = "all" | "image" | "video";
let personConfirmationMediaFilter: ConfirmationMediaFilter = "all";
let petConfirmationMediaFilter: ConfirmationMediaFilter = "all";
let lastPersonOverview: PersonOverview | null = null;
let lastPetOverview: PetOverview | null = null;

type CandidateReviewSuggestion = {
  name: string;
  similarity: number;
  previewUrl: string | null;
};

type CandidateReviewItem = {
  detectionId: number;
  mediaId: number;
  relativePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  suggestions: CandidateReviewSuggestion[];
};

type CandidateReviewState = {
  kind: "person" | "pet";
  candidateId: number;
  items: CandidateReviewItem[];
  index: number;
  knownNames: string[];
};

let candidateReviewState: CandidateReviewState | null = null;
let currentImagePreviewDetails: MediaDetails | null = null;
let currentVideoFrameTimestamp: number | null = null;
let videoFrameThumbnailObserver: IntersectionObserver | null = null;
let imagePreviewDetailLoadToken = 0;

function createLoadingIndicator(text = "Daten werden geladen …"): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "data-loading";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "data-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = text;
  wrap.append(spinner, label);
  return wrap;
}

function showBlockLoading(container: HTMLElement, text = "Daten werden geladen …"): void {
  container.replaceChildren(createLoadingIndicator(text));
}

function showTableLoading(text = "Medien werden geladen …"): void {
  mediaRows.replaceChildren();
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 7;
  td.className = "table-loading-cell";
  td.appendChild(createLoadingIndicator(text));
  tr.appendChild(td);
  mediaRows.appendChild(tr);
}

let identityBrowserSelectionToken = 0;
let scanning = false;
let restoring = false;
let resetting = false;
let lastThumbnailDone = -1;
let lastMetadataDone = -1;
let lastFaceDone = -1;
let lastFaceEmbeddingDone = -1;
let lastPetDone = -1;
let lastPetFusionDone = -1;
let lastPetEmbeddingDone = -1;
let lastObjectVerificationDone = -1;
let lastSemanticDone = -1;
let lastVideoAnalysisDone = -1;
let lastPipelineIssueTotal = -1;
let analysisRefreshTimer: number | null = null;
let sourcePipelineRefreshTimer: number | null = null;
let identityStatsRefreshTimer: number | null = null;
let watchCatalogRefreshTimer: number | null = null;
let rendererShuttingDown = false;
let searchFacetsScopeKey: string | null = null;
let latestAnalysisStatus: AnalysisWorkerStatus | null = null;
let backgroundPauseState: BackgroundPauseState = {
  paused: false,
  changing: false,
  message: "Hintergrundarbeit läuft."
};
let qwenBenchmarkSelectedPath: string | null = null;
let qwenBenchmarkRunning = false;
let qwenBenchmarkModelInRun: QwenBenchmarkModel = "minicpm";
let qwenBenchmarkStages: QwenBenchmarkStageResult[] = [];
let qwenBenchmarkProfilesInRun: QwenBenchmarkProfile[] = [];
let qwenBenchmarkProgressCurrent: {
  current: number | null;
  total: number | null;
  message: string;
} | null = null;
let qwenBenchmarkRunError: string | null = null;
let automaticQwenEnabled = false;
let catalogWatchSnapshot: CatalogWatchSnapshot = {
  sources: [],
  history: []
};

function renderAutomaticQwenState(enabled: boolean): void {
  automaticQwenEnabled = enabled;
  qwenAutomaticButton.disabled = enabled;
  qwenAutomaticButton.textContent = enabled
    ? "Qwen 4B Kataloganalyse aktiv"
    : "Qwen 4B Kataloganalyse starten";
  qwenAutomaticButton.title = enabled
    ? "Qwen3-VL 4B läuft automatisch als letzte Katalogstufe mit Gesamtbild plus vier Teilbildern."
    : "Qwen3-VL 4B kann manuell wieder für die automatische Kataloganalyse aktiviert werden.";
}

function benchmarkModelLabel(model: QwenBenchmarkModel): string {
  if (model === "qwen3vl4b") return "Qwen3-VL 4B Instruct Q4_K_M";
  if (model === "qwen3vl2b") return "Qwen3-VL 2B Instruct Q4_K_M";
  return "MiniCPM-V 4.6 Q4_K_M";
}

const benchmarkSearchStopWords = new Set([
  "am", "an", "auf", "bei", "beim", "das", "dem", "den", "der", "die", "ein",
  "eine", "einem", "einen", "einer", "im", "in", "ist", "mit", "und", "vom",
  "von", "zu", "zum", "zur"
]);

function normalizeBenchmarkSearchText(value: string): string {
  return value
    .toLocaleLowerCase("de-DE")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function benchmarkSearchProbeResult(stage: QwenBenchmarkStageResult): {
  matched: number;
  total: number;
  details: string[];
} | null {
  const query = normalizeBenchmarkSearchText(qwenBenchmarkSearchProbe.value);
  if (!query) return null;

  const queryTokens = [...new Set(
    query
      .split(/\s+/)
      .filter((token) => token.length >= 2 && !benchmarkSearchStopWords.has(token))
  )];
  if (queryTokens.length === 0) return null;

  const fields: Array<[string, string[]]> = [
    ["Beschreibung", stage.semantic.description ? [stage.semantic.description] : []],
    ["Motive", stage.semantic.subjects],
    ["Handlungen", stage.semantic.actions],
    ["Szene", stage.semantic.scenes],
    ["Suchbegriffe", stage.semantic.tags],
    ["Konzepte", stage.semantic.concepts]
  ];

  const matchedTokens = new Set<string>();
  const details: string[] = [];

  for (const [label, values] of fields) {
    const hits: string[] = [];
    for (const value of values) {
      const normalized = normalizeBenchmarkSearchText(value);
      if (!normalized) continue;
      const words = normalized.split(/\s+/);

      const matches = queryTokens.filter((queryToken) =>
        words.some((word) =>
          word === queryToken ||
          (queryToken.length >= 5 && word.startsWith(queryToken)) ||
          (word.length >= 5 && queryToken.startsWith(word))
        )
      );

      if (matches.length > 0) {
        matches.forEach((token) => matchedTokens.add(token));
        hits.push(value);
      }
    }

    if (hits.length > 0) {
      details.push(label + ": " + [...new Set(hits)].slice(0, 4).join(", "));
    }
  }

  return {
    matched: matchedTokens.size,
    total: queryTokens.length,
    details
  };
}

function benchmarkDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return hours.toLocaleString("de-DE") + ":" +
      minutes.toString().padStart(2, "0") + ":" +
      seconds.toString().padStart(2, "0") + " h";
  }
  if (minutes > 0) {
    return minutes.toLocaleString("de-DE") + ":" +
      seconds.toString().padStart(2, "0") + " min";
  }
  return seconds.toLocaleString("de-DE") + " s";
}

function benchmarkObjectSummary(stage: QwenBenchmarkStageResult): string {
  const parts: string[] = [];
  if (stage.semantic.description) parts.push(stage.semantic.description);
  if (stage.semantic.subjects.length > 0) {
    parts.push("Motive: " + stage.semantic.subjects.join(", "));
  }
  if (stage.semantic.actions.length > 0) {
    parts.push("Handlung: " + stage.semantic.actions.join(", "));
  }
  if (stage.semantic.scenes.length > 0) {
    parts.push("Szene: " + stage.semantic.scenes.join(", "));
  }
  if (stage.semantic.tags.length > 0) {
    parts.push("Tags: " + stage.semantic.tags.join(", "));
  }
  if (stage.semantic.concepts.length > 0) {
    parts.push("Konzepte: " + stage.semantic.concepts.join(", "));
  }
  return parts.length > 0 ? parts.join(" · ") : "Kein semantischer Inhalt erkannt.";
}

function benchmarkProfileInfo(
  profile: QwenBenchmarkProfile
): { label: string; calls: number } {
  switch (profile) {
    case "whole":
      return { label: "1 · Nur Gesamtbild", calls: 1 };
    case "tiles4":
      return { label: "2 · Gesamtbild + 4 Kacheln", calls: 5 };
    case "tiles9":
      return { label: "3 · Gesamtbild + 9 Kacheln", calls: 10 };
    case "tiles16":
      return { label: "4 · Gesamtbild + 16 Kacheln", calls: 17 };
  }
}

function benchmarkProfileOrder(profile: QwenBenchmarkProfile): number {
  return ["whole", "tiles4", "tiles9", "tiles16"].indexOf(profile);
}

function renderQwenBenchmarkResults(): void {
  qwenBenchmarkResults.replaceChildren();

  const requested = qwenBenchmarkProfilesInRun.length > 0
    ? [...qwenBenchmarkProfilesInRun]
    : qwenBenchmarkStages.map((stage) => stage.profile);

  requested.sort(
    (left, right) => benchmarkProfileOrder(left) - benchmarkProfileOrder(right)
  );

  if (requested.length === 0) {
    const empty = document.createElement("p");
    empty.className = "qwen-benchmark-empty";
    empty.textContent = "Noch keine Testergebnisse.";
    qwenBenchmarkResults.appendChild(empty);
    copyQwenBenchmarkButton.disabled = true;
    return;
  }

  const firstIncomplete = requested.find(
    (profile) => !qwenBenchmarkStages.some((stage) => stage.profile === profile)
  );

  for (const profile of requested) {
    const result = qwenBenchmarkStages.find((stage) => stage.profile === profile);
    const card = document.createElement("article");
    card.className = "qwen-benchmark-result";
    card.dataset.profile = profile;

    if (!result) {
      const info = benchmarkProfileInfo(profile);
      const isActive = qwenBenchmarkRunning && firstIncomplete === profile;
      const hasError = qwenBenchmarkRunError !== null && firstIncomplete === profile;

      card.classList.add(
        hasError ? "error" : isActive ? "running" : "waiting"
      );

      const header = document.createElement("div");
      header.className = "qwen-benchmark-result-header";
      const title = document.createElement("h3");
      title.textContent = info.label;
      const state = document.createElement("strong");
      state.textContent = hasError ? "Fehler" : isActive ? "Läuft" : "Wartet";
      header.append(title, state);

      const progress = document.createElement("p");
      const progressState = qwenBenchmarkProgressCurrent;
      if (hasError) {
        progress.textContent = qwenBenchmarkRunError ?? "Unbekannter Fehler.";
      } else if (
        isActive &&
        progressState !== null &&
        progressState.current !== null &&
        progressState.total !== null
      ) {
        progress.textContent =
          "Bildbereich " +
          progressState.current.toLocaleString("de-DE") +
          "/" +
          progressState.total.toLocaleString("de-DE") +
          " · " +
          progressState.message;
      } else if (isActive) {
        progress.textContent =
          "Stufe wird vorbereitet. " +
          info.calls.toLocaleString("de-DE") +
          (info.calls === 1 ? " Modellaufruf." : " Modellaufrufe.");
      } else {
        progress.textContent =
          "Startet nach der vorherigen Stufe · " +
          info.calls.toLocaleString("de-DE") +
          (info.calls === 1 ? " Modellaufruf." : " Modellaufrufe.");
      }

      const note = document.createElement("small");
      note.className = "qwen-benchmark-stage-note";
      note.textContent =
        "Das Endergebnis dieser Stufe erscheint, sobald alle zugehörigen Bildbereiche ausgewertet sind.";

      card.append(header, progress, note);
      qwenBenchmarkResults.appendChild(card);
      continue;
    }

    card.classList.add("done");

    const header = document.createElement("div");
    header.className = "qwen-benchmark-result-header";
    const title = document.createElement("h3");
    title.textContent = result.label;
    const total = document.createElement("strong");
    total.textContent = benchmarkDuration(result.timings.totalMs);
    header.append(title, total);

    const metrics = document.createElement("div");
    metrics.className = "qwen-benchmark-metrics";

    const metricValues: Array<[string, string]> = [
      ["Modell bereit", benchmarkDuration(result.timings.modelReadyMs)],
      ["Bildanalyse", benchmarkDuration(result.timings.discoveryMs)],
      ["Bildbereiche", result.regionCount.toLocaleString("de-DE")],
      ["Motive", result.semantic.subjects.length.toLocaleString("de-DE")],
      ["Suchbegriffe", result.semantic.tags.length.toLocaleString("de-DE")],
      ["Konzepte", result.semantic.concepts.length.toLocaleString("de-DE")],
      ["Textfunde", result.semantic.visibleText.length.toLocaleString("de-DE")],
      ["JSON", result.semantic.repaired ? "repariert" : "direkt"]
    ];

    for (const [label, value] of metricValues) {
      const item = document.createElement("div");
      item.className = "qwen-benchmark-metric";
      const small = document.createElement("small");
      small.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value;
      item.append(small, strong);
      metrics.appendChild(item);
    }

    const summary = document.createElement("p");
    summary.textContent = benchmarkObjectSummary(result);

    const repairedNote = document.createElement("small");
    repairedNote.className = "qwen-benchmark-stage-note";
    repairedNote.textContent = result.semantic.repaired
      ? "Die Modellantwort war formal unvollständig. Vollständig gelieferte Felder wurden automatisch übernommen."
      : "";

    const probeResult = benchmarkSearchProbeResult(result);
    const probeNote = document.createElement("div");
    probeNote.className = "qwen-benchmark-probe-result";
    if (probeResult) {
      const ratio = probeResult.total > 0 ? probeResult.matched / probeResult.total : 0;
      probeNote.classList.add(
        ratio >= 0.99 ? "strong" : ratio >= 0.5 ? "partial" : "weak"
      );
      probeNote.textContent =
        "Suchprobe: " +
        probeResult.matched.toLocaleString("de-DE") +
        "/" +
        probeResult.total.toLocaleString("de-DE") +
        " relevante Begriffe gefunden" +
        (probeResult.details.length > 0
          ? " · " + probeResult.details.join(" · ")
          : "");
    }

    const details = document.createElement("details");
    const detailsSummary = document.createElement("summary");
    detailsSummary.textContent = "Rohdaten anzeigen";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(result, null, 2);
    details.append(detailsSummary, pre);

    card.append(header, metrics, summary);
    if (probeResult) card.appendChild(probeNote);
    if (result.semantic.repaired) card.appendChild(repairedNote);
    card.appendChild(details);
    qwenBenchmarkResults.appendChild(card);
  }

  copyQwenBenchmarkButton.disabled = qwenBenchmarkStages.length === 0;
}

function renderQwenBenchmarkStage(stage: QwenBenchmarkStageResult): void {
  const existingIndex = qwenBenchmarkStages.findIndex(
    (item) => item.profile === stage.profile
  );
  if (existingIndex >= 0) {
    qwenBenchmarkStages[existingIndex] = stage;
  } else {
    qwenBenchmarkStages.push(stage);
  }

  qwenBenchmarkStages.sort(
    (left, right) =>
      benchmarkProfileOrder(left.profile) - benchmarkProfileOrder(right.profile)
  );

  qwenBenchmarkProgressCurrent = null;
  renderQwenBenchmarkResults();
}

function renderQwenBenchmarkProgress(status: AnalysisWorkerStatus): void {
  if (!qwenBenchmarkRunning) return;

  const progress = status.progress;
  const expectedKind =
    qwenBenchmarkModelInRun === "qwen3vl4b"
      ? "qwen3vl4b"
      : qwenBenchmarkModelInRun === "qwen3vl2b"
        ? "qwen3vl2b"
        : "minicpm";
  if (progress?.kind === expectedKind && progress.message) {
    qwenBenchmarkLive.textContent = progress.message;
    qwenBenchmarkProgressCurrent = {
      current: progress.current,
      total: progress.total,
      message: progress.message
    };
    renderQwenBenchmarkResults();
  } else if (status.message) {
    qwenBenchmarkLive.textContent = status.message;
  }
}

function qwenBenchmarkCopyText(): string {
  const probeQuery = qwenBenchmarkSearchProbe.value.trim();
  const lines = [
    benchmarkModelLabel(qwenBenchmarkModelInRun) + " · Einzelbild-Benchmark",
    "Datei: " + (qwenBenchmarkSelectedPath ?? "—"),
    ...(probeQuery ? ["Suchprobe: " + probeQuery] : []),
    ""
  ];

  for (const stage of qwenBenchmarkStages) {
    lines.push(
      stage.label,
      stage.description,
      "Modell: " + stage.model,
      "Gesamt: " + benchmarkDuration(stage.timings.totalMs),
      "Modell bereit: " + benchmarkDuration(stage.timings.modelReadyMs),
      "Bildanalyse: " + benchmarkDuration(stage.timings.discoveryMs),
      "Bildbereiche: " + stage.regionCount.toLocaleString("de-DE"),
      "Beschreibung: " + (stage.semantic.description || "—"),
      "Motive: " + (stage.semantic.subjects.join(", ") || "—"),
      "Handlungen: " + (stage.semantic.actions.join(", ") || "—"),
      "Szene: " + (stage.semantic.scenes.join(", ") || "—"),
      "Sichtbarer Text: " + (stage.semantic.visibleText.join(" | ") || "—"),
      "Suchbegriffe: " + (stage.semantic.tags.join(", ") || "—"),
      "Abgeleitete Konzepte: " + (stage.semantic.concepts.join(", ") || "—"),
      ...(probeQuery && benchmarkSearchProbeResult(stage)
        ? [
            "Suchprobe-Treffer: " +
            benchmarkSearchProbeResult(stage)!.matched.toLocaleString("de-DE") +
            "/" +
            benchmarkSearchProbeResult(stage)!.total.toLocaleString("de-DE")
          ]
        : []),
      ""
    );
  }

  return lines.join("\n").trim();
}

function renderQwenLiveProgress(): void {
  const progress = latestAnalysisStatus?.progress;
  if (!progress || progress.kind !== "qwen3vl") return;

  objectVerificationStageState.className = "stage-state running";
  objectVerificationStageState.textContent = "Läuft";
  objectVerificationStageCounts.textContent =
    progress.message.replace(/^Qwen3-VL:\s*/, "");
}

function renderBackgroundPauseState(state: BackgroundPauseState): void {
  backgroundPauseState = state;
  backgroundPauseButton.disabled = state.changing;
  backgroundPauseButton.classList.toggle("paused", state.paused);
  backgroundPauseButton.setAttribute("aria-pressed", String(state.paused));

  if (state.changing) {
    backgroundPauseIcon.textContent = "…";
    backgroundPauseLabel.textContent = state.paused
      ? "Wird pausiert …"
      : "Wird fortgesetzt …";
    backgroundPauseHint.textContent = state.message;
    return;
  }

  if (state.paused) {
    backgroundPauseIcon.textContent = "▶";
    backgroundPauseLabel.textContent = "Hintergrund fortsetzen";
    backgroundPauseHint.textContent = "Analyse und Scan wieder starten";
    backgroundPauseButton.title = "Hintergrundverarbeitung fortsetzen";
  } else {
    backgroundPauseIcon.textContent = "Ⅱ";
    backgroundPauseLabel.textContent = "Hintergrund pausieren";
    backgroundPauseHint.textContent = "CPU/GPU freigeben";
    backgroundPauseButton.title =
      "Hintergrundverarbeitung pausieren und CPU/GPU freigeben";
  }
}

function renderAnalysisStatus(status: AnalysisWorkerStatus): void {
  latestAnalysisStatus = status;
  analysisWorkerState.className = "analysis-state";

  switch (status.state) {
    case "READY":
      if (status.activeJobs > 0) {
        analysisWorkerState.classList.add("running");
        analysisWorkerState.textContent =
          `Läuft · ${status.activeJobs} ${status.activeJobs === 1 ? "Job" : "Jobs"}`;
      } else {
        analysisWorkerState.classList.add("ready");
        analysisWorkerState.textContent = "Bereit";
      }
      break;
    case "STARTING":
      analysisWorkerState.classList.add("starting");
      analysisWorkerState.textContent = "Startet …";
      break;
    case "ERROR":
      analysisWorkerState.classList.add("error");
      analysisWorkerState.textContent = "Fehler";
      break;
    case "STOPPED":
      analysisWorkerState.classList.add("stopped");
      analysisWorkerState.textContent = "Gestoppt";
      break;
  }

  analysisPython.textContent = status.python ?? "—";
  analysisPriority.textContent =
    status.processPriority === "below-normal" ? "Niedrig" : status.processPriority;
  analysisCpuBudget.textContent = `${status.cpuBudgetPercent} % Ziel`;
  if (document.activeElement !== analysisParallelSelect) {
    analysisParallelSelect.value = String(status.maxConcurrentJobs);
  }
  analysisQueue.textContent = status.queuedJobs.toLocaleString("de-DE");
  analysisActive.textContent = status.activeJobs.toLocaleString("de-DE");
  analysisMessage.textContent = status.message;

  if (status.progress?.kind === "qwen3vl") {
    const progress = status.progress;
    if (
      progress.current !== null &&
      progress.total !== null &&
      progress.total > 0
    ) {
      analysisWorkerState.textContent =
        `Qwen ${progress.current.toLocaleString("de-DE")}/` +
        progress.total.toLocaleString("de-DE");
    } else {
      analysisWorkerState.textContent = "Qwen läuft";
    }
  }

  renderQwenLiveProgress();
}

function stageText(stats: PipelineStatus["technical"]): {
  text: string;
  className: string;
} {
  if (stats.running > 0) return { text: "Läuft", className: "running" };
  if (stats.pending > 0) return { text: "Wartet", className: "waiting" };
  if (stats.failed > 0) return { text: "Mit Fehlern", className: "error" };
  if (stats.unavailable > 0) {
    return { text: "Dateien fehlen", className: "unavailable" };
  }
  if (stats.done > 0) return { text: "Fertig", className: "done" };
  return { text: "Bereit", className: "waiting" };
}

function renderStage(
  stateElement: HTMLSpanElement,
  countsElement: HTMLElement,
  stats: PipelineStatus["technical"]
): void {
  const state = stageText(stats);
  stateElement.className = `stage-state ${state.className}`;
  stateElement.textContent = state.text;
  countsElement.textContent =
    `${stats.done.toLocaleString("de-DE")} fertig · ` +
    `${stats.running.toLocaleString("de-DE")} läuft · ` +
    `${stats.pending.toLocaleString("de-DE")} offen · ` +
    `${stats.failed.toLocaleString("de-DE")} Fehler · ` +
    `${stats.unavailable.toLocaleString("de-DE")} fehlen`;
}

async function refreshSelectedPipelineStatus(): Promise<void> {
  // Die Stufenanzeige ist global und entspricht damit der ebenfalls globalen
  // Worker-Statuszeile. Ein aktuell laufender SigLIP/Qwen-Job kann so nicht
  // hinter einer bereits fertigen ausgewählten Quelle verschwinden.
  const status = await window.imageSorter.analysis.getPipelineStatus();
  renderPipelineStatus(status);
}

function scheduleSelectedPipelineRefresh(): void {
  if (rendererShuttingDown) return;
  if (sourcePipelineRefreshTimer !== null) {
    window.clearTimeout(sourcePipelineRefreshTimer);
  }

  sourcePipelineRefreshTimer = window.setTimeout(() => {
    sourcePipelineRefreshTimer = null;
    void refreshSelectedPipelineStatus().catch(() => {
      // Die Katalogansicht bleibt auch bei einem kurzzeitigen Statusfehler bedienbar.
    });
  }, 250);
}

function renderLivePipelineActivity(status: PipelineStatus): void {
  const stages: Array<[string, number]> = [
    ["Technik", status.technical.running],
    ["Thumbnails", status.thumbnails.running],
    ["Metadaten", status.imageMetadata.running],
    ["Gesichter", status.faces.running],
    ["Gesichtsmerkmale", status.faceEmbeddings.running],
    ["Haustiererkennung", status.petDetection.running],
    ["Haustierfusion", status.petFusion.running],
    ["Dog-ReID", status.petEmbeddings.running],
    ["SigLIP", status.semanticEmbeddings.running],
    ["Qwen", status.objectVerification.running],
    ["Videoanalyse", status.videoAnalysis.running]
  ];

  const active = stages.filter(([, count]) => count > 0);
  const total = active.reduce((sum, [, count]) => sum + count, 0);

  analysisLiveActivity.classList.toggle("running", total > 0);
  analysisLiveActivityText.textContent =
    total > 0
      ? active
          .map(([label, count]) => `${count}× ${label}`)
          .join(" · ")
      : "Keine laufenden Pipeline-Jobs.";
}

function renderPipelineStatus(status: PipelineStatus): void {
  renderLivePipelineActivity(status);
  renderStage(technicalStageState, technicalStageCounts, status.technical);
  renderStage(thumbnailStageState, thumbnailStageCounts, status.thumbnails);
  renderStage(metadataStageState, metadataStageCounts, status.imageMetadata);
  renderStage(faceStageState, faceStageCounts, status.faces);
  renderStage(
    faceEmbeddingStageState,
    faceEmbeddingStageCounts,
    status.faceEmbeddings
  );
  renderStage(petStageState, petStageCounts, status.petDetection);
  renderStage(petFusionStageState, petFusionStageCounts, status.petFusion);
  renderStage(
    petEmbeddingStageState,
    petEmbeddingStageCounts,
    status.petEmbeddings
  );
  renderStage(
    objectVerificationStageState,
    objectVerificationStageCounts,
    status.objectVerification
  );
  renderStage(
    semanticStageState,
    semanticStageCounts,
    status.semanticEmbeddings
  );
  renderStage(
    videoAnalysisStageState,
    videoAnalysisStageCounts,
    status.videoAnalysis
  );

  // Ein Pipeline-Refresh darf den feineren Live-Status einer laufenden
  // Qwen-Anfrage nicht mit den groben Job-Zählern überschreiben.
  renderQwenLiveProgress();

  const visualDataChanged =
    status.thumbnails.done !== lastThumbnailDone ||
    status.imageMetadata.done !== lastMetadataDone ||
    status.faces.done !== lastFaceDone ||
    status.faceEmbeddings.done !== lastFaceEmbeddingDone ||
    status.petDetection.done !== lastPetDone ||
    status.petFusion.done !== lastPetFusionDone ||
    status.petEmbeddings.done !== lastPetEmbeddingDone ||
    status.objectVerification.done !== lastObjectVerificationDone ||
    status.semanticEmbeddings.done !== lastSemanticDone ||
    status.videoAnalysis.done !== lastVideoAnalysisDone;

  lastThumbnailDone = status.thumbnails.done;
  lastMetadataDone = status.imageMetadata.done;
  lastFaceDone = status.faces.done;
  lastFaceEmbeddingDone = status.faceEmbeddings.done;
  lastPetDone = status.petDetection.done;
  lastPetFusionDone = status.petFusion.done;
  lastPetEmbeddingDone = status.petEmbeddings.done;
  lastObjectVerificationDone = status.objectVerification.done;
  lastSemanticDone = status.semanticEmbeddings.done;
  lastVideoAnalysisDone = status.videoAnalysis.done;

  const stages = [
    status.technical,
    status.thumbnails,
    status.imageMetadata,
    status.faces,
    status.faceEmbeddings,
    status.petDetection,
    status.petFusion,
    status.petEmbeddings,
    status.objectVerification,
    status.semanticEmbeddings,
    status.videoAnalysis
  ];

  const totalIssues = stages.reduce(
    (sum, stats) => sum + stats.failed + stats.unavailable,
    0
  );

  if (totalIssues !== lastPipelineIssueTotal) {
    lastPipelineIssueTotal = totalIssues;
    void refreshAnalysisErrorCount();
  }

  if (!visualDataChanged) return;

  if (analysisRefreshTimer !== null) {
    window.clearTimeout(analysisRefreshTimer);
  }

  analysisRefreshTimer = window.setTimeout(() => {
    analysisRefreshTimer = null;

    // Die Medienliste darf während laufender Analyse automatisch aktualisiert
    // werden. Die Personenansicht enthält jedoch Eingabefelder; ein komplettes
    // Re-Rendern würde dort den Fokus/Cursor beim Tippen zerstören.
    if (
      !imagePreviewDialog.open &&
      (currentView === "media" || currentView === "search") &&
      selectedSourceId() !== null
    ) {
      void runSafely(refreshCatalog);
    }
  }, 500);
}

function thumbnailUrl(row: MediaRecord): string | null {
  if (!row.thumbnailReady || !row.thumbnailVersion) return null;
  return `image-sorter-thumb://media/${row.id}?v=${encodeURIComponent(row.thumbnailVersion)}`;
}

const IDENTITY_IMAGE_CACHE_VERSION = "2026-11-04-v2";

function faceCropUrl(faceDetectionId: number): string {
  return `image-sorter-face://face/${faceDetectionId}?v=${IDENTITY_IMAGE_CACHE_VERSION}`;
}

function petCropUrl(petDetectionId: number): string {
  return `image-sorter-pet://pet/${petDetectionId}?v=${IDENTITY_IMAGE_CACHE_VERSION}`;
}

type IdentityNameOption = {
  id: number;
  name: string;
  count: number;
  previewUrl: string | null;
};

type IdentitySimilarityOption = {
  id: number;
  name: string;
  similarity: number;
  previewUrl: string | null;
};

function normalizedIdentityName(value: string): string {
  return value.trim().toLocaleLowerCase("de-DE");
}

function createIdentityNameField(
  input: HTMLInputElement,
  options: IdentityNameOption[]
): HTMLDivElement {
  const field = document.createElement("div");
  field.className = "identity-name-field";

  const menu = document.createElement("div");
  menu.className = "identity-name-menu";
  menu.hidden = true;

  const render = () => {
    const query = normalizedIdentityName(input.value);
    menu.replaceChildren();

    if (!query) {
      menu.hidden = true;
      return;
    }

    const matches = options
      .map((option) => ({
        option,
        normalized: normalizedIdentityName(option.name)
      }))
      .filter(({ normalized }) => normalized.includes(query))
      .sort((left, right) => {
        const leftPrefix = left.normalized.startsWith(query) ? 0 : 1;
        const rightPrefix = right.normalized.startsWith(query) ? 0 : 1;
        if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
        return left.option.name.localeCompare(right.option.name, "de");
      })
      .slice(0, 8);

    if (matches.length === 0) {
      menu.hidden = true;
      return;
    }

    for (const { option } of matches) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "identity-name-option";

      if (option.previewUrl) {
        const img = document.createElement("img");
        img.src = option.previewUrl;
        img.alt = "";
        img.loading = "lazy";
        choice.appendChild(img);
      }

      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = option.name;
      const small = document.createElement("small");
      small.textContent =
        option.count.toLocaleString("de-DE") +
        (option.count === 1 ? " bestätigter Treffer" : " bestätigte Treffer");
      text.append(strong, small);
      choice.appendChild(text);

      choice.addEventListener("mousedown", (event) => {
        // Verhindert, dass blur das Menü vor dem Klick schließt.
        event.preventDefault();
      });
      choice.addEventListener("click", () => {
        input.value = option.name;
        menu.hidden = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });

      menu.appendChild(choice);
    }

    menu.hidden = false;
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      menu.hidden = true;
    }, 120);
  });

  field.append(input, menu);
  return field;
}

function createIdentitySimilarityList(
  title: string,
  options: IdentitySimilarityOption[],
  input: HTMLInputElement,
  onDirectAssign?: (option: IdentitySimilarityOption) => void
): HTMLDivElement | null {
  if (options.length === 0) return null;

  const block = document.createElement("div");
  block.className = "identity-similarity-block";

  const label = document.createElement("small");
  label.className = "identity-similarity-label";
  label.textContent = title;

  const list = document.createElement("div");
  list.className = "identity-similarity-list";

  for (const option of options) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "identity-similarity-option";
    choice.title =
      option.name + " auswählen · Ähnlichkeit " + option.similarity.toFixed(3);

    if (option.previewUrl) {
      const img = document.createElement("img");
      img.src = option.previewUrl;
      img.alt = "";
      img.loading = "lazy";
      choice.appendChild(img);
    }

    const text = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = option.name;
    const small = document.createElement("small");
    small.textContent = "Ähnlichkeit " + option.similarity.toFixed(3);
    text.append(strong, small);
    choice.appendChild(text);

    choice.addEventListener("click", () => {
      input.value = option.name;
      input.dispatchEvent(new Event("input", { bubbles: true }));

      if (onDirectAssign) {
        onDirectAssign(option);
        return;
      }

      input.focus();
    });

    list.appendChild(choice);
  }

  block.append(label, list);
  return block;
}

function fullPreviewUrl(mediaId: number): string {
  return `image-sorter-preview://media/${mediaId}?v=${IDENTITY_IMAGE_CACHE_VERSION}`;
}

function fullMediaUrl(mediaId: number): string {
  return `image-sorter-media://media/${mediaId}`;
}

function videoSceneImageUrl(
  mediaId: number,
  frame: { timestampMs: number; frameIndex: number | null; frameHash: string | null },
  width = 320
): string {
  const params = new URLSearchParams({
    ms: String(frame.timestampMs),
    width: String(width)
  });
  if (frame.frameIndex !== null && frame.frameHash) {
    params.set("i", String(frame.frameIndex));
    params.set("h", frame.frameHash);
  }
  return `image-sorter-frame://media/${mediaId}?${params.toString()}`;
}

function isVideoExtension(extension: string): boolean {
  return LIBRARY_VIDEO_EXTENSIONS.has(extension.toLowerCase());
}



function renderCandidateReviewBox(): void {
  const state = candidateReviewState;
  const item = state?.items[state.index];
  if (!item || !candidateReviewImage.naturalWidth || !candidateReviewImage.naturalHeight) {
    candidateReviewBox.hidden = true;
    return;
  }

  const imageWidth = candidateReviewImage.naturalWidth;
  const imageHeight = candidateReviewImage.naturalHeight;
  const left = Math.max(0, Math.min(100, (item.x / imageWidth) * 100));
  const top = Math.max(0, Math.min(100, (item.y / imageHeight) * 100));
  const width = Math.max(0, Math.min(100 - left, (item.width / imageWidth) * 100));
  const height = Math.max(0, Math.min(100 - top, (item.height / imageHeight) * 100));

  candidateReviewBox.hidden = !(width > 0 && height > 0);
  candidateReviewBox.style.left = left + "%";
  candidateReviewBox.style.top = top + "%";
  candidateReviewBox.style.width = width + "%";
  candidateReviewBox.style.height = height + "%";
}

function renderCandidateReview(): void {
  const state = candidateReviewState;
  if (!state || state.items.length === 0) {
    candidateReviewDialog.close();
    candidateReviewState = null;
    return;
  }

  state.index = Math.max(0, Math.min(state.index, state.items.length - 1));
  const item = state.items[state.index];
  const kindLabel = state.kind === "person" ? "Personengruppe" : "Hundegruppe";

  candidateReviewTitle.textContent = kindLabel + " einzeln prüfen";
  candidateReviewMeta.textContent =
    state.items.length.toLocaleString("de-DE") +
    (state.items.length === 1 ? " verbleibende Fundstelle" : " verbleibende Fundstellen");
  candidateReviewPosition.textContent =
    (state.index + 1).toLocaleString("de-DE") +
    " / " +
    state.items.length.toLocaleString("de-DE");
  candidateReviewPath.textContent = item.relativePath;
  candidateReviewPrev.disabled = state.index === 0;
  candidateReviewNext.disabled = state.index >= state.items.length - 1;

  candidateReviewBox.hidden = true;
  candidateReviewImage.src = fullPreviewUrl(item.mediaId);
  candidateReviewImage.alt = item.relativePath;

  candidateReviewSuggestions.replaceChildren();
  if (item.suggestions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "candidate-review-empty";
    empty.textContent = "Keine ausreichend ähnliche bestätigte Identität gefunden.";
    candidateReviewSuggestions.appendChild(empty);
  } else {
    for (const suggestion of item.suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "candidate-review-suggestion";

      if (suggestion.previewUrl) {
        const img = document.createElement("img");
        img.src = suggestion.previewUrl;
        img.alt = "";
        img.loading = "lazy";
        button.appendChild(img);
      }

      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = suggestion.name;
      const similarity = document.createElement("small");
      similarity.textContent = "Ähnlichkeit " + suggestion.similarity.toFixed(3);
      text.append(name, similarity);
      button.appendChild(text);

      button.addEventListener("click", () => {
        candidateReviewName.value = suggestion.name;

        if (state.kind === "pet") {
          // Bei Hunden ist ein Klick auf einen Ähnlichkeitsvorschlag bereits
          // die eindeutige Einzelbild-Entscheidung: sofort zuweisen. Der
          // bestehende Zuweisungsablauf entfernt die Fundstelle anschließend
          // aus der Review-Liste und zeigt direkt die nächste an.
          candidateReviewAssign.click();
          return;
        }

        candidateReviewName.focus();
      });
      candidateReviewSuggestions.appendChild(button);
    }
  }

  candidateReviewNames.replaceChildren();
  for (const knownName of [...new Set(state.knownNames)].sort((a, b) =>
    a.localeCompare(b, "de", { sensitivity: "base" })
  )) {
    const option = document.createElement("option");
    option.value = knownName;
    candidateReviewNames.appendChild(option);
  }

  candidateReviewThumbnails.replaceChildren();
  state.items.forEach((entry, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-review-thumb";
    button.classList.toggle("active", index === state.index);
    button.title = entry.relativePath;

    const img = document.createElement("img");
    img.src = fullPreviewUrl(entry.mediaId);
    img.alt = "";
    img.loading = "lazy";
    button.appendChild(img);

    button.addEventListener("click", () => {
      if (!candidateReviewState) return;
      candidateReviewState.index = index;
      candidateReviewName.value = "";
      renderCandidateReview();
    });
    candidateReviewThumbnails.appendChild(button);
  });

  candidateReviewName.value = "";
  candidateReviewAssign.disabled = false;
}

function openPersonCandidateReview(
  candidate: PersonOverview["candidates"][number],
  overview: PersonOverview
): void {
  candidateReviewState = {
    kind: "person",
    candidateId: candidate.id,
    index: 0,
    knownNames: overview.persons.map((person) => person.name),
    items: candidate.faces.map((face) => ({
      detectionId: face.faceDetectionId,
      mediaId: face.mediaId,
      relativePath: face.relativePath,
      x: face.x,
      y: face.y,
      width: face.width,
      height: face.height,
      suggestions: face.suggestedPersons.map((suggestion) => ({
        name: suggestion.personName,
        similarity: suggestion.similarity,
        previewUrl:
          suggestion.representativeFaceId === null
            ? null
            : faceCropUrl(suggestion.representativeFaceId)
      }))
    }))
  };
  renderCandidateReview();
  candidateReviewDialog.showModal();
}

function openPetCandidateReview(
  candidate: PetOverview["candidates"][number],
  overview: PetOverview
): void {
  candidateReviewState = {
    kind: "pet",
    candidateId: candidate.id,
    index: 0,
    knownNames: overview.pets
      .filter((pet) => pet.petClass === candidate.petClass)
      .map((pet) => pet.name),
    items: candidate.pets.map((pet) => ({
      detectionId: pet.petDetectionId,
      mediaId: pet.mediaId,
      relativePath: pet.relativePath,
      x: pet.x,
      y: pet.y,
      width: pet.width,
      height: pet.height,
      suggestions: pet.suggestedPets.map((suggestion) => ({
        name: suggestion.petName,
        similarity: suggestion.similarity,
        previewUrl:
          suggestion.representativePetId === null
            ? null
            : petCropUrl(suggestion.representativePetId)
      }))
    }))
  };
  renderCandidateReview();
  candidateReviewDialog.showModal();
}

candidateReviewImage.addEventListener("load", renderCandidateReviewBox);

candidateReviewPrev.addEventListener("click", () => {
  if (!candidateReviewState || candidateReviewState.index <= 0) return;
  candidateReviewState.index -= 1;
  renderCandidateReview();
});

candidateReviewNext.addEventListener("click", () => {
  if (
    !candidateReviewState ||
    candidateReviewState.index >= candidateReviewState.items.length - 1
  ) return;
  candidateReviewState.index += 1;
  renderCandidateReview();
});

closeCandidateReviewButton.addEventListener("click", () => {
  candidateReviewDialog.close();
});

candidateReviewAssign.addEventListener("click", () => {
  const state = candidateReviewState;
  const item = state?.items[state.index];
  const name = candidateReviewName.value.trim();
  if (!state || !item) return;
  if (!name) {
    candidateReviewName.focus();
    return;
  }

  void runSafely(async () => {
    candidateReviewAssign.disabled = true;
    progressText.textContent =
      "Fundstelle wird „" + name + "“ zugewiesen …";

    if (state.kind === "person") {
      await window.imageSorter.people.assignCandidateSelection(
        state.candidateId,
        [item.detectionId],
        name
      );
    } else {
      await window.imageSorter.pets.assignCandidateSelection(
        state.candidateId,
        [item.detectionId],
        name
      );
    }

    if (!state.knownNames.some(
      (entry) => normalizedIdentityName(entry) === normalizedIdentityName(name)
    )) {
      state.knownNames.push(name);
    }

    state.items.splice(state.index, 1);
    if (state.index >= state.items.length) {
      state.index = Math.max(0, state.items.length - 1);
    }

    const sourceId = selectedSourceId();
    if (sourceId !== null) {
      if (state.kind === "person") {
        await loadPersonOverview(sourceId);
      } else {
        await loadPetOverview(sourceId);
      }
    }

    progressText.textContent =
      "Fundstelle wurde „" + name + "“ zugewiesen. " +
      state.items.length.toLocaleString("de-DE") +
      (state.items.length === 1
        ? " Fundstelle bleibt in der Gruppe."
        : " Fundstellen bleiben in der Gruppe.");

    if (state.items.length === 0) {
      candidateReviewDialog.close();
      candidateReviewState = null;
      return;
    }

    renderCandidateReview();
  });
});

candidateReviewName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    candidateReviewAssign.click();
  }
});


type IdentityBrowserMediaRef = {
  mediaId: number;
  relativePath: string;
  kind?: "image" | "video";
  startMs?: number;
  endMs?: number;
  hitCount?: number;
  maxSimilarity?: number | null;
};

const IDENTITY_TERM_TRANSLATIONS: Record<string, string> = {
  dog: "Hund",
  dogs: "Hunde",
  cat: "Katze",
  cats: "Katzen",
  bird: "Vogel",
  birds: "Vögel",
  person: "Person",
  people: "Personen",
  animal: "Tier",
  animals: "Tiere",
  outdoor: "Draußen",
  outdoors: "Draußen",
  indoor: "Innen",
  indoors: "Innen",
  vehicle: "Fahrzeug",
  vehicles: "Fahrzeuge",
  tree: "Baum",
  trees: "Bäume",
  grass: "Gras",
  sky: "Himmel",
  water: "Wasser",
  building: "Gebäude",
  street: "Straße",
  road: "Straße",
  forest: "Wald",
  field: "Feld"
};

let identityBrowserDetails: MediaDetails[] = [];
let identityBrowserRefs: IdentityBrowserMediaRef[] = [];
let identityBrowserActiveTerm: string | null = null;
let identityBrowserMinDate = 0;
let identityBrowserMaxDate = 0;

function germanIdentityTerm(value: string): string {
  const cleaned = value.trim().replace(/^[\s,.;:!?()[\]{}"'“”„]+|[\s,.;:!?()[\]{}"'“”„]+$/g, "");
  if (!cleaned) return "";
  const key = cleaned.toLocaleLowerCase("de-DE");
  return MOTIF_LABELS_DE[key] ?? IDENTITY_TERM_TRANSLATIONS[key] ?? cleaned;
}

function identityTermKey(value: string): string {
  return germanIdentityTerm(value).toLocaleLowerCase("de-DE");
}

async function loadIdentityMediaDetails(
  refs: IdentityBrowserMediaRef[],
  token: number
): Promise<MediaDetails[]> {
  const unique = [...new Map(refs.map((ref) => [ref.mediaId, ref])).values()];
  const details: MediaDetails[] = [];
  const batchSize = 10;
  for (let index = 0; index < unique.length; index += batchSize) {
    if (token !== identityBrowserSelectionToken) return [];
    const batch = unique.slice(index, index + batchSize);
    const loaded = await Promise.all(
      batch.map((ref) => window.imageSorter.catalog.getMediaDetails(ref.mediaId))
    );
    details.push(...loaded.filter((item): item is MediaDetails => item !== null));
  }
  return details;
}

function identityCaptureDate(details: MediaDetails): number {
  const capturedAt = details.imageMetadata?.capturedAt;
  if (capturedAt) {
    const value = Date.parse(capturedAt);
    if (Number.isFinite(value)) return value;
  }
  return details.mtimeMs;
}

function identityDateText(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function identityRangeTimestamp(value: number): number {
  if (identityBrowserMaxDate <= identityBrowserMinDate) return identityBrowserMinDate;
  return identityBrowserMinDate +
    (identityBrowserMaxDate - identityBrowserMinDate) * (value / 1000);
}

function mediaHasIdentityTerm(details: MediaDetails, termKey: string): boolean {
  for (const object of details.objects) {
    if (identityTermKey(object.label) === termKey) return true;
  }
  for (const tag of details.videoAnalysis?.tags ?? []) {
    if (identityTermKey(tag.label) === termKey) return true;
  }
  const semantic = details.semantic;
  if (!semantic) return false;
  return [
    ...semantic.tags,
    ...semantic.subjects,
    ...semantic.actions,
    ...semantic.scenes,
    ...semantic.concepts
  ].some((term) => identityTermKey(term) === termKey);
}

function filteredIdentityDetailsByDate(): MediaDetails[] {
  if (identityBrowserDetails.length === 0) return [];
  const from = identityRangeTimestamp(Number(identityDateFrom.value));
  const to = identityRangeTimestamp(Number(identityDateTo.value));
  return identityBrowserDetails.filter((details) => {
    const timestamp = identityCaptureDate(details);
    return timestamp >= from && timestamp <= to;
  });
}

function updateIdentityRangePresentation(): void {
  const fromValue = Number(identityDateFrom.value);
  const toValue = Number(identityDateTo.value);
  const from = identityRangeTimestamp(fromValue);
  const to = identityRangeTimestamp(toValue);
  identityDateFromLabel.textContent = identityDateText(from);
  identityDateToLabel.textContent = identityDateText(to);
  identityDateRangeLabel.textContent =
    identityDateText(from) + " – " + identityDateText(to);
  identityRangeFill.style.left = (fromValue / 10).toFixed(1) + "%";
  identityRangeFill.style.right = (100 - toValue / 10).toFixed(1) + "%";
}

function renderIdentityWordCloud(detailsList: MediaDetails[]): void {
  const scores = new Map<string, { label: string; score: number; media: Set<number> }>();

  const add = (raw: string, score: number, mediaId: number) => {
    const label = germanIdentityTerm(raw);
    const key = identityTermKey(raw);
    if (!label || !key || label.length < 2) return;
    const current = scores.get(key) ?? { label, score: 0, media: new Set<number>() };
    current.score += Math.max(0.5, score);
    current.media.add(mediaId);
    scores.set(key, current);
  };

  for (const details of detailsList) {
    const objectSeen = new Set<string>();
    for (const object of details.objects) {
      const key = identityTermKey(object.label);
      if (!key || objectSeen.has(key)) continue;
      objectSeen.add(key);
      const engineWeight = Math.max(
        1,
        object.agreementCount ?? 0,
        object.sources?.length ?? 0
      );
      add(object.label, engineWeight * Math.max(0.5, object.score), details.mediaId);
    }

    for (const tag of details.videoAnalysis?.tags ?? []) {
      const frequencyWeight = Math.max(1, Math.log2(tag.hitCount + 1));
      add(
        tag.label,
        frequencyWeight * Math.max(0.5, tag.score),
        details.mediaId
      );
    }

    const semantic = details.semantic;
    if (semantic) {
      const semanticSeen = new Set<string>();
      for (const term of [
        ...semantic.tags,
        ...semantic.subjects,
        ...semantic.actions,
        ...semantic.scenes,
        ...semantic.concepts
      ]) {
        const key = identityTermKey(term);
        if (!key || semanticSeen.has(key)) continue;
        semanticSeen.add(key);
        add(term, 1.15, details.mediaId);
      }
    }
  }

  const words = [...scores.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.score - a.score || b.media.size - a.media.size)
    .slice(0, 45);

  identityWordCloud.replaceChildren();
  if (words.length === 0) {
    const empty = document.createElement("div");
    empty.className = "identity-browser-empty";
    empty.textContent = "Für diesen Zeitraum sind keine beschreibenden Begriffe gespeichert.";
    identityWordCloud.appendChild(empty);
    identityCloudHint.textContent = "Keine verwertbaren Erkennungen im gewählten Zeitraum.";
    return;
  }

  const min = Math.min(...words.map((word) => word.score));
  const max = Math.max(...words.map((word) => word.score));
  for (const word of words) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "identity-cloud-word";
    button.classList.toggle("active", identityBrowserActiveTerm === word.key);
    const normalized = max === min ? 0.55 : (word.score - min) / (max - min);
    button.style.fontSize = (0.82 + normalized * 1.55).toFixed(2) + "rem";
    button.style.fontWeight = String(Math.round(520 + normalized * 260));
    button.textContent = word.label;
    button.title =
      "In " + word.media.size.toLocaleString("de-DE") +
      (word.media.size === 1 ? " Medium" : " Medien") +
      " erkannt · klicken zum Filtern";
    button.addEventListener("click", () => {
      identityBrowserActiveTerm =
        identityBrowserActiveTerm === word.key ? null : word.key;
      applyIdentityBrowserFilters();
    });
    identityWordCloud.appendChild(button);
  }

  identityCloudHint.textContent = identityBrowserActiveTerm
    ? "Wortfilter aktiv · erneut auf das markierte Wort klicken, um ihn aufzuheben."
    : "Wort anklicken, um die Bilder zu filtern. Mehrfacherkennungen werden zusammengeführt und stärker gewichtet.";
}

function videoTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? hours.toString().padStart(2, "0") + ":" +
      minutes.toString().padStart(2, "0") + ":" +
      seconds.toString().padStart(2, "0")
    : minutes.toString().padStart(2, "0") + ":" +
      seconds.toString().padStart(2, "0");
}

function renderIdentityTimeline(detailsList: MediaDetails[]): void {
  const mediaIds = new Set(detailsList.map((details) => details.mediaId));
  const entries: Array<{
    details: MediaDetails;
    ref: IdentityBrowserMediaRef | null;
  }> = [];

  for (const details of detailsList) {
    const videoRefs = identityBrowserRefs.filter(
      (ref) =>
        ref.mediaId === details.mediaId &&
        ref.kind === "video"
    );

    if (details.videoAnalysis && videoRefs.length > 0) {
      for (const ref of videoRefs) entries.push({ details, ref });
    } else {
      entries.push({ details, ref: null });
    }
  }

  entries.sort(
    (a, b) =>
      identityCaptureDate(a.details) - identityCaptureDate(b.details) ||
      (a.ref?.startMs ?? 0) - (b.ref?.startMs ?? 0)
  );

  identityTimeline.replaceChildren();
  identityTimelineCount.textContent =
    entries.length.toLocaleString("de-DE") +
    (entries.length === 1 ? " Treffer" : " Treffer");

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "identity-browser-empty";
    empty.textContent = "Für die gewählten Filter gibt es keine Aufnahmen.";
    identityTimeline.appendChild(empty);
    return;
  }

  for (const { details, ref } of entries) {
    if (!mediaIds.has(details.mediaId)) continue;

    const card = document.createElement("article");
    card.className = "identity-timeline-card";

    if (details.videoAnalysis && ref?.kind === "video") {
      card.classList.add("identity-video-card");
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "identity-video-preview";
      preview.innerHTML = "<span>▶</span><strong>Video</strong>";
      preview.title =
        "Video öffnen · Treffer " +
        videoTimestamp(ref.startMs ?? 0) +
        "–" +
        videoTimestamp(ref.endMs ?? ref.startMs ?? 0);
      preview.addEventListener("click", () => {
        void runSafely(async () => {
          await window.imageSorter.analysis.openFile(details.mediaId);
          progressText.textContent =
            "Video geöffnet · relevanter Abschnitt " +
            videoTimestamp(ref.startMs ?? 0) +
            "–" +
            videoTimestamp(ref.endMs ?? ref.startMs ?? 0) +
            ".";
        });
      });
      card.appendChild(preview);
    } else {
      const image = document.createElement("img");
      image.src = fullPreviewUrl(details.mediaId);
      image.alt = details.relativePath;
      image.loading = "lazy";
      makePreviewable(image, details.mediaId, details.relativePath);
      card.appendChild(image);
    }

    const info = document.createElement("div");
    const date = document.createElement("strong");
    const captured = details.imageMetadata?.capturedAt;
    date.textContent = captured
      ? new Date(captured).toLocaleString("de-DE")
      : new Date(details.mtimeMs).toLocaleString("de-DE");

    if (details.videoAnalysis && ref?.kind === "video") {
      const segment = document.createElement("span");
      segment.className = "identity-video-segment";
      segment.textContent =
        videoTimestamp(ref.startMs ?? 0) +
        "–" +
        videoTimestamp(ref.endMs ?? ref.startMs ?? 0) +
        " · " +
        (ref.hitCount ?? 1).toLocaleString("de-DE") +
        ((ref.hitCount ?? 1) === 1 ? " Treffer" : " Treffer");
      info.append(date, segment);
    } else {
      info.appendChild(date);
    }

    const path = document.createElement("small");
    path.textContent = details.relativePath;
    info.appendChild(path);
    card.appendChild(info);
    identityTimeline.appendChild(card);
  }
}

function applyIdentityBrowserFilters(): void {
  updateIdentityRangePresentation();
  const dateFiltered = filteredIdentityDetailsByDate();
  renderIdentityWordCloud(dateFiltered);
  const finalDetails = identityBrowserActiveTerm
    ? dateFiltered.filter((details) =>
        mediaHasIdentityTerm(details, identityBrowserActiveTerm!)
      )
    : dateFiltered;
  renderIdentityTimeline(finalDetails);
}

function configureIdentityDateRange(detailsList: MediaDetails[]): void {
  const timestamps = detailsList.map(identityCaptureDate).filter(Number.isFinite);
  identityBrowserMinDate = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  identityBrowserMaxDate = timestamps.length > 0 ? Math.max(...timestamps) : identityBrowserMinDate;
  identityDateFrom.value = "0";
  identityDateTo.value = "1000";
  updateIdentityRangePresentation();
}

function identityRefsForMediaFilter(
  refs: IdentityBrowserMediaRef[]
): IdentityBrowserMediaRef[] {
  if (identityBrowserMediaFilter === "all") return refs;
  return refs.filter((ref) => (ref.kind ?? "image") === identityBrowserMediaFilter);
}

function identityMediaCounts(refs: IdentityBrowserMediaRef[]): {
  images: number;
  videos: number;
} {
  return {
    images: new Set(
      refs
        .filter((ref) => (ref.kind ?? "image") === "image")
        .map((ref) => ref.mediaId)
    ).size,
    videos: new Set(
      refs
        .filter((ref) => ref.kind === "video")
        .map((ref) => ref.mediaId)
    ).size
  };
}

function identityPassesMediaFilter(refs: IdentityBrowserMediaRef[]): boolean {
  if (identityBrowserMediaFilter === "all") return refs.length > 0;
  return refs.some(
    (ref) => (ref.kind ?? "image") === identityBrowserMediaFilter
  );
}

function renderIdentityMediaFilterState(): void {
  identityBrowserAllMedia.classList.toggle(
    "active",
    identityBrowserMediaFilter === "all"
  );
  identityBrowserImagesOnly.classList.toggle(
    "active",
    identityBrowserMediaFilter === "image"
  );
  identityBrowserVideosOnly.classList.toggle(
    "active",
    identityBrowserMediaFilter === "video"
  );
}

async function selectIdentityBrowserEntry(
  kind: "Personen" | "Tiere",
  name: string,
  refs: IdentityBrowserMediaRef[]
): Promise<void> {
  const token = ++identityBrowserSelectionToken;
  identityBrowserPlaceholder.hidden = true;
  identityBrowserDetail.hidden = false;
  identityBrowserKind.textContent = kind;
  identityBrowserName.textContent = name;
  const counts = identityMediaCounts(refs);
  const uniqueMediaCount = new Set(refs.map((ref) => ref.mediaId)).size;
  identityBrowserMeta.textContent =
    uniqueMediaCount.toLocaleString("de-DE") +
    (uniqueMediaCount === 1 ? " zugeordnetes Medium" : " zugeordnete Medien") +
    " · " +
    counts.images.toLocaleString("de-DE") +
    (counts.images === 1 ? " Bild" : " Bilder") +
    " · " +
    counts.videos.toLocaleString("de-DE") +
    (counts.videos === 1 ? " Video" : " Videos");
  identityWordCloud.replaceChildren();
  identityTimeline.replaceChildren();
  identityCloudHint.textContent = "Erkennungen werden zusammengeführt …";
  identityTimelineCount.textContent = "Bilder werden geladen …";
  identityBrowserActiveTerm = null;
  identityBrowserDetails = [];
  identityBrowserRefs = [...refs];

  const details = await loadIdentityMediaDetails(refs, token);
  if (token !== identityBrowserSelectionToken) return;
  identityBrowserDetails = details;
  configureIdentityDateRange(details);
  applyIdentityBrowserFilters();
}

async function loadIdentityBrowser(): Promise<void> {
  const sourceId = selectedSourceId() ?? 0;
  identityBrowserPeopleTab.classList.toggle("active", identityBrowserMode === "people");
  identityBrowserPetsTab.classList.toggle("active", identityBrowserMode === "pets");
  renderIdentityMediaFilterState();

  identityBrowserListTitle.textContent =
    identityBrowserMode === "people" ? "Bestätigte Personen" : "Bestätigte Tiere";
  showBlockLoading(identityBrowserList, "Identitäten werden geladen …");
  identityBrowserPlaceholder.hidden = true;
  identityBrowserDetail.hidden = true;
  identityBrowserSelectionToken++;
  identityBrowserDetails = [];
  identityBrowserRefs = [];
  identityBrowserActiveTerm = null;

  if (identityBrowserMode === "people") {
    const overview = await window.imageSorter.people.getOverview(sourceId, false);
    const entries = overview.persons.map((person) => {
      const refs: IdentityBrowserMediaRef[] = [
        ...person.faces.map((face) => ({
          mediaId: face.mediaId,
          relativePath: face.relativePath,
          kind: "image" as const
        })),
        ...person.videoHits.map((hit) => ({
          mediaId: hit.mediaId,
          relativePath: hit.relativePath,
          kind: "video" as const,
          startMs: hit.startMs,
          endMs: hit.endMs,
          hitCount: hit.hitCount,
          maxSimilarity: hit.maxSimilarity
        }))
      ];
      return { person, refs };
    }).filter(({ refs }) => identityPassesMediaFilter(refs));

    identityBrowserCount.textContent =
      entries.length.toLocaleString("de-DE") +
      " / " +
      overview.persons.length.toLocaleString("de-DE");

    if (entries.length === 0) {
      identityBrowserList.innerHTML =
        '<div class="identity-browser-empty">Für diesen Medientyp gibt es keine bestätigten Personen.</div>';
      return;
    }

    for (const { person, refs } of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "identity-browser-entry";

      if (person.representativeFaceId !== null) {
        const image = document.createElement("img");
        image.src = faceCropUrl(person.representativeFaceId);
        image.alt = "";
        image.loading = "lazy";
        button.appendChild(image);
      }

      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = person.name;
      const count = document.createElement("small");
      const counts = identityMediaCounts(refs);
      count.textContent =
        counts.images.toLocaleString("de-DE") +
        (counts.images === 1 ? " Bild" : " Bilder") +
        " · " +
        counts.videos.toLocaleString("de-DE") +
        (counts.videos === 1 ? " Video" : " Videos");
      text.append(title, count);
      button.appendChild(text);

      button.addEventListener("click", () => {
        identityBrowserList
          .querySelectorAll(".identity-browser-entry")
          .forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        void selectIdentityBrowserEntry(
          "Personen",
          person.name,
          identityRefsForMediaFilter(refs)
        );
      });

      identityBrowserList.appendChild(button);
    }
    return;
  }

  const overview = await window.imageSorter.pets.getOverview(sourceId, false);
  const entries = overview.pets.map((pet) => {
    const refs: IdentityBrowserMediaRef[] = [
      ...pet.pets.map((item) => ({
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        kind: "image" as const
      })),
      ...pet.videoHits.map((hit) => ({
        mediaId: hit.mediaId,
        relativePath: hit.relativePath,
        kind: "video" as const,
        startMs: hit.startMs,
        endMs: hit.endMs,
        hitCount: hit.hitCount,
        maxSimilarity: hit.maxSimilarity
      }))
    ];
    return { pet, refs };
  }).filter(({ refs }) => identityPassesMediaFilter(refs));

  identityBrowserCount.textContent =
    entries.length.toLocaleString("de-DE") +
    " / " +
    overview.pets.length.toLocaleString("de-DE");

  if (entries.length === 0) {
    identityBrowserList.innerHTML =
      '<div class="identity-browser-empty">Für diesen Medientyp gibt es keine bestätigten Tiere.</div>';
    return;
  }

  for (const { pet, refs } of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "identity-browser-entry";

    if (pet.representativePetId !== null) {
      const image = document.createElement("img");
      image.src = petCropUrl(pet.representativePetId);
      image.alt = "";
      image.loading = "lazy";
      button.appendChild(image);
    }

    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = pet.name;
    const count = document.createElement("small");
    const counts = identityMediaCounts(refs);
    count.textContent =
      (pet.petClass === "cat" ? "Katze" : "Hund") +
      " · " +
      counts.images.toLocaleString("de-DE") +
      (counts.images === 1 ? " Bild" : " Bilder") +
      " · " +
      counts.videos.toLocaleString("de-DE") +
      (counts.videos === 1 ? " Video" : " Videos");
    text.append(title, count);
    button.appendChild(text);

    button.addEventListener("click", () => {
      identityBrowserList
        .querySelectorAll(".identity-browser-entry")
        .forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      void selectIdentityBrowserEntry(
        "Tiere",
        pet.name,
        identityRefsForMediaFilter(refs)
      );
    });

    identityBrowserList.appendChild(button);
  }
}

identityBrowserPeopleTab.addEventListener("click", () => {
  if (identityBrowserMode === "people") return;
  identityBrowserMode = "people";
  void runSafely(loadIdentityBrowser);
});

identityBrowserPetsTab.addEventListener("click", () => {
  if (identityBrowserMode === "pets") return;
  identityBrowserMode = "pets";
  void runSafely(loadIdentityBrowser);
});

function setIdentityBrowserMediaFilter(
  filter: "all" | "image" | "video"
): void {
  if (identityBrowserMediaFilter === filter) return;
  identityBrowserMediaFilter = filter;
  void runSafely(loadIdentityBrowser);
}

identityBrowserAllMedia.addEventListener("click", () => {
  setIdentityBrowserMediaFilter("all");
});

identityBrowserImagesOnly.addEventListener("click", () => {
  setIdentityBrowserMediaFilter("image");
});

identityBrowserVideosOnly.addEventListener("click", () => {
  setIdentityBrowserMediaFilter("video");
});

identityDateFrom.addEventListener("input", () => {
  if (Number(identityDateFrom.value) > Number(identityDateTo.value)) {
    identityDateFrom.value = identityDateTo.value;
  }
  identityBrowserActiveTerm = null;
  applyIdentityBrowserFilters();
});

identityDateTo.addEventListener("input", () => {
  if (Number(identityDateTo.value) < Number(identityDateFrom.value)) {
    identityDateTo.value = identityDateFrom.value;
  }
  identityBrowserActiveTerm = null;
  applyIdentityBrowserFilters();
});


function detailText(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function detailPercent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : Math.round(value * 100).toLocaleString("de-DE") + " %";
}

function detailTimestamp(value: string | null): string {
  return value ? value.replace("T", " ") : "—";
}

function appendDetailSection(
  title: string,
  content: HTMLElement
): void {
  const section = document.createElement("section");
  section.className = "image-detail-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("div");
  body.className = "image-detail-section-body";
  body.appendChild(content);
  section.append(heading, body);
  imagePreviewDetails.appendChild(section);
}

function detailGrid(rows: Array<[string, unknown]>): HTMLDListElement {
  const dl = document.createElement("dl");
  dl.className = "image-detail-grid";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = detailText(value);
    dl.append(dt, dd);
  }
  return dl;
}

function detailChips(values: string[]): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "image-detail-chips";
  if (values.length === 0) {
    const empty = document.createElement("span");
    empty.className = "image-preview-detail-empty";
    empty.textContent = "—";
    wrapper.appendChild(empty);
    return wrapper;
  }
  for (const value of values) {
    const chip = document.createElement("span");
    chip.className = "image-detail-chip";
    chip.textContent = value;
    wrapper.appendChild(chip);
  }
  return wrapper;
}


function fillPreviewIdentityNames(
  persons: Array<{ name: string }>,
  pets: Array<{ name: string }>
): void {
  imagePreviewPersonNames.replaceChildren();
  for (const name of [...new Set(persons.map((item) => item.name))].sort((a, b) =>
    a.localeCompare(b, "de", { sensitivity: "base" })
  )) {
    const option = document.createElement("option");
    option.value = name;
    imagePreviewPersonNames.appendChild(option);
  }

  imagePreviewPetNames.replaceChildren();
  for (const name of [...new Set(pets.map((item) => item.name))].sort((a, b) =>
    a.localeCompare(b, "de", { sensitivity: "base" })
  )) {
    const option = document.createElement("option");
    option.value = name;
    imagePreviewPetNames.appendChild(option);
  }
}

function previewDetectionPercent(
  value: number,
  total: number
): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

type PreviewOverlayIdentity = {
  kind: "person" | "pet";
  id: number;
  name: string | null;
  suggestionName: string | null;
  confirmed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  petClass?: "dog" | "cat" | null;
  onAssign: (name: string) => Promise<void>;
};

function renderPreviewIdentityOverlay(
  identities: PreviewOverlayIdentity[],
  naturalWidth: number,
  naturalHeight: number
): void {
  imagePreviewOverlay.replaceChildren();
  if (!naturalWidth || !naturalHeight) return;

  for (const identity of identities) {
    const box = document.createElement("div");
    box.className =
      "image-preview-detection " +
      identity.kind +
      (identity.confirmed ? " confirmed" : " unconfirmed");
    box.tabIndex = 0;
    box.setAttribute("role", "button");
    box.setAttribute("aria-label", "Erkennung bearbeiten");

    const left = previewDetectionPercent(identity.x, naturalWidth);
    const top = previewDetectionPercent(identity.y, naturalHeight);
    const width = Math.min(
      100 - left,
      Math.max(1, previewDetectionPercent(identity.width, naturalWidth))
    );
    const height = Math.min(
      100 - top,
      Math.max(1, previewDetectionPercent(identity.height, naturalHeight))
    );

    box.style.left = left + "%";
    box.style.top = top + "%";
    box.style.width = width + "%";
    box.style.height = height + "%";

    const kindLabel =
      identity.kind === "person"
        ? "Person"
        : identity.petClass === "cat"
          ? "Katze"
          : "Hund";
    const displayName =
      identity.name ??
      identity.suggestionName ??
      kindLabel;

    const badge = document.createElement("span");
    badge.className = "image-preview-detection-badge";
    badge.textContent = identity.confirmed
      ? displayName + " · bestätigt"
      : identity.name || identity.suggestionName
        ? "Vorschlag: " + displayName + " · unbestätigt"
        : kindLabel + " · unbestätigt";

    const editor = document.createElement("form");
    editor.className = "image-preview-detection-editor";
    editor.hidden = true;
    editor.addEventListener("click", (event) => event.stopPropagation());

    const kind = document.createElement("span");
    kind.className = "image-preview-detection-kind";
    kind.textContent = kindLabel;

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 120;
    input.autocomplete = "off";
    const initialName = identity.name ?? identity.suggestionName ?? "";
    input.value = initialName;
    input.placeholder = initialName || "Name …";
    input.setAttribute(
      "list",
      identity.kind === "person"
        ? "imagePreviewPersonNames"
        : "imagePreviewPetNames"
    );
    input.setAttribute(
      "aria-label",
      identity.kind === "person" ? "Personenname" : "Haustiername"
    );

    // Der Vorschlag bleibt zunächst im Feld, sodass ein Klick auf ✓ ihn direkt
    // bestätigt. Wer in das Feld klickt, bekommt dagegen sofort ein leeres
    // Eingabefeld und kann einen anderen Namen eingeben/auswählen.
    let inputEdited = false;
    input.addEventListener("focus", () => {
      if (!inputEdited && initialName && input.value === initialName) {
        input.value = "";
        inputEdited = true;
      }
    });
    input.addEventListener("input", () => {
      inputEdited = true;
    });

    const save = document.createElement("button");
    save.type = "submit";
    save.className = "image-preview-detection-save";
    save.textContent = "✓";
    save.title = identity.confirmed
      ? "Zuordnung ändern oder erneut bestätigen"
      : "Vorschlag bestätigen";

    const state = document.createElement("span");
    state.className = "image-preview-detection-state";
    state.textContent = identity.confirmed ? "bestätigt" : "unbestätigt";

    editor.append(kind, input, save, state);
    box.append(badge, editor);

    const toggleEditor = () => {
      for (const other of imagePreviewOverlay.querySelectorAll<HTMLElement>(
        ".image-preview-detection-editor"
      )) {
        if (other !== editor) other.hidden = true;
      }
      editor.hidden = !editor.hidden;
    };

    box.addEventListener("click", (event) => {
      if (event.target === editor || editor.contains(event.target as Node)) return;
      toggleEditor();
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleEditor();
      }
    });

    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim() || initialName;
      if (!name) {
        input.focus();
        return;
      }

      void runSafely(async () => {
        save.disabled = true;
        input.disabled = true;
        state.textContent = "speichert …";
        try {
          await identity.onAssign(name);
        } finally {
          save.disabled = false;
          input.disabled = false;
        }
      });
    });

    imagePreviewOverlay.appendChild(box);
  }
}

function renderImagePreviewOverlay(details: MediaDetails): void {
  const naturalWidth =
    imagePreviewImage.naturalWidth || details.imageMetadata?.width || 0;
  const naturalHeight =
    imagePreviewImage.naturalHeight || details.imageMetadata?.height || 0;

  const identities: PreviewOverlayIdentity[] = [
    ...details.faces.map((face) => ({
      kind: "person" as const,
      id: face.id,
      name: face.personName,
      suggestionName: face.suggestedPersons[0]?.personName ?? null,
      confirmed: Boolean(
        face.personId && face.assignmentSource === "CONFIRMED"
      ),
      x: face.x,
      y: face.y,
      width: face.width,
      height: face.height,
      onAssign: async (name: string) => {
        await window.imageSorter.people.assignDetectionName(face.id, name);
        progressText.textContent =
          "Gesicht wurde „" + name + "“ zugeordnet und bestätigt.";
        if (imagePreviewDialog.open) {
          await loadImagePreviewDetails(details.mediaId);
        }
        await Promise.all([
          refreshIdentityTabStats(),
          refreshCatalog()
        ]);
      }
    })),
    ...details.pets.map((pet) => ({
      kind: "pet" as const,
      id: pet.id,
      name: pet.petName,
      suggestionName: pet.suggestedPets[0]?.petName ?? null,
      confirmed: Boolean(
        pet.petId && pet.assignmentSource === "CONFIRMED"
      ),
      x: pet.x,
      y: pet.y,
      width: pet.width,
      height: pet.height,
      petClass: pet.petClass,
      onAssign: async (name: string) => {
        await window.imageSorter.pets.assignDetectionName(pet.id, name);
        progressText.textContent =
          "Haustierfundstelle wurde „" + name +
          "“ zugeordnet und bestätigt.";
        if (imagePreviewDialog.open) {
          await loadImagePreviewDetails(details.mediaId);
        }
        await Promise.all([
          refreshIdentityTabStats(),
          refreshCatalog()
        ]);
      }
    }))
  ];

  renderPreviewIdentityOverlay(identities, naturalWidth, naturalHeight);
}

async function refreshCurrentVideoFrameAfterAssignment(
  details: MediaDetails,
  timestampMs: number
): Promise<void> {
  const refreshed = await window.imageSorter.catalog.getMediaDetails(details.mediaId);
  if (!refreshed || !imagePreviewDialog.open) return;
  currentImagePreviewDetails = refreshed;
  renderImagePreviewDetails(refreshed);

  const frame = refreshed.videoAnalysis?.frames.find(
    (item) => item.timestampMs === timestampMs
  );
  if (frame) {
    renderVideoFrameOverlay(refreshed, frame);
  }

  void window.imageSorter.catalog
    .getSearchFacets(refreshed.sourceId)
    .then((facets) => fillPreviewIdentityNames(facets.persons, facets.pets))
    .catch(() => undefined);
}

function renderVideoFrameOverlay(
  details: MediaDetails,
  frame: NonNullable<MediaDetails["videoAnalysis"]>["frames"][number]
): void {
  const identities: PreviewOverlayIdentity[] = frame.detections.map(
    (detection) => ({
      kind: detection.kind,
      id: detection.detectionIndex,
      name: detection.name,
      suggestionName: detection.name,
      confirmed: detection.confirmed,
      x: detection.x,
      y: detection.y,
      width: detection.width,
      height: detection.height,
      petClass: detection.petClass,
      onAssign: async (name: string) => {
        await window.imageSorter.catalog.assignVideoFrameIdentityName(
          details.mediaId,
          frame.timestampMs,
          detection.kind,
          detection.detectionIndex,
          detection.petClass,
          name
        );
        progressText.textContent =
          (detection.kind === "person" ? "Person" : "Haustier") +
          " im Video bei " + videoTimestamp(frame.timestampMs) +
          " wurde „" + name + "“ zugeordnet und bestätigt.";
        await refreshCurrentVideoFrameAfterAssignment(
          details,
          frame.timestampMs
        );
        await refreshIdentityTabStats();
      }
    })
  );

  renderPreviewIdentityOverlay(
    identities,
    frame.width,
    frame.height
  );
}

async function openVideoFrameEditor(
  details: MediaDetails,
  frame: NonNullable<MediaDetails["videoAnalysis"]>["frames"][number]
): Promise<void> {
  imagePreviewVideo.pause();
  currentVideoFrameTimestamp = frame.timestampMs;
  imagePreviewImageWrap.hidden = false;
  imagePreviewVideo.hidden = true;
  imagePreviewBackToVideo.hidden = false;
  imagePreviewImage.src = videoSceneImageUrl(details.mediaId, frame, 1600);
  imagePreviewImage.alt =
    details.relativePath + " bei " + videoTimestamp(frame.timestampMs);
  imagePreviewCaption.textContent =
    details.relativePath + " · Szenenbild " + videoTimestamp(frame.timestampMs);

  try {
    await imagePreviewImage.decode();
  } catch {
    imagePreviewImage.removeAttribute("src");
    imagePreviewOverlay.replaceChildren();
    imagePreviewCaption.textContent =
      "Szenenbild konnte nicht geladen oder verifiziert werden. Bei älteren Analysen bitte Video neu analysieren.";
    return;
  }
  if (!imagePreviewDialog.open || currentVideoFrameTimestamp !== frame.timestampMs) {
    return;
  }

  renderVideoFrameOverlay(details, frame);

  void window.imageSorter.catalog
    .getSearchFacets(details.sourceId)
    .then((facets) => fillPreviewIdentityNames(facets.persons, facets.pets))
    .catch(() => undefined);
}

function restoreVideoPreview(): void {
  if (!currentImagePreviewDetails) return;
  currentVideoFrameTimestamp = null;
  imagePreviewOverlay.replaceChildren();
  imagePreviewImage.removeAttribute("src");
  imagePreviewImageWrap.hidden = true;
  imagePreviewVideo.hidden = false;
  imagePreviewBackToVideo.hidden = true;
  imagePreviewCaption.textContent = currentImagePreviewDetails.relativePath;
}

function populateVideoFrameThumbnails(
  details: MediaDetails,
  gallery: HTMLElement
): void {
  videoFrameThumbnailObserver?.disconnect();
  videoFrameThumbnailObserver = null;
  const framesByTime = new Map(
    (details.videoAnalysis?.frames ?? []).map((frame) => [frame.timestampMs, frame])
  );
  const pending = new Map<Element, { image: HTMLImageElement; url: string }>();
  for (const image of gallery.querySelectorAll<HTMLImageElement>("img[data-frame-ms]")) {
    const timestampMs = Number(image.dataset.frameMs);
    const frame = framesByTime.get(timestampMs);
    if (!frame) continue;
    const card = image.closest(".video-frame-card");
    if (!card) continue;
    const placeholder = card.querySelector<HTMLElement>(".video-frame-thumb-placeholder");
    image.addEventListener("load", () => {
      image.dataset.loaded = "1";
      if (placeholder) placeholder.textContent = "";
    }, { once: true });
    image.addEventListener("error", () => {
      image.removeAttribute("src");
      if (placeholder) {
        placeholder.textContent = "Szenenbild nicht verfügbar";
        placeholder.classList.add("video-frame-thumb-error");
        placeholder.title =
          "Frame konnte nicht verifiziert werden; bei älteren Videos ist ggf. eine erneute Videoanalyse nötig.";
      }
    }, { once: true });
    pending.set(card, { image, url: videoSceneImageUrl(details.mediaId, frame) });
  }

  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const item = pending.get(entry.target);
        if (!item) continue;
        observer.unobserve(entry.target);
        pending.delete(entry.target);
        item.image.src = item.url;
      }
    }, { rootMargin: "300px 0px" });
    videoFrameThumbnailObserver = observer;
    for (const card of pending.keys()) observer.observe(card);
  } else {
    for (const item of pending.values()) item.image.src = item.url;
  }
}

function renderImagePreviewDetails(details: MediaDetails): void {
  videoFrameThumbnailObserver?.disconnect();
  videoFrameThumbnailObserver = null;
  imagePreviewDetails.replaceChildren();

  const reanalyzePanel = document.createElement("div");
  reanalyzePanel.className = "image-detail-reanalyze";

  const reanalyzeCopy = document.createElement("div");
  const reanalyzeTitle = document.createElement("strong");
  reanalyzeTitle.textContent = "Analyse dieses Mediums";
  const reanalyzeHint = document.createElement("small");
  reanalyzeHint.textContent =
    "Entfernt alle automatisch erkannten Daten dieses Mediums und legt sämtliche Analyse-Stufen mit höchster Priorität neu in die Warteschlange.";
  reanalyzeCopy.append(reanalyzeTitle, reanalyzeHint);

  const reanalyzeButton = document.createElement("button");
  reanalyzeButton.type = "button";
  reanalyzeButton.className = "danger";
  reanalyzeButton.textContent = "Bevorzugt neu analysieren";
  reanalyzeButton.addEventListener("click", () => {
    const confirmed = window.confirm(
      "Alle automatisch erkannten Daten für dieses Medium löschen und vollständig neu analysieren? " +
      "Bestätigte Gesichts-/Haustierzuordnungen dieses Mediums werden dabei ebenfalls entfernt. " +
      "Manuelle Lebensbereiche bleiben erhalten."
    );
    if (!confirmed) return;

    void runSafely(async () => {
      reanalyzeButton.disabled = true;
      reanalyzeButton.textContent = "Wird neu eingereiht …";
      try {
        const result = await window.imageSorter.catalog.reanalyzeMedia(details.mediaId);
        progressText.textContent =
          "Medium bevorzugt neu eingereiht · " +
          result.requeued.toLocaleString("de-DE") + " Analyse-Stufen · " +
          result.cleared.toLocaleString("de-DE") + " alte Ergebnisse entfernt.";
        await Promise.all([
          loadImagePreviewDetails(details.mediaId),
          refreshCatalog(),
          refreshSelectedPipelineStatus()
        ]);
      } finally {
        reanalyzeButton.disabled = false;
        reanalyzeButton.textContent = "Bevorzugt neu analysieren";
      }
    });
  });

  reanalyzePanel.append(reanalyzeCopy, reanalyzeButton);
  imagePreviewDetails.appendChild(reanalyzePanel);

  if (!isVideoExtension(details.extension)) {
    const pendingFaces = details.faces
      .filter((face) => !(face.personId && face.assignmentSource === "CONFIRMED"))
      .map((face) => ({
        id: face.id,
        name: face.personName ?? face.suggestedPersons[0]?.personName ?? ""
      }))
      .filter((face) => face.name.trim().length > 0);
    const pendingPets = details.pets
      .filter((pet) => !(pet.petId && pet.assignmentSource === "CONFIRMED"))
      .map((pet) => ({
        id: pet.id,
        name: pet.petName ?? pet.suggestedPets[0]?.petName ?? ""
      }))
      .filter((pet) => pet.name.trim().length > 0);
    const pendingCount = pendingFaces.length + pendingPets.length;
    if (pendingCount > 0) {
      const panel = document.createElement("div");
      panel.className = "image-detail-reanalyze";
      const description = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "Erkannte Personen und Haustiere";
      const hint = document.createElement("small");
      hint.textContent =
        pendingCount + (pendingCount === 1
          ? " unbestätigter Namensvorschlag"
          : " unbestätigte Namensvorschläge") +
        " · Erkennungen ohne Namensvorschlag bleiben unverändert.";
      description.append(title, hint);

      const confirmAll = document.createElement("button");
      confirmAll.type = "button";
      confirmAll.className = "secondary";
      confirmAll.textContent = "Alle bestätigen (" + pendingCount + ")";
      confirmAll.addEventListener("click", () => {
        void runSafely(async () => {
          confirmAll.disabled = true;
          let succeeded = 0;
          const failures: string[] = [];
          try {
            for (const face of pendingFaces) {
              try {
                await window.imageSorter.people.assignDetectionName(face.id, face.name);
                succeeded += 1;
              } catch (error) {
                failures.push("Person " + face.id + ": " + String(error));
              }
            }
            for (const pet of pendingPets) {
              try {
                await window.imageSorter.pets.assignDetectionName(pet.id, pet.name);
                succeeded += 1;
              } catch (error) {
                failures.push("Haustier " + pet.id + ": " + String(error));
              }
            }
            progressText.textContent =
              succeeded + " Zuordnungen bestätigt." +
              (failures.length ? " " + failures.length + " fehlgeschlagen: " + failures.slice(0, 2).join("; ") : "");
            await Promise.all([
              loadImagePreviewDetails(details.mediaId),
              refreshIdentityTabStats(),
              refreshCatalog()
            ]);
          } finally {
            confirmAll.disabled = false;
          }
        });
      });
      panel.append(description, confirmAll);
      imagePreviewDetails.appendChild(panel);
    }
  }

  const fileRows: Array<[string, unknown]> = [
    ["Datei", details.relativePath],
    ["Vollständiger Pfad", details.absolutePath],
    ["Dateityp", details.extension],
    ["Größe", formatBytes(details.sizeBytes)],
    ["Status", details.availability],
    ["SHA-256", details.sha256],
    ["Datei geändert", new Date(details.mtimeMs).toLocaleString("de-DE")],
    ["Erstmals gesehen", detailTimestamp(details.firstSeenAt)],
    ["Zuletzt gesehen", detailTimestamp(details.lastSeenAt)],
    ["Inhalt geändert", detailTimestamp(details.lastChangedAt)],
    ["Verschoben", detailTimestamp(details.lastMovedAt)],
    ["Dubletten", details.duplicateCount],
    ["Geräte-ID", details.deviceId],
    ["Inode", details.inode],
    ["Papierkorbpfad", details.recyclePath]
  ];
  appendDetailSection("Datei", detailGrid(fileRows));

  const lifeAreaBody = document.createElement("div");
  lifeAreaBody.className = "media-life-area-editor";
  if (details.lifeAreas.length === 0) {
    const empty = document.createElement("span");
    empty.className = "image-preview-detail-empty";
    empty.textContent = "Noch keinem Lebensbereich zugeordnet.";
    lifeAreaBody.appendChild(empty);
  } else {
    for (const assignment of details.lifeAreas) {
      const row = document.createElement("div");
      row.className = "media-life-area-option";
      const marker = document.createElement("span");
      marker.textContent = "◆";
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = assignment.name;
      const meta = document.createElement("small");
      meta.textContent =
        assignment.assignmentSource === "MANUAL"
          ? "Manuell"
          : "Automatisch · " +
            (assignment.ruleLabel ?? "Wenn-dann-Regel");
      text.append(title, meta);
      row.append(marker, text);
      lifeAreaBody.appendChild(row);
    }
  }

  const editLifeAreas = document.createElement("button");
  editLifeAreas.type = "button";
  editLifeAreas.className = "secondary";
  editLifeAreas.textContent = "Lebensbereiche bearbeiten";
  editLifeAreas.addEventListener("click", () => {
    void runSafely(() =>
      openLifeAreaAssignment(details.mediaId, details.relativePath)
    );
  });
  lifeAreaBody.appendChild(editLifeAreas);
  appendDetailSection("Lebensbereiche", lifeAreaBody);

  const technicalRows: Array<[string, unknown]> = [];
  if (details.technicalProbe) {
    const probeLabels: Record<string, string> = {
      exists: "Datei erreichbar",
      sizeBytes: "Prüfgröße",
      mtimeNs: "mtime ns",
      mimeType: "MIME-Typ",
      extension: "Prüf-Endung",
      expectedSha256: "Erwarteter SHA-256"
    };
    for (const [key, value] of Object.entries(details.technicalProbe)) {
      if (key === "module" || key === "path") continue;
      technicalRows.push([
        probeLabels[key] ?? key,
        key === "sizeBytes" && typeof value === "number" ? formatBytes(value) : value
      ]);
    }
  }

  if (details.imageMetadata) {
    const meta = details.imageMetadata;
    technicalRows.push(
      ["Abmessungen", meta.width + " × " + meta.height + " px"],
      ["Format", meta.format],
      ["Farbmodus", meta.colorMode],
      ["EXIF-Ausrichtung", meta.orientation],
      ["Aufnahmezeit", detailTimestamp(meta.capturedAt)],
      ["Kamerahersteller", meta.cameraMake],
      ["Kameramodell", meta.cameraModel],
      ["Objektiv", meta.lensModel],
      [
        "GPS",
        meta.gpsLatitude !== null && meta.gpsLongitude !== null
          ? meta.gpsLatitude.toFixed(6) + ", " + meta.gpsLongitude.toFixed(6)
          : null
      ],
      ["Metadaten aktualisiert", detailTimestamp(meta.updatedAt)]
    );
  }
  appendDetailSection(
    "Technische Daten / EXIF",
    technicalRows.length > 0
      ? detailGrid(technicalRows)
      : Object.assign(document.createElement("div"), {
          className: "image-preview-detail-empty",
          textContent: isVideoExtension(details.extension)
            ? "Noch keine zusätzlichen technischen Metadaten vorhanden."
            : "Noch keine technischen Bildmetadaten vorhanden."
        })
  );

  if (isVideoExtension(details.extension)) {
    const videoBody = document.createElement("div");
    if (details.videoAnalysis) {
      const video = details.videoAnalysis;
      videoBody.appendChild(detailGrid([
        ["Dauer", videoTimestamp(video.durationMs)],
        ["Auflösung", video.width + " × " + video.height + " px"],
        ["Bildrate", video.fps.toLocaleString("de-DE", { maximumFractionDigits: 3 }) + " fps"],
        ["Analyseintervall", videoTimestamp(video.sampleIntervalMs)],
        ["Analysierte Frames", video.sampledFrames],
        ["Szenen", video.sceneCount]
      ]));

      const tagHeading = document.createElement("strong");
      tagHeading.className = "image-detail-subheading";
      tagHeading.textContent = "Erkannte Motive / Tags";
      videoBody.appendChild(tagHeading);

      if (video.tags.length > 0) {
        const tags = document.createElement("div");
        tags.className = "image-detail-list";
        for (const tag of video.tags) {
          const item = document.createElement("div");
          item.className = "image-detail-item";
          const title = document.createElement("strong");
          title.textContent = MOTIF_LABELS_DE[tag.label] ?? tag.label;
          const meta = document.createElement("small");
          meta.textContent =
            "Score " + detailPercent(tag.score) +
            " · " + tag.hitCount.toLocaleString("de-DE") +
            (tag.hitCount === 1 ? " Treffer" : " Treffer");
          item.append(title, meta);
          tags.appendChild(item);
        }
        videoBody.appendChild(tags);
      } else {
        const emptyTags = document.createElement("div");
        emptyTags.className = "image-preview-detail-empty";
        emptyTags.textContent = "Keine Video-Tags gespeichert.";
        videoBody.appendChild(emptyTags);
      }

      const identityHeading = document.createElement("strong");
      identityHeading.className = "image-detail-subheading";
      identityHeading.textContent = "Personen- / Haustiertreffer";
      videoBody.appendChild(identityHeading);

      if (video.identityHits.length > 0) {
        const hits = document.createElement("div");
        hits.className = "image-detail-list";
        for (const hit of video.identityHits) {
          const item = document.createElement("div");
          item.className = "image-detail-item";
          const title = document.createElement("strong");
          const kind =
            hit.kind === "person"
              ? "Person"
              : hit.petClass === "cat"
                ? "Katze"
                : "Hund";
          title.textContent = kind + ": " + (hit.name ?? "noch nicht benannt");
          const meta = document.createElement("small");
          meta.textContent =
            videoTimestamp(hit.startMs) + " – " + videoTimestamp(hit.endMs) +
            " · " + hit.hitCount.toLocaleString("de-DE") +
            (hit.hitCount === 1 ? " Treffer" : " Treffer") +
            (hit.maxSimilarity !== null
              ? " · Ähnlichkeit " + detailPercent(hit.maxSimilarity)
              : "");
          item.append(title, meta);
          hits.appendChild(item);
        }
        videoBody.appendChild(hits);
      } else {
        const emptyHits = document.createElement("div");
        emptyHits.className = "image-preview-detail-empty";
        emptyHits.textContent = "Keine bekannten Personen- oder Haustiertreffer gespeichert.";
        videoBody.appendChild(emptyHits);
      }

      const frameHeading = document.createElement("strong");
      frameHeading.className = "image-detail-subheading";
      frameHeading.textContent = "Szenenbilder mit Personen / Haustieren";
      videoBody.appendChild(frameHeading);

      if (video.frames.length > 0) {
        const openFrames = document.createElement("button");
        openFrames.type = "button";
        openFrames.className = "secondary video-frame-gallery-toggle";
        openFrames.textContent =
          video.frames.length.toLocaleString("de-DE") +
          (video.frames.length === 1
            ? " Szenenbild anzeigen"
            : " Szenenbilder anzeigen");

        const gallery = document.createElement("div");
        gallery.className = "video-frame-gallery";
        gallery.hidden = true;

        for (const frame of video.frames) {
          const card = document.createElement("button");
          card.type = "button";
          card.className = "video-frame-card";

          const image = document.createElement("img");
          image.className = "video-frame-thumb";
          image.alt = "";
          image.dataset.frameMs = String(frame.timestampMs);

          const placeholder = document.createElement("span");
          placeholder.className = "video-frame-thumb-placeholder";
          placeholder.textContent = "▶";

          const info = document.createElement("span");
          info.className = "video-frame-card-info";

          const time = document.createElement("strong");
          time.textContent = videoTimestamp(frame.timestampMs);

          const confirmed = frame.detections.filter(
            (detection) => detection.confirmed
          ).length;
          const names = [
            ...new Set(
              frame.detections
                .map((detection) => detection.name)
                .filter((name): name is string => Boolean(name))
            )
          ];

          const meta = document.createElement("small");
          meta.textContent =
            frame.detections.length.toLocaleString("de-DE") +
            (frame.detections.length === 1 ? " Erkennung" : " Erkennungen") +
            " · " + confirmed.toLocaleString("de-DE") + " bestätigt" +
            (names.length > 0 ? " · " + names.join(", ") : "");

          info.append(time, meta);
          card.append(image, placeholder, info);

          card.addEventListener("click", () => {
            void runSafely(() => openVideoFrameEditor(details, frame));
          });

          gallery.appendChild(card);
        }

        let thumbnailsStarted = false;
        openFrames.addEventListener("click", () => {
          gallery.hidden = !gallery.hidden;
          openFrames.textContent = gallery.hidden
            ? video.frames.length.toLocaleString("de-DE") +
              (video.frames.length === 1
                ? " Szenenbild anzeigen"
                : " Szenenbilder anzeigen")
            : "Szenenbilder ausblenden";

          if (!gallery.hidden && !thumbnailsStarted) {
            thumbnailsStarted = true;
            populateVideoFrameThumbnails(details, gallery);
          }
        });

        videoBody.append(openFrames, gallery);
      } else {
        const emptyFrames = document.createElement("div");
        emptyFrames.className = "image-preview-detail-empty";
        const videoJob = details.analysisJobs.find(
          (job) => job.module === "video-analyze-v1"
        );
        emptyFrames.textContent =
          videoJob?.status === "PENDING" || videoJob?.status === "RUNNING"
            ? "Die Szenenbild-Erkennungen werden mit der aktualisierten Videoanalyse aufgebaut."
            : "Noch keine bearbeitbaren Personen-/Haustier-Szenenbilder gespeichert.";
        videoBody.appendChild(emptyFrames);
      }
    } else {
      videoBody.className = "image-preview-detail-empty";
      videoBody.textContent = "Die Videoanalyse ist noch nicht abgeschlossen.";
    }
    appendDetailSection("Videoanalyse", videoBody);
  }

  const faceList = document.createElement("div");
  faceList.className = "image-detail-list";
  if (details.faces.length === 0) {
    faceList.textContent = "Keine Gesichter erkannt.";
    faceList.classList.add("image-preview-detail-empty");
  } else {
    for (const face of details.faces) {
      const item = document.createElement("div");
      item.className = "image-detail-item image-detail-crop-row";
      const crop = document.createElement("img");
      crop.className = "image-detail-crop";
      crop.src = faceCropUrl(face.id);
      crop.alt = "";

      const text = document.createElement("div");
      const title = document.createElement("strong");
      const bestPersonSuggestion = face.suggestedPersons[0] ?? null;
      title.textContent = face.personName
        ? "Person: " + face.personName
        : bestPersonSuggestion
          ? "Vorschlag: " + bestPersonSuggestion.personName +
            " · " + detailPercent(bestPersonSuggestion.similarity)
          : face.candidateId !== null
            ? "Personenkandidat #" + face.candidateId
            : "Person noch nicht zugeordnet";

      const meta = document.createElement("small");
      const parts = [
        "Erkennung " + detailPercent(face.score),
        face.embeddingReady
          ? "Gesichtsmerkmale: " + (face.embeddingModel ?? "bereit")
          : "Gesichtsmerkmale noch nicht vorhanden",
        face.assignmentSource ? "Zuordnung: " + face.assignmentSource : null,
        face.assignmentConfidence !== null
          ? "Zuordnung " + detailPercent(face.assignmentConfidence)
          : null,
        face.candidateSimilarity !== null
          ? "Kandidat-Ähnlichkeit " + detailPercent(face.candidateSimilarity)
          : null,
        face.detectorVersion
      ].filter(Boolean);
      meta.textContent = parts.join(" · ");
      text.append(title, meta);

      if (!face.personName && face.suggestedPersons.length > 0) {
        const suggestions = document.createElement("small");
        suggestions.className = "image-detail-identity-suggestions";
        suggestions.textContent =
          "Mögliche Personen: " +
          face.suggestedPersons
            .map(
              (suggestion) =>
                suggestion.personName + " " + detailPercent(suggestion.similarity)
            )
            .join(" · ");
        text.appendChild(suggestions);
      }

      item.append(crop, text);
      faceList.appendChild(item);
    }
  }
  appendDetailSection(
    "Personen / Gesichter (" + details.faces.length.toLocaleString("de-DE") + ")",
    faceList
  );

  const petList = document.createElement("div");
  petList.className = "image-detail-list";
  if (details.pets.length === 0) {
    petList.textContent = "Keine Haustiere erkannt.";
    petList.classList.add("image-preview-detail-empty");
  } else {
    for (const pet of details.pets) {
      const item = document.createElement("div");
      item.className = "image-detail-item image-detail-crop-row";
      const crop = document.createElement("img");
      crop.className = "image-detail-crop";
      crop.src = petCropUrl(pet.id);
      crop.alt = "";

      const text = document.createElement("div");
      const title = document.createElement("strong");
      const species = pet.petClass === "cat" ? "Katze" : "Hund";
      const bestPetSuggestion = pet.suggestedPets[0] ?? null;
      title.textContent = pet.petName
        ? species + ": " + pet.petName
        : bestPetSuggestion
          ? species + " · Vorschlag: " + bestPetSuggestion.petName +
            " · " + detailPercent(bestPetSuggestion.similarity)
          : pet.candidateId !== null
            ? species + " · Kandidat #" + pet.candidateId
            : species + " noch nicht zugeordnet";

      const meta = document.createElement("small");
      meta.textContent = [
        "Erkennung " + detailPercent(pet.score),
        "Modelle " + pet.agreementCount,
        pet.sources.length > 0 ? pet.sources.join(" + ") : null,
        pet.embeddingReady
          ? "Merkmale: " + (pet.embeddingModel ?? "bereit")
          : "Merkmale noch nicht vorhanden",
        pet.assignmentSource ? "Zuordnung: " + pet.assignmentSource : null,
        pet.assignmentConfidence !== null
          ? "Zuordnung " + detailPercent(pet.assignmentConfidence)
          : null,
        pet.candidateSimilarity !== null
          ? "Kandidat-Ähnlichkeit " + detailPercent(pet.candidateSimilarity)
          : null
      ].filter(Boolean).join(" · ");
      text.append(title, meta);

      if (!pet.petName && pet.suggestedPets.length > 0) {
        const suggestions = document.createElement("small");
        suggestions.className = "image-detail-identity-suggestions";
        suggestions.textContent =
          "Mögliche Haustiere: " +
          pet.suggestedPets
            .map(
              (suggestion) =>
                suggestion.petName + " " + detailPercent(suggestion.similarity)
            )
            .join(" · ");
        text.appendChild(suggestions);
      }

      item.append(crop, text);
      petList.appendChild(item);
    }
  }
  appendDetailSection(
    "Haustiere (" + details.pets.length.toLocaleString("de-DE") + ")",
    petList
  );

  const objectList = document.createElement("div");
  objectList.className = "image-detail-list";
  if (details.objects.length === 0) {
    objectList.textContent = "Keine allgemeinen Motive gespeichert.";
    objectList.classList.add("image-preview-detail-empty");
  } else {
    for (const object of details.objects) {
      const item = document.createElement("div");
      item.className = "image-detail-item";
      const title = document.createElement("strong");
      title.textContent =
        (MOTIF_LABELS_DE[object.label] ?? object.label) +
        (object.raw ? " · Rohdetektion" : " · fusioniert");
      const meta = document.createElement("small");
      meta.textContent = [
        "Score " + detailPercent(object.score),
        object.agreementCount !== null ? "Übereinstimmung " + object.agreementCount : null,
        object.sources.length > 0 ? object.sources.join(" + ") : null,
        object.version
      ].filter(Boolean).join(" · ");
      item.append(title, meta);
      objectList.appendChild(item);
    }
  }
  appendDetailSection(
    "Motive / Objekte (" + details.objects.length.toLocaleString("de-DE") + ")",
    objectList
  );

  const semanticBody = document.createElement("div");
  if (details.semantic) {
    const semantic = details.semantic;
    const description = document.createElement("p");
    description.className = "image-detail-semantic-description";
    description.textContent = semantic.description || "Keine Beschreibung.";
    semanticBody.appendChild(description);

    for (const [label, values] of [
      ["Motive", semantic.subjects],
      ["Handlungen", semantic.actions],
      ["Szene", semantic.scenes],
      ["Sichtbarer Text", semantic.visibleText],
      ["Suchbegriffe", semantic.tags],
      ["Konzepte", semantic.concepts]
    ] as Array<[string, string[]]>) {
      const heading = document.createElement("strong");
      heading.textContent = label;
      heading.style.display = "block";
      heading.style.margin = "8px 0 5px";
      heading.style.fontSize = "11px";
      semanticBody.append(heading, detailChips(values));
    }

    semanticBody.appendChild(detailGrid([
      ["Modell", semantic.model],
      ["Profil", semantic.profileVersion],
      ["Bereiche", semantic.regionCount],
      ["JSON repariert", semantic.repaired ? "Ja" : "Nein"],
      ["Aktualisiert", detailTimestamp(semantic.updatedAt)]
    ]));

    if (semantic.regions.length > 0) {
      const regions = document.createElement("details");
      regions.style.marginTop = "9px";
      const summary = document.createElement("summary");
      summary.textContent = "Einzelergebnisse der " + semantic.regions.length + " Bildbereiche";
      const pre = document.createElement("pre");
      pre.className = "analysis-error-message";
      pre.textContent = JSON.stringify(semantic.regions, null, 2);
      regions.append(summary, pre);
      semanticBody.appendChild(regions);
    }

    const timings = document.createElement("details");
    timings.style.marginTop = "8px";
    const timingSummary = document.createElement("summary");
    timingSummary.textContent = "Qwen-Laufzeiten";
    const timingPre = document.createElement("pre");
    timingPre.className = "analysis-error-message";
    timingPre.textContent = JSON.stringify(semantic.timings, null, 2);
    timings.append(timingSummary, timingPre);
    semanticBody.appendChild(timings);
  } else {
    semanticBody.className = "image-preview-detail-empty";
    semanticBody.textContent = "Qwen-4B-Katalogsemantik noch nicht vorhanden.";
  }
  appendDetailSection("Qwen-4B-Semantik", semanticBody);

  appendDetailSection(
    "SigLIP2",
    details.semanticEmbedding
      ? detailGrid([
          ["Modell", details.semanticEmbedding.model],
          ["Dimensionen", details.semanticEmbedding.dimension],
          ["Max. Patches", details.semanticEmbedding.maxNumPatches],
          ["Präzision", details.semanticEmbedding.precision],
          ["Aktualisiert", detailTimestamp(details.semanticEmbedding.updatedAt)]
        ])
      : Object.assign(document.createElement("div"), {
          className: "image-preview-detail-empty",
          textContent: "Noch kein SigLIP2-Vektor vorhanden."
        })
  );

  const jobs = document.createElement("div");
  if (details.analysisJobs.length === 0) {
    jobs.className = "image-preview-detail-empty";
    jobs.textContent = "Keine Analysejobs vorhanden.";
  } else {
    for (const job of details.analysisJobs) {
      const row = document.createElement("div");
      row.className = "image-detail-job";
      const module = document.createElement("code");
      module.textContent = job.module;
      const status = document.createElement("span");
      status.className = "image-detail-job-status " + job.status;
      status.textContent = job.status;
      const meta = document.createElement("small");
      meta.textContent =
        "Versuche: " + job.attempts.toLocaleString("de-DE") +
        (job.finishedAt ? " · fertig " + detailTimestamp(job.finishedAt) : "") +
        (job.errorMessage ? " · " + job.errorMessage : "");
      meta.style.gridColumn = "1 / -1";
      row.append(module, status, meta);
      jobs.appendChild(row);
    }
  }
  appendDetailSection("Analyse-Pipeline", jobs);
}

async function loadImagePreviewDetails(
  mediaId: number
): Promise<MediaDetails | null> {
  const loadToken = ++imagePreviewDetailLoadToken;
  imagePreviewDetails.replaceChildren(
    createLoadingIndicator("Daten werden geladen …")
  );
  imagePreviewOverlay.replaceChildren();

  try {
    const details = await window.imageSorter.catalog.getMediaDetails(mediaId);
    if (
      !imagePreviewDialog.open ||
      loadToken !== imagePreviewDetailLoadToken
    ) {
      return null;
    }

    if (!details) {
      imagePreviewDetails.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "image-preview-detail-empty";
      empty.textContent = "Für dieses Medium wurden keine Detaildaten gefunden.";
      imagePreviewDetails.appendChild(empty);
      return null;
    }

    // Die eigentlichen Mediendaten sofort anzeigen. Die Namens-Facetten sind
    // nur Zusatzdaten für die Eingabefelder und dürfen die Detailansicht nicht
    // blockieren.
    currentImagePreviewDetails = details;
    renderImagePreviewDetails(details);
    if (!isVideoExtension(details.extension)) {
      renderImagePreviewOverlay(details);
    } else {
      imagePreviewOverlay.replaceChildren();
    }

    if (!isVideoExtension(details.extension)) {
      window.setTimeout(() => {
        if (
          !imagePreviewDialog.open ||
          loadToken !== imagePreviewDetailLoadToken
        ) {
          return;
        }

        void window.imageSorter.catalog
          .getSearchFacets(details.sourceId)
          .then((facets) => {
            if (
              !imagePreviewDialog.open ||
              loadToken !== imagePreviewDetailLoadToken ||
              currentImagePreviewDetails?.mediaId !== mediaId
            ) {
              return;
            }
            fillPreviewIdentityNames(facets.persons, facets.pets);
            renderImagePreviewOverlay(details);
          })
          .catch(() => {
            // Die Detailansicht ist bereits vollständig nutzbar; eine langsame
            // oder fehlgeschlagene Namensliste darf sie nicht wieder verdecken.
          });
      }, 0);
    }

    return details;
  } catch (error) {
    if (
      !imagePreviewDialog.open ||
      loadToken !== imagePreviewDetailLoadToken
    ) {
      return null;
    }

    imagePreviewDetails.replaceChildren();
    const message = document.createElement("div");
    message.className = "image-preview-detail-error";
    message.textContent =
      "Detaildaten konnten nicht geladen werden: " +
      (error instanceof Error ? error.message : String(error));
    imagePreviewDetails.appendChild(message);
    return null;
  }
}

async function openLifeAreaAssignment(
  mediaId: number,
  relativePath: string
): Promise<void> {
  lifeAreaAssignPath.textContent = relativePath;
  lifeAreaAssignPath.title = relativePath;
  showBlockLoading(lifeAreaAssignList, "Lebensbereiche werden geladen …");

  if (!lifeAreaAssignDialog.open) {
    lifeAreaAssignDialog.showModal();
  }

  const [lifeAreas, details] = await Promise.all([
    window.imageSorter.catalog.listLifeAreas(),
    window.imageSorter.catalog.getMediaDetails(mediaId)
  ]);

  if (!lifeAreaAssignDialog.open) return;
  lifeAreaAssignList.replaceChildren();

  if (lifeAreas.length === 0) {
    const empty = document.createElement("div");
    empty.className = "image-preview-detail-empty";
    empty.textContent =
      "Noch keine Lebensbereiche vorhanden. Lege sie links unter „Lebensbereiche“ an.";
    lifeAreaAssignList.appendChild(empty);
    return;
  }

  const assigned = new Map(
    (details?.lifeAreas ?? []).map((item) => [item.lifeAreaId, item])
  );

  for (const area of lifeAreas) {
    const label = document.createElement("label");
    label.className = "media-life-area-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = assigned.has(area.id);

    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = area.name;

    const meta = document.createElement("small");
    const current = assigned.get(area.id);
    meta.textContent = current
      ? current.assignmentSource === "MANUAL"
        ? "Manuell zugewiesen"
        : "Automatisch · " + (current.ruleLabel ?? "Wenn-dann-Regel")
      : area.mediaCount.toLocaleString("de-DE") +
        (area.mediaCount === 1 ? " Medium im Bereich" : " Medien im Bereich");

    text.append(title, meta);
    label.append(checkbox, text);

    checkbox.addEventListener("change", () => {
      void runSafely(async () => {
        checkbox.disabled = true;
        try {
          await window.imageSorter.catalog.setMediaLifeArea(
            mediaId,
            area.id,
            checkbox.checked
          );
          invalidateLifeAreas();

          const refreshed = await window.imageSorter.catalog.getMediaDetails(mediaId);
          const assignment = refreshed?.lifeAreas.find(
            (item) => item.lifeAreaId === area.id
          );
          meta.textContent = assignment
            ? assignment.assignmentSource === "MANUAL"
              ? "Manuell zugewiesen"
              : "Automatisch · " + (assignment.ruleLabel ?? "Wenn-dann-Regel")
            : checkbox.checked
              ? "Manuell zugewiesen"
              : "Manuell ausgeschlossen";

          if (imagePreviewDialog.open) {
            await loadImagePreviewDetails(mediaId);
          }
        } finally {
          checkbox.disabled = false;
        }
      });
    });

    lifeAreaAssignList.appendChild(label);
  }
}

function openImagePreview(
  mediaId: number,
  caption: string,
  extension = ""
): void {
  currentImagePreviewDetails = null;
  currentVideoFrameTimestamp = null;
  imagePreviewBackToVideo.hidden = true;
  imagePreviewOverlay.replaceChildren();
  imagePreviewCaption.textContent = caption;

  const video = isVideoExtension(extension);
  imagePreviewImageWrap.hidden = video;
  imagePreviewVideo.hidden = !video;
  imagePreviewVideoError.hidden = true;
  imagePreviewVideoError.textContent = "";

  if (video) {
    imagePreviewImage.removeAttribute("src");
    imagePreviewVideo.pause();
    imagePreviewVideo.src = fullMediaUrl(mediaId);
    imagePreviewVideo.load();
  } else {
    imagePreviewVideo.pause();
    imagePreviewVideo.removeAttribute("src");
    imagePreviewVideo.load();
    imagePreviewImage.src = fullPreviewUrl(mediaId);
    imagePreviewImage.alt = caption;
  }

  if (!imagePreviewDialog.open) {
    imagePreviewDialog.showModal();
  }

  // Player und Detaildaten sind absichtlich unabhängig. Ein Video kann sofort
  // starten, auch wenn Analyse-/Mediendaten noch nicht vorhanden sind.
  void loadImagePreviewDetails(mediaId);
}

imagePreviewBackToVideo.addEventListener("click", () => {
  restoreVideoPreview();
});

imagePreviewVideo.addEventListener("loadedmetadata", () => {
  imagePreviewVideoError.hidden = true;
  imagePreviewVideoError.textContent = "";
});

imagePreviewVideo.addEventListener("error", () => {
  if (imagePreviewVideo.hidden || !imagePreviewDialog.open) return;
  const code = imagePreviewVideo.error?.code ?? 0;
  imagePreviewVideoError.hidden = false;
  imagePreviewVideoError.textContent =
    "Video kann im integrierten Player nicht wiedergegeben werden" +
    (code ? " (Fehlercode " + code + ")" : "") +
    ". Datei/Codec oder Videostream prüfen.";
});

imagePreviewImage.addEventListener("load", () => {
  if (
    !imagePreviewDialog.open ||
    !currentImagePreviewDetails ||
    isVideoExtension(currentImagePreviewDetails.extension)
  ) return;
  renderImagePreviewOverlay(currentImagePreviewDetails);
});

imagePreviewDialog.addEventListener("close", () => {
  imagePreviewDetailLoadToken += 1;
  videoFrameThumbnailObserver?.disconnect();
  videoFrameThumbnailObserver = null;
  currentVideoFrameTimestamp = null;
  imagePreviewBackToVideo.hidden = true;
  currentImagePreviewDetails = null;
  imagePreviewVideo.pause();
  imagePreviewVideoError.hidden = true;
  imagePreviewVideoError.textContent = "";
  imagePreviewVideo.removeAttribute("src");
  imagePreviewVideo.load();

  if (
    !rendererShuttingDown &&
    currentView === "media" &&
    selectedSourceId() !== null
  ) {
    window.setTimeout(() => {
      if (!imagePreviewDialog.open) {
        void runSafely(refreshCatalog);
      }
    }, 100);
  }
});

function makePreviewable(
  image: HTMLImageElement,
  mediaId: number,
  caption: string
): void {
  image.classList.add("previewable-image");
  image.tabIndex = 0;
  image.setAttribute("role", "button");
  image.setAttribute("aria-label", "Bild groß anzeigen");

  const extension =
    caption.includes(".") ? "." + caption.split(".").pop()!.toLowerCase() : "";
  const open = () => openImagePreview(mediaId, caption, extension);
  image.addEventListener("click", open);
  image.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
}

function isEditingPersonView(): boolean {
  if (currentView !== "people") return false;

  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !personView.contains(active)) {
    return false;
  }

  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    active instanceof HTMLTextAreaElement
  );
}

function isEditingPetView(): boolean {
  if (currentView !== "pets") return false;

  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !petView.contains(active)) {
    return false;
  }

  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    active instanceof HTMLTextAreaElement
  );
}

function updateCatalogWatchSnapshot(event: CatalogWatchEvent): void {
  catalogWatchSnapshot.history = [
    event,
    ...catalogWatchSnapshot.history.filter(
      (item) =>
        !(
          item.sourceId === event.sourceId &&
          item.occurredAt === event.occurredAt &&
          item.kind === event.kind &&
          item.message === event.message
        )
    )
  ].slice(0, 50);

  const existingIndex = catalogWatchSnapshot.sources.findIndex(
    (source) => source.sourceId === event.sourceId
  );
  const existing = existingIndex >= 0
    ? catalogWatchSnapshot.sources[existingIndex]
    : {
        sourceId: event.sourceId,
        sourcePath: event.sourcePath,
        state: "WATCHING" as const,
        recursive: true,
        lastEventAt: null,
        lastScanAt: null
      };

  const next = {
    ...existing,
    sourcePath: event.sourcePath || existing.sourcePath,
    lastEventAt: event.occurredAt,
    state:
      event.kind === "SCAN_STARTED"
        ? "SCANNING" as const
        : event.kind === "ERROR"
          ? "ERROR" as const
          : event.kind === "FALLBACK"
            ? "FALLBACK" as const
            : event.kind === "WATCHING"
              ? "WATCHING" as const
              : event.kind === "SCAN_FINISHED"
                ? (existing.recursive ? "WATCHING" as const : "FALLBACK" as const)
                : existing.state,
    recursive:
      event.kind === "FALLBACK"
        ? false
        : event.kind === "WATCHING"
          ? true
          : existing.recursive,
    lastScanAt:
      event.kind === "SCAN_FINISHED"
        ? event.occurredAt
        : existing.lastScanAt
  };

  if (existingIndex >= 0) {
    catalogWatchSnapshot.sources.splice(existingIndex, 1, next);
  } else {
    catalogWatchSnapshot.sources.push(next);
  }
}

function renderCatalogWatchState(): void {
  const sourceId = selectedSourceId();

  if (sourceId === null) {
    watchState.className = "watch-state waiting";
    watchState.textContent = "Keine Quelle gewählt";
    watchDetail.textContent =
      "Nach dem Hinzufügen einer Quelle startet die Live-Überwachung automatisch.";
    watchHistory.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "watch-history-empty";
    empty.textContent = "Noch keine Live-Änderungen erkannt.";
    watchHistory.appendChild(empty);
    return;
  }

  const source = catalogWatchSnapshot.sources.find(
    (item) => item.sourceId === sourceId
  );

  if (!source) {
    watchState.className = "watch-state waiting";
    watchState.textContent = "Live-Überwachung wird vorbereitet …";
    watchDetail.textContent =
      "Neue, geänderte, verschobene und gelöschte Medien werden automatisch erkannt.";
  } else {
    watchState.className =
      "watch-state " +
      (source.state === "WATCHING"
        ? "watching"
        : source.state === "SCANNING"
          ? "scanning"
          : source.state === "FALLBACK"
            ? "fallback"
            : "error");

    watchState.textContent =
      source.state === "WATCHING"
        ? "● Live-Überwachung aktiv"
        : source.state === "SCANNING"
          ? "↻ Automatischer Abgleich läuft"
          : source.state === "FALLBACK"
            ? "Live-Watcher eingeschränkt"
            : "Live-Überwachung gestört";

    watchDetail.textContent =
      source.state === "WATCHING"
        ? "Rekursiv überwacht · Sicherheitsabgleich alle 15 Minuten" +
          (source.lastScanAt
            ? " · letzter Auto-Abgleich " +
              new Date(source.lastScanAt).toLocaleTimeString("de-DE")
            : "")
        : source.state === "SCANNING"
          ? "Dateisystemänderungen werden mit dem Katalog abgeglichen …"
          : source.state === "FALLBACK"
            ? "Wurzelordner wird beobachtet · vollständiger Sicherheitsabgleich alle 15 Minuten"
            : "Der 15-Minuten-Sicherheitsabgleich versucht die Quelle weiterhin erneut.";
  }

  watchHistory.replaceChildren();
  const rows: Array<{
    occurredAt: string;
    kind: string;
    className: string;
    path: string;
  }> = [];

  for (const event of catalogWatchSnapshot.history) {
    if (event.sourceId !== sourceId) continue;

    if (event.kind === "SCAN_FINISHED" && event.scanResult) {
      for (const change of event.scanResult.changes) {
        const mapping = {
          ADDED: ["NEU", "added"],
          MOVED: ["VERSCHOBEN", "moved"],
          CHANGED: ["GEÄNDERT", "changed"],
          MISSING: ["GELÖSCHT", "missing"],
          RECYCLE: ["PAPIERKORB", "recycle"],
          RECYCLE_AMBIGUOUS: ["PAPIERKORB?", "recycle"]
        } as const;
        const [label, className] = mapping[change.kind];
        rows.push({
          occurredAt: event.occurredAt,
          kind: label,
          className,
          path:
            change.kind === "MOVED" && change.previousPath
              ? change.previousPath + " → " + change.path
              : change.path
        });
      }
    } else if (event.kind === "ERROR" || event.kind === "FALLBACK") {
      rows.push({
        occurredAt: event.occurredAt,
        kind: event.kind === "ERROR" ? "FEHLER" : "HINWEIS",
        className: event.kind === "ERROR" ? "missing" : "changed",
        path: event.message
      });
    }

    if (rows.length >= 50) break;
  }

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "watch-history-empty";
    empty.textContent = "Noch keine Dateiänderungen erkannt.";
    watchHistory.appendChild(empty);
    return;
  }

  for (const row of rows.slice(0, 50)) {
    const entry = document.createElement("div");
    entry.className = "watch-history-entry " + row.className;

    const time = document.createElement("time");
    time.textContent = new Date(row.occurredAt).toLocaleTimeString("de-DE");

    const kind = document.createElement("span");
    kind.className = "watch-history-kind";
    kind.textContent = row.kind;

    const filePath = document.createElement("span");
    filePath.className = "watch-history-path";
    filePath.textContent = row.path;

    entry.append(time, kind, filePath);
    watchHistory.appendChild(entry);
  }
}

function selectedSourceId(): number | null {
  const value = sourceSelect.value;
  return value ? Number(value) : null;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function statusFor(row: MediaRecord): { text: string; className: string } {
  if (row.availability === "AVAILABLE") {
    return { text: "Verfügbar", className: "badge ok" };
  }
  if (row.recycleState === "RESTORABLE") {
    return { text: "Papierkorb – wiederherstellbar", className: "badge recycle" };
  }
  if (row.recycleState === "AMBIGUOUS") {
    return { text: "Papierkorb – Zuordnung mehrdeutig", className: "badge recycle ambiguous" };
  }
  return { text: "Fehlt", className: "badge missing" };
}

const MOTIF_LABELS_DE: Record<string, string> = {
  person: "Person",
  bicycle: "Fahrrad",
  car: "Auto",
  motorcycle: "Motorrad",
  airplane: "Flugzeug",
  bus: "Bus",
  train: "Zug",
  truck: "Lkw",
  boat: "Boot",
  "traffic light": "Ampel",
  "fire hydrant": "Hydrant",
  "stop sign": "Stoppschild",
  "parking meter": "Parkscheinautomat",
  bench: "Bank",
  bird: "Vogel",
  cat: "Katze",
  dog: "Hund",
  horse: "Pferd",
  sheep: "Schaf",
  cow: "Kuh",
  elephant: "Elefant",
  bear: "Bär",
  zebra: "Zebra",
  giraffe: "Giraffe",
  backpack: "Rucksack",
  umbrella: "Regenschirm",
  handbag: "Handtasche",
  tie: "Krawatte",
  suitcase: "Koffer",
  frisbee: "Frisbee",
  skis: "Ski",
  snowboard: "Snowboard",
  "sports ball": "Ball",
  kite: "Drachen",
  "baseball bat": "Baseballschläger",
  "baseball glove": "Baseballhandschuh",
  skateboard: "Skateboard",
  surfboard: "Surfbrett",
  "tennis racket": "Tennisschläger",
  bottle: "Flasche",
  "wine glass": "Weinglas",
  cup: "Tasse/Becher",
  fork: "Gabel",
  knife: "Messer",
  spoon: "Löffel",
  bowl: "Schüssel",
  banana: "Banane",
  apple: "Apfel",
  sandwich: "Sandwich",
  orange: "Orange",
  broccoli: "Brokkoli",
  carrot: "Karotte",
  "hot dog": "Hotdog",
  pizza: "Pizza",
  donut: "Donut",
  cake: "Kuchen",
  chair: "Stuhl",
  couch: "Sofa",
  "potted plant": "Topfpflanze",
  bed: "Bett",
  "dining table": "Tisch",
  toilet: "Toilette",
  tv: "Fernseher",
  laptop: "Laptop",
  mouse: "Maus",
  remote: "Fernbedienung",
  keyboard: "Tastatur",
  "cell phone": "Handy",
  microwave: "Mikrowelle",
  oven: "Backofen",
  toaster: "Toaster",
  sink: "Spüle",
  refrigerator: "Kühlschrank",
  book: "Buch",
  clock: "Uhr",
  vase: "Vase",
  scissors: "Schere",
  "teddy bear": "Teddybär",
  "hair drier": "Haartrockner",
  toothbrush: "Zahnbürste"
};

function checkedValues(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function boundedCount(input: HTMLInputElement): number {
  const value = Math.trunc(Number(input.value) || 0);
  return Math.max(0, Math.min(20, value));
}

function currentSearchFilter(): SearchFilter {
  return {
    personIds: checkedValues(searchPersons)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0),
    petIds: checkedValues(searchPets)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0),
    objectLabels: checkedValues(searchObjects),
    minDogs: boundedCount(searchMinDogs),
    minCats: boundedCount(searchMinCats),
    semanticQuery: searchSemanticQuery.value.trim(),
    semanticMinProbability: Math.max(
      0,
      Math.min(0.99, (Number(searchSemanticMinProbability.value) || 0) / 100)
    )
  };
}

function searchCriterionCount(filter: SearchFilter): number {
  return (
    filter.personIds.length +
    filter.petIds.length +
    filter.objectLabels.length +
    (filter.minDogs > 0 ? 1 : 0) +
    (filter.minCats > 0 ? 1 : 0) +
    (filter.semanticQuery ? 1 : 0)
  );
}

function appendFacet(
  container: HTMLElement,
  value: string,
  label: string,
  mediaCount: number,
  checked: boolean,
  previewUrl?: string | null
): void {
  const wrapper = document.createElement("label");
  wrapper.className = "search-facet";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = value;
  input.checked = checked;

  if (previewUrl) {
    const preview = document.createElement("img");
    preview.className = "search-facet-preview";
    preview.src = previewUrl;
    preview.alt = "";
    preview.loading = "lazy";
    wrapper.appendChild(preview);
  }

  const text = document.createElement("span");
  text.textContent = label;

  const count = document.createElement("small");
  count.textContent = mediaCount.toLocaleString("de-DE");

  wrapper.append(input, text, count);
  container.appendChild(wrapper);
}

function renderSearchFacets(facets: SearchFacets): void {
  const selectedPersons = new Set(checkedValues(searchPersons));
  const selectedPets = new Set(checkedValues(searchPets));
  const selectedObjects = new Set(checkedValues(searchObjects));

  searchPersons.replaceChildren();
  searchPets.replaceChildren();
  searchObjects.replaceChildren();

  for (const person of facets.persons) {
    appendFacet(
      searchPersons,
      String(person.id),
      person.name,
      person.mediaCount,
      selectedPersons.has(String(person.id)),
      person.representativeFaceId === null
        ? null
        : faceCropUrl(person.representativeFaceId)
    );
  }

  for (const pet of facets.pets) {
    appendFacet(
      searchPets,
      String(pet.id),
      pet.name + (pet.petClass === "dog" ? " · Hund" : " · Katze"),
      pet.mediaCount,
      selectedPets.has(String(pet.id)),
      pet.representativePetId === null
        ? null
        : petCropUrl(pet.representativePetId)
    );
  }

  for (const object of facets.objects) {
    appendFacet(
      searchObjects,
      object.label,
      MOTIF_LABELS_DE[object.label] ?? object.label,
      object.mediaCount,
      selectedObjects.has(object.label)
    );
  }

  const addEmpty = (container: HTMLElement, text: string) => {
    if (container.childElementCount > 0) return;
    const empty = document.createElement("span");
    empty.className = "search-facet-empty";
    empty.textContent = text;
    container.appendChild(empty);
  };

  addEmpty(searchPersons, "Noch keine bestätigten Personen.");
  addEmpty(searchPets, "Noch keine bestätigten Haustiere.");
  addEmpty(searchObjects, "Noch keine belastbaren Motive analysiert.");
}

function searchScopeSourceId(): number | undefined {
  if (searchScope.value !== "source") return undefined;
  return selectedSourceId() ?? undefined;
}

function currentSearchScopeKey(): string {
  const sourceId = searchScopeSourceId();
  return sourceId === undefined ? "catalog" : "source:" + sourceId;
}

async function loadSearchFacets(sourceId?: number): Promise<void> {
  const facets = await window.imageSorter.catalog.getSearchFacets(sourceId);
  renderSearchFacets(facets);
  searchFacetsScopeKey =
    sourceId === undefined ? "catalog" : "source:" + sourceId;
}

async function runCombinedSearch(sourceId?: number): Promise<void> {
  showTableLoading("Suchergebnisse werden geladen …");
  searchSummary.textContent = "Suche läuft …";
  const filter = currentSearchFilter();
  const rows = await window.imageSorter.catalog.searchMedia(
    sourceId,
    filter,
    1000
  );
  renderRows(rows, "Keine Medien entsprechen allen ausgewählten Kriterien.");

  const criteria = searchCriterionCount(filter);
  const scopeLabel =
    sourceId === undefined ? "gesamter Katalog" : "aktuelle Quelle";
  searchTabCount.textContent = rows.length.toLocaleString("de-DE");
  searchSummary.textContent =
    rows.length.toLocaleString("de-DE") + " " +
    (rows.length === 1 ? "Treffer" : "Treffer") +
    " · " + scopeLabel +
    (criteria > 0
      ? " · " + criteria.toLocaleString("de-DE") + " UND-" +
        (criteria === 1 ? "Kriterium" : "Kriterien")
      : " · keine Einschränkung") +
    (filter.semanticQuery.trim()
      ? " · Qwen-4B-Semantik + SigLIP2-Ranking"
      : "");
}

function clearSearchControls(): void {
  for (const input of [
    ...searchPersons.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ...searchPets.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ...searchObjects.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  ]) {
    input.checked = false;
  }
  searchMinDogs.value = "0";
  searchMinCats.value = "0";
  searchSemanticQuery.value = "";
  searchSemanticMinProbability.value = "65";
}

function setView(view: CatalogView): void {
  currentView = view;

  mediaTab.classList.toggle("active", view === "media");
  searchTab.classList.toggle("active", view === "search");
  duplicateTab.classList.toggle("active", view === "duplicates");
  peopleTab.classList.toggle("active", view === "people");
  petsTab.classList.toggle("active", view === "pets");
  recycleTab.classList.toggle("active", view === "recycle");

  libraryToolbar.hidden = view !== "media";
  searchPanel.hidden = view !== "search";
  duplicateView.hidden = view !== "duplicates";
  personView.hidden = view !== "people";
  petView.hidden = view !== "pets";
  mediaView.hidden =
    view === "duplicates" || view === "people" || view === "pets";

  void runSafely(refreshCatalog);
}

function libraryMediaKind(row: MediaRecord): "image" | "video" | "other" {
  const extension = row.extension.toLocaleLowerCase("de-DE");
  if (LIBRARY_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (LIBRARY_VIDEO_EXTENSIONS.has(extension)) return "video";
  return "other";
}

function libraryMarkerEntries(row: MediaRecord): string[] {
  const marks = new Set<string>();
  if (row.faceCount > 0) marks.add("Gesicht");
  if (row.dogCount > 0) marks.add("Hund");
  if (row.catCount > 0) marks.add("Katze");
  if (row.duplicateCount > 0) marks.add("Dublette");
  if (row.catalogSemanticReady) marks.add("Qwen 4B");
  if (row.semanticReady) marks.add("SigLIP2");

  for (const label of row.objectLabels ?? []) {
    const translated = MOTIF_LABELS_DE[label] ?? germanIdentityTerm(label);
    if (translated) marks.add(translated);
  }
  for (const marker of row.markerLabels ?? []) {
    if (
      marker.startsWith("Person: ") ||
      marker.startsWith("Haustier: ") ||
      marker.startsWith("Lebensbereich: ")
    ) {
      marks.add(marker);
      continue;
    }
    const translated = MOTIF_LABELS_DE[marker] ?? germanIdentityTerm(marker);
    if (translated) marks.add(translated);
  }
  return [...marks].sort((a, b) => a.localeCompare(b, "de"));
}

function libraryTimestamp(row: MediaRecord): number {
  const captured = row.capturedAt ? Date.parse(row.capturedAt) : Number.NaN;
  if (Number.isFinite(captured)) return captured;
  const seen = Date.parse(row.lastSeenAt);
  return Number.isFinite(seen) ? seen : 0;
}

function libraryGroupLabel(row: MediaRecord): string {
  switch (libraryGroup.value) {
    case "media-type":
      return libraryMediaKind(row) === "video"
        ? "Videos"
        : libraryMediaKind(row) === "image"
          ? "Bilder"
          : "Sonstige Medien";
    case "month": {
      const timestamp = libraryTimestamp(row);
      if (!timestamp) return "Ohne Datum";
      return new Date(timestamp).toLocaleDateString("de-DE", {
        year: "numeric",
        month: "long"
      });
    }
    case "status":
      return row.availability === "AVAILABLE" ? "Verfügbar" : "Fehlend";
    case "marker":
      return libraryMarkerEntries(row)[0] ?? "Ohne Kennzeichen";
    case "person":
      return libraryMarkerEntries(row)
        .find((mark) => mark.startsWith("Person: "))
        ?.slice("Person: ".length) ?? "Ohne bestätigte Person";
    case "pet":
      return libraryMarkerEntries(row)
        .find((mark) => mark.startsWith("Haustier: "))
        ?.slice("Haustier: ".length) ?? "Ohne benanntes Haustier";
    case "life-area":
      return libraryMarkerEntries(row)
        .find((mark) => mark.startsWith("Lebensbereich: "))
        ?.slice("Lebensbereich: ".length) ?? "Ohne Lebensbereich";
    case "motif":
      return libraryMarkerEntries(row)
        .find((mark) =>
          !mark.startsWith("Person: ") &&
          !mark.startsWith("Haustier: ") &&
          !mark.startsWith("Lebensbereich: ") &&
          mark !== "Gesicht" &&
          mark !== "Dublette" &&
          mark !== "Qwen 4B" &&
          mark !== "SigLIP2"
        ) ?? "Ohne Motivkennzeichen";
    default:
      return "";
  }
}

function updateLibraryMarkOptions(rows: MediaRecord[]): void {
  const available = [...new Set(rows.flatMap(libraryMarkerEntries))]
    .sort((a, b) => a.localeCompare(b, "de"));

  for (const selected of [...selectedLibraryMarks]) {
    if (!available.includes(selected)) selectedLibraryMarks.delete(selected);
  }

  libraryMarksOptions.replaceChildren();
  if (available.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "Noch keine erkannten Kennzeichen vorhanden.";
    libraryMarksOptions.appendChild(empty);
  } else {
    for (const mark of available) {
      const label = document.createElement("label");
      label.className = "library-mark-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selectedLibraryMarks.has(mark);
      input.addEventListener("change", () => {
        if (input.checked) selectedLibraryMarks.add(mark);
        else selectedLibraryMarks.delete(mark);
        applyLibraryView();
      });
      const span = document.createElement("span");
      span.textContent = mark;
      label.append(input, span);
      libraryMarksOptions.appendChild(label);
    }
  }

  libraryMarksCount.textContent = selectedLibraryMarks.size
    ? String(selectedLibraryMarks.size)
    : String(available.length);
  libraryMarksFilter.classList.toggle("active", selectedLibraryMarks.size > 0);
}

function filteredLibraryRows(): MediaRecord[] {
  const type = libraryMediaType.value;
  const status = libraryStatus.value;
  const query = libraryTextFilter.value.trim().toLocaleLowerCase("de-DE");
  const selectedMarks = [...selectedLibraryMarks];

  const rows = libraryRows.filter((row) => {
    const kind = libraryMediaKind(row);
    if (type !== "all" && kind !== type) return false;
    if (status === "available" && row.availability !== "AVAILABLE") return false;
    if (status === "missing" && row.availability !== "MISSING") return false;

    if (
      query &&
      !row.relativePath.toLocaleLowerCase("de-DE").includes(query) &&
      !(row.sourcePath ?? "").toLocaleLowerCase("de-DE").includes(query)
    ) {
      return false;
    }

    if (selectedMarks.length > 0) {
      const marks = new Set(libraryMarkerEntries(row));
      if (!selectedMarks.every((mark) => marks.has(mark))) return false;
    }
    return true;
  });

  rows.sort((left, right) => {
    switch (librarySort.value) {
      case "captured-asc":
        return libraryTimestamp(left) - libraryTimestamp(right) ||
          left.relativePath.localeCompare(right.relativePath, "de");
      case "path-desc":
        return right.relativePath.localeCompare(left.relativePath, "de");
      case "size-desc":
        return right.sizeBytes - left.sizeBytes ||
          left.relativePath.localeCompare(right.relativePath, "de");
      case "size-asc":
        return left.sizeBytes - right.sizeBytes ||
          left.relativePath.localeCompare(right.relativePath, "de");
      case "type-asc":
        return left.extension.localeCompare(right.extension, "de") ||
          left.relativePath.localeCompare(right.relativePath, "de");
      case "path-asc":
        return left.relativePath.localeCompare(right.relativePath, "de");
      default:
        return libraryTimestamp(right) - libraryTimestamp(left) ||
          left.relativePath.localeCompare(right.relativePath, "de");
    }
  });

  if (libraryGroup.value !== "none") {
    rows.sort((left, right) =>
      libraryGroupLabel(left).localeCompare(libraryGroupLabel(right), "de") ||
      (libraryTimestamp(right) - libraryTimestamp(left)) ||
      left.relativePath.localeCompare(right.relativePath, "de")
    );
  }

  return rows;
}

function applyLibraryView(): void {
  if (currentView !== "media") return;
  const rows = filteredLibraryRows();
  librarySummary.textContent =
    rows.length.toLocaleString("de-DE") + " von " +
    libraryRows.length.toLocaleString("de-DE") + " Medien" +
    (selectedLibraryMarks.size
      ? " · " + selectedLibraryMarks.size.toLocaleString("de-DE") + " Kennzeichen aktiv"
      : "");
  renderRows(rows, "Keine Medien entsprechen den gewählten Filtern.");
}

function renderRows(rows: MediaRecord[], emptyText = "Noch keine Medien katalogisiert."): void {
  mediaRows.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "empty";
    td.textContent = emptyText;
    tr.appendChild(td);
    mediaRows.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();
  let previousGroup = "";

  for (const row of rows) {
    if (currentView === "media" && libraryGroup.value !== "none") {
      const group = libraryGroupLabel(row);
      if (group !== previousGroup) {
        const groupRow = document.createElement("tr");
        groupRow.className = "media-group-row";
        const groupCell = document.createElement("td");
        groupCell.colSpan = 7;
        groupCell.textContent = group;
        groupRow.appendChild(groupCell);
        fragment.appendChild(groupRow);
        previousGroup = group;
      }
    }

    const tr = document.createElement("tr");

    const previewCell = document.createElement("td");
    previewCell.className = "preview-cell";

    const thumbnail = thumbnailUrl(row);
    const previewable =
      row.availability === "AVAILABLE" &&
      (
        LIBRARY_IMAGE_EXTENSIONS.has(row.extension.toLowerCase()) ||
        LIBRARY_VIDEO_EXTENSIONS.has(row.extension.toLowerCase())
      );

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "media-preview-button";
    previewButton.disabled = !previewable;
    previewButton.title = previewable
      ? isVideoExtension(row.extension)
        ? "Video mit Details öffnen"
        : "Bild mit Details öffnen"
      : "Für dieses Medium ist keine Vorschau verfügbar.";
    previewButton.setAttribute(
      "aria-label",
      previewable
        ? isVideoExtension(row.extension)
          ? "Video-Detailansicht öffnen"
          : "Bild-Detailansicht öffnen"
        : "Keine Vorschau verfügbar"
    );

    if (previewable) {
      previewButton.addEventListener("click", () => {
        openImagePreview(
          row.id,
          row.relativePath,
          row.extension.toLowerCase()
        );
      });
    }

    const appendPlaceholder = () => {
      previewButton.replaceChildren();
      const placeholder = document.createElement("span");
      placeholder.className = "preview-placeholder";
      placeholder.textContent =
        row.availability === "AVAILABLE"
          ? row.extension.replace(".", "").toUpperCase()
          : "—";
      previewButton.appendChild(placeholder);

      if (previewable && isVideoExtension(row.extension)) {
        const play = document.createElement("span");
        play.className = "media-video-play";
        play.textContent = "▶";
        play.setAttribute("aria-hidden", "true");
        previewButton.appendChild(play);
      }
    };

    if (thumbnail) {
      const img = document.createElement("img");
      img.className = "media-thumbnail";
      img.src = thumbnail;
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      img.addEventListener("error", appendPlaceholder);
      previewButton.appendChild(img);

      if (previewable && isVideoExtension(row.extension)) {
        const play = document.createElement("span");
        play.className = "media-video-play";
        play.textContent = "▶";
        play.setAttribute("aria-hidden", "true");
        previewButton.appendChild(play);
      }
    } else {
      appendPlaceholder();
    }

    previewCell.appendChild(previewButton);

    const pathCell = document.createElement("td");
    pathCell.className = "path-cell";
    pathCell.title = row.relativePath;

    const pathMain = document.createElement("div");
    pathMain.className = "path-main";
    pathMain.textContent = row.relativePath;
    pathCell.appendChild(pathMain);

    if (
      currentView === "search" &&
      searchScope.value === "catalog" &&
      row.sourcePath
    ) {
      const source = document.createElement("small");
      source.className = "path-meta";
      const normalized = row.sourcePath.replace(/\\/g, "/");
      const sourceName =
        normalized.split("/").filter(Boolean).at(-1) ?? row.sourcePath;
      source.textContent = "Quelle: " + sourceName;
      source.title = row.sourcePath;
      pathCell.appendChild(source);
    }

    if (row.capturedAt) {
      const captured = document.createElement("small");
      captured.className = "path-meta";
      captured.textContent = `Aufnahme: ${row.capturedAt.replace("T", " ")}`;
      pathCell.appendChild(captured);
    }

    const semanticReasons = row.semanticMatchReasons ?? [];
    if (semanticReasons.length > 0) {
      const reasons = document.createElement("small");
      reasons.className = "semantic-match-reasons";
      reasons.textContent = "Treffer: " + semanticReasons.join(" · ");
      reasons.title =
        (row.semanticDescription ? row.semanticDescription + "\n\n" : "") +
        "Qwen-Konzepte: " +
        ((row.semanticConcepts ?? []).join(", ") || "—");
      pathCell.appendChild(reasons);
    }

    const typeCell = document.createElement("td");
    typeCell.textContent = row.extension.replace(".", "").toUpperCase();

    const sizeCell = document.createElement("td");
    sizeCell.textContent = formatBytes(row.sizeBytes);

    const stateCell = document.createElement("td");
    const status = statusFor(row);
    const badge = document.createElement("span");
    badge.className = status.className;
    badge.textContent = status.text;
    stateCell.appendChild(badge);

    if (row.availability === "AVAILABLE" && row.duplicateCount > 0) {
      const duplicateBadge = document.createElement("span");
      duplicateBadge.className = "badge duplicate";
      duplicateBadge.textContent = `Dubletten ×${row.duplicateCount + 1}`;
      duplicateBadge.title = "Dateien mit identischem SHA-256-Inhalt";
      stateCell.appendChild(duplicateBadge);
    }

    if (row.availability === "AVAILABLE" && row.faceCount > 0) {
      const faceBadge = document.createElement("span");
      faceBadge.className = "badge faces";
      faceBadge.textContent =
        `${row.faceCount} ${row.faceCount === 1 ? "Gesicht" : "Gesichter"}`;
      faceBadge.title = "Automatisch erkannte Gesichter; noch keiner Person zugeordnet";
      stateCell.appendChild(faceBadge);

      const embeddingBadge = document.createElement("span");
      embeddingBadge.className = "badge embedding";
      embeddingBadge.textContent =
        row.faceEmbeddingCount >= row.faceCount
          ? "Merkmale bereit"
          : `Merkmale ${row.faceEmbeddingCount}/${row.faceCount}`;
      embeddingBadge.title =
        "SFace-Merkmale für die spätere Gruppierung derselben Person";
      stateCell.appendChild(embeddingBadge);
    }

    if (row.availability === "AVAILABLE" && row.petCount > 0) {
      const ensembleTitle =
        `Ensemble-Fusion: ${row.petMultiModelCount} ` +
        `${row.petMultiModelCount === 1 ? "Fundstelle von beiden Modellen" : "Fundstellen von beiden Modellen"}; ` +
        `${row.petSingleModelCount} ` +
        `${row.petSingleModelCount === 1 ? "Fundstelle nur von einem Modell" : "Fundstellen nur von einem Modell"}.`;

      if (row.dogCount > 0) {
        const dogBadge = document.createElement("span");
        dogBadge.className = "badge pet";
        dogBadge.textContent =
          `${row.dogCount} ${row.dogCount === 1 ? "Hund" : "Hunde"}`;
        dogBadge.title = ensembleTitle;
        stateCell.appendChild(dogBadge);
      }

      if (row.catCount > 0) {
        const catBadge = document.createElement("span");
        catBadge.className = "badge pet";
        catBadge.textContent =
          `${row.catCount} ${row.catCount === 1 ? "Katze" : "Katzen"}`;
        catBadge.title = ensembleTitle;
        stateCell.appendChild(catBadge);
      }

      const ensembleBadge = document.createElement("span");
      ensembleBadge.className =
        row.petSingleModelCount > 0
          ? "badge ensemble mixed"
          : "badge ensemble";
      ensembleBadge.textContent =
        row.petSingleModelCount > 0
          ? `Ensemble ${row.petMultiModelCount}/${row.petCount}`
          : "Ensemble bestätigt";
      ensembleBadge.title = ensembleTitle;
      stateCell.appendChild(ensembleBadge);
    }

    const motifLabels = row.objectLabels.filter(
      (label) => label !== "dog" && label !== "cat"
    );

    if (row.availability === "AVAILABLE" && motifLabels.length > 0) {
      const motifBadge = document.createElement("span");
      motifBadge.className = "badge motif";
      const visible = motifLabels.slice(0, 3);
      motifBadge.textContent =
        "Motive: " + visible.join(" · ") +
        (motifLabels.length > visible.length ? " …" : "");
      motifBadge.title =
        "Vorhandene allgemeine Motiverkennung: " + motifLabels.join(", ");
      stateCell.appendChild(motifBadge);
    }

    if (row.availability === "AVAILABLE" && row.catalogSemanticReady) {
      const catalogBadge = document.createElement("span");
      catalogBadge.className = "badge semantic catalog-semantic";

      if (row.combinedSemanticScore !== null) {
        catalogBadge.textContent =
          "Relevanz " +
          Math.round(row.combinedSemanticScore * 100).toLocaleString("de-DE") +
          " %";
        const qwenScore =
          row.catalogSemanticScore !== null
            ? Math.round(row.catalogSemanticScore * 100).toLocaleString("de-DE") + " %"
            : "—";
        const siglipScore =
          row.semanticScore !== null
            ? Math.round(row.semanticScore * 100).toLocaleString("de-DE") + " %"
            : "nicht verwendet";
        catalogBadge.title =
          "Hybrides Ranking · Qwen-4B-Text/Konzepte: " + qwenScore +
          " · SigLIP2: " + siglipScore +
          (row.semanticMatchReasons?.length
            ? " · Treffergründe: " + row.semanticMatchReasons.join(" | ")
            : "");
      } else {
        catalogBadge.textContent = "Qwen 4B Inhalt bereit";
        catalogBadge.title =
          row.catalogSemanticModel ??
          "Qwen3-VL-4B-Katalogbeschreibung und Suchkonzepte vorhanden";
      }

      stateCell.appendChild(catalogBadge);
    }

    if (
      row.availability === "AVAILABLE" &&
      row.semanticReady &&
      !row.catalogSemanticReady
    ) {
      const semanticBadge = document.createElement("span");
      semanticBadge.className = "badge semantic";

      if (row.semanticScore !== null) {
        semanticBadge.textContent =
          "SigLIP2 " + Math.round(row.semanticScore * 100).toLocaleString("de-DE") + " %";
        semanticBadge.title =
          "SigLIP2-Suchscore; Qwen-4B-Kataloganalyse für dieses Bild ist noch nicht fertig.";
      } else {
        semanticBadge.textContent = "SigLIP2 bereit";
        semanticBadge.title = row.semanticModel ?? "SigLIP2-Semantikanalyse abgeschlossen";
      }

      stateCell.appendChild(semanticBadge);
    }

    const analysisCell = document.createElement("td");
    analysisCell.className = "analysis-stage-cell";
    const analysisStage = document.createElement("span");
    const displayedStage = displayedMediaAnalysisStage(row);
    analysisStage.className =
      "analysis-stage-badge " +
      (displayedStage ? "done" : "waiting");
    analysisStage.textContent = displayedStage
      ? analysisModuleLabel(displayedStage)
      : "Noch nicht analysiert";
    analysisStage.title = displayedStage
      ? row.analysisStage
        ? "Höchste vollständig abgeschlossene Analyse-Stufe"
        : "Aus bereits gespeicherten Analyseergebnissen abgeleitete Stufe"
      : "Für diese Datei ist noch keine Analyse-Stufe vollständig abgeschlossen.";
    analysisCell.appendChild(analysisStage);

    const analysisFacts: string[] = [];
    if (row.faceCount > 0) {
      analysisFacts.push(
        row.faceCount.toLocaleString("de-DE") +
        (row.faceCount === 1 ? " Gesicht" : " Gesichter")
      );
    }
    if (row.dogCount > 0) {
      analysisFacts.push(
        row.dogCount.toLocaleString("de-DE") +
        (row.dogCount === 1 ? " Hund" : " Hunde")
      );
    }
    if (row.catCount > 0) {
      analysisFacts.push(
        row.catCount.toLocaleString("de-DE") +
        (row.catCount === 1 ? " Katze" : " Katzen")
      );
    }
    if (row.objectCount > 0) {
      analysisFacts.push(
        row.objectCount.toLocaleString("de-DE") +
        (row.objectCount === 1 ? " Motiv" : " Motive")
      );
    }
    if (row.semanticReady) analysisFacts.push("SigLIP2");
    if (row.catalogSemanticReady) analysisFacts.push("Qwen 4B");

    const identityMarkers = row.markerLabels
      .filter(
        (label) =>
          label.startsWith("Person: ") ||
          label.startsWith("Haustier: ")
      )
      .slice(0, 4)
      .map((label) => label.replace(/^Person: /, "").replace(/^Haustier: /, ""));

    if (identityMarkers.length > 0) {
      analysisFacts.push(identityMarkers.join(", "));
    }

    if (analysisFacts.length > 0) {
      const summary = document.createElement("small");
      summary.className = "analysis-stage-summary";
      summary.textContent = analysisFacts.join(" · ");
      summary.title = "Bereits gespeicherte Analyseergebnisse";
      analysisCell.appendChild(summary);
    }

    const actionCell = document.createElement("td");
    if (row.availability === "MISSING" && row.recycleState === "RESTORABLE") {
      const restoreButton = document.createElement("button");
      restoreButton.className = "table-action";
      restoreButton.textContent = "Wiederherstellen";
      restoreButton.disabled = restoring;
      restoreButton.addEventListener("click", () => {
        void restoreRow(row, restoreButton);
      });
      actionCell.appendChild(restoreButton);
    } else if (row.recycleState === "AMBIGUOUS") {
      actionCell.textContent = "Keine automatische Aktion";
      actionCell.className = "muted";
      actionCell.title = "Mehrere identische Papierkorb-Dateien passen. Die App trifft absichtlich keine unsichere Auswahl.";
    } else if (row.availability === "AVAILABLE") {
      const lifeAreaButton = document.createElement("button");
      lifeAreaButton.type = "button";
      lifeAreaButton.className = "table-action";
      lifeAreaButton.textContent = "Lebensbereiche";
      lifeAreaButton.addEventListener("click", () => {
        void runSafely(() =>
          openLifeAreaAssignment(row.id, row.relativePath)
        );
      });
      actionCell.appendChild(lifeAreaButton);
    } else {
      actionCell.textContent = "—";
      actionCell.className = "muted";
    }

    tr.append(previewCell, pathCell, typeCell, sizeCell, stateCell, analysisCell, actionCell);
    fragment.appendChild(tr);
  }

  mediaRows.appendChild(fragment);
}

function renderDuplicateGroups(groups: DuplicateGroup[]): void {
  duplicateGroups.replaceChildren();

  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "duplicate-empty";
    empty.textContent = "Keine exakten Dubletten gefunden.";
    duplicateGroups.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const group of groups) {
    const card = document.createElement("article");
    card.className = "duplicate-card";

    const header = document.createElement("div");
    header.className = "duplicate-card-header";

    const titleBlock = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = `${group.count} identische Dateien`;
    const meta = document.createElement("p");
    meta.textContent =
      `${formatBytes(group.sizeBytes)} je Datei · ` +
      `${formatBytes(group.wastedBytes)} potenziell mehrfach belegt`;
    titleBlock.append(title, meta);

    const hash = document.createElement("code");
    hash.className = "duplicate-hash";
    hash.textContent = group.sha256.slice(0, 12);
    hash.title = group.sha256;

    header.append(titleBlock, hash);

    const list = document.createElement("ul");
    list.className = "duplicate-paths";

    for (const item of group.items) {
      const li = document.createElement("li");
      const pathSpan = document.createElement("span");
      pathSpan.textContent = item.relativePath;
      pathSpan.title = item.relativePath;

      const typeSpan = document.createElement("small");
      typeSpan.textContent = item.extension.replace(".", "").toUpperCase();

      li.append(pathSpan, typeSpan);
      list.appendChild(li);
    }

    const note = document.createElement("p");
    note.className = "duplicate-note";
    note.textContent = "Nur markiert – keine Datei wird automatisch gelöscht oder zusammengeführt.";

    card.append(header, list, note);
    fragment.appendChild(card);
  }

  duplicateGroups.appendChild(fragment);
}

function renderIdentityTabStats(stats: IdentityTabStats): void {
  const ungroupedFaces = Math.max(
    0,
    stats.unassignedFaceEmbeddings - stats.personCandidateFaces
  );
  const ungroupedDogs = Math.max(
    0,
    stats.unassignedDogEmbeddings - stats.petCandidateDetections
  );

  peopleTabCount.textContent =
    stats.personCandidates.toLocaleString("de-DE") +
    " Gr. · " +
    stats.personCandidateFaces.toLocaleString("de-DE") +
    " Ges.";
  peopleTabCount.title =
    "Alle aktiven Quellen · " +
    stats.personCandidates.toLocaleString("de-DE") +
    " unbestätigte Personengruppen mit " +
    stats.personCandidateFaces.toLocaleString("de-DE") +
    " Gesichtern in echten Gruppen · " +
    ungroupedFaces.toLocaleString("de-DE") +
    " Einzelgesichter aktuell ohne Gruppe · " +
    stats.embeddedFaces.toLocaleString("de-DE") +
    " Gesichtsmerkmale gespeichert · " +
    stats.detectedFaces.toLocaleString("de-DE") +
    " Gesichter erkannt · " +
    stats.assignedPersonFaces.toLocaleString("de-DE") +
    " Gesichter bereits bestätigt/zugeordnet";

  petsTabCount.textContent =
    stats.petCandidates.toLocaleString("de-DE") +
    " Gr. · " +
    stats.petCandidateDetections.toLocaleString("de-DE") +
    " Hunde";
  petsTabCount.title =
    "Alle aktiven Quellen · " +
    stats.petCandidates.toLocaleString("de-DE") +
    " unbestätigte Hundegruppen mit " +
    stats.petCandidateDetections.toLocaleString("de-DE") +
    " Fundstellen in echten Gruppen · " +
    ungroupedDogs.toLocaleString("de-DE") +
    " einzelne Hund-Fundstellen aktuell ohne Gruppe · " +
    stats.embeddedDogs.toLocaleString("de-DE") +
    " Hundemerkmale gespeichert · " +
    stats.fusedDogs.toLocaleString("de-DE") +
    " Hunde nach Ensemble-Fusion erkannt · " +
    stats.assignedPetDetections.toLocaleString("de-DE") +
    " Hundefundstellen bereits bestätigt/zugeordnet";
}

async function refreshIdentityTabStats(): Promise<void> {
  const enabledSources = sources.filter((source) => source.enabled);
  const aggregate: IdentityTabStats = {
    personCandidates: 0,
    personCandidateFaces: 0,
    detectedFaces: 0,
    embeddedFaces: 0,
    unassignedFaceEmbeddings: 0,
    persons: 0,
    assignedPersonFaces: 0,
    petCandidates: 0,
    petCandidateDetections: 0,
    fusedDogs: 0,
    embeddedDogs: 0,
    unassignedDogEmbeddings: 0,
    pets: 0,
    assignedPetDetections: 0
  };

  const statsList = await Promise.all(
    enabledSources.map((source) =>
      window.imageSorter.catalog.getStats(source.id)
    )
  );

  for (const stats of statsList) {
    aggregate.personCandidates += stats.personCandidates;
    aggregate.personCandidateFaces += stats.personCandidateFaces;
    aggregate.detectedFaces += stats.detectedFaces;
    aggregate.embeddedFaces += stats.embeddedFaces;
    aggregate.unassignedFaceEmbeddings += stats.unassignedFaceEmbeddings;
    aggregate.persons += stats.persons;
    aggregate.assignedPersonFaces += stats.assignedPersonFaces;
    aggregate.petCandidates += stats.petCandidates;
    aggregate.petCandidateDetections += stats.petCandidateDetections;
    aggregate.fusedDogs += stats.fusedDogs;
    aggregate.embeddedDogs += stats.embeddedDogs;
    aggregate.unassignedDogEmbeddings += stats.unassignedDogEmbeddings;
    aggregate.pets += stats.pets;
    aggregate.assignedPetDetections += stats.assignedPetDetections;
  }

  renderIdentityTabStats(aggregate);
}

function scheduleIdentityTabStatsRefresh(): void {
  if (identityStatsRefreshTimer !== null) {
    window.clearTimeout(identityStatsRefreshTimer);
  }

  identityStatsRefreshTimer = window.setTimeout(() => {
    identityStatsRefreshTimer = null;
    void refreshIdentityTabStats().catch(() => {
      // Live-Zähler dürfen die Oberfläche bei einem kurzzeitigen DB-Fehler nicht blockieren.
    });
  }, 750);
}

function renderPersonOverview(overview: PersonOverview): void {
  personCandidates.replaceChildren();
  confirmedPersons.replaceChildren();

  personConfirmAllMedia.classList.toggle("active", personConfirmationMediaFilter === "all");
  personConfirmImagesOnly.classList.toggle("active", personConfirmationMediaFilter === "image");
  personConfirmVideosOnly.classList.toggle("active", personConfirmationMediaFilter === "video");

  const visibleCandidates =
    personConfirmationMediaFilter === "video" ? [] : overview.candidates;
  const visiblePersons = overview.persons.filter((person) => {
    if (personConfirmationMediaFilter === "image") return person.faceCount > 0;
    if (personConfirmationMediaFilter === "video") return person.videoHits.length > 0;
    return true;
  });

  const assignedFaces = overview.persons.reduce(
    (sum, person) => sum + person.faceCount,
    0
  );

  const candidateWindowTruncated =
    overview.candidates.length < overview.candidateTotal;
  const candidateWindowText = candidateWindowTruncated
    ? "Gezeigt werden die " +
      overview.candidates.length.toLocaleString("de-DE") +
      " größten von " +
      overview.candidateTotal.toLocaleString("de-DE") +
      " Gruppen. "
    : overview.candidateTotal.toLocaleString("de-DE") +
      (overview.candidateTotal === 1 ? " Gruppe. " : " Gruppen. ");

  if (personConfirmationMediaFilter === "video") {
    const videoCount = visiblePersons.reduce(
      (sum, person) => sum + new Set(person.videoHits.map((hit) => hit.mediaId)).size,
      0
    );
    personStatus.textContent =
      visiblePersons.length.toLocaleString("de-DE") +
      (visiblePersons.length === 1
        ? " bestätigte Person mit Videotreffern · "
        : " bestätigte Personen mit Videotreffern · ") +
      videoCount.toLocaleString("de-DE") +
      (videoCount === 1 ? " Video." : " Videos.") +
      " Neue, noch unbekannte Personen werden aus Videos derzeit nicht als Bestätigungsgruppe erzeugt.";
  } else if (overview.clusteringPending) {
    personStatus.textContent =
      candidateWindowText +
      overview.candidateFaceTotal.toLocaleString("de-DE") +
      " Gesichter in Gruppen · " +
      overview.ungroupedFaceTotal.toLocaleString("de-DE") +
      " Einzelgesichter ohne Gruppe · " +
      assignedFaces.toLocaleString("de-DE") +
      " Gesichter bereits bestätigt. " +
      "Neue SFace-Ergebnisse werden während der laufenden Analyse regelmäßig neu gruppiert.";
  } else if (overview.candidateTotal > 0) {
    personStatus.textContent =
      candidateWindowText +
      overview.candidateFaceTotal.toLocaleString("de-DE") +
      " Gesichter in Gruppen · " +
      overview.ungroupedFaceTotal.toLocaleString("de-DE") +
      " Einzelgesichter ohne Gruppe · " +
      assignedFaces.toLocaleString("de-DE") +
      " Gesichter bereits bestätigt.";
  } else {
    personStatus.textContent =
      "Aktuell gibt es keine unbestätigten Personengruppen. " +
      overview.ungroupedFaceTotal.toLocaleString("de-DE") +
      " Einzelgesichter haben derzeit keine Gruppe · " +
      assignedFaces.toLocaleString("de-DE") + " Gesichter sind bereits bestätigt.";
  }

  if (visibleCandidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty";
    empty.textContent =
      personConfirmationMediaFilter === "video"
        ? "Keine unbestätigten Videogruppen. Die Videoanalyse ordnet derzeit nur bereits bestätigte Personen wieder zu."
        : overview.clusteringPending
          ? "Warte auf die laufende Gesichtsmerkmals-Analyse …"
          : "Keine Personengruppen zu bestätigen.";
    personCandidates.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const candidate of visibleCandidates) {
      const card = document.createElement("article");
      card.className = "person-candidate-card";

      const faceStrip = document.createElement("div");
      faceStrip.className = "person-face-strip";

      for (const face of candidate.faces) {
        const figure = document.createElement("figure");
        figure.className = "person-face";
        if (face.faceDetectionId === candidate.representativeFaceId) {
          figure.classList.add("representative");
        }

        const img = document.createElement("img");
        img.src = faceCropUrl(face.faceDetectionId);
        img.alt = "";
        img.loading = "lazy";
        img.title =
          `${face.relativePath}\nÄhnlichkeit zur Gruppe: ${face.similarity.toFixed(3)}`;
        makePreviewable(img, face.mediaId, face.relativePath);

        const fallback = document.createElement("span");
        fallback.className = "face-fallback";
        fallback.textContent = "Gesicht";
        fallback.hidden = true;

        img.addEventListener("error", () => {
          img.hidden = true;
          fallback.hidden = false;
        });

        figure.append(img, fallback);

        if (candidate.faceCount > 1) {
          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.className = "face-correction-button";
          removeButton.textContent = "×";
          removeButton.title = "Dieses Gesicht aus der vorgeschlagenen Gruppe lösen";
          removeButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();

            void runSafely(async () => {
              removeButton.disabled = true;
              progressText.textContent =
                "Gesicht wird dauerhaft aus dieser Gruppierung getrennt …";

              await window.imageSorter.people.removeCandidateFace(
                candidate.id,
                face.faceDetectionId
              );

              const sourceId = selectedSourceId();
              if (sourceId !== null) {
                await loadPersonOverview(sourceId, true);
                if (currentView === "media") {
    showTableLoading("Medienbibliothek wird geladen …");
    librarySummary.textContent = "Medien werden geladen …";
  } else if (currentView === "duplicates") {
    showBlockLoading(duplicateGroups, "Dubletten werden geladen …");
  } else if (currentView === "recycle") {
    showTableLoading("Papierkorb-Daten werden geladen …");
  } else if (currentView === "search") {
    showTableLoading("Suchdaten werden geladen …");
  }

  const stats = await window.imageSorter.catalog.getStats(sourceId);
                await refreshIdentityTabStats();
              }

              progressText.textContent =
                "Korrektur gespeichert. Die automatische Gruppierung berücksichtigt diese Trennung künftig.";
            });
          });
          figure.appendChild(removeButton);
        }

        faceStrip.appendChild(figure);
      }

      const body = document.createElement("div");
      body.className = "person-candidate-body";

      const heading = document.createElement("div");
      heading.className = "person-candidate-heading";

      const titleBlock = document.createElement("div");
      const title = document.createElement("h4");
      title.textContent =
        `${candidate.faceCount.toLocaleString("de-DE")} ` +
        `${candidate.faceCount === 1 ? "Fundstelle" : "Fundstellen"}`;

      const similarity = document.createElement("p");
      similarity.textContent =
        `Gruppenähnlichkeit Ø ${candidate.averageSimilarity.toFixed(3)} · ` +
        `Minimum ${candidate.minSimilarity.toFixed(3)}`;

      titleBlock.append(title, similarity);

      if (
        candidate.ignoredIdentityId !== null &&
        candidate.ignoredSimilarity !== null
      ) {
        const warning = document.createElement("p");
        warning.className = "ignore-warning";
        warning.textContent =
          "Hinweis: Diese Gruppe ähnelt einer bereits dauerhaft verworfenen Person " +
          "(Ähnlichkeit " + candidate.ignoredSimilarity.toFixed(3) + "). " +
          "Wenn es doch eine andere Person ist, kannst du sie trotzdem hinzufügen.";
        titleBlock.appendChild(warning);
      }

      const reviewGroupButton = document.createElement("button");
      reviewGroupButton.type = "button";
      reviewGroupButton.className = "ghost candidate-review-open";
      reviewGroupButton.textContent = "Gruppe öffnen";
      reviewGroupButton.title =
        "Alle Fundstellen groß anzeigen und einzeln zuordnen";
      reviewGroupButton.addEventListener("click", () => {
        openPersonCandidateReview(candidate, overview);
      });
      heading.append(titleBlock, reviewGroupButton);

      const confirmRow = document.createElement("div");
      confirmRow.className = "person-confirm-row";

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 120;
      input.placeholder = "Name der Person";
      input.autocomplete = "off";

      const nameField = createIdentityNameField(
        input,
        overview.persons.map((person) => ({
          id: person.id,
          name: person.name,
          count: person.faceCount,
          previewUrl:
            person.representativeFaceId === null
              ? null
              : faceCropUrl(person.representativeFaceId)
        }))
      );

      const button = document.createElement("button");
      button.className = "primary person-confirm";
      button.type = "button";

      const similarityMatches = createIdentitySimilarityList(
        "Ähnlichste bereits bestätigte Personen",
        candidate.suggestedPersons.map((suggestion) => ({
          id: suggestion.personId,
          name: suggestion.personName,
          similarity: suggestion.similarity,
          previewUrl:
            suggestion.representativeFaceId === null
              ? null
              : faceCropUrl(suggestion.representativeFaceId)
        })),
        input,
        () => {
          window.setTimeout(() => {
            button.click();
          }, 0);
        }
      );

      const updateConfirmLabel = () => {
        const entered = input.value.trim();
        if (!entered) {
          button.textContent =
            candidate.ignoredIdentityId !== null
              ? "Trotzdem hinzufügen"
              : "Bestätigen";
          return;
        }

        const existing = overview.persons.find(
          (person) =>
            normalizedIdentityName(person.name) === normalizedIdentityName(entered)
        );

        if (candidate.ignoredIdentityId !== null) {
          button.textContent = existing
            ? "Trotzdem " + existing.name + " zuordnen"
            : "Trotzdem als " + entered + " hinzufügen";
        } else {
          button.textContent = existing
            ? existing.name + " zuordnen"
            : "Als " + entered + " bestätigen";
        }
      };

      updateConfirmLabel();
      input.addEventListener("input", updateConfirmLabel);

      const confirm = async () => {
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }

        input.disabled = true;
        button.disabled = true;
        button.textContent = "Bestätige…";
        progressText.textContent =
          "Personengruppe wird als „" + name + "“ bestätigt …";

        try {
          const fallbackFaceDetectionId =
            candidate.representativeFaceId ??
            candidate.faces[0]?.faceDetectionId;

          const result = await window.imageSorter.people.confirmCandidate(
            candidate.id,
            name,
            fallbackFaceDetectionId,
            candidate.faceCount,
            candidate.memberSignature
          );
          button.textContent = "Bestätigt ✓";
          progressText.textContent =
            `${result.name}: ${result.faceCount.toLocaleString("de-DE")} ` +
            `${result.faceCount === 1 ? "Gesicht bestätigt" : "Gesichter bestätigt"}.`;

          const sourceId = selectedSourceId();
          if (sourceId !== null) {
            // Nur die Personenansicht neu laden. Das ist bewusst read-only und
            // löst kein komplettes Re-Clustering tausender Gesichter aus.
            await loadPersonOverview(sourceId);
          } else {
            card.remove();
            await refreshIdentityTabStats();
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          progressText.textContent = "Bestätigung fehlgeschlagen: " + message;
          personStatus.textContent = "Bestätigung fehlgeschlagen: " + message;
          input.disabled = false;
          button.disabled = false;
          updateConfirmLabel();
        }
      };

      const ignoreButton = document.createElement("button");
      ignoreButton.className = "ghost ignore-candidate-button";
      ignoreButton.type = "button";
      ignoreButton.textContent =
        candidate.ignoredIdentityId !== null
          ? "Ebenfalls dauerhaft ignorieren"
          : "Dauerhaft ignorieren";
      ignoreButton.title =
        "Diese Person nicht als Identität speichern und bei eindeutigen zukünftigen Treffern nicht erneut anzeigen.";

      ignoreButton.addEventListener("click", () => {
        const message =
          candidate.ignoredIdentityId !== null
            ? "Diese Gruppe der bereits verworfenen Person zuordnen und künftig bei eindeutigen Treffern automatisch ausblenden?"
            : "Diese Person dauerhaft ignorieren? Die Merkmale werden nur in der Ignore-Liste gespeichert, damit sie künftig nicht erneut angeboten wird.";

        if (!window.confirm(message)) return;

        void runSafely(async () => {
          input.disabled = true;
          button.disabled = true;
          ignoreButton.disabled = true;
          ignoreButton.textContent = "Wird ignoriert …";

          const fallbackFaceDetectionId =
            candidate.representativeFaceId ??
            candidate.faces[0]?.faceDetectionId;

          const result = await window.imageSorter.people.ignoreCandidate(
            candidate.id,
            fallbackFaceDetectionId,
            candidate.faceCount,
            candidate.memberSignature,
            candidate.ignoredIdentityId ?? undefined
          );

          progressText.textContent =
            result.faceCount.toLocaleString("de-DE") +
            " Gesichter dauerhaft ignoriert. Eindeutige zukünftige Treffer werden automatisch ausgeblendet.";

          const sourceId = selectedSourceId();
          if (sourceId !== null) await loadPersonOverview(sourceId);
          await refreshIdentityTabStats();
        });
      });

      button.addEventListener("click", () => void confirm());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void confirm();
      });

      confirmRow.append(nameField, button, ignoreButton);
      if (candidate.faceCount > candidate.faces.length) {
        const hiddenNote = document.createElement("small");
        hiddenNote.className = "person-hidden-note";
        hiddenNote.textContent =
          "Es werden " + candidate.faces.length + " von " +
          candidate.faceCount + " Fundstellen angezeigt.";
        body.append(heading);
        if (similarityMatches) body.appendChild(similarityMatches);
        body.append(hiddenNote, confirmRow);
      } else {
        body.append(heading);
        if (similarityMatches) body.appendChild(similarityMatches);
        body.append(confirmRow);
      }
      card.append(faceStrip, body);
      fragment.appendChild(card);
    }

    personCandidates.appendChild(fragment);
  }

  if (visiblePersons.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty compact";
    empty.textContent =
      personConfirmationMediaFilter === "video"
        ? "Keine bestätigte Person mit Videotreffern vorhanden."
        : personConfirmationMediaFilter === "image"
          ? "Keine bestätigte Person mit Bildtreffern vorhanden."
          : "Noch keine Personen bestätigt.";
    confirmedPersons.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const person of visiblePersons) {
      const card = document.createElement("article");
      card.className = "confirmed-person-card";

      const header = document.createElement("div");
      header.className = "confirmed-person-header";

      if (person.representativeFaceId !== null) {
        const img = document.createElement("img");
        img.src = faceCropUrl(person.representativeFaceId);
        img.alt = "";
        img.loading = "lazy";
        const representative = person.faces.find(
          (face) => face.faceDetectionId === person.representativeFaceId
        );
        if (representative) {
          makePreviewable(img, representative.mediaId, representative.relativePath);
        }
        header.appendChild(img);
      }

      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = person.name;
      const count = document.createElement("small");
      const personVideoCount = new Set(
        person.videoHits.map((hit) => hit.mediaId)
      ).size;
      count.textContent =
        person.faceCount.toLocaleString("de-DE") +
        (person.faceCount === 1 ? " Bildtreffer" : " Bildtreffer") +
        " · " +
        personVideoCount.toLocaleString("de-DE") +
        (personVideoCount === 1 ? " Video" : " Videos");
      text.append(name, count);
      header.appendChild(text);
      card.appendChild(header);

      const faceStrip = document.createElement("div");
      faceStrip.className = "confirmed-face-strip";

      for (const face of person.faces) {
        const figure = document.createElement("figure");
        figure.className = "person-face confirmed-face";

        const img = document.createElement("img");
        img.src = faceCropUrl(face.faceDetectionId);
        img.alt = "";
        img.loading = "lazy";
        img.title = face.relativePath;
        makePreviewable(img, face.mediaId, face.relativePath);

        const fallback = document.createElement("span");
        fallback.className = "face-fallback";
        fallback.textContent = "Gesicht";
        fallback.hidden = true;

        img.addEventListener("error", () => {
          img.hidden = true;
          fallback.hidden = false;
        });

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "face-correction-button";
        removeButton.textContent = "×";
        removeButton.title = "Dieses Gesicht aus „" + person.name + "“ entfernen";
        removeButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();

          const confirmed = window.confirm(
            "Dieses Gesicht wirklich aus „" + person.name + "“ entfernen? " +
            "Die Korrektur wird gespeichert und bei späteren Gruppierungen berücksichtigt."
          );
          if (!confirmed) return;

          void runSafely(async () => {
            removeButton.disabled = true;
            const result = await window.imageSorter.people.removePersonFace(
              person.id,
              face.faceDetectionId
            );

            const sourceId = selectedSourceId();
            if (sourceId !== null) {
              await loadPersonOverview(sourceId, true);
            }

            progressText.textContent =
              result.affectedFaces.toLocaleString("de-DE") + " " +
              (result.affectedFaces === 1 ? "Gesicht wurde" : "Gesichter wurden") +
              " aus „" + person.name + "“ entfernt.";
          });
        });

        figure.append(img, fallback, removeButton);
        faceStrip.appendChild(figure);
      }

      card.appendChild(faceStrip);

      if (person.faceCount > person.faces.length) {
        const hiddenNote = document.createElement("small");
        hiddenNote.className = "person-hidden-note confirmed-note";
        hiddenNote.textContent =
          "Es werden " + person.faces.length + " von " +
          person.faceCount + " Gesichtern angezeigt.";
        card.appendChild(hiddenNote);
      }

      const controls = document.createElement("div");
      controls.className = "confirmed-person-controls";

      const renameGroup = document.createElement("div");
      renameGroup.className = "person-control-group";

      const renameInput = document.createElement("input");
      renameInput.type = "text";
      renameInput.maxLength = 120;
      renameInput.value = person.name;
      renameInput.setAttribute("aria-label", "Name von " + person.name);

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "ghost";
      renameButton.textContent = "Umbenennen";
      renameButton.addEventListener("click", () => {
        const newName = renameInput.value.trim();
        if (!newName || newName === person.name) return;

        void runSafely(async () => {
          renameButton.disabled = true;
          await window.imageSorter.people.renamePerson(person.id, newName);
          const sourceId = selectedSourceId();
          if (sourceId !== null) await loadPersonOverview(sourceId);
          progressText.textContent = "Person wurde in „" + newName + "“ umbenannt.";
        });
      });

      renameGroup.append(renameInput, renameButton);
      controls.appendChild(renameGroup);

      const mergeTargets = overview.persons.filter((item) => item.id !== person.id);
      if (mergeTargets.length > 0) {
        const mergeGroup = document.createElement("div");
        mergeGroup.className = "person-control-group";

        const select = document.createElement("select");
        select.setAttribute(
          "aria-label",
          person.name + " mit anderer Person zusammenführen"
        );

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Zusammenführen mit …";
        select.appendChild(placeholder);

        for (const target of mergeTargets) {
          const option = document.createElement("option");
          option.value = String(target.id);
          option.textContent = target.name;
          select.appendChild(option);
        }

        const mergeButton = document.createElement("button");
        mergeButton.type = "button";
        mergeButton.className = "ghost";
        mergeButton.textContent = "Zusammenführen";
        mergeButton.addEventListener("click", () => {
          const targetId = Number(select.value);
          if (!Number.isInteger(targetId) || targetId <= 0) return;

          const target = overview.persons.find((item) => item.id === targetId);
          if (!target) return;

          const confirmed = window.confirm(
            "„" + person.name + "“ vollständig mit „" + target.name +
            "“ zusammenführen? Danach bleibt „" + target.name + "“ als Person bestehen."
          );
          if (!confirmed) return;

          void runSafely(async () => {
            mergeButton.disabled = true;
            const result = await window.imageSorter.people.mergePersons(
              target.id,
              person.id
            );

            const sourceId = selectedSourceId();
            if (sourceId !== null) await loadPersonOverview(sourceId, true);

            progressText.textContent =
              "Zusammengeführt: „" + result.name + "“ hat jetzt " +
              result.faceCount.toLocaleString("de-DE") +
              " bestätigte Gesichter.";
          });
        });

        mergeGroup.append(select, mergeButton);
        controls.appendChild(mergeGroup);
      }

      card.appendChild(controls);
      fragment.appendChild(card);
    }

    confirmedPersons.appendChild(fragment);
  }
}

async function loadPersonOverview(
  sourceId: number,
  forceRefresh = false
): Promise<void> {
  refreshPeopleButton.disabled = true;
  showBlockLoading(personCandidates, "Personenvorschläge werden geladen …");
  showBlockLoading(confirmedPersons, "Bestätigte Personen werden geladen …");
  personStatus.textContent = "Personendaten werden geladen …";
  try {
    const overview = await window.imageSorter.people.getOverview(
      sourceId,
      forceRefresh
    );
    lastPersonOverview = overview;
    renderPersonOverview(overview);
    await refreshIdentityTabStats();
  } finally {
    refreshPeopleButton.disabled = false;
  }
}


function renderPetOverview(overview: PetOverview): void {
  petCandidates.replaceChildren();
  confirmedPets.replaceChildren();

  petConfirmAllMedia.classList.toggle("active", petConfirmationMediaFilter === "all");
  petConfirmImagesOnly.classList.toggle("active", petConfirmationMediaFilter === "image");
  petConfirmVideosOnly.classList.toggle("active", petConfirmationMediaFilter === "video");

  const visibleCandidates =
    petConfirmationMediaFilter === "video" ? [] : overview.candidates;
  const visiblePets = overview.pets.filter((pet) => {
    if (petConfirmationMediaFilter === "image") return pet.detectionCount > 0;
    if (petConfirmationMediaFilter === "video") return pet.videoHits.length > 0;
    return true;
  });

  const assignedDogs = overview.pets.reduce(
    (sum, pet) => sum + pet.detectionCount,
    0
  );

  const petWindowTruncated =
    overview.candidates.length < overview.candidateTotal;
  const petWindowText = petWindowTruncated
    ? "Gezeigt werden die " +
      overview.candidates.length.toLocaleString("de-DE") +
      " größten von " +
      overview.candidateTotal.toLocaleString("de-DE") +
      " Hundegruppen. "
    : overview.candidateTotal.toLocaleString("de-DE") +
      (overview.candidateTotal === 1 ? " Hundegruppe. " : " Hundegruppen. ");

  if (petConfirmationMediaFilter === "video") {
    const videoCount = visiblePets.reduce(
      (sum, pet) => sum + new Set(pet.videoHits.map((hit) => hit.mediaId)).size,
      0
    );
    petStatus.textContent =
      visiblePets.length.toLocaleString("de-DE") +
      (visiblePets.length === 1
        ? " bestätigtes Haustier mit Videotreffern · "
        : " bestätigte Haustiere mit Videotreffern · ") +
      videoCount.toLocaleString("de-DE") +
      (videoCount === 1 ? " Video." : " Videos.") +
      " Neue, noch unbekannte Hunde werden aus Videos derzeit nicht als Bestätigungsgruppe erzeugt.";
  } else if (overview.clusteringPending) {
    petStatus.textContent =
      petWindowText +
      overview.candidateDetectionTotal.toLocaleString("de-DE") +
      " Hundefundstellen in Gruppen · " +
      overview.ungroupedDetectionTotal.toLocaleString("de-DE") +
      " einzelne Hundefundstellen ohne Gruppe · " +
      assignedDogs.toLocaleString("de-DE") +
      " Fundstellen bereits einem Hund zugeordnet. " +
      "Neue Dog-ReID-Ergebnisse werden während der laufenden Analyse regelmäßig neu gruppiert.";
  } else if (overview.candidateTotal > 0) {
    petStatus.textContent =
      petWindowText +
      overview.candidateDetectionTotal.toLocaleString("de-DE") +
      " Hundefundstellen in Gruppen · " +
      overview.ungroupedDetectionTotal.toLocaleString("de-DE") +
      " einzelne Hundefundstellen ohne Gruppe · " +
      assignedDogs.toLocaleString("de-DE") +
      " Fundstellen sind bereits zugeordnet.";
  } else {
    petStatus.textContent =
      "Aktuell gibt es keine unbestätigten Hundegruppen. " +
      overview.ungroupedDetectionTotal.toLocaleString("de-DE") +
      " einzelne Hundefundstellen haben derzeit keine Gruppe · " +
      assignedDogs.toLocaleString("de-DE") +
      " Hundefundstellen sind bereits zugeordnet.";
  }

  if (visibleCandidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty";
    empty.textContent =
      petConfirmationMediaFilter === "video"
        ? "Keine unbestätigten Videogruppen. Die Videoanalyse ordnet derzeit nur bereits bestätigte Hunde wieder zu."
        : overview.clusteringPending
          ? "Warte auf die laufende Dog-ReID-Analyse …"
          : "Keine Hundegruppen zu bestätigen.";
    petCandidates.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const candidate of visibleCandidates) {
      const card = document.createElement("article");
      card.className = "person-candidate-card";

      const cropStrip = document.createElement("div");
      cropStrip.className = "person-face-strip pet-split-strip";

      const selectedPetIds = new Set<number>();
      const selectionInputs = new Map<number, HTMLInputElement>();
      let updateSelectionUi = () => {};

      for (const pet of candidate.pets) {
        const figure = document.createElement("figure");
        figure.className = "person-face pet-crop";
        if (pet.petDetectionId === candidate.representativePetId) {
          figure.classList.add("representative");
        }

        const img = document.createElement("img");
        img.src = petCropUrl(pet.petDetectionId);
        img.alt = "";
        img.loading = "lazy";
        img.title =
          pet.relativePath + "\nÄhnlichkeit zur Gruppe: " +
          pet.similarity.toFixed(3);
        makePreviewable(img, pet.mediaId, pet.relativePath);

        const fallback = document.createElement("span");
        fallback.className = "face-fallback";
        fallback.textContent = "Hund";
        fallback.hidden = true;

        img.addEventListener("error", () => {
          img.hidden = true;
          fallback.hidden = false;
        });

        const selector = document.createElement("label");
        selector.className = "pet-split-selector";
        selector.title = "Fundstelle für Aufteilen oder Einzelzuweisung auswählen";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute(
          "aria-label",
          "Fundstelle " + pet.relativePath + " auswählen"
        );
        selectionInputs.set(pet.petDetectionId, checkbox);

        const marker = document.createElement("span");
        marker.textContent = "✓";

        selector.addEventListener("click", (event) => {
          event.stopPropagation();
        });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            selectedPetIds.add(pet.petDetectionId);
            figure.classList.add("split-selected");
          } else {
            selectedPetIds.delete(pet.petDetectionId);
            figure.classList.remove("split-selected");
          }
          updateSelectionUi();
        });

        selector.append(checkbox, marker);
        figure.append(img, fallback, selector);
        cropStrip.appendChild(figure);
      }

      const body = document.createElement("div");
      body.className = "person-candidate-body";

      const heading = document.createElement("div");
      heading.className = "person-candidate-heading";

      const titleBlock = document.createElement("div");
      const title = document.createElement("h4");
      title.textContent =
        candidate.detectionCount.toLocaleString("de-DE") + " " +
        (candidate.detectionCount === 1 ? "Hundefundstelle" : "Hundefundstellen");

      const similarity = document.createElement("p");
      similarity.textContent =
        "Dog-ReID Ähnlichkeit Ø " + candidate.averageSimilarity.toFixed(3) +
        " · Minimum " + candidate.minSimilarity.toFixed(3);

      titleBlock.append(title, similarity);

      if (
        candidate.ignoredIdentityId !== null &&
        candidate.ignoredSimilarity !== null
      ) {
        const warning = document.createElement("p");
        warning.className = "ignore-warning";
        warning.textContent =
          "Hinweis: Diese Hundegruppe ähnelt einem bereits dauerhaft verworfenen Hund " +
          "(Ähnlichkeit " + candidate.ignoredSimilarity.toFixed(3) + "). " +
          "Wenn es doch ein anderer Hund ist, kannst du ihn trotzdem hinzufügen.";
        titleBlock.appendChild(warning);
      }

      const reviewGroupButton = document.createElement("button");
      reviewGroupButton.type = "button";
      reviewGroupButton.className = "ghost candidate-review-open";
      reviewGroupButton.textContent = "Gruppe öffnen";
      reviewGroupButton.title =
        "Alle Fundstellen groß anzeigen und einzeln zuordnen";
      reviewGroupButton.addEventListener("click", () => {
        openPetCandidateReview(candidate, overview);
      });
      heading.append(titleBlock, reviewGroupButton);

      const confirmRow = document.createElement("div");
      confirmRow.className = "person-confirm-row";

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 120;
      input.placeholder = "Name des Hundes";
      input.autocomplete = "off";

      const matchingPets = overview.pets.filter(
        (pet) => pet.petClass === candidate.petClass
      );
      const nameField = createIdentityNameField(
        input,
        matchingPets.map((pet) => ({
          id: pet.id,
          name: pet.name,
          count: pet.detectionCount,
          previewUrl:
            pet.representativePetId === null
              ? null
              : petCropUrl(pet.representativePetId)
        }))
      );

      const selectionPanel = document.createElement("section");
      selectionPanel.className = "pet-selection-panel";

      const selectionHeader = document.createElement("div");
      selectionHeader.className = "pet-selection-header";

      const selectionInfo = document.createElement("div");
      const selectionTitle = document.createElement("strong");
      selectionTitle.textContent = "Gruppe korrigieren";
      const selectionHint = document.createElement("small");
      selectionHint.textContent =
        "Fundstellen links markieren. Einzelne Bilder können direkt zugewiesen oder mehrere dauerhaft abgetrennt werden.";
      selectionInfo.append(selectionTitle, selectionHint);

      const selectionCount = document.createElement("span");
      selectionCount.className = "pet-selection-count";
      selectionHeader.append(selectionInfo, selectionCount);

      const selectionQuickActions = document.createElement("div");
      selectionQuickActions.className = "pet-selection-quick-actions";

      const selectAllButton = document.createElement("button");
      selectAllButton.type = "button";
      selectAllButton.className = "ghost";
      selectAllButton.textContent = "Alle sichtbaren";
      selectAllButton.addEventListener("click", () => {
        for (const [id, checkbox] of selectionInputs) {
          checkbox.checked = true;
          selectedPetIds.add(id);
          checkbox.closest(".person-face")?.classList.add("split-selected");
        }
        updateSelectionUi();
      });

      const clearSelectionButton = document.createElement("button");
      clearSelectionButton.type = "button";
      clearSelectionButton.className = "ghost";
      clearSelectionButton.textContent = "Auswahl aufheben";
      clearSelectionButton.addEventListener("click", () => {
        for (const checkbox of selectionInputs.values()) {
          checkbox.checked = false;
          checkbox.closest(".person-face")?.classList.remove("split-selected");
        }
        selectedPetIds.clear();
        updateSelectionUi();
      });

      selectionQuickActions.append(selectAllButton, clearSelectionButton);

      const selectionAssignRow = document.createElement("div");
      selectionAssignRow.className = "pet-selection-assign-row";

      const selectionNameInput = document.createElement("input");
      selectionNameInput.type = "text";
      selectionNameInput.maxLength = 120;
      selectionNameInput.placeholder = "Markierte Fundstellen zu Hund …";
      selectionNameInput.autocomplete = "off";

      const selectionNameField = createIdentityNameField(
        selectionNameInput,
        matchingPets.map((pet) => ({
          id: pet.id,
          name: pet.name,
          count: pet.detectionCount,
          previewUrl:
            pet.representativePetId === null
              ? null
              : petCropUrl(pet.representativePetId)
        }))
      );

      const assignSelectionButton = document.createElement("button");
      assignSelectionButton.type = "button";
      assignSelectionButton.className = "primary";
      assignSelectionButton.textContent = "Markierte zuweisen";

      const splitSelectionButton = document.createElement("button");
      splitSelectionButton.type = "button";
      splitSelectionButton.className = "secondary";
      splitSelectionButton.textContent = "Als eigene Gruppe abtrennen";

      updateSelectionUi = () => {
        const selectedCount = selectedPetIds.size;
        selectionCount.textContent =
          selectedCount.toLocaleString("de-DE") +
          " von " +
          candidate.detectionCount.toLocaleString("de-DE") +
          " ausgewählt";
        assignSelectionButton.disabled = selectedCount === 0;
        splitSelectionButton.disabled =
          selectedCount === 0 || selectedCount >= candidate.detectionCount;
        clearSelectionButton.disabled = selectedCount === 0;
      };

      assignSelectionButton.addEventListener("click", () => {
        const selected = [...selectedPetIds];
        const name = selectionNameInput.value.trim();
        if (selected.length === 0) return;
        if (!name) {
          selectionNameInput.focus();
          return;
        }

        void runSafely(async () => {
          assignSelectionButton.disabled = true;
          splitSelectionButton.disabled = true;
          progressText.textContent =
            selected.length.toLocaleString("de-DE") +
            (selected.length === 1
              ? " Fundstelle wird "
              : " Fundstellen werden ") +
            "„" + name + "“ zugewiesen …";

          const result =
            await window.imageSorter.pets.assignCandidateSelection(
              candidate.id,
              selected,
              name
            );

          const sourceId = selectedSourceId();
          if (sourceId !== null) await loadPetOverview(sourceId);
          progressText.textContent =
            result.detectionCount.toLocaleString("de-DE") +
            (result.detectionCount === 1
              ? " Fundstelle wurde "
              : " Fundstellen wurden ") +
            "„" + result.name + "“ fest zugewiesen. " +
            result.remainingCount.toLocaleString("de-DE") +
            " bleiben in der ursprünglichen Gruppe.";
        });
      });

      splitSelectionButton.addEventListener("click", () => {
        const selected = [...selectedPetIds];
        if (
          selected.length === 0 ||
          selected.length >= candidate.detectionCount
        ) {
          return;
        }

        void runSafely(async () => {
          assignSelectionButton.disabled = true;
          splitSelectionButton.disabled = true;
          progressText.textContent =
            "Markierte Hundefundstellen werden dauerhaft als eigene Gruppe abgetrennt …";

          const result = await window.imageSorter.pets.splitCandidate(
            candidate.id,
            selected
          );

          const sourceId = selectedSourceId();
          if (sourceId !== null) await loadPetOverview(sourceId);
          progressText.textContent =
            "Gruppe dauerhaft geteilt: " +
            result.selectedCount.toLocaleString("de-DE") +
            " Fundstellen in der neuen Gruppe · " +
            result.remainingCount.toLocaleString("de-DE") +
            " Fundstellen in der ursprünglichen Gruppe.";
        });
      });

      selectionNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && selectedPetIds.size > 0) {
          event.preventDefault();
          assignSelectionButton.click();
        }
      });

      selectionAssignRow.append(
        selectionNameField,
        assignSelectionButton,
        splitSelectionButton
      );
      selectionPanel.append(
        selectionHeader,
        selectionQuickActions,
        selectionAssignRow
      );
      updateSelectionUi();

      const button = document.createElement("button");
      button.className = "primary person-confirm";
      button.type = "button";

      const similarityMatches = createIdentitySimilarityList(
        "Ähnlichste bereits bestätigte Hunde",
        candidate.suggestedPets.map((suggestion) => ({
          id: suggestion.petId,
          name: suggestion.petName,
          similarity: suggestion.similarity,
          previewUrl:
            suggestion.representativePetId === null
              ? null
              : petCropUrl(suggestion.representativePetId)
        })),
        input,
        () => {
          window.setTimeout(() => {
            button.click();
          }, 0);
        }
      );

      const updateConfirmLabel = () => {
        const entered = input.value.trim();
        if (!entered) {
          button.textContent =
            candidate.ignoredIdentityId !== null
              ? "Trotzdem hinzufügen"
              : "Bestätigen";
          return;
        }

        const existing = matchingPets.find(
          (pet) =>
            normalizedIdentityName(pet.name) === normalizedIdentityName(entered)
        );

        if (candidate.ignoredIdentityId !== null) {
          button.textContent = existing
            ? "Trotzdem " + existing.name + " zuordnen"
            : "Trotzdem als " + entered + " hinzufügen";
        } else {
          button.textContent = existing
            ? existing.name + " zuordnen"
            : "Als " + entered + " bestätigen";
        }
      };

      updateConfirmLabel();
      input.addEventListener("input", updateConfirmLabel);

      const confirm = async () => {
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }

        input.disabled = true;
        button.disabled = true;
        button.textContent = "Bestätige…";
        progressText.textContent =
          "Hundegruppe wird als „" + name + "“ bestätigt …";

        try {
          const matchesSuggestion =
            candidate.suggestedPetName !== null &&
            name.toLocaleLowerCase("de-DE") ===
              candidate.suggestedPetName.toLocaleLowerCase("de-DE");

          const rejectedPetId =
            candidate.suggestedPetId !== null && !matchesSuggestion
              ? candidate.suggestedPetId
              : undefined;

          const fallbackPetDetectionId =
            candidate.representativePetId ??
            candidate.pets[0]?.petDetectionId;

          const result = await window.imageSorter.pets.confirmCandidate(
            candidate.id,
            name,
            rejectedPetId,
            fallbackPetDetectionId,
            candidate.detectionCount,
            candidate.memberSignature
          );

          button.textContent = "Bestätigt ✓";
          progressText.textContent =
            result.name + ": " +
            result.detectionCount.toLocaleString("de-DE") + " " +
            (result.detectionCount === 1
              ? "Fundstelle bestätigt."
              : "Fundstellen bestätigt.");

          const sourceId = selectedSourceId();
          if (sourceId !== null) {
            await loadPetOverview(sourceId);
          } else {
            card.remove();
            await refreshIdentityTabStats();
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          progressText.textContent = "Bestätigung fehlgeschlagen: " + message;
          petStatus.textContent = "Bestätigung fehlgeschlagen: " + message;
          input.disabled = false;
          button.disabled = false;
          updateConfirmLabel();
        }
      };

      const ignoreButton = document.createElement("button");
      ignoreButton.className = "ghost ignore-candidate-button";
      ignoreButton.type = "button";
      ignoreButton.textContent =
        candidate.ignoredIdentityId !== null
          ? "Ebenfalls dauerhaft ignorieren"
          : "Dauerhaft ignorieren";
      ignoreButton.title =
        "Diesen Hund nicht als Haustier speichern und bei eindeutigen zukünftigen Treffern nicht erneut anzeigen.";

      ignoreButton.addEventListener("click", () => {
        const message =
          candidate.ignoredIdentityId !== null
            ? "Diese Gruppe dem bereits verworfenen Hund zuordnen und künftig bei eindeutigen Treffern automatisch ausblenden?"
            : "Diesen Hund dauerhaft ignorieren? Die Merkmale werden nur in der Ignore-Liste gespeichert, damit er künftig nicht erneut angeboten wird.";

        if (!window.confirm(message)) return;

        void runSafely(async () => {
          input.disabled = true;
          button.disabled = true;
          ignoreButton.disabled = true;
          ignoreButton.textContent = "Wird ignoriert …";

          const fallbackPetDetectionId =
            candidate.representativePetId ??
            candidate.pets[0]?.petDetectionId;

          const result = await window.imageSorter.pets.ignoreCandidate(
            candidate.id,
            fallbackPetDetectionId,
            candidate.detectionCount,
            candidate.memberSignature,
            candidate.ignoredIdentityId ?? undefined
          );

          progressText.textContent =
            result.detectionCount.toLocaleString("de-DE") +
            " Hundefundstellen dauerhaft ignoriert. Eindeutige zukünftige Treffer werden automatisch ausgeblendet.";

          const sourceId = selectedSourceId();
          if (sourceId !== null) await loadPetOverview(sourceId);
          await refreshIdentityTabStats();
        });
      });

      button.addEventListener("click", () => void confirm());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void confirm();
      });

      confirmRow.append(nameField, button, ignoreButton);

      if (candidate.detectionCount > candidate.pets.length) {
        const hiddenNote = document.createElement("small");
        hiddenNote.className = "person-hidden-note";
        hiddenNote.textContent =
          "Es werden " + candidate.pets.length + " von " +
          candidate.detectionCount + " Fundstellen angezeigt.";
        body.append(heading, selectionPanel);
        if (similarityMatches) body.appendChild(similarityMatches);
        body.append(hiddenNote, confirmRow);
      } else {
        body.append(heading, selectionPanel);
        if (similarityMatches) body.appendChild(similarityMatches);
        body.append(confirmRow);
      }

      card.append(cropStrip, body);
      fragment.appendChild(card);
    }

    petCandidates.appendChild(fragment);
  }

  if (visiblePets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty compact";
    empty.textContent =
      petConfirmationMediaFilter === "video"
        ? "Kein bestätigtes Haustier mit Videotreffern vorhanden."
        : petConfirmationMediaFilter === "image"
          ? "Kein bestätigtes Haustier mit Bildtreffern vorhanden."
          : "Noch keine Haustiere bestätigt.";
    confirmedPets.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const pet of visiblePets) {
      const card = document.createElement("article");
      card.className = "confirmed-person-card";

      const header = document.createElement("div");
      header.className = "confirmed-person-header";

      if (pet.representativePetId !== null) {
        const img = document.createElement("img");
        img.src = petCropUrl(pet.representativePetId);
        img.alt = "";
        img.loading = "lazy";
        const representative = pet.pets.find(
          (item) => item.petDetectionId === pet.representativePetId
        );
        if (representative) {
          makePreviewable(img, representative.mediaId, representative.relativePath);
        }
        header.appendChild(img);
      }

      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = pet.name;
      const count = document.createElement("small");
      const petVideoCount = new Set(
        pet.videoHits.map((hit) => hit.mediaId)
      ).size;
      count.textContent =
        pet.detectionCount.toLocaleString("de-DE") +
        (pet.detectionCount === 1 ? " Bildtreffer" : " Bildtreffer") +
        " · " +
        petVideoCount.toLocaleString("de-DE") +
        (petVideoCount === 1 ? " Video" : " Videos") +
        (pet.automaticCount > 0
          ? " · " + pet.automaticCount.toLocaleString("de-DE") + " automatisch"
          : "");
      const type = document.createElement("small");
      type.textContent = pet.petClass === "dog" ? "Hund" : "Katze";
      text.append(name, count, type);
      header.appendChild(text);
      card.appendChild(header);

      const cropStrip = document.createElement("div");
      cropStrip.className = "confirmed-face-strip";

      for (const detection of pet.pets) {
        const figure = document.createElement("figure");
        figure.className = "person-face confirmed-face pet-crop";

        const isAutomatic =
          detection.assignmentSource === "AUTO_HIGH_CONFIDENCE";
        if (isAutomatic) figure.classList.add("auto-assigned");

        const img = document.createElement("img");
        img.src = petCropUrl(detection.petDetectionId);
        img.alt = "";
        img.loading = "lazy";
        img.title =
          detection.relativePath +
          (isAutomatic && detection.confidence !== null
            ? "\nAutomatisch erkannt · Ähnlichkeit " +
              detection.confidence.toFixed(3)
            : "\nVon dir bestätigt");
        makePreviewable(img, detection.mediaId, detection.relativePath);

        const fallback = document.createElement("span");
        fallback.className = "face-fallback";
        fallback.textContent = "Hund";
        fallback.hidden = true;

        img.addEventListener("error", () => {
          img.hidden = true;
          fallback.hidden = false;
        });

        if (isAutomatic) {
          const autoBadge = document.createElement("span");
          autoBadge.className = "pet-auto-badge";
          autoBadge.textContent =
            detection.confidence === null
              ? "Auto"
              : "Auto " + detection.confidence.toFixed(2);
          autoBadge.title =
            "Automatische Zuordnung. Dieses Bild wird erst nach deiner Bestätigung als Referenz verwendet.";
          figure.appendChild(autoBadge);

          const confirmAutoButton = document.createElement("button");
          confirmAutoButton.type = "button";
          confirmAutoButton.className = "pet-auto-confirm-button";
          confirmAutoButton.textContent = "✓";
          confirmAutoButton.title =
            "Diese automatische Zuordnung zu „" + pet.name + "“ bestätigen";
          confirmAutoButton.setAttribute(
            "aria-label",
            "Automatische Zuordnung zu " + pet.name + " bestätigen"
          );
          confirmAutoButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();

            void runSafely(async () => {
              confirmAutoButton.disabled = true;
              const result = await window.imageSorter.pets.confirmPetDetection(
                pet.id,
                detection.petDetectionId
              );
              const sourceId = selectedSourceId();
              if (sourceId !== null) await loadPetOverview(sourceId);
              progressText.textContent =
                result.affectedPets > 0
                  ? "Automatische Zuordnung zu „" + pet.name +
                    "“ wurde von dir bestätigt und darf künftig als Referenz dienen."
                  : "Diese Zuordnung war bereits bestätigt.";
            });
          });

          figure.appendChild(confirmAutoButton);
        }

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "face-correction-button";
        removeButton.textContent = "×";
        removeButton.title =
          "Diese Fundstelle aus „" + pet.name + "“ entfernen";
        removeButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();

          const confirmed = window.confirm(
            "Diese Hundefundstelle wirklich aus „" + pet.name + "“ entfernen? " +
            "Die Korrektur wird für zukünftige Vorschläge gespeichert."
          );
          if (!confirmed) return;

          void runSafely(async () => {
            removeButton.disabled = true;
            const result = await window.imageSorter.pets.removePetDetection(
              pet.id,
              detection.petDetectionId
            );
            const sourceId = selectedSourceId();
            if (sourceId !== null) await loadPetOverview(sourceId, true);
            progressText.textContent =
              result.affectedPets.toLocaleString("de-DE") + " " +
              (result.affectedPets === 1 ? "Fundstelle wurde" : "Fundstellen wurden") +
              " aus „" + pet.name + "“ entfernt.";
          });
        });

        figure.append(img, fallback, removeButton);
        cropStrip.appendChild(figure);
      }

      card.appendChild(cropStrip);

      const controls = document.createElement("div");
      controls.className = "confirmed-person-controls";

      const renameGroup = document.createElement("div");
      renameGroup.className = "person-control-group";

      const renameInput = document.createElement("input");
      renameInput.type = "text";
      renameInput.maxLength = 120;
      renameInput.value = pet.name;
      renameInput.setAttribute("aria-label", "Name von " + pet.name);

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "ghost";
      renameButton.textContent = "Umbenennen";
      renameButton.addEventListener("click", () => {
        const newName = renameInput.value.trim();
        if (!newName || newName === pet.name) return;

        void runSafely(async () => {
          renameButton.disabled = true;
          await window.imageSorter.pets.renamePet(pet.id, newName);
          const sourceId = selectedSourceId();
          if (sourceId !== null) await loadPetOverview(sourceId);
          progressText.textContent =
            "Haustier wurde in „" + newName + "“ umbenannt.";
        });
      });

      renameGroup.append(renameInput, renameButton);
      controls.appendChild(renameGroup);

      const mergeTargets = overview.pets.filter(
        (item) => item.id !== pet.id && item.petClass === pet.petClass
      );

      if (mergeTargets.length > 0) {
        const mergeGroup = document.createElement("div");
        mergeGroup.className = "person-control-group";

        const select = document.createElement("select");
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Zusammenführen mit …";
        select.appendChild(placeholder);

        for (const target of mergeTargets) {
          const option = document.createElement("option");
          option.value = String(target.id);
          option.textContent = target.name;
          select.appendChild(option);
        }

        const mergeButton = document.createElement("button");
        mergeButton.type = "button";
        mergeButton.className = "ghost";
        mergeButton.textContent = "Zusammenführen";
        mergeButton.addEventListener("click", () => {
          const targetId = Number(select.value);
          if (!Number.isInteger(targetId) || targetId <= 0) return;

          const target = overview.pets.find((item) => item.id === targetId);
          if (!target) return;

          const confirmed = window.confirm(
            "„" + pet.name + "“ vollständig mit „" + target.name +
            "“ zusammenführen?"
          );
          if (!confirmed) return;

          void runSafely(async () => {
            mergeButton.disabled = true;
            const result = await window.imageSorter.pets.mergePets(
              target.id,
              pet.id
            );
            const sourceId = selectedSourceId();
            if (sourceId !== null) await loadPetOverview(sourceId, true);
            progressText.textContent =
              "Zusammengeführt: „" + result.name + "“ hat jetzt " +
              result.detectionCount.toLocaleString("de-DE") +
              " bestätigte Fundstellen.";
          });
        });

        mergeGroup.append(select, mergeButton);
        controls.appendChild(mergeGroup);
      }

      card.appendChild(controls);
      fragment.appendChild(card);
    }

    confirmedPets.appendChild(fragment);
  }
}

async function loadPetOverview(
  sourceId: number,
  forceRefresh = false
): Promise<void> {
  refreshPetsButton.disabled = true;
  showBlockLoading(petCandidates, "Haustiergruppen werden geladen …");
  showBlockLoading(confirmedPets, "Bestätigte Haustiere werden geladen …");
  petStatus.textContent = "Haustierdaten werden geladen …";
  try {
    const overview = await window.imageSorter.pets.getOverview(
      sourceId,
      forceRefresh
    );
    lastPetOverview = overview;
    renderPetOverview(overview);
    await refreshIdentityTabStats();
  } finally {
    refreshPetsButton.disabled = false;
  }
}

function setPersonConfirmationMediaFilter(filter: ConfirmationMediaFilter): void {
  if (personConfirmationMediaFilter === filter) return;
  personConfirmationMediaFilter = filter;
  if (lastPersonOverview) renderPersonOverview(lastPersonOverview);
}

function setPetConfirmationMediaFilter(filter: ConfirmationMediaFilter): void {
  if (petConfirmationMediaFilter === filter) return;
  petConfirmationMediaFilter = filter;
  if (lastPetOverview) renderPetOverview(lastPetOverview);
}

personConfirmAllMedia.addEventListener("click", () => {
  setPersonConfirmationMediaFilter("all");
});
personConfirmImagesOnly.addEventListener("click", () => {
  setPersonConfirmationMediaFilter("image");
});
personConfirmVideosOnly.addEventListener("click", () => {
  setPersonConfirmationMediaFilter("video");
});
petConfirmAllMedia.addEventListener("click", () => {
  setPetConfirmationMediaFilter("all");
});
petConfirmImagesOnly.addEventListener("click", () => {
  setPetConfirmationMediaFilter("image");
});
petConfirmVideosOnly.addEventListener("click", () => {
  setPetConfirmationMediaFilter("video");
});

const analysisModuleLabels: Record<string, string> = {
  "file-probe-v1": "Technische Prüfung",
  "thumbnail-v1": "Thumbnail",
  "image-metadata-v1": "Bildmetadaten",
  "video-analyze-v1": "Video · Personen, Haustiere & Motive",
  "face-detect-yunet-v1": "Gesichter erkennen (YuNet)",
  "face-embed-sface-v1": "Gesichtsmerkmale (SFace)",
  "pet-detect-nanodet-v1": "Haustierdetektor NanoDet",
  "pet-detect-yolox-v1": "Haustierdetektor YOLOX-S",
  "pet-fuse-ensemble-v1": "Haustier-Ergebnisse fusionieren",
  "pet-embed-dogreid-v1": "Individuelle Hundemerkmale",
  "catalog-semantic-qwen3vl4b-v3": "Kataloginhalt · Qwen3-VL 4B · Gesamtbild + 4 Teilbilder",
  "object-detect-qwen3vl-gguf-v2": "Legacy · Qwen3-VL-8B",
  "semantic-embed-siglip2-v1": "Semantikanalyse (SigLIP2 So400m NaFlex)"
};

function analysisModuleLabel(module: string): string {
  return analysisModuleLabels[module] ?? module;
}

function displayedMediaAnalysisStage(row: MediaRecord): string {
  if (row.analysisStage) return row.analysisStage;
  if (row.catalogSemanticReady) return "catalog-semantic-qwen3vl4b-v3";
  if (row.semanticReady) return "semantic-embed-siglip2-v1";
  if (row.petCount > 0) return "pet-fuse-ensemble-v1";
  if (row.faceEmbeddingCount > 0) return "face-embed-sface-v1";
  if (row.faceCount > 0) return "face-detect-yunet-v1";
  if (row.thumbnailReady) return "thumbnail-v1";
  return "";
}

function isUnavailableAnalysisError(error: AnalysisErrorRecord): boolean {
  return (
    error.status === "UNAVAILABLE" ||
    error.errorMessage.toLocaleLowerCase("de-DE").includes("nicht erreichbar")
  );
}

function analysisErrorCopyText(error: AnalysisErrorRecord): string {
  return [
    "Image Sortierer – Analysefehler",
    "Stufe: " + analysisModuleLabel(error.module),
    "Modul: " + error.module,
    "Status: " + (isUnavailableAnalysisError(error) ? "Datei nicht erreichbar" : "Analysefehler"),
    "Datei: " + error.relativePath,
    "Dateityp: " + error.extension,
    "Versuche: " + error.attempts.toLocaleString("de-DE"),
    "Gestartet: " + (error.startedAt ?? "—"),
    "Beendet: " + (error.finishedAt ?? "—"),
    "",
    "Fehlermeldung:",
    error.errorMessage
  ].join("\n");
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function renderAnalysisErrors(errors: AnalysisErrorRecord[]): void {
  analysisErrorList.replaceChildren();
  analysisErrorSummary.textContent =
    errors.length.toLocaleString("de-DE") + " " +
    (errors.length === 1 ? "Fehler" : "Fehler");

  if (errors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "analysis-error-empty";
    empty.textContent = "Aktuell sind keine fehlgeschlagenen Analysejobs vorhanden.";
    analysisErrorList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const error of errors) {
    const card = document.createElement("article");
    card.className = "analysis-error-card";

    const header = document.createElement("div");
    header.className = "analysis-error-card-header";

    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = analysisModuleLabel(error.module);

    const meta = document.createElement("small");
    const finished = error.finishedAt
      ? error.finishedAt.replace("T", " ")
      : "Zeitpunkt unbekannt";
    meta.textContent =
      (isUnavailableAnalysisError(error) ? "Datei nicht erreichbar" : "Analysefehler") +
      " · Versuche: " + error.attempts.toLocaleString("de-DE") +
      " · " + finished;

    heading.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "analysis-error-actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "ghost";
    copyButton.textContent = "Kopieren";
    copyButton.addEventListener("click", () => {
      void runSafely(async () => {
        await copyText(analysisErrorCopyText(error));
        progressText.textContent =
          "Analysefehler wurde in die Zwischenablage kopiert.";
      });
    });

    if (isUnavailableAnalysisError(error)) {
      const openFileButton = document.createElement("button");
      openFileButton.type = "button";
      openFileButton.className = "ghost";
      openFileButton.textContent = "Datei öffnen";
      openFileButton.addEventListener("click", () => {
        void runSafely(async () => {
          await window.imageSorter.analysis.openFile(error.mediaId);
          progressText.textContent = "Datei wurde an Windows zum Öffnen übergeben.";
        });
      });

      const openFolderButton = document.createElement("button");
      openFolderButton.type = "button";
      openFolderButton.className = "ghost";
      openFolderButton.textContent = "Ordner öffnen";
      openFolderButton.addEventListener("click", () => {
        void runSafely(async () => {
          await window.imageSorter.analysis.openFolder(error.mediaId);
          progressText.textContent = "Ordner wurde geöffnet.";
        });
      });

      actions.append(openFileButton, openFolderButton);
    }

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "secondary";
    retryButton.textContent = "Erneut versuchen";
    retryButton.addEventListener("click", () => {
      void runSafely(async () => {
        retryButton.disabled = true;
        const result = await window.imageSorter.analysis.retryJob(error.id);
        progressText.textContent =
          result.retried > 0
            ? analysisModuleLabel(error.module) + " wurde erneut eingeplant."
            : isUnavailableAnalysisError(error)
              ? "Die Datei ist weiterhin nicht erreichbar."
              : "Der Fehlerjob ist nicht mehr erneut startbar.";
        await loadAnalysisErrors();
      });
    });

    actions.prepend(copyButton);
    actions.append(retryButton);
    header.append(heading, actions);

    const path = document.createElement("div");
    path.className = "analysis-error-path";
    path.textContent = error.relativePath;
    path.title = error.relativePath;

    const message = document.createElement("pre");
    message.className = "analysis-error-message";
    message.textContent = error.errorMessage;

    card.append(header, path, message);
    fragment.appendChild(card);
  }

  analysisErrorList.appendChild(fragment);
}

async function refreshAnalysisErrorCount(): Promise<number> {
  const sourceId = selectedSourceId() ?? undefined;
  const count = await window.imageSorter.analysis.countErrors(sourceId);
  analysisErrorCount.textContent = count.toLocaleString("de-DE");
  analysisErrorsButton.hidden = count === 0;
  return count;
}

async function loadAnalysisErrors(): Promise<void> {
  showBlockLoading(analysisErrorList, "Analysefehler werden geladen …");
  analysisErrorSummary.textContent = "Wird geladen …";
  const sourceId = selectedSourceId() ?? undefined;
  const [errors, total] = await Promise.all([
    window.imageSorter.analysis.listErrors(sourceId, 300),
    window.imageSorter.analysis.countErrors(sourceId)
  ]);

  renderAnalysisErrors(errors);
  analysisErrorSummary.textContent =
    errors.length < total
      ? errors.length.toLocaleString("de-DE") +
        " von " + total.toLocaleString("de-DE") + " Fehlern angezeigt"
      : total.toLocaleString("de-DE") + " " +
        (total === 1 ? "Fehler" : "Fehler");

  analysisErrorCount.textContent = total.toLocaleString("de-DE");
  analysisErrorsButton.hidden = total === 0;
}

function scheduleWatchCatalogRefresh(): void {
  if (rendererShuttingDown) return;
  if (watchCatalogRefreshTimer !== null) {
    window.clearTimeout(watchCatalogRefreshTimer);
  }

  // Mehrere SCAN_FINISHED-Ereignisse einer Kopierwelle erzeugen nur noch
  // einen UI-Reload. Der Watcher/Katalog selbst läuft davon unabhängig weiter.
  watchCatalogRefreshTimer = window.setTimeout(() => {
    watchCatalogRefreshTimer = null;

    if (
      scanning ||
      restoring ||
      resetting ||
      imagePreviewDialog.open ||
      isEditingPersonView() ||
      isEditingPetView()
    ) {
      scheduleWatchCatalogRefresh();
      return;
    }

    void runSafely(refreshCatalog);
  }, 900);
}

async function loadLibraryRows(
  sourceId: number,
  showLoading = false
): Promise<void> {
  const loadToken = ++libraryLoadToken;
  const mediaKind =
    libraryMediaType.value === "image" || libraryMediaType.value === "video"
      ? libraryMediaType.value
      : "all";

  if (showLoading || libraryRows.length === 0) {
    showTableLoading(
      mediaKind === "video"
        ? "Videos werden geladen …"
        : mediaKind === "image"
          ? "Bilder werden geladen …"
          : "Medienbibliothek wird geladen …"
    );
  }

  const rows = await window.imageSorter.catalog.listMedia(
    sourceId,
    2000,
    mediaKind
  );

  if (
    rendererShuttingDown ||
    loadToken !== libraryLoadToken ||
    currentView !== "media" ||
    selectedSourceId() !== sourceId
  ) {
    return;
  }

  libraryRows = rows;
  updateLibraryMarkOptions(rows);
  applyLibraryView();
}

async function refreshCatalog(): Promise<void> {
  if (rendererShuttingDown) return;
  const sourceId = selectedSourceId();
  scanButton.disabled = sourceId === null || scanning || restoring || resetting;
  resetButton.disabled = scanning || restoring || resetting;

  if (sourceId === null) {
    libraryLoadToken += 1;
    libraryRows = [];
    totalCount.textContent = "0";
    availableCount.textContent = "0";
    missingCount.textContent = "0";
    recycleCount.textContent = "0";
    lastScan.textContent = "—";
    mediaTabCount.textContent = "0";
    searchTabCount.textContent = "0";
    duplicateTabCount.textContent = "0";
    peopleTabCount.textContent = "0";
    petsTabCount.textContent = "0";
    recycleTabCount.textContent = "0";
    renderRows([]);
    renderDuplicateGroups([]);
    renderPersonOverview({
      candidates: [],
      persons: [],
      clusteringPending: false,
      candidateTotal: 0,
      candidateFaceTotal: 0,
      ungroupedFaceTotal: 0
    });
    renderPetOverview({
      candidates: [],
      pets: [],
      clusteringPending: false,
      candidateTotal: 0,
      candidateDetectionTotal: 0,
      ungroupedDetectionTotal: 0
    });
    return;
  }

  // Medienliste sofort losschicken. Sie steht damit in der Worker-Queue vor
  // den weniger wichtigen Zähler-/Statistikabfragen und kann sichtbar werden,
  // ohne auf diese Nebeninformationen zu warten.
  const libraryPromise =
    currentView === "media"
      ? loadLibraryRows(sourceId, libraryRows.length === 0)
      : null;

  const stats = await window.imageSorter.catalog.getStats(sourceId);

  totalCount.textContent = stats.total.toLocaleString("de-DE");
  availableCount.textContent = stats.available.toLocaleString("de-DE");
  missingCount.textContent = stats.missing.toLocaleString("de-DE");
  recycleCount.textContent = stats.recycleBin.toLocaleString("de-DE");
  lastScan.textContent = stats.lastScan ?? "—";
  mediaTabCount.textContent = stats.total.toLocaleString("de-DE");
  duplicateTabCount.textContent = stats.duplicateGroups.toLocaleString("de-DE");
  recycleTabCount.textContent = stats.recycleBin.toLocaleString("de-DE");

  if (currentView === "media") {
    // Zähler aktualisieren die Navigation nur ergänzend. Sie dürfen die
    // eigentliche Medienansicht nicht verzögern.
    void refreshAnalysisErrorCount().catch(() => undefined);
    void refreshIdentityTabStats().catch(() => undefined);
    await libraryPromise;
    return;
  }

  await Promise.all([
    refreshAnalysisErrorCount(),
    refreshIdentityTabStats()
  ]);

  if (currentView === "duplicates") {
    const groups = await window.imageSorter.catalog.listDuplicateGroups(sourceId, 100);
    renderDuplicateGroups(groups);
    return;
  }

  if (currentView === "people") {
    await loadPersonOverview(sourceId);
    return;
  }

  if (currentView === "pets") {
    await loadPetOverview(sourceId);
    return;
  }

  if (currentView === "recycle") {
    const rows = await window.imageSorter.catalog.listRecycleMedia(sourceId, 500);
    renderRows(rows, "Keine wiederherstellbaren oder mehrdeutigen Papierkorb-Einträge.");
    return;
  }

  if (currentView === "search") {
    const searchSourceId = searchScopeSourceId();
    await loadSearchFacets(searchSourceId);
    await runCombinedSearch(searchSourceId);
  }
}

async function loadSources(preselectId?: number): Promise<void> {
  sources = await window.imageSorter.catalog.listSources();
  sourceSelect.replaceChildren();

  if (sources.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Noch keine Medienquelle";
    sourceSelect.appendChild(option);
  } else {
    for (const source of sources) {
      const option = document.createElement("option");
      option.value = String(source.id);
      option.textContent = source.path;
      sourceSelect.appendChild(option);
    }
  }

  if (preselectId !== undefined) sourceSelect.value = String(preselectId);
  renderCatalogWatchState();
  await refreshCatalog();
  await refreshSelectedPipelineStatus();
}

async function runSafely(action: () => Promise<void>): Promise<void> {
  if (rendererShuttingDown) return;
  try {
    workerState.textContent = "Katalog-Worker aktiv";
    workerState.classList.add("ready");
    await action();
  } catch (error) {
    workerState.textContent = "Fehler";
    workerState.classList.remove("ready");
    progressText.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function restoreRow(row: MediaRecord, button: HTMLButtonElement): Promise<void> {
  if (restoring || scanning || resetting) return;

  await runSafely(async () => {
    restoring = true;
    button.disabled = true;
    scanButton.disabled = true;
    resetButton.disabled = true;
    addSourceButton.disabled = true;
    progressText.textContent = `Wiederherstellung läuft: ${row.relativePath}`;

    try {
      const result = await window.imageSorter.catalog.restoreMedia(row.id);
      progressText.textContent = `Wiederhergestellt: ${result.path}`;
      await refreshCatalog();
    } finally {
      restoring = false;
      addSourceButton.disabled = false;
      resetButton.disabled = false;
      scanButton.disabled = selectedSourceId() === null;
    }
  });
}

addSourceButton.addEventListener("click", () => {
  void runSafely(async () => {
    await window.imageSorter.openSourceManager();
    progressText.textContent =
      "Medienquellenverwaltung geöffnet. Änderungen werden beim Zurückkehren übernommen.";
  });
});

scanButton.addEventListener("click", () => {
  const sourceId = selectedSourceId();
  if (sourceId === null || scanning || restoring || resetting) return;

  void runSafely(async () => {
    scanning = true;
    scanButton.disabled = true;
    resetButton.disabled = true;
    addSourceButton.disabled = true;
    progressBar.classList.add("active");
    progressText.textContent = "Scan wird gestartet …";

    try {
      const result = await window.imageSorter.catalog.scanSource(sourceId);
      progressText.textContent =
        `Fertig · ${result.discovered.toLocaleString("de-DE")} Medien gefunden · ` +
        `${result.added.toLocaleString("de-DE")} neu · ` +
        `${result.moved.toLocaleString("de-DE")} verschoben/umbenannt · ` +
        `${result.changed.toLocaleString("de-DE")} geändert · ` +
        `${result.missing.toLocaleString("de-DE")} neu fehlend · ` +
        `${result.recycleBin.toLocaleString("de-DE")} im Papierkorb · ` +
        `${result.errors.toLocaleString("de-DE")} Fehler`;

      await loadSources(sourceId);
    } finally {
      scanning = false;
      addSourceButton.disabled = false;
      resetButton.disabled = false;
      scanButton.disabled = selectedSourceId() === null;
      progressBar.classList.remove("active");
    }
  });
});

resetButton.addEventListener("click", () => {
  if (scanning || restoring || resetting) return;

  const confirmed = window.confirm(
    "Wirklich die komplette Entwicklungsdatenbank zurücksetzen? " +
    "Medienquellen, Katalog, Scan-Historie, Analysejobs, Gesichts-/Haustierzuordnungen, " +
    "Motiverkennung und alle SigLIP2-Semantikvektoren werden vollständig gelöscht. " +
    "Die Originaldateien und die lokal installierten KI-Modelle bleiben unverändert."
  );
  if (!confirmed) return;

  void runSafely(async () => {
    resetting = true;
    resetButton.disabled = true;
    scanButton.disabled = true;
    addSourceButton.disabled = true;
    sourceSelect.disabled = true;
    progressText.textContent = "Katalog wird vollständig zurückgesetzt …";

    try {
      if (identityStatsRefreshTimer !== null) {
        window.clearTimeout(identityStatsRefreshTimer);
        identityStatsRefreshTimer = null;
      }
      if (sourcePipelineRefreshTimer !== null) {
        window.clearTimeout(sourcePipelineRefreshTimer);
        sourcePipelineRefreshTimer = null;
      }
      if (analysisRefreshTimer !== null) {
        window.clearTimeout(analysisRefreshTimer);
        analysisRefreshTimer = null;
      }

      await window.imageSorter.catalog.resetCatalog();
      currentView = "media";
      mediaTab.classList.add("active");
      searchTab.classList.remove("active");
      duplicateTab.classList.remove("active");
      peopleTab.classList.remove("active");
      petsTab.classList.remove("active");
      recycleTab.classList.remove("active");
      searchPanel.hidden = true;
      mediaView.hidden = false;
      duplicateView.hidden = true;
      personView.hidden = true;
      petView.hidden = true;
      clearSearchControls();
      searchFacetsScopeKey = null;
      searchTabCount.textContent = "0";
      searchSummary.textContent = "Noch keine Suche ausgeführt.";
      await loadSources();
      progressText.textContent =
        "Datenbank vollständig und geprüft zurückgesetzt. " +
        "Alle alten Katalog-, Personen-, Hunde-, KI- und Semantikdaten sind entfernt. " +
        "Füge jetzt die gewünschte Medienquelle neu hinzu, um einen sauberen Durchlauf zu starten.";
    } finally {
      resetting = false;
      resetButton.disabled = false;
      addSourceButton.disabled = false;
      sourceSelect.disabled = false;
      scanButton.disabled = selectedSourceId() === null;
    }
  });
});

libraryMediaType.addEventListener("change", () => {
  const sourceId = selectedSourceId();
  if (sourceId === null || currentView !== "media") return;
  void runSafely(() => loadLibraryRows(sourceId, true));
});

for (const control of [
  libraryStatus,
  librarySort,
  libraryGroup
]) {
  control.addEventListener("change", applyLibraryView);
}

libraryTextFilter.addEventListener("input", applyLibraryView);

libraryReset.addEventListener("click", () => {
  const mediaKindChanged = libraryMediaType.value !== "all";
  libraryMediaType.value = "all";
  libraryStatus.value = "all";
  libraryTextFilter.value = "";
  librarySort.value = "captured-desc";
  libraryGroup.value = "none";
  selectedLibraryMarks.clear();

  const sourceId = selectedSourceId();
  if (mediaKindChanged && sourceId !== null && currentView === "media") {
    void runSafely(() => loadLibraryRows(sourceId, true));
    return;
  }

  updateLibraryMarkOptions(libraryRows);
  applyLibraryView();
});

mediaTab.addEventListener("click", () => setView("media"));
searchTab.addEventListener("click", () => setView("search"));
duplicateTab.addEventListener("click", () => setView("duplicates"));
peopleTab.addEventListener("click", () => setView("people"));
petsTab.addEventListener("click", () => setView("pets"));
recycleTab.addEventListener("click", () => setView("recycle"));

refreshPeopleButton.addEventListener("click", () => {
  const sourceId = selectedSourceId();
  if (sourceId === null) return;

  void runSafely(async () => {
    personStatus.textContent = "Personenvorschläge werden neu berechnet …";
    await loadPersonOverview(sourceId, true);
    await refreshIdentityTabStats();
  });
});

refreshPetsButton.addEventListener("click", () => {
  const sourceId = selectedSourceId();
  if (sourceId === null) return;

  void runSafely(async () => {
    petStatus.textContent = "Hundegruppen werden neu berechnet …";
    await loadPetOverview(sourceId, true);
    await refreshIdentityTabStats();
  });
});
analysisDevLogButton.addEventListener("click", () => {
  void runSafely(async () => {
    const result = await window.imageSorter.analysis.openDevLog();
    progressText.textContent = "Dev-Protokoll geöffnet: " + result.path;
  });
});

analysisCopyDevLogButton.addEventListener("click", () => {
  void runSafely(async () => {
    analysisCopyDevLogButton.disabled = true;
    try {
      const result = await window.imageSorter.analysis.copyDevLog();
      progressText.textContent =
        "Dev-Protokoll in die Zwischenablage kopiert · " +
        result.characters.toLocaleString("de-DE") +
        " Zeichen.";
    } finally {
      analysisCopyDevLogButton.disabled = false;
    }
  });
});

analysisParallelSelect.addEventListener("change", () => {
  const requested = Math.max(
    1,
    Math.min(8, Math.trunc(Number(analysisParallelSelect.value) || 1))
  );

  window.localStorage.setItem(
    "image-sorter.analysis.maxConcurrentJobs",
    String(requested)
  );

  void runSafely(async () => {
    analysisParallelSelect.disabled = true;
    try {
      const result = await window.imageSorter.analysis.setMaxConcurrentJobs(requested);
      analysisParallelSelect.value = String(result.maxConcurrentJobs);
      progressText.textContent =
        `Parallele Analysejobs auf ${result.maxConcurrentJobs} gesetzt.`;
    } finally {
      analysisParallelSelect.disabled = false;
    }
  });
});

analysisClearDevLogButton.addEventListener("click", () => {
  if (!window.confirm(
    "Dev-Protokoll wirklich löschen? Ab diesem Zeitpunkt werden nur neue Diagnoseeinträge gespeichert."
  )) return;

  void runSafely(async () => {
    analysisClearDevLogButton.disabled = true;
    try {
      const result = await window.imageSorter.analysis.clearDevLog();
      progressText.textContent =
        "Dev-Protokoll gelöscht. Ab jetzt enthält es nur neue Einträge · " +
        result.path;
    } finally {
      analysisClearDevLogButton.disabled = false;
    }
  });
});

qwenAutomaticButton.addEventListener("click", () => {
  if (automaticQwenEnabled) return;

  void runSafely(async () => {
    qwenAutomaticButton.disabled = true;
    progressText.textContent =
      "Qwen3-VL-4B-Kataloganalyse wird freigegeben. Das Modell wird erst beim nächsten 4B-Job geladen …";

    try {
      const result = await window.imageSorter.analysis.startAutomaticQwen();
      renderAutomaticQwenState(result.enabled);
      progressText.textContent =
        "Qwen3-VL-4B-Kataloganalyse ist aktiv. Einzelbildtests pausieren sie weiterhin automatisch.";
    } catch (error) {
      renderAutomaticQwenState(false);
      throw error;
    }
  });
});

async function closeQwenBenchmarkAndResume(): Promise<void> {
  if (qwenBenchmarkRunning) {
    qwenBenchmarkLive.textContent =
      "Der Test läuft noch. Nach Abschluss kann das Fenster geschlossen werden.";
    return;
  }

  closeQwenBenchmarkButton.disabled = true;
  pickQwenBenchmarkImageButton.disabled = true;
  runQwenBenchmarkButton.disabled = true;
  qwenBenchmarkLive.textContent =
    "Testmodus wird beendet. Normale Analyse wird wieder freigegeben …";

  try {
    await window.imageSorter.analysis.finishQwenBenchmark();
    qwenBenchmarkDialog.close();
    progressText.textContent =
      "Vision-Einzeltest beendet. Automatische Kataloganalyse läuft wieder weiter.";
  } finally {
    closeQwenBenchmarkButton.disabled = false;
    pickQwenBenchmarkImageButton.disabled = false;
    runQwenBenchmarkButton.disabled = false;
  }
}

qwenBenchmarkButton.addEventListener("click", () => {
  void runSafely(async () => {
    if (!qwenBenchmarkDialog.open) qwenBenchmarkDialog.showModal();

    qwenBenchmarkButton.disabled = true;
    pickQwenBenchmarkImageButton.disabled = true;
    runQwenBenchmarkButton.disabled = true;
    qwenBenchmarkLive.textContent =
      "Standardanalyse wird pausiert und große Vision-Modelle werden aus dem Speicher entladen …";

    try {
      await window.imageSorter.analysis.prepareQwenBenchmark();
      qwenBenchmarkLive.textContent =
        "Standardanalyse ist vollständig pausiert. " +
        "Du kannst jetzt ein Bild auswählen.";
    } finally {
      qwenBenchmarkButton.disabled = false;
      pickQwenBenchmarkImageButton.disabled = false;
      runQwenBenchmarkButton.disabled = false;
    }
  });
});

closeQwenBenchmarkButton.addEventListener("click", () => {
  void runSafely(closeQwenBenchmarkAndResume);
});

qwenBenchmarkDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!qwenBenchmarkRunning) {
    void runSafely(closeQwenBenchmarkAndResume);
  } else {
    qwenBenchmarkLive.textContent =
      "Der Test läuft noch. Nach Abschluss kann das Fenster geschlossen werden.";
  }
});

pickQwenBenchmarkImageButton.addEventListener("click", () => {
  void runSafely(async () => {
    const selected = await window.imageSorter.analysis.pickQwenBenchmarkImage();
    if (!selected) return;

    qwenBenchmarkSelectedPath = selected;
    qwenBenchmarkFilePath.textContent = selected;
    qwenBenchmarkFilePath.title = selected;
    qwenBenchmarkLive.textContent =
      "Bild ausgewählt. Jetzt eine oder mehrere Teststufen starten.";
  });
});

runQwenBenchmarkButton.addEventListener("click", () => {
  void runSafely(async () => {
    if (!qwenBenchmarkSelectedPath) {
      qwenBenchmarkLive.textContent = "Bitte zuerst ein Bild auswählen.";
      return;
    }

    const selectedModelInput = qwenBenchmarkModelInputs.find(
      (input) => input.checked
    );
    const model = (selectedModelInput?.value ?? "minicpm") as QwenBenchmarkModel;
    const profiles = qwenBenchmarkProfileInputs
      .filter((input) => input.checked)
      .map((input) => input.value as QwenBenchmarkProfile);

    if (profiles.length === 0) {
      qwenBenchmarkLive.textContent = "Bitte mindestens eine Teststufe auswählen.";
      return;
    }

    qwenBenchmarkRunning = true;
    qwenBenchmarkModelInRun = model;
    qwenBenchmarkStages = [];
    qwenBenchmarkProfilesInRun = [...profiles];
    qwenBenchmarkProgressCurrent = null;
    qwenBenchmarkRunError = null;
    renderQwenBenchmarkResults();
    runQwenBenchmarkButton.disabled = true;
    pickQwenBenchmarkImageButton.disabled = true;
    copyQwenBenchmarkButton.disabled = true;
    closeQwenBenchmarkButton.disabled = true;
    for (const input of qwenBenchmarkModelInputs) input.disabled = true;
    qwenBenchmarkLive.textContent =
      "Standardanalyse ist pausiert. " +
      benchmarkModelLabel(model) +
      " wird vorbereitet …";

    try {
      const result = await window.imageSorter.analysis.runQwenBenchmark(
        qwenBenchmarkSelectedPath,
        model,
        profiles
      );

      for (const stage of result.results) {
        if (!qwenBenchmarkStages.some((item) => item.profile === stage.profile)) {
          renderQwenBenchmarkStage(stage);
        }
      }

      qwenBenchmarkLive.textContent =
        "Test abgeschlossen · " +
        result.results.length.toLocaleString("de-DE") +
        (result.results.length === 1 ? " Stufe." : " Stufen.");
    } catch (error) {
      qwenBenchmarkRunError =
        error instanceof Error ? error.message : String(error);
      qwenBenchmarkLive.textContent =
        benchmarkModelLabel(model) + " abgebrochen: " + qwenBenchmarkRunError;
    } finally {
      qwenBenchmarkRunning = false;
      renderQwenBenchmarkResults();
      runQwenBenchmarkButton.disabled = false;
      pickQwenBenchmarkImageButton.disabled = false;
      closeQwenBenchmarkButton.disabled = false;
      for (const input of qwenBenchmarkModelInputs) input.disabled = false;
      copyQwenBenchmarkButton.disabled = qwenBenchmarkStages.length === 0;
    }
  });
});

qwenBenchmarkSearchProbe.addEventListener("input", () => {
  renderQwenBenchmarkResults();
});

copyQwenBenchmarkButton.addEventListener("click", () => {
  void runSafely(async () => {
    if (qwenBenchmarkStages.length === 0) return;
    await copyText(qwenBenchmarkCopyText());
    qwenBenchmarkLive.textContent = "Testprotokoll in die Zwischenablage kopiert.";
  });
});

analysisErrorsButton.addEventListener("click", () => {
  void runSafely(async () => {
    if (!analysisErrorDialog.open) analysisErrorDialog.showModal();
    await loadAnalysisErrors();
  });
});

closeAnalysisErrorsButton.addEventListener("click", () => {
  analysisErrorDialog.close();
});

copyAllAnalysisErrorsButton.addEventListener("click", () => {
  void runSafely(async () => {
    const sourceId = selectedSourceId() ?? undefined;
    const errors = await window.imageSorter.analysis.listErrors(sourceId, 300);

    if (errors.length === 0) {
      progressText.textContent = "Es gibt keine Analysefehler zum Kopieren.";
      return;
    }

    const text = errors
      .map((error, index) =>
        "===== Fehler " + (index + 1).toLocaleString("de-DE") + " von " +
        errors.length.toLocaleString("de-DE") + " =====\n" +
        analysisErrorCopyText(error)
      )
      .join("\n\n");

    await copyText(text);
    progressText.textContent =
      errors.length.toLocaleString("de-DE") +
      (errors.length === 1
        ? " Analysefehler wurde kopiert."
        : " Analysefehler wurden kopiert.");
  });
});

retryAllAnalysisErrorsButton.addEventListener("click", () => {
  const sourceId = selectedSourceId() ?? undefined;

  void runSafely(async () => {
    retryAllAnalysisErrorsButton.disabled = true;
    try {
      const result = await window.imageSorter.analysis.retryAll(sourceId);
      progressText.textContent =
        result.retried.toLocaleString("de-DE") +
        (result.retried === 1
          ? " Analysejob wurde erneut eingeplant."
          : " Analysejobs wurden erneut eingeplant.");
      await loadAnalysisErrors();
    } finally {
      retryAllAnalysisErrorsButton.disabled = false;
    }
  });
});

analysisErrorDialog.addEventListener("click", (event) => {
  if (event.target === analysisErrorDialog) analysisErrorDialog.close();
});

closeLifeAreaAssignButton.addEventListener("click", () => {
  lifeAreaAssignDialog.close();
});

lifeAreaAssignDialog.addEventListener("click", (event) => {
  if (event.target === lifeAreaAssignDialog) lifeAreaAssignDialog.close();
});

lifeAreaAssignDialog.addEventListener("close", () => {
  lifeAreaAssignPath.textContent = "—";
  lifeAreaAssignList.replaceChildren();
});

window.addEventListener("life-area:preview", (event) => {
  const detail = (event as CustomEvent<{
    mediaId: number;
    caption: string;
  }>).detail;
  if (!detail || !Number.isFinite(detail.mediaId)) return;
  openImagePreview(detail.mediaId, detail.caption);
});

closeImagePreviewButton.addEventListener("click", () => {
  imagePreviewDialog.close();
});

imagePreviewDialog.addEventListener("click", (event) => {
  if (event.target === imagePreviewDialog) imagePreviewDialog.close();
});

imagePreviewDialog.addEventListener("close", () => {
  imagePreviewImage.removeAttribute("src");
  imagePreviewCaption.textContent = "";
  imagePreviewDetails.replaceChildren();
});

window.addEventListener("focus", () => {
  const previousSourceId = selectedSourceId();
  void runSafely(async () => {
    await loadSources(previousSourceId ?? undefined);
  });
});

sourceSelect.addEventListener("change", () => {
  renderCatalogWatchState();
  scheduleSelectedPipelineRefresh();

  if (searchScope.value === "source") {
    clearSearchControls();
    searchFacetsScopeKey = null;
    searchTabCount.textContent = "0";
    searchSummary.textContent = "Noch keine Suche ausgeführt.";
  }

  void runSafely(refreshCatalog);
});

runSearchButton.addEventListener("click", () => {
  void runSafely(async () => {
    const sourceId = searchScopeSourceId();
    const scopeKey = currentSearchScopeKey();
    if (searchFacetsScopeKey !== scopeKey) {
      await loadSearchFacets(sourceId);
    }
    await runCombinedSearch(sourceId);
  });
});

searchSemanticQuery.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  runSearchButton.click();
});

resetSearchButton.addEventListener("click", () => {
  clearSearchControls();
  void runSafely(() => runCombinedSearch(searchScopeSourceId()));
});

searchScope.addEventListener("change", () => {
  clearSearchControls();
  searchFacetsScopeKey = null;
  searchTabCount.textContent = "0";
  searchSummary.textContent = "Noch keine Suche ausgeführt.";

  void runSafely(async () => {
    const sourceId = searchScopeSourceId();
    await loadSearchFacets(sourceId);
    await runCombinedSearch(sourceId);
  });
});

refreshButton.addEventListener("click", () => void runSafely(refreshCatalog));

backgroundPauseButton.addEventListener("click", () => {
  if (backgroundPauseState.changing) return;

  void runSafely(async () => {
    const next = await window.imageSorter.lifecycle.setBackgroundPaused(
      !backgroundPauseState.paused
    );
    renderBackgroundPauseState(next);
  });
});

window.imageSorter.catalog.onProgress((progress) => {
  if (progress.sourceId !== selectedSourceId()) return;
  progressText.textContent = progress.message;
});

window.imageSorter.catalog.onWatchEvent((event) => {
  if (rendererShuttingDown) return;
  updateCatalogWatchSnapshot(event);
  renderCatalogWatchState();

  if (event.sourceId !== selectedSourceId()) return;

  if (event.kind === "CHANGE_DETECTED" || event.kind === "SCAN_STARTED") {
    progressBar.classList.add("active");
    progressText.textContent = event.message;
  }

  if (event.kind === "SCAN_FINISHED") {
    progressBar.classList.remove("active");
    progressText.textContent = event.message;

    const result = event.scanResult;
    const hasVisibleChanges =
      result !== null &&
      (
        result.added > 0 ||
        result.moved > 0 ||
        result.changed > 0 ||
        result.missing > 0 ||
        result.recycleBin > 0 ||
        result.errors > 0
      );

    // Ein Abgleich ohne echte Änderung darf keine komplette UI-Neuladung
    // auslösen. Bei Importwellen werden mehrere echte Änderungen gebündelt.
    if (hasVisibleChanges) {
      invalidateMapData();
      invalidateLifeAreas();
      scheduleWatchCatalogRefresh();
    }
  }

  if (event.kind === "ERROR") {
    progressBar.classList.remove("active");
    progressText.textContent = event.message;
  }
});

window.imageSorter.lifecycle.onBackgroundPauseState((state) => {
  renderBackgroundPauseState(state);
});

window.imageSorter.lifecycle.onShutdownStatus((status) => {
  rendererShuttingDown = true;

  for (const timer of [
    analysisRefreshTimer,
    sourcePipelineRefreshTimer,
    identityStatsRefreshTimer,
    watchCatalogRefreshTimer
  ]) {
    if (timer !== null) window.clearTimeout(timer);
  }
  analysisRefreshTimer = null;
  sourcePipelineRefreshTimer = null;
  identityStatsRefreshTimer = null;
  watchCatalogRefreshTimer = null;

  shutdownMessage.textContent = status.message;
  shutdownOverlay.hidden = false;

  // Während des geordneten Shutdowns keine weitere Interaktion zulassen.
  for (const control of Array.from(
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      "button, input, select"
    )
  )) {
    control.disabled = true;
  }
});

window.imageSorter.analysis.onStatus((status) => {
  renderAnalysisStatus(status);
  renderQwenBenchmarkProgress(status);
});
window.imageSorter.analysis.onQwenBenchmarkStage((stage) => {
  if (qwenBenchmarkDialog.open || qwenBenchmarkRunning) {
    renderQwenBenchmarkStage(stage);
  }
});
window.imageSorter.analysis.onPipelineStatus((status) => {
  if (rendererShuttingDown) return;
  // Den vom Main-Prozess bereits gelieferten Live-Zustand sofort anzeigen.
  // Eine erneute DB-Abfrage hat kurze Jobs bisher oft erst nach deren Ende
  // sichtbar gemacht.
  renderPipelineStatus(status);
  scheduleIdentityTabStatsRefresh();
});

window.imageSorter.people.onUpdated(() => {
  if (rendererShuttingDown) return;
  const sourceId = selectedSourceId();
  if (sourceId === null) return;

  void runSafely(async () => {
    await refreshIdentityTabStats();

    // Neue Vorschläge dürfen im Hintergrund entstehen, aber eine laufende
    // Eingabe wird niemals durch replaceChildren()/Neuaufbau unterbrochen.
    if (currentView === "people" && !isEditingPersonView()) {
      await loadPersonOverview(sourceId);
    }
  });
});

window.imageSorter.pets.onUpdated(() => {
  if (rendererShuttingDown) return;
  const sourceId = selectedSourceId();
  if (sourceId === null) return;

  void runSafely(async () => {
    await refreshIdentityTabStats();

    if (currentView === "pets" && !isEditingPetView()) {
      await loadPetOverview(sourceId);
    }
  });
});

const appNavItems = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-app-page]")
);
const workspacePages = Array.from(
  document.querySelectorAll<HTMLElement>("[data-workspace-page]")
);

async function showAppPage(page: string): Promise<void> {
  for (const item of appNavItems) {
    item.classList.toggle("active", item.dataset.appPage === page);
  }
  for (const view of workspacePages) {
    const active = view.dataset.workspacePage === page;
    view.hidden = !active;
    view.classList.toggle("active", active);
  }
  if (page === "map") {
    await activateMapView();
  }
  if (page === "identities") {
    await loadIdentityBrowser();
  }
  if (page === "life-areas") {
    await activateLifeAreasView();
  }
}

for (const item of appNavItems) {
  item.addEventListener("click", () => {
    const page = item.dataset.appPage;
    if (page) void showAppPage(page);
  });
}

void initEmbeddedSourceExplorer();

void window.imageSorter.lifecycle
  .getBackgroundPauseState()
  .then(renderBackgroundPauseState)
  .catch(() => {
    renderBackgroundPauseState({
      paused: false,
      changing: false,
      message: "Pausenstatus konnte nicht gelesen werden."
    });
  });

void window.imageSorter.analysis
  .getAutomaticQwenState()
  .then((state) => renderAutomaticQwenState(state.enabled))
  .catch(() => renderAutomaticQwenState(false));

void window.imageSorter.analysis
  .getPipelineStatus()
  .then(renderPipelineStatus)
  .catch(() => {
    renderPipelineStatus({
      technical: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      thumbnails: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      imageMetadata: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      faces: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      faceEmbeddings: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      petDetection: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      petFusion: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      petEmbeddings: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      objectVerification: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      semanticEmbeddings: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 },
      videoAnalysis: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 }
    });
  });

void window.imageSorter.analysis
  .getStatus()
  .then(async (status) => {
    renderAnalysisStatus(status);

    const saved = Number(
      window.localStorage.getItem("image-sorter.analysis.maxConcurrentJobs")
    );
    if (Number.isFinite(saved) && saved >= 1 && saved <= 8) {
      const result = await window.imageSorter.analysis.setMaxConcurrentJobs(saved);
      analysisParallelSelect.value = String(result.maxConcurrentJobs);
    }
  })
  .catch((error) => {
    renderAnalysisStatus({
      state: "ERROR",
      pid: null,
      python: null,
      processPriority: "below-normal",
      cpuBudgetPercent: 50,
      maxConcurrentJobs: 1,
      queuedJobs: 0,
      activeJobs: 0,
      message: error instanceof Error ? error.message : String(error)
    });
  });

void runSafely(async () => {
  catalogWatchSnapshot = await window.imageSorter.catalog.getWatchSnapshot();
  await loadSources();
  renderCatalogWatchState();
  workerState.textContent = "Katalog-Worker aktiv";
  workerState.classList.add("ready");
});
