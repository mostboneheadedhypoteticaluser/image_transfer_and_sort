import type {
  AnalysisErrorRecord,
  AnalysisWorkerStatus,
  QwenBenchmarkModel,
  QwenBenchmarkProfile,
  QwenBenchmarkStageResult,
  DuplicateGroup,
  MediaRecord,
  PersonOverview,
  PetOverview,
  PipelineStatus,
  SearchFacets,
  SearchFilter,
  SourceRecord
} from "../shared/protocol";

type CatalogView = "media" | "search" | "duplicates" | "people" | "pets" | "recycle";

const sourceSelect = document.querySelector<HTMLSelectElement>("#sourceSelect")!;
const addSourceButton = document.querySelector<HTMLButtonElement>("#addSource")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scanSource")!;
const resetButton = document.querySelector<HTMLButtonElement>("#resetCatalog")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const mediaRows = document.querySelector<HTMLTableSectionElement>("#mediaRows")!;
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
const confirmedPersons = document.querySelector<HTMLDivElement>("#confirmedPersons")!;
const personStatus = document.querySelector<HTMLParagraphElement>("#personStatus")!;
const refreshPeopleButton = document.querySelector<HTMLButtonElement>("#refreshPeople")!;
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
const workerState = document.querySelector<HTMLSpanElement>("#workerState")!;
const totalCount = document.querySelector<HTMLSpanElement>("#totalCount")!;
const availableCount = document.querySelector<HTMLSpanElement>("#availableCount")!;
const missingCount = document.querySelector<HTMLSpanElement>("#missingCount")!;
const recycleCount = document.querySelector<HTMLSpanElement>("#recycleCount")!;
const lastScan = document.querySelector<HTMLSpanElement>("#lastScan")!;
const analysisWorkerState = document.querySelector<HTMLSpanElement>("#analysisWorkerState")!;
const analysisPython = document.querySelector<HTMLElement>("#analysisPython")!;
const analysisPriority = document.querySelector<HTMLElement>("#analysisPriority")!;
const analysisCpuBudget = document.querySelector<HTMLElement>("#analysisCpuBudget")!;
const analysisParallel = document.querySelector<HTMLElement>("#analysisParallel")!;
const analysisQueue = document.querySelector<HTMLElement>("#analysisQueue")!;
const analysisActive = document.querySelector<HTMLElement>("#analysisActive")!;
const analysisMessage = document.querySelector<HTMLSpanElement>("#analysisMessage")!;
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
const analysisErrorsButton = document.querySelector<HTMLButtonElement>("#analysisErrorsButton")!;
const analysisDevLogButton = document.querySelector<HTMLButtonElement>("#analysisDevLogButton")!;
const analysisCopyDevLogButton = document.querySelector<HTMLButtonElement>("#analysisCopyDevLogButton")!;
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
const imagePreviewDialog = document.querySelector<HTMLDialogElement>("#imagePreviewDialog")!;
const closeImagePreviewButton = document.querySelector<HTMLButtonElement>("#closeImagePreview")!;
const imagePreviewImage = document.querySelector<HTMLImageElement>("#imagePreviewImage")!;
const imagePreviewCaption = document.querySelector<HTMLDivElement>("#imagePreviewCaption")!;
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

let sources: SourceRecord[] = [];
let currentView: CatalogView = "media";
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
let analysisRefreshTimer: number | null = null;
let searchFacetsSourceId: number | null = null;
let latestAnalysisStatus: AnalysisWorkerStatus | null = null;
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

