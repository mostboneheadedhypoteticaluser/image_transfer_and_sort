import "./style.css";
import type { MediaRecord, SourceRecord } from "../shared/protocol";

const sourceSelect = document.querySelector<HTMLSelectElement>("#sourceSelect")!;
const addSourceButton = document.querySelector<HTMLButtonElement>("#addSource")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scanSource")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const mediaRows = document.querySelector<HTMLTableSectionElement>("#mediaRows")!;
const progressText = document.querySelector<HTMLSpanElement>("#progressText")!;
const progressBar = document.querySelector<HTMLDivElement>("#progressBar")!;
const workerState = document.querySelector<HTMLSpanElement>("#workerState")!;
const totalCount = document.querySelector<HTMLSpanElement>("#totalCount")!;
const availableCount = document.querySelector<HTMLSpanElement>("#availableCount")!;
const missingCount = document.querySelector<HTMLSpanElement>("#missingCount")!;
const recycleCount = document.querySelector<HTMLSpanElement>("#recycleCount")!;
const lastScan = document.querySelector<HTMLSpanElement>("#lastScan")!;

let sources: SourceRecord[] = [];
let scanning = false;
let restoring = false;

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
  if (row.inRecycleBin) {
    return { text: "Papierkorb – wiederherstellbar", className: "badge recycle" };
  }
  return { text: "Fehlt", className: "badge missing" };
}

function renderRows(rows: MediaRecord[]): void {
  mediaRows.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty";
    td.textContent = "Noch keine Bilder katalogisiert.";
    tr.appendChild(td);
    mediaRows.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const tr = document.createElement("tr");

    const pathCell = document.createElement("td");
    pathCell.className = "path-cell";
    pathCell.textContent = row.relativePath;
    pathCell.title = row.relativePath;

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

    const actionCell = document.createElement("td");
    if (row.availability === "MISSING" && row.inRecycleBin) {
      const restoreButton = document.createElement("button");
      restoreButton.className = "table-action";
      restoreButton.textContent = "Wiederherstellen";
      restoreButton.disabled = restoring;
      restoreButton.addEventListener("click", () => {
        void restoreRow(row, restoreButton);
      });
      actionCell.appendChild(restoreButton);
    } else {
      actionCell.textContent = "—";
      actionCell.className = "muted";
    }

    tr.append(pathCell, typeCell, sizeCell, stateCell, actionCell);
    fragment.appendChild(tr);
  }

  mediaRows.appendChild(fragment);
}

async function refreshCatalog(): Promise<void> {
  const sourceId = selectedSourceId();
  scanButton.disabled = sourceId === null || scanning || restoring;

  if (sourceId === null) {
    totalCount.textContent = "0";
    availableCount.textContent = "0";
    missingCount.textContent = "0";
    recycleCount.textContent = "0";
    lastScan.textContent = "—";
    renderRows([]);
    return;
  }

  const [stats, rows] = await Promise.all([
    window.imageSorter.catalog.getStats(sourceId),
    window.imageSorter.catalog.listMedia(sourceId, 500)
  ]);

  totalCount.textContent = stats.total.toLocaleString("de-DE");
  availableCount.textContent = stats.available.toLocaleString("de-DE");
  missingCount.textContent = stats.missing.toLocaleString("de-DE");
  recycleCount.textContent = stats.recycleBin.toLocaleString("de-DE");
  lastScan.textContent = stats.lastScan ?? "—";
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
  if (restoring || scanning) return;

  await runSafely(async () => {
    restoring = true;
    button.disabled = true;
    scanButton.disabled = true;
    addSourceButton.disabled = true;
    progressText.textContent = `Wiederherstellung läuft: ${row.relativePath}`;

    try {
      const result = await window.imageSorter.catalog.restoreMedia(row.id);
      progressText.textContent = `Wiederhergestellt: ${result.path}`;
      await refreshCatalog();
    } finally {
      restoring = false;
      addSourceButton.disabled = false;
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
  if (sourceId === null || scanning || restoring) return;

  void runSafely(async () => {
    scanning = true;
    scanButton.disabled = true;
    addSourceButton.disabled = true;
    progressBar.classList.add("active");
    progressText.textContent = "Scan wird gestartet …";

    try {
      const result = await window.imageSorter.catalog.scanSource(sourceId);
      progressText.textContent =
        `Fertig · ${result.discovered.toLocaleString("de-DE")} gefunden · ` +
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
      scanButton.disabled = selectedSourceId() === null;
      progressBar.classList.remove("active");
    }
  });
});

sourceSelect.addEventListener("change", () => void runSafely(refreshCatalog));
refreshButton.addEventListener("click", () => void runSafely(refreshCatalog));

window.imageSorter.catalog.onProgress((progress) => {
  if (progress.sourceId !== selectedSourceId()) return;
  progressText.textContent = progress.message;
});

void runSafely(async () => {
  await loadSources();
  workerState.textContent = "Katalog-Worker aktiv";
  workerState.classList.add("ready");
});
