import type { FolderTreeNode, SourceRecord } from "../shared/protocol";

const pickRootButton = document.querySelector<HTMLButtonElement>("#pickRoot")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refreshTree")!;
const activeSources = document.querySelector<HTMLDivElement>("#activeSources")!;
const sourceCount = document.querySelector<HTMLElement>("#sourceCount")!;
const rootLabel = document.querySelector<HTMLElement>("#rootLabel")!;
const treeStatus = document.querySelector<HTMLDivElement>("#treeStatus")!;
const folderTree = document.querySelector<HTMLDivElement>("#folderTree")!;

let sources: SourceRecord[] = [];
let rootPath: string | null = null;
let rootNode: FolderTreeNode | null = null;
let loading = false;

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/g, "").replace(/\\/g, "/").toLocaleLowerCase("de-DE");
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

function mediaLabel(node: FolderTreeNode): string {
  const parts: string[] = [];
  if (node.images > 0) parts.push(`${node.images.toLocaleString("de-DE")} Bilder`);
  if (node.videos > 0) parts.push(`${node.videos.toLocaleString("de-DE")} Videos`);
  return parts.length > 0 ? parts.join(" · ") : "keine Medien";
}

function directMediaLabel(node: FolderTreeNode): string | null {
  if (node.directImages === node.images && node.directVideos === node.videos) return null;
  const count = node.directImages + node.directVideos;
  return count > 0
    ? `direkt im Ordner: ${node.directImages} Bilder · ${node.directVideos} Videos`
    : "Medien nur in Unterordnern";
}

function setBusy(busy: boolean, message = ""): void {
  loading = busy;
  pickRootButton.disabled = busy;
  refreshButton.disabled = busy;
  if (busy) {
    treeStatus.hidden = false;
    treeStatus.classList.add("loading");
    treeStatus.textContent = message || "Ordnerstruktur wird eingelesen …";
    folderTree.hidden = true;
  } else {
    treeStatus.classList.remove("loading");
  }
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-chip" + (rootPath && samePath(rootPath, source.path) ? " active" : "");

    const icon = document.createElement("span");
    icon.className = "source-chip-icon";
    icon.textContent = "▣";

    const content = document.createElement("span");
    const name = document.createElement("strong");
    const segments = source.path.replace(/\\/g, "/").split("/").filter(Boolean);
    name.textContent = segments.at(-1) ?? source.path;
    const pathLine = document.createElement("small");
    pathLine.textContent = source.path;
    content.append(name, pathLine);

    button.append(icon, content);
    button.addEventListener("click", () => {
      void loadTree(source.path);
    });
    activeSources.appendChild(button);
  }
}