function renderAnalysisStatus(status: AnalysisWorkerStatus): void {
  latestAnalysisStatus = status;
  analysisWorkerState.className = "analysis-state";

  switch (status.state) {
    case "READY":
      analysisWorkerState.classList.add("ready");
      analysisWorkerState.textContent = "Bereit";
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
  analysisParallel.textContent =
    `${status.maxConcurrentJobs} ${status.maxConcurrentJobs === 1 ? "Job" : "Jobs"}`;
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
    `${stats.pending.toLocaleString("de-DE")} offen · ` +
    `${stats.failed.toLocaleString("de-DE")} Fehler · ` +
    `${stats.unavailable.toLocaleString("de-DE")} fehlen`;
}

function renderPipelineStatus(status: PipelineStatus): void {
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
    status.semanticEmbeddings.done !== lastSemanticDone;

  lastThumbnailDone = status.thumbnails.done;
  lastMetadataDone = status.imageMetadata.done;
  lastFaceDone = status.faces.done;
  lastFaceEmbeddingDone = status.faceEmbeddings.done;
  lastPetDone = status.petDetection.done;
  lastPetFusionDone = status.petFusion.done;
  lastPetEmbeddingDone = status.petEmbeddings.done;
  lastObjectVerificationDone = status.objectVerification.done;
  lastSemanticDone = status.semanticEmbeddings.done;

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
    status.semanticEmbeddings
  ];

  const totalIssues = stages.reduce(
    (sum, stats) => sum + stats.failed + stats.unavailable,
    0
  );

  analysisErrorCount.textContent = totalIssues.toLocaleString("de-DE");
  analysisErrorsButton.hidden = totalIssues === 0;

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

function faceCropUrl(faceDetectionId: number): string {
  return `image-sorter-face://face/${faceDetectionId}`;
}

function petCropUrl(petDetectionId: number): string {
  return `image-sorter-pet://pet/${petDetectionId}`;
}

function fullPreviewUrl(mediaId: number): string {
  return `image-sorter-preview://media/${mediaId}`;
}

function openImagePreview(mediaId: number, caption: string): void {
  imagePreviewImage.src = fullPreviewUrl(mediaId);
  imagePreviewImage.alt = caption;
  imagePreviewCaption.textContent = caption;

  if (!imagePreviewDialog.open) {
    imagePreviewDialog.showModal();
  }
}

function makePreviewable(
  image: HTMLImageElement,
  mediaId: number,
  caption: string
): void {
  image.classList.add("previewable-image");
  image.tabIndex = 0;
  image.setAttribute("role", "button");
  image.setAttribute("aria-label", "Bild groß anzeigen");

  const open = () => openImagePreview(mediaId, caption);
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
  checked: boolean
): void {
  const wrapper = document.createElement("label");
  wrapper.className = "search-facet";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = value;
  input.checked = checked;

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
      selectedPersons.has(String(person.id))
    );
  }

  for (const pet of facets.pets) {
    appendFacet(
      searchPets,
      String(pet.id),
      pet.name + (pet.petClass === "dog" ? " · Hund" : " · Katze"),
      pet.mediaCount,
      selectedPets.has(String(pet.id))
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

async function loadSearchFacets(sourceId: number): Promise<void> {
  const facets = await window.imageSorter.catalog.getSearchFacets(sourceId);
  renderSearchFacets(facets);
  searchFacetsSourceId = sourceId;
}

async function runCombinedSearch(sourceId: number): Promise<void> {
  const filter = currentSearchFilter();
  const rows = await window.imageSorter.catalog.searchMedia(sourceId, filter, 1000);
  renderRows(rows, "Keine Medien entsprechen allen ausgewählten Kriterien.");

  const criteria = searchCriterionCount(filter);
  searchTabCount.textContent = rows.length.toLocaleString("de-DE");
  searchSummary.textContent =
    rows.length.toLocaleString("de-DE") + " " +
    (rows.length === 1 ? "Treffer" : "Treffer") +
    (criteria > 0
      ? " · " + criteria.toLocaleString("de-DE") + " UND-" +
        (criteria === 1 ? "Kriterium" : "Kriterien")
      : " · keine Einschränkung");
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

  searchPanel.hidden = view !== "search";
  duplicateView.hidden = view !== "duplicates";
  personView.hidden = view !== "people";
  petView.hidden = view !== "pets";
  mediaView.hidden =
    view === "duplicates" || view === "people" || view === "pets";

  void runSafely(refreshCatalog);
}

function renderRows(rows: MediaRecord[], emptyText = "Noch keine Medien katalogisiert."): void {
  mediaRows.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "empty";
    td.textContent = emptyText;
    tr.appendChild(td);
    mediaRows.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const tr = document.createElement("tr");

    const previewCell = document.createElement("td");
    previewCell.className = "preview-cell";

    const thumbnail = thumbnailUrl(row);
    if (thumbnail) {
      const img = document.createElement("img");
      img.className = "media-thumbnail";
      img.src = thumbnail;
      img.alt = "";
      img.loading = "lazy";
      makePreviewable(img, row.id, row.relativePath);
      img.addEventListener("error", () => {
        previewCell.replaceChildren();
        const fallback = document.createElement("span");
        fallback.className = "preview-placeholder";
        fallback.textContent = row.extension.replace(".", "").toUpperCase();
        previewCell.appendChild(fallback);
      });
      previewCell.appendChild(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "preview-placeholder";
      placeholder.textContent =
        row.availability === "AVAILABLE"
          ? row.extension.replace(".", "").toUpperCase()
          : "—";
      previewCell.appendChild(placeholder);
    }

    const pathCell = document.createElement("td");
    pathCell.className = "path-cell";
    pathCell.title = row.relativePath;

    const pathMain = document.createElement("div");
    pathMain.className = "path-main";
    pathMain.textContent = row.relativePath;
    pathCell.appendChild(pathMain);

    if (row.capturedAt) {
      const captured = document.createElement("small");
      captured.className = "path-meta";
      captured.textContent = `Aufnahme: ${row.capturedAt.replace("T", " ")}`;
      pathCell.appendChild(captured);
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
        "Qwen3-VL-8B: Vollbild/Kachel erkannt und pro Ausschnitt doppelt bestätigt: " +
        motifLabels.join(", ");
      stateCell.appendChild(motifBadge);
    }

    if (row.availability === "AVAILABLE" && row.semanticReady) {
      const semanticBadge = document.createElement("span");
      semanticBadge.className = "badge semantic";

      if (row.semanticScore !== null) {
        semanticBadge.textContent =
          "Semantik " + Math.round(row.semanticScore * 100).toLocaleString("de-DE") + " %";
        semanticBadge.title =
          "SigLIP2-Suchscore für den eingegebenen semantischen Inhalt · " +
          (row.semanticModel ?? "SigLIP2");
      } else {
        semanticBadge.textContent = "Semantik bereit";
        semanticBadge.title = row.semanticModel ?? "SigLIP2-Semantikanalyse abgeschlossen";
      }

      stateCell.appendChild(semanticBadge);
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
    } else {
      actionCell.textContent = "—";
      actionCell.className = "muted";
    }

    tr.append(previewCell, pathCell, typeCell, sizeCell, stateCell, actionCell);
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

function renderPersonOverview(overview: PersonOverview): void {
  personCandidates.replaceChildren();
  confirmedPersons.replaceChildren();

  if (overview.clusteringPending) {
    personStatus.textContent =
      "Gesichtsmerkmale werden noch im Hintergrund berechnet. " +
      "Die Personenvorschläge werden danach neu gruppiert.";
  } else if (overview.candidates.length > 0) {
    personStatus.textContent =
      `${overview.candidates.length.toLocaleString("de-DE")} unbestätigte ` +
      `${overview.candidates.length === 1 ? "Gruppe" : "Gruppen"} gefunden. ` +
      "Erst deine Bestätigung erzeugt eine dauerhafte Person.";
  } else {
    personStatus.textContent =
      "Aktuell gibt es keine unbestätigten Personenvorschläge.";
  }

  peopleTabCount.textContent = overview.candidates.length.toLocaleString("de-DE");

  if (overview.candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty";
    empty.textContent = overview.clusteringPending
      ? "Warte auf die laufende Gesichtsmerkmals-Analyse …"
      : "Keine Personengruppen zu bestätigen.";
    personCandidates.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const candidate of overview.candidates) {
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
                const stats = await window.imageSorter.catalog.getStats(sourceId);
                peopleTabCount.textContent =
                  stats.personCandidates.toLocaleString("de-DE");
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
      heading.appendChild(titleBlock);

      const confirmRow = document.createElement("div");
      confirmRow.className = "person-confirm-row";

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 120;
      input.placeholder = "Name der Person";
      input.autocomplete = "off";

      const button = document.createElement("button");
      button.className = "primary person-confirm";
      button.type = "button";
      button.textContent = "Bestätigen";

      const confirm = async () => {
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }

        input.disabled = true;
        button.disabled = true;

        try {
          const result = await window.imageSorter.people.confirmCandidate(
            candidate.id,
            name
          );
          progressText.textContent =
            `${result.name}: ${result.faceCount.toLocaleString("de-DE")} ` +
            `${result.faceCount === 1 ? "Gesicht bestätigt" : "Gesichter bestätigt"}.`;
          await refreshCatalog();
        } catch (error) {
          progressText.textContent =
            error instanceof Error ? error.message : String(error);
          input.disabled = false;
          button.disabled = false;
        }
      };

      button.addEventListener("click", () => void confirm());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void confirm();
      });

      confirmRow.append(input, button);
      if (candidate.faceCount > candidate.faces.length) {
        const hiddenNote = document.createElement("small");
        hiddenNote.className = "person-hidden-note";
        hiddenNote.textContent =
          "Es werden " + candidate.faces.length + " von " +
          candidate.faceCount + " Fundstellen angezeigt.";
        body.append(heading, hiddenNote, confirmRow);
      } else {
        body.append(heading, confirmRow);
      }
      card.append(faceStrip, body);
      fragment.appendChild(card);
    }

    personCandidates.appendChild(fragment);
  }

  if (overview.persons.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty compact";
    empty.textContent = "Noch keine Personen bestätigt.";
    confirmedPersons.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const person of overview.persons) {
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
      count.textContent =
        person.faceCount.toLocaleString("de-DE") + " " +
        (person.faceCount === 1 ? "bestätigtes Gesicht" : "bestätigte Gesichter");
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
  try {
    const overview = await window.imageSorter.people.getOverview(
      sourceId,
      forceRefresh
    );
    renderPersonOverview(overview);
  } finally {
    refreshPeopleButton.disabled = false;
  }
}


function renderPetOverview(overview: PetOverview): void {
  petCandidates.replaceChildren();
  confirmedPets.replaceChildren();

  if (overview.clusteringPending) {
    petStatus.textContent =
      "Individuelle Hundemerkmale werden noch im Hintergrund berechnet. " +
      "Die Hundegruppen entstehen automatisch, sobald diese Stufe fertig ist.";
  } else if (overview.candidates.length > 0) {
    petStatus.textContent =
      overview.candidates.length.toLocaleString("de-DE") + " " +
      (overview.candidates.length === 1 ? "Hundegruppe" : "Hundegruppen") +
      " zur Bestätigung gefunden.";
  } else {
    petStatus.textContent =
      "Aktuell gibt es keine unbestätigten Hundegruppen. " +
      "Gruppen benötigen mindestens zwei ausreichend ähnliche Fundstellen.";
  }

  petsTabCount.textContent = overview.candidates.length.toLocaleString("de-DE");

  if (overview.candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty";
    empty.textContent = overview.clusteringPending
      ? "Warte auf die laufende Dog-ReID-Analyse …"
      : "Keine Hundegruppen zu bestätigen.";
    petCandidates.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const candidate of overview.candidates) {
      const card = document.createElement("article");
      card.className = "person-candidate-card";

      const cropStrip = document.createElement("div");
      cropStrip.className = "person-face-strip";

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

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "face-correction-button";
        removeButton.textContent = "×";
        removeButton.title = "Diesen Hund aus der vorgeschlagenen Gruppe entfernen";
        removeButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();

          void runSafely(async () => {
            removeButton.disabled = true;
            const result = await window.imageSorter.pets.removeCandidatePet(
              candidate.id,
              pet.petDetectionId
            );
            const sourceId = selectedSourceId();
            if (sourceId !== null) await loadPetOverview(sourceId, true);
            progressText.textContent =
              result.affectedPets.toLocaleString("de-DE") + " " +
              (result.affectedPets === 1 ? "Fundstelle wurde" : "Fundstellen wurden") +
              " dauerhaft aus dieser Hundegruppe getrennt.";
          });
        });

        figure.append(img, fallback, removeButton);
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
        candidate.suggestedPetName &&
        candidate.suggestedPetSimilarity !== null
      ) {
        const suggestion = document.createElement("p");
        suggestion.className = "pet-suggestion";
        suggestion.textContent =
          "Vermutlich „" + candidate.suggestedPetName + "“ · Referenzähnlichkeit " +
          candidate.suggestedPetSimilarity.toFixed(3);
        titleBlock.appendChild(suggestion);
      }

      heading.appendChild(titleBlock);

      const confirmRow = document.createElement("div");
      confirmRow.className = "person-confirm-row";

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 120;
      input.placeholder = "Name des Hundes";
      input.autocomplete = "off";
      input.value = candidate.suggestedPetName ?? "";

      const button = document.createElement("button");
      button.className = "primary person-confirm";
      button.type = "button";

      const updateConfirmLabel = () => {
        const entered = input.value.trim();
        if (!entered) {
          button.textContent = "Bestätigen";
          return;
        }

        const matchesSuggestion =
          candidate.suggestedPetName !== null &&
          entered.toLocaleLowerCase("de-DE") ===
            candidate.suggestedPetName.toLocaleLowerCase("de-DE");

        button.textContent = matchesSuggestion
          ? candidate.suggestedPetName + " bestätigen"
          : "Als " + entered + " bestätigen";
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

        try {
          const matchesSuggestion =
            candidate.suggestedPetName !== null &&
            name.toLocaleLowerCase("de-DE") ===
              candidate.suggestedPetName.toLocaleLowerCase("de-DE");

          const rejectedPetId =
            candidate.suggestedPetId !== null && !matchesSuggestion
              ? candidate.suggestedPetId
              : undefined;

          const result = await window.imageSorter.pets.confirmCandidate(
            candidate.id,
            name,
            rejectedPetId
          );

          progressText.textContent =
            result.name + ": " +
            result.detectionCount.toLocaleString("de-DE") + " " +
            (result.detectionCount === 1
              ? "Fundstelle bestätigt."
              : "Fundstellen bestätigt.");

          const sourceId = selectedSourceId();
          if (sourceId !== null) {
            await loadPetOverview(sourceId, true);
            const stats = await window.imageSorter.catalog.getStats(sourceId);
            petsTabCount.textContent =
              stats.petCandidates.toLocaleString("de-DE");
          }
        } catch (error) {
          progressText.textContent =
            error instanceof Error ? error.message : String(error);
          input.disabled = false;
          button.disabled = false;
        }
      };

      button.addEventListener("click", () => void confirm());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void confirm();
      });

      confirmRow.append(input, button);

      if (candidate.detectionCount > candidate.pets.length) {
        const hiddenNote = document.createElement("small");
        hiddenNote.className = "person-hidden-note";
        hiddenNote.textContent =
          "Es werden " + candidate.pets.length + " von " +
          candidate.detectionCount + " Fundstellen angezeigt.";
        body.append(heading, hiddenNote, confirmRow);
      } else {
        body.append(heading, confirmRow);
      }

      card.append(cropStrip, body);
      fragment.appendChild(card);
    }

    petCandidates.appendChild(fragment);
  }

  if (overview.pets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "person-empty compact";
    empty.textContent = "Noch keine Haustiere bestätigt.";
    confirmedPets.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();

    for (const pet of overview.pets) {
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
      count.textContent =
        pet.confirmedCount.toLocaleString("de-DE") + " bestätigt" +
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
  try {
    const overview = await window.imageSorter.pets.getOverview(
      sourceId,
      forceRefresh
    );
    renderPetOverview(overview);
  } finally {
    refreshPetsButton.disabled = false;
  }
}

const analysisModuleLabels: Record<string, string> = {
  "file-probe-v1": "Technische Prüfung",
  "thumbnail-v1": "Thumbnail",
  "image-metadata-v1": "Bildmetadaten",
  "face-detect-yunet-v1": "Gesichter erkennen (YuNet)",
  "face-embed-sface-v1": "Gesichtsmerkmale (SFace)",
  "pet-detect-nanodet-v1": "Haustierdetektor NanoDet",
  "pet-detect-yolox-v1": "Haustierdetektor YOLOX-S",
  "pet-fuse-ensemble-v1": "Haustier-Ergebnisse fusionieren",
  "pet-embed-dogreid-v1": "Individuelle Hundemerkmale",
  "object-detect-qwen3vl-gguf-v2": "Motive · Qwen3-VL-8B Q8_0 Vollbild/Kachel + Doppelprüfung",
  "semantic-embed-siglip2-v1": "Semantikanalyse (SigLIP2 So400m NaFlex)"
};

function analysisModuleLabel(module: string): string {
  return analysisModuleLabels[module] ?? module;
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

async function loadAnalysisErrors(): Promise<void> {
  const sourceId = selectedSourceId() ?? undefined;
  const errors = await window.imageSorter.analysis.listErrors(sourceId, 300);
  renderAnalysisErrors(errors);

  analysisErrorCount.textContent = errors.length.toLocaleString("de-DE");
  analysisErrorsButton.hidden = errors.length === 0;
}

async function refreshCatalog(): Promise<void> {
  const sourceId = selectedSourceId();
  scanButton.disabled = sourceId === null || scanning || restoring || resetting;
  resetButton.disabled = scanning || restoring || resetting;

  if (sourceId === null) {
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
      clusteringPending: false
    });
    renderPetOverview({
      candidates: [],
      pets: [],
      clusteringPending: false
    });
    return;
  }

  const stats = await window.imageSorter.catalog.getStats(sourceId);

  totalCount.textContent = stats.total.toLocaleString("de-DE");
  availableCount.textContent = stats.available.toLocaleString("de-DE");
  missingCount.textContent = stats.missing.toLocaleString("de-DE");
  recycleCount.textContent = stats.recycleBin.toLocaleString("de-DE");
  lastScan.textContent = stats.lastScan ?? "—";
  mediaTabCount.textContent = stats.total.toLocaleString("de-DE");
  duplicateTabCount.textContent = stats.duplicateGroups.toLocaleString("de-DE");
  peopleTabCount.textContent = stats.personCandidates.toLocaleString("de-DE");
  petsTabCount.textContent = stats.petCandidates.toLocaleString("de-DE");
  recycleTabCount.textContent = stats.recycleBin.toLocaleString("de-DE");

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
    await loadSearchFacets(sourceId);
    await runCombinedSearch(sourceId);
    return;
  }

  const rows = await window.imageSorter.catalog.listMedia(sourceId, 500);
  renderRows(rows);
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
  await refreshCatalog();
}

