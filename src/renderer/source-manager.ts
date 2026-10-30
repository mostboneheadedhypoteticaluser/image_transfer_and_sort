import type {
  ExplorerFolderNode,
  ExplorerRoot,
  SourceRecord
} from "../shared/protocol";

const refreshExplorerButton =
  document.querySelector<HTMLButtonElement>("#refreshExplorer")!;
const activeSources = document.querySelector<HTMLDivElement>("#activeSources")!;
const sourceCount = document.querySelector<HTMLElement>("#sourceCount")!;
const treeStatus = document.querySelector<HTMLDivElement>("#treeStatus")!;
const folderTree = document.querySelector<HTMLDivElement>("#folderTree")!;

let sources: SourceRecord[] = [];
let loadingExplorer = false;

function normalizePath(value: string): string {
  return value
    .replace(/[\\/]+$/g, "")
    .replace(/\\/g, "/")
    .toLocaleLowerCase("de-DE");
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isInside(candidate: string, parent: string): boolean {
  const child = normalizePath(candidate);
  const root = normalizePath(parent);
  return child === root || child.startsWith(root + "/");
}

function sourceForExactPath(folderPath: string): SourceRecord | null {
  return sources.find((source) => samePath(source.path, folderPath)) ?? null;
}

function coveringSource(folderPath: string): SourceRecord | null {
  return (
    sources
      .filter((source) => isInside(folderPath, source.path))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  );
}

function folderName(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? sourcePath;
}

function renderSources(): void {
  sourceCount.textContent = String(sources.length);
  activeSources.replaceChildren();

  if (sources.length === 0) {
    const empty = document.createElement("div");
    empty.className = "source-empty";
    empty.textContent = "Noch keine Ordner ausgewählt.";
    activeSources.appendChild(empty);
    return;
  }

  for (const source of sources) {
    const item = document.createElement("div");
    item.className = "source-chip";

    const icon = document.createElement("span");
    icon.className = "source-chip-icon";
    icon.textContent = "✓";

    const content = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = folderName(source.path);
    const pathLine = document.createElement("small");
    pathLine.textContent = source.path;
    content.append(name, pathLine);

    item.append(icon, content);
    activeSources.appendChild(item);
  }
}

function mediaText(images: number, videos: number): string {
  if (images === 0 && videos === 0) return "keine Medien direkt im Ordner";
  const parts: string[] = [];
  if (images > 0) parts.push(`${images.toLocaleString("de-DE")} Bilder`);
  if (videos > 0) parts.push(`${videos.toLocaleString("de-DE")} Videos`);
  return parts.join(" · ") + " direkt";
}

function applySelectionState(
  path: string,
  checkbox: HTMLInputElement,
  title: HTMLElement
): void {
  const exact = sourceForExactPath(path);
  const covering = coveringSource(path);
  const inherited = covering !== null && exact === null;

  checkbox.checked = exact !== null || inherited;
  checkbox.disabled = inherited;
  checkbox.indeterminate = false;
  checkbox.title = inherited
    ? `Bereits rekursiv über ${covering?.path ?? "übergeordneten Ordner"} enthalten`
    : exact
      ? "Haken entfernen: Quelle nicht mehr überwachen"
      : "Haken setzen: Ordner rekursiv scannen und überwachen";

  title.querySelectorAll(".selection-badge").forEach((badge) => badge.remove());

  if (exact) {
    const badge = document.createElement("span");
    badge.className = "selection-badge exact";
    badge.textContent = "rekursiv aktiv";
    title.appendChild(badge);
  } else if (inherited) {
    const badge = document.createElement("span");
    badge.className = "selection-badge inherited";
    badge.textContent = "übergeordnet enthalten";
    title.appendChild(badge);
  }
}

function refreshRenderedSelections(): void {
  for (const row of folderTree.querySelectorAll<HTMLElement>(".folder-row")) {
    const path = row.dataset.path;
    if (!path) continue;
    const checkbox = row.querySelector<HTMLInputElement>(".folder-check");
    const title = row.querySelector<HTMLElement>(".folder-title");
    if (!checkbox || !title) continue;
    applySelectionState(path, checkbox, title);
  }
}

async function refreshSources(): Promise<void> {
  sources = await window.imageSorter.catalog.listSources();
  renderSources();
  refreshRenderedSelections();
}

function createNode(
  node: ExplorerFolderNode | ExplorerRoot,
  depth: number,
  drive = false
): HTMLElement {
  const item = document.createElement("div");
  item.className = "folder-node";

  const row = document.createElement("div");
  row.className = "folder-row";
  row.dataset.path = node.path;
  row.style.setProperty("--depth", String(depth));

  const disclosure = document.createElement("button");
  disclosure.type = "button";
  disclosure.className = "folder-disclosure";
  disclosure.textContent = node.hasChildren ? "›" : "";
  disclosure.disabled = !node.hasChildren;
  disclosure.setAttribute(
    "aria-label",
    node.hasChildren ? "Ordner auf- oder zuklappen" : "Keine Unterordner"
  );

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "folder-check";

  const icon = document.createElement("span");
  icon.className = drive ? "drive-icon" : "folder-icon";
  icon.textContent = drive ? "▣" : "▰";

  const info = document.createElement("div");
  info.className = "folder-info";

  const title = document.createElement("div");
  title.className = "folder-title";
  const name = document.createElement("strong");
  name.textContent = node.name;
  title.appendChild(name);

  const counts = document.createElement("div");
  counts.className = "folder-counts";

  const media = document.createElement("span");
  media.className =
    node.directImages + node.directVideos > 0
      ? "count-badge has-media"
      : "count-badge";
  media.textContent = mediaText(node.directImages, node.directVideos);
  counts.appendChild(media);

  if (node.hasChildren) {
    const childHint = document.createElement("span");
    childHint.className = "child-hint";
    childHint.textContent = "Unterordner";
    counts.appendChild(childHint);
  }

  if (node.readError) {
    const error = document.createElement("span");
    error.className = "folder-error";
    error.textContent = "nicht lesbar";
    error.title = node.readError;
    counts.appendChild(error);
  }

  info.append(title, counts);
  row.append(disclosure, checkbox, icon, info);
  item.appendChild(row);

  const children = document.createElement("div");
  children.className = "folder-children";
  children.hidden = true;
  item.appendChild(children);

  applySelectionState(node.path, checkbox, title);

  let loaded = false;
  let loading = false;

  const setExpanded = async (expanded: boolean): Promise<void> => {
    if (!node.hasChildren) return;

    if (expanded && !loaded && !loading) {
      loading = true;
      disclosure.classList.add("loading");
      try {
        const childNodes =
          await window.imageSorter.catalog.getExplorerChildren(node.path);
        children.replaceChildren(
          ...childNodes.map((child) => createNode(child, depth + 1, false))
        );
        loaded = true;
      } catch (error) {
        const message = document.createElement("div");
        message.className = "folder-load-error";
        message.textContent =
          error instanceof Error ? error.message : String(error);
        children.replaceChildren(message);
        loaded = true;
      } finally {
        loading = false;
        disclosure.classList.remove("loading");
      }
    }

    children.hidden = !expanded;
    disclosure.classList.toggle("expanded", expanded);
  };

  disclosure.addEventListener("click", () => {
    void setExpanded(children.hidden);
  });
  icon.addEventListener("dblclick", () => {
    void setExpanded(children.hidden);
  });
  name.addEventListener("dblclick", () => {
    void setExpanded(children.hidden);
  });

  checkbox.addEventListener("change", () => {
    void (async () => {
      const exact = sourceForExactPath(node.path);
      checkbox.disabled = true;

      try {
        if (exact) {
          await window.imageSorter.catalog.disableSource(exact.id);
        } else {
          await window.imageSorter.catalog.addSource(node.path);
        }
        await refreshSources();
      } catch (error) {
        treeStatus.hidden = false;
        treeStatus.classList.remove("loading");
        treeStatus.textContent =
          error instanceof Error ? error.message : String(error);
        refreshRenderedSelections();
      } finally {
        const inherited = coveringSource(node.path) !== null &&
          sourceForExactPath(node.path) === null;
        checkbox.disabled = inherited;
      }
    })();
  });

  return item;
}

async function loadExplorer(): Promise<void> {
  if (loadingExplorer) return;
  loadingExplorer = true;
  refreshExplorerButton.disabled = true;
  folderTree.hidden = true;
  treeStatus.hidden = false;
  treeStatus.classList.add("loading");
  treeStatus.textContent = "Laufwerke werden geladen …";

  try {
    await refreshSources();
    const roots = await window.imageSorter.catalog.listExplorerRoots();
    folderTree.replaceChildren(
      ...roots.map((root) => createNode(root, 0, true))
    );

    if (roots.length === 0) {
      treeStatus.classList.remove("loading");
      treeStatus.textContent = "Keine erreichbaren Laufwerke gefunden.";
      return;
    }

    treeStatus.hidden = true;
    folderTree.hidden = false;
  } catch (error) {
    treeStatus.classList.remove("loading");
    treeStatus.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    loadingExplorer = false;
    refreshExplorerButton.disabled = false;
  }
}

refreshExplorerButton.addEventListener("click", () => {
  void loadExplorer();
});

void loadExplorer();
