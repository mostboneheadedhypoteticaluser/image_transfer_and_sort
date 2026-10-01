import "./style.css";
import type {
  AnalysisWorkerStatus,
  DuplicateGroup,
  MediaRecord,
  PersonOverview,
  PipelineStatus,
  SourceRecord
} from "../shared/protocol";

type CatalogView = "media" | "duplicates" | "people" | "recycle";

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
const personCandidates = document.querySelector<HTMLDivElement>("#personCandidates")!;
const confirmedPersons = document.querySelector<HTMLDivElement>("#confirmedPersons")!;
const personStatus = document.querySelector<HTMLParagraphElement>("#personStatus")!;
const refreshPeopleButton = document.querySelector<HTMLButtonElement>("#refreshPeople")!;
const mediaTab = document.querySelector<HTMLButtonElement>("#mediaTab")!;
const duplicateTab = document.querySelector<HTMLButtonElement>("#duplicateTab")!;
const peopleTab = document.querySelector<HTMLButtonElement>("#peopleTab")!;
const recycleTab = document.querySelector<HTMLButtonElement>("#recycleTab")!;
const mediaTabCount = document.querySelector<HTMLSpanElement>("#mediaTabCount")!;
const duplicateTabCount = document.querySelector<HTMLSpanElement>("#duplicateTabCount")!;
const peopleTabCount = document.querySelector<HTMLSpanElement>("#peopleTabCount")!;
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

let sources: SourceRecord[] = [];
let currentView: CatalogView = "media";
let scanning = false;
let restoring = false;
let resetting = false;
let lastThumbnailDone = -1;
let lastMetadataDone = -1;
let lastFaceDone = -1;
let lastFaceEmbeddingDone = -1;
let analysisRefreshTimer: number | null = null;

function renderAnalysisStatus(status: AnalysisWorkerStatus): void {
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
}

function stageText(stats: PipelineStatus["technical"]): {
  text: string;
  className: string;
} {
  if (stats.running > 0) return { text: "Läuft", className: "running" };
  if (stats.pending > 0) return { text: "Wartet", className: "waiting" };
  if (stats.failed > 0) return { text: "Mit Fehlern", className: "error" };
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
    `${stats.failed.toLocaleString("de-DE")} Fehler`;
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

  const visualDataChanged =
    status.thumbnails.done !== lastThumbnailDone ||
    status.imageMetadata.done !== lastMetadataDone ||
    status.faces.done !== lastFaceDone ||
    status.faceEmbeddings.done !== lastFaceEmbeddingDone;

  lastThumbnailDone = status.thumbnails.done;
  lastMetadataDone = status.imageMetadata.done;
  lastFaceDone = status.faces.done;
  lastFaceEmbeddingDone = status.faceEmbeddings.done;

  if (!visualDataChanged) return;

  if (analysisRefreshTimer !== null) {
    window.clearTimeout(analysisRefreshTimer);
  }

  analysisRefreshTimer = window.setTimeout(() => {
    analysisRefreshTimer = null;
    if (
      (currentView === "media" || currentView === "people") &&
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

function setView(view: CatalogView): void {
  currentView = view;

  mediaTab.classList.toggle("active", view === "media");
  duplicateTab.classList.toggle("active", view === "duplicates");
  peopleTab.classList.toggle("active", view === "people");
  recycleTab.classList.toggle("active", view === "recycle");

  duplicateView.hidden = view !== "duplicates";
  personView.hidden = view !== "people";
  mediaView.hidden = view === "duplicates" || view === "people";

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

        const fallback = document.createElement("span");
        fallback.className = "face-fallback";
        fallback.textContent = "Gesicht";
        fallback.hidden = true;

        img.addEventListener("error", () => {
          img.hidden = true;
          fallback.hidden = false;
        });

        figure.append(img, fallback);
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
      body.append(heading, confirmRow);
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

      if (person.representativeFaceId !== null) {
        const img = document.createElement("img");
        img.src = faceCropUrl(person.representativeFaceId);
        img.alt = "";
        img.loading = "lazy";
        card.appendChild(img);
      }

      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = person.name;
      const count = document.createElement("small");
      count.textContent =
        `${person.faceCount.toLocaleString("de-DE")} ` +
        `${person.faceCount === 1 ? "bestätigtes Gesicht" : "bestätigte Gesichter"}`;
      text.append(name, count);
      card.appendChild(text);
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
    duplicateTabCount.textContent = "0";
    peopleTabCount.textContent = "0";
    recycleTabCount.textContent = "0";
    renderRows([]);
    renderDuplicateGroups([]);
    renderPersonOverview({
      candidates: [],
      persons: [],
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

  if (currentView === "recycle") {
    const rows = await window.imageSorter.catalog.listRecycleMedia(sourceId, 500);
    renderRows(rows, "Keine wiederherstellbaren oder mehrdeutigen Papierkorb-Einträge.");
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
    "Alle Medienquellen, Katalogeinträge, Scan-Historien und Analysejobs werden gelöscht. " +
    "Die Originaldateien auf der Festplatte bleiben unverändert."
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
      duplicateTab.classList.remove("active");
      peopleTab.classList.remove("active");
      recycleTab.classList.remove("active");
      mediaView.hidden = false;
      duplicateView.hidden = true;
      personView.hidden = true;
      await loadSources();
      progressText.textContent = "Katalog zurückgesetzt. Du kannst jetzt eine Medienquelle neu hinzufügen und sauber neu scannen.";
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
duplicateTab.addEventListener("click", () => setView("duplicates"));
peopleTab.addEventListener("click", () => setView("people"));
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
sourceSelect.addEventListener("change", () => void runSafely(refreshCatalog));
refreshButton.addEventListener("click", () => void runSafely(refreshCatalog));

window.imageSorter.catalog.onProgress((progress) => {
  if (progress.sourceId !== selectedSourceId()) return;
  progressText.textContent = progress.message;
});

window.imageSorter.analysis.onStatus(renderAnalysisStatus);
window.imageSorter.analysis.onPipelineStatus(renderPipelineStatus);

void window.imageSorter.analysis
  .getPipelineStatus()
  .then(renderPipelineStatus)
  .catch(() => {
    renderPipelineStatus({
      technical: { pending: 0, running: 0, done: 0, failed: 0 },
      thumbnails: { pending: 0, running: 0, done: 0, failed: 0 },
      imageMetadata: { pending: 0, running: 0, done: 0, failed: 0 },
      faces: { pending: 0, running: 0, done: 0, failed: 0 },
      faceEmbeddings: { pending: 0, running: 0, done: 0, failed: 0 }
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