async function runSafely(action: () => Promise<void>): Promise<void> {
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
    const selected = await window.imageSorter.pickSource();
    if (!selected) return;
    const source = await window.imageSorter.catalog.addSource(selected);
    await loadSources(source.id);
    progressText.textContent = "Quelle hinzugefügt. Bereit zum Scannen.";
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
      searchFacetsSourceId = null;
      searchTabCount.textContent = "0";
      searchSummary.textContent = "Noch keine Suche ausgeführt.";
      await loadSources();
      progressText.textContent =
        "Datenbank vollständig zurückgesetzt. Du kannst jetzt sauber neu beginnen; " +
        "auch alte KI- und Semantikdaten sind entfernt.";
    } finally {
      resetting = false;
      resetButton.disabled = false;
      addSourceButton.disabled = false;
      sourceSelect.disabled = false;
      scanButton.disabled = selectedSourceId() === null;
    }
  });
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
    const stats = await window.imageSorter.catalog.getStats(sourceId);
    peopleTabCount.textContent = stats.personCandidates.toLocaleString("de-DE");
  });
});

refreshPetsButton.addEventListener("click", () => {
  const sourceId = selectedSourceId();
  if (sourceId === null) return;

  void runSafely(async () => {
    petStatus.textContent = "Hundegruppen werden neu berechnet …";
    await loadPetOverview(sourceId, true);
    const stats = await window.imageSorter.catalog.getStats(sourceId);
    petsTabCount.textContent = stats.petCandidates.toLocaleString("de-DE");
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
    await loadAnalysisErrors();
    if (!analysisErrorDialog.open) analysisErrorDialog.showModal();
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

closeImagePreviewButton.addEventListener("click", () => {
  imagePreviewDialog.close();
});

imagePreviewDialog.addEventListener("click", (event) => {
  if (event.target === imagePreviewDialog) imagePreviewDialog.close();
});

imagePreviewDialog.addEventListener("close", () => {
  imagePreviewImage.removeAttribute("src");
  imagePreviewCaption.textContent = "";
});

sourceSelect.addEventListener("change", () => {
  clearSearchControls();
  searchFacetsSourceId = null;
  searchTabCount.textContent = "0";
  searchSummary.textContent = "Noch keine Suche ausgeführt.";
  void runSafely(refreshCatalog);
});

runSearchButton.addEventListener("click", () => {
  const sourceId = selectedSourceId();
  if (sourceId === null) return;
  void runSafely(async () => {
    if (searchFacetsSourceId !== sourceId) await loadSearchFacets(sourceId);
    await runCombinedSearch(sourceId);
  });
});

searchSemanticQuery.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  runSearchButton.click();
});

resetSearchButton.addEventListener("click", () => {
  const sourceId = selectedSourceId();
  clearSearchControls();
  if (sourceId === null) return;
  void runSafely(() => runCombinedSearch(sourceId));
});

refreshButton.addEventListener("click", () => void runSafely(refreshCatalog));

window.imageSorter.catalog.onProgress((progress) => {
  if (progress.sourceId !== selectedSourceId()) return;
  progressText.textContent = progress.message;
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
window.imageSorter.analysis.onPipelineStatus(renderPipelineStatus);

window.imageSorter.people.onUpdated(() => {
  const sourceId = selectedSourceId();
  if (sourceId === null) return;

  void runSafely(async () => {
    const stats = await window.imageSorter.catalog.getStats(sourceId);
    peopleTabCount.textContent = stats.personCandidates.toLocaleString("de-DE");

    // Neue Vorschläge dürfen im Hintergrund entstehen, aber eine laufende
    // Eingabe wird niemals durch replaceChildren()/Neuaufbau unterbrochen.
    if (currentView === "people" && !isEditingPersonView()) {
      await loadPersonOverview(sourceId);
    }
  });
});

window.imageSorter.pets.onUpdated(() => {
  const sourceId = selectedSourceId();
  if (sourceId === null) return;

  void runSafely(async () => {
    const stats = await window.imageSorter.catalog.getStats(sourceId);
    petsTabCount.textContent = stats.petCandidates.toLocaleString("de-DE");

    if (currentView === "pets" && !isEditingPetView()) {
      await loadPetOverview(sourceId);
    }
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
      semanticEmbeddings: { pending: 0, running: 0, done: 0, failed: 0, unavailable: 0 }
    });
  });

void window.imageSorter.analysis
  .getStatus()
  .then(renderAnalysisStatus)
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
  await loadSources();
  workerState.textContent = "Katalog-Worker aktiv";
  workerState.classList.add("ready");
});