function createFolderNode(node: FolderTreeNode, depth = 0): HTMLElement {
  const item = document.createElement("div");
  item.className = "folder-node";
  item.style.setProperty("--depth", String(depth));

  const row = document.createElement("div");
  row.className = "folder-row";

  const hasChildren = node.children.length > 0;
  const disclosure = document.createElement("button");
  disclosure.type = "button";
  disclosure.className = "folder-disclosure";
  disclosure.textContent = hasChildren ? "›" : "";
  disclosure.disabled = !hasChildren;
  disclosure.setAttribute("aria-label", hasChildren ? "Unterordner ein-/ausklappen" : "Keine Unterordner");

  const exact = sourceForExactPath(node.path);
  const covering = coveringSource(node.path);
  const inherited = covering !== null && exact === null;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "folder-check";
  checkbox.checked = exact !== null || inherited;
  checkbox.disabled = inherited || loading;
  checkbox.title = inherited
    ? `Bereits rekursiv über ${covering?.path ?? "übergeordneten Ordner"} enthalten`
    : exact
      ? "Aus der aktiven Überwachung entfernen"
      : "Diesen Ordner rekursiv überwachen";

  const folderIcon = document.createElement("span");
  folderIcon.className = "folder-icon";
  folderIcon.textContent = hasChildren ? "▰" : "▱";

  const info = document.createElement("div");
  info.className = "folder-info";
  const title = document.createElement("div");
  title.className = "folder-title";
  const name = document.createElement("strong");
  name.textContent = node.name;
  title.appendChild(name);

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

  const counts = document.createElement("div");
  counts.className = "folder-counts";
  const images = document.createElement("span");
  images.className = "count-badge";
  images.textContent = `${node.images.toLocaleString("de-DE")} Bilder`;
  const videos = document.createElement("span");
  videos.className = "count-badge";
  videos.textContent = `${node.videos.toLocaleString("de-DE")} Videos`;
  counts.append(images, videos);

  const direct = directMediaLabel(node);
  if (direct) {
    const directLabel = document.createElement("small");
    directLabel.textContent = direct;
    counts.appendChild(directLabel);
  }

  if (node.readError) {
    const error = document.createElement("small");
    error.className = "folder-error";
    error.textContent = "Nicht lesbar: " + node.readError;
    counts.appendChild(error);
  }

  info.append(title, counts);
  row.append(disclosure, checkbox, folderIcon, info);
  item.appendChild(row);

  const children = document.createElement("div");
  children.className = "folder-children";
  children.hidden = depth > 0;
  for (const child of node.children) {
    children.appendChild(createFolderNode(child, depth + 1));
  }
  item.appendChild(children);

  if (hasChildren) {
    const setExpanded = (expanded: boolean) => {
      children.hidden = !expanded;
      disclosure.classList.toggle("expanded", expanded);
    };
    setExpanded(depth === 0);
    disclosure.addEventListener("click", () => setExpanded(children.hidden));
    folderIcon.addEventListener("click", () => setExpanded(children.hidden));
    name.addEventListener("dblclick", () => setExpanded(children.hidden));
  }

  checkbox.addEventListener("change", () => {
    void updateSelection(node, checkbox);
  });

  return item;
}

function renderTree(): void {
  folderTree.replaceChildren();

  if (!rootNode) {
    folderTree.hidden = true;
    treeStatus.hidden = false;
    treeStatus.textContent = "Keine Ordnerstruktur geladen.";
    return;
  }

  rootLabel.textContent = rootNode.path;
  folderTree.appendChild(createFolderNode(rootNode));
  folderTree.hidden = false;
  treeStatus.hidden = true;
}

async function refreshSources(): Promise<void> {
  sources = await window.imageSorter.catalog.listSources();
  renderSources();
}

async function updateSelection(
  node: FolderTreeNode,
  checkbox: HTMLInputElement
): Promise<void> {
  const exact = sourceForExactPath(node.path);
  checkbox.disabled = true;

  try {
    if (exact) {
      await window.imageSorter.catalog.disableSource(exact.id);
    } else {
      await window.imageSorter.catalog.addSource(node.path);
    }
    await refreshSources();
    renderTree();
  } catch (error) {
    checkbox.checked = exact !== null;
    treeStatus.hidden = false;
    treeStatus.classList.remove("loading");
    treeStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    checkbox.disabled = false;
  }
}

async function loadTree(path: string): Promise<void> {
  if (loading) return;
  rootPath = path;
  rootLabel.textContent = path;
  renderSources();
  setBusy(true, "Ordnerstruktur und Medienzahlen werden eingelesen …");

  try {
    rootNode = await window.imageSorter.catalog.getFolderTree(path);
    renderTree();
  } catch (error) {
    rootNode = null;
    folderTree.hidden = true;
    treeStatus.hidden = false;
    treeStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
}

pickRootButton.addEventListener("click", () => {
  void (async () => {
    const selected = await window.imageSorter.pickSource();
    if (!selected) return;
    await loadTree(selected);
  })();
});

refreshButton.addEventListener("click", () => {
  void (async () => {
    await refreshSources();
    if (rootPath) await loadTree(rootPath);
  })();
});

void (async () => {
  await refreshSources();
  if (sources.length > 0) {
    await loadTree(sources[0].path);
  }
})();
