import type {
  MediaDetails,
  PersonOverview,
  PetOverview
} from "../shared/protocol";

type IdentityKind = "person" | "pet";
type SerialQueueMode = "suggested" | "unknown";

type SerialSuggestion = {
  id: number;
  name: string;
  similarity: number;
  previewUrl: string | null;
};

type SerialItem = {
  kind: IdentityKind;
  candidateId: number | null;
  detectionId: number;
  mediaId: number;
  relativePath: string;
  petClass: "dog" | "cat" | null;
  x: number;
  y: number;
  width: number;
  height: number;
  suggestions: SerialSuggestion[];
};

type SerialState = {
  kind: IdentityKind;
  queue: SerialQueueMode;
  selectedGroup: string | null;
  busy: boolean;
  completed: Set<number>;
  rejected: Set<string>;
  skippedUnknown: Set<string>;
  personOverview: PersonOverview | null;
  petOverview: PetOverview | null;
};

type SerialDom = {
  groupedView: HTMLElement;
  serialView: HTMLElement;
  groupedButton: HTMLButtonElement;
  serialButton: HTMLButtonElement;
  suggestedButton: HTMLButtonElement;
  unknownButton: HTMLButtonElement;
  summary: HTMLElement;
  groups: HTMLElement;
  stage: HTMLElement;
  image: HTMLImageElement;
  box: HTMLElement;
  pip: HTMLElement | null;
  pipImage: HTMLImageElement | null;
  path: HTMLElement;
  primary: HTMLElement;
  yes: HTMLButtonElement;
  no: HTMLButtonElement;
  alternatives: HTMLElement;
  knownActions: HTMLElement;
  unknownActions: HTMLElement;
  nameMount: HTMLElement;
  assign: HTMLButtonElement;
  skip: HTMLButtonElement;
  empty: HTMLElement;
};

const CACHE_VERSION = "2026-11-06-serial-v2";
const preloadCache = new Map<string, HTMLImageElement>();
const pipPreloadCache = new Map<string, HTMLImageElement>();
const mediaDetailsCache = new Map<number, Promise<MediaDetails | null>>();
const boxRenderRevision: Record<IdentityKind, number> = {
  person: 0,
  pet: 0
};

type SerialBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function previewOrientedDimensions(
  width: number,
  height: number,
  orientation: number
): { width: number; height: number } {
  return [5, 6, 7, 8].includes(orientation)
    ? { width: height, height: width }
    : { width, height };
}

function orientRawPreviewBox(
  box: SerialBox,
  rawWidth: number,
  rawHeight: number,
  orientation: number
): SerialBox {
  if (orientation === 1 || rawWidth <= 0 || rawHeight <= 0) {
    return box;
  }

  const points = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]
  ] as const;

  const orientPoint = (x: number, y: number): [number, number] => {
    switch (orientation) {
      case 2:
        return [rawWidth - x, y];
      case 3:
        return [rawWidth - x, rawHeight - y];
      case 4:
        return [x, rawHeight - y];
      case 5:
        return [y, x];
      case 6:
        return [rawHeight - y, x];
      case 7:
        return [rawHeight - y, rawWidth - x];
      case 8:
        return [y, rawWidth - x];
      default:
        return [x, y];
    }
  };

  const oriented = points.map(([x, y]) => orientPoint(x, y));
  const xs = oriented.map(([x]) => x);
  const ys = oriented.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function mediaDetails(mediaId: number): Promise<MediaDetails | null> {
  let pending = mediaDetailsCache.get(mediaId);
  if (!pending) {
    pending = window.imageSorter.catalog
      .getMediaDetails(mediaId)
      .catch(() => null);
    mediaDetailsCache.set(mediaId, pending);
  }
  return pending;
}

function resetBox(dom: SerialDom): void {
  dom.box.hidden = true;
  dom.box.style.left = "0%";
  dom.box.style.top = "0%";
  dom.box.style.width = "0%";
  dom.box.style.height = "0%";
}

function resetPip(dom: SerialDom): void {
  dom.stage.classList.remove("has-face-pip");
  if (dom.pip) dom.pip.hidden = true;
  if (dom.pipImage) dom.pipImage.removeAttribute("src");
}

function updateFacePip(
  state: SerialState,
  item: SerialItem,
  box: SerialBox,
  imageWidth: number,
  imageHeight: number
): void {
  const dom = currentDom(state);
  resetPip(dom);

  if (
    state.kind !== "person" ||
    !dom.pip ||
    !dom.pipImage ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return;
  }

  const faceScale = Math.max(
    box.width / imageWidth,
    box.height / imageHeight
  );
  if (faceScale >= 0.25) {
    return;
  }

  dom.pipImage.src = faceCropUrl(item.detectionId);
  dom.pipImage.alt = "Vergrößerter Gesichtsausschnitt";
  dom.pip.hidden = false;
  dom.stage.classList.add("has-face-pip");
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error("Serielle Bestätigung: Element fehlt: " + selector);
  return element;
}

function domFor(kind: IdentityKind): SerialDom {
  const prefix = kind === "person" ? "person" : "pet";
  return {
    groupedView: required<HTMLElement>("#" + prefix + "GroupedView"),
    serialView: required<HTMLElement>("#" + prefix + "SerialView"),
    groupedButton: required<HTMLButtonElement>("#" + prefix + "ViewGrouped"),
    serialButton: required<HTMLButtonElement>("#" + prefix + "ViewSerial"),
    suggestedButton: required<HTMLButtonElement>("#" + prefix + "SerialSuggested"),
    unknownButton: required<HTMLButtonElement>("#" + prefix + "SerialUnknown"),
    summary: required<HTMLElement>("#" + prefix + "SerialSummary"),
    groups: required<HTMLElement>("#" + prefix + "SerialGroups"),
    stage: required<HTMLElement>("#" + prefix + "SerialStage"),
    image: required<HTMLImageElement>("#" + prefix + "SerialImage"),
    box: required<HTMLElement>("#" + prefix + "SerialBox"),
    pip: document.querySelector<HTMLElement>("#" + prefix + "SerialPip"),
    pipImage: document.querySelector<HTMLImageElement>("#" + prefix + "SerialPipImage"),
    path: required<HTMLElement>("#" + prefix + "SerialPath"),
    primary: required<HTMLElement>("#" + prefix + "SerialPrimary"),
    yes: required<HTMLButtonElement>("#" + prefix + "SerialYes"),
    no: required<HTMLButtonElement>("#" + prefix + "SerialNo"),
    alternatives: required<HTMLElement>("#" + prefix + "SerialAlternatives"),
    knownActions: required<HTMLElement>("#" + prefix + "SerialKnownActions"),
    unknownActions: required<HTMLElement>("#" + prefix + "SerialUnknownActions"),
    nameMount: required<HTMLElement>("#" + prefix + "SerialNameMount"),
    assign: required<HTMLButtonElement>("#" + prefix + "SerialAssign"),
    skip: required<HTMLButtonElement>("#" + prefix + "SerialSkip"),
    empty: required<HTMLElement>("#" + prefix + "SerialEmpty")
  };
}

const personDom = domFor("person");
const petDom = domFor("pet");
const progressText = required<HTMLElement>("#progressText");

const personState: SerialState = {
  kind: "person",
  queue: "suggested",
  selectedGroup: null,
  busy: false,
  completed: new Set<number>(),
  rejected: new Set<string>(),
  skippedUnknown: new Set<string>(),
  personOverview: null,
  petOverview: null
};
const petState: SerialState = {
  kind: "pet",
  queue: "suggested",
  selectedGroup: null,
  busy: false,
  completed: new Set<number>(),
  rejected: new Set<string>(),
  skippedUnknown: new Set<string>(),
  personOverview: null,
  petOverview: null
};

function stateFor(kind: IdentityKind): SerialState {
  return kind === "person" ? personState : petState;
}

function currentDom(state: SerialState): SerialDom {
  return state.kind === "person" ? personDom : petDom;
}

function previewUrl(mediaId: number): string {
  return "image-sorter-preview://media/" + mediaId + "?v=" + CACHE_VERSION;
}

function faceCropUrl(faceDetectionId: number): string {
  return "image-sorter-face://face/" + faceDetectionId + "?v=" + CACHE_VERSION;
}

function petCropUrl(petDetectionId: number): string {
  return "image-sorter-pet://pet/" + petDetectionId + "?v=" + CACHE_VERSION;
}

function percent(value: number): string {
  return Math.max(0, Math.min(100, value * 100)).toFixed(1) + " %";
}

function rejectionKey(detectionId: number, suggestionId: number): string {
  return detectionId + ":" + suggestionId;
}

function personItems(state: SerialState): SerialItem[] {
  const overview = state.personOverview;
  if (!overview) return [];

  const items: SerialItem[] = [];
  for (const candidate of overview.candidates) {
    for (const face of candidate.faces) {
      if (state.completed.has(face.faceDetectionId)) continue;
      items.push({
        kind: "person",
        candidateId: candidate.id,
        detectionId: face.faceDetectionId,
        mediaId: face.mediaId,
        relativePath: face.relativePath,
        petClass: null,
        x: face.x,
        y: face.y,
        width: face.width,
        height: face.height,
        suggestions: face.suggestedPersons
          .filter((suggestion) =>
            !state.rejected.has(
              rejectionKey(face.faceDetectionId, suggestion.personId)
            )
          )
          .map((suggestion) => ({
            id: suggestion.personId,
            name: suggestion.personName,
            similarity: suggestion.similarity,
            previewUrl: suggestion.representativeFaceId === null
              ? null
              : faceCropUrl(suggestion.representativeFaceId)
          }))
      });
    }
  }

  for (const face of overview.ungroupedFaces) {
    if (state.completed.has(face.faceDetectionId)) continue;
    const stub: SerialItem = {
      kind: "person",
      candidateId: null,
      detectionId: face.faceDetectionId,
      mediaId: face.mediaId,
      relativePath: face.relativePath,
      petClass: null,
      x: face.x,
      y: face.y,
      width: face.width,
      height: face.height,
      suggestions: []
    };
    stub.suggestions = face.suggestedPersons
      .filter((suggestion) =>
        !state.rejected.has(rejectionKey(stub.detectionId, suggestion.personId))
      )
      .map((suggestion) => ({
        id: suggestion.personId,
        name: suggestion.personName,
        similarity: suggestion.similarity,
        previewUrl: suggestion.representativeFaceId === null
          ? null
          : faceCropUrl(suggestion.representativeFaceId)
      }));
    items.push(stub);
  }

  return items;
}

function petItems(state: SerialState): SerialItem[] {
  const overview = state.petOverview;
  if (!overview) return [];

  const items: SerialItem[] = [];
  for (const candidate of overview.candidates) {
    for (const pet of candidate.pets) {
      if (state.completed.has(pet.petDetectionId)) continue;
      const stub: SerialItem = {
        kind: "pet",
        candidateId: candidate.id,
        detectionId: pet.petDetectionId,
        mediaId: pet.mediaId,
        relativePath: pet.relativePath,
        petClass: candidate.petClass,
        x: pet.x,
        y: pet.y,
        width: pet.width,
        height: pet.height,
        suggestions: []
      };
      stub.suggestions = pet.suggestedPets
        .filter((suggestion) =>
          !state.rejected.has(rejectionKey(stub.detectionId, suggestion.petId))
        )
        .map((suggestion) => ({
          id: suggestion.petId,
          name: suggestion.petName,
          similarity: suggestion.similarity,
          previewUrl: suggestion.representativePetId === null
            ? null
            : petCropUrl(suggestion.representativePetId)
        }));
      items.push(stub);
    }
  }

  for (const pet of overview.ungroupedPets) {
    if (state.completed.has(pet.petDetectionId)) continue;
    const stub: SerialItem = {
      kind: "pet",
      candidateId: null,
      detectionId: pet.petDetectionId,
      mediaId: pet.mediaId,
      relativePath: pet.relativePath,
      petClass: pet.petClass,
      x: pet.x,
      y: pet.y,
      width: pet.width,
      height: pet.height,
      suggestions: []
    };
    stub.suggestions = pet.suggestedPets
      .filter((suggestion) =>
        !state.rejected.has(rejectionKey(stub.detectionId, suggestion.petId))
      )
      .map((suggestion) => ({
        id: suggestion.petId,
        name: suggestion.petName,
        similarity: suggestion.similarity,
        previewUrl: suggestion.representativePetId === null
          ? null
          : petCropUrl(suggestion.representativePetId)
      }));
    items.push(stub);
  }

  return items;
}

function allItems(state: SerialState): SerialItem[] {
  return state.kind === "person" ? personItems(state) : petItems(state);
}

function unknownSkipKey(item: SerialItem): string {
  return item.candidateId === null
    ? "detection:" + item.detectionId
    : "candidate:" + item.candidateId;
}

function itemsForQueue(state: SerialState): SerialItem[] {
  const wantSuggested = state.queue === "suggested";
  return allItems(state)
    .filter((item) =>
      wantSuggested
        ? item.suggestions.length > 0
        : item.suggestions.length === 0 &&
          !state.skippedUnknown.has(unknownSkipKey(item))
    )
    .sort((left, right) => {
      const leftScore = left.suggestions[0]?.similarity ?? 0;
      const rightScore = right.suggestions[0]?.similarity ?? 0;
      return rightScore - leftScore || right.detectionId - left.detectionId;
    });
}

function skipUnknownGroup(state: SerialState, item: SerialItem): void {
  if (state.queue !== "unknown" || state.busy) return;

  const key = unknownSkipKey(item);
  const skippedCount = itemsForQueue(state).filter(
    (entry) => unknownSkipKey(entry) === key
  ).length;

  state.skippedUnknown.add(key);
  progressText.textContent =
    item.kind === "person"
      ? item.candidateId === null
        ? "Dieses unbekannte Gesicht wurde für die aktuelle Runde übersprungen."
        : "Diese unbekannte Gesichtergruppe mit " +
          skippedCount.toLocaleString("de-DE") +
          (skippedCount === 1 ? " Fundstelle wurde " : " Fundstellen wurden ") +
          "für die aktuelle Runde übersprungen."
      : item.candidateId === null
        ? "Diese unbekannte Haustierfundstelle wurde für die aktuelle Runde übersprungen."
        : "Diese unbekannte Haustiergruppe mit " +
          skippedCount.toLocaleString("de-DE") +
          (skippedCount === 1 ? " Fundstelle wurde " : " Fundstellen wurden ") +
          "für die aktuelle Runde übersprungen.";

  renderState(state);
}

type GroupEntry = {
  key: string;
  name: string;
  items: SerialItem[];
};

function groupItems(state: SerialState, items: SerialItem[]): GroupEntry[] {
  if (state.queue === "unknown") {
    return items.length === 0
      ? []
      : [{ key: "unknown", name: "Ohne Vorschlag", items }];
  }

  const groups = new Map<string, GroupEntry>();
  for (const item of items) {
    const primary = item.suggestions[0];
    if (!primary) continue;
    const key = String(primary.id);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, { key, name: primary.name, items: [item] });
    }
  }

  return [...groups.values()].sort((left, right) =>
    right.items.length - left.items.length ||
    left.name.localeCompare(right.name, "de", { sensitivity: "base" })
  );
}

function setViewMode(kind: IdentityKind, serial: boolean): void {
  const dom = kind === "person" ? personDom : petDom;
  dom.groupedView.hidden = serial;
  dom.serialView.hidden = !serial;
  dom.groupedButton.classList.toggle("active", !serial);
  dom.serialButton.classList.toggle("active", serial);
  if (serial) renderState(stateFor(kind));
}

function setQueue(state: SerialState, queue: SerialQueueMode): void {
  if (state.queue === queue) return;
  state.queue = queue;
  state.selectedGroup = null;
  renderState(state);
}

function renderBox(state: SerialState, item: SerialItem | null): void {
  const dom = currentDom(state);
  const revision = ++boxRenderRevision[state.kind];
  resetBox(dom);
  resetPip(dom);

  if (!item || !dom.image.naturalWidth || !dom.image.naturalHeight) {
    return;
  }

  void mediaDetails(item.mediaId).then((details) => {
    if (
      revision !== boxRenderRevision[state.kind] ||
      !item ||
      !dom.image.naturalWidth ||
      !dom.image.naturalHeight
    ) {
      return;
    }

    // Die Vollbild-Vorschau wird vom Preview-Handler auf maximal 1920×1440
    // verkleinert und von Sharp EXIF-orientiert. Die Detektionskoordinaten
    // liegen dagegen im Koordinatensystem der Analyse. Deshalb dürfen sie
    // NICHT gegen naturalWidth/naturalHeight der verkleinerten Vorschau
    // normiert werden.
    const rawWidth = details?.imageMetadata?.width ?? dom.image.naturalWidth;
    const rawHeight = details?.imageMetadata?.height ?? dom.image.naturalHeight;
    const orientation = details?.imageMetadata?.orientation ?? 1;
    const orientedDimensions = previewOrientedDimensions(
      rawWidth,
      rawHeight,
      orientation
    );

    let box: SerialBox = {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    };

    // YuNet/Gesichter werden bereits auf EXIF-orientierten Pixeln analysiert.
    // NanoDet/YOLOX-Haustiere liegen dagegen in Rohpixel-Koordinaten und
    // müssen für dieselbe auto-orientierte Vorschau gedreht/gespiegelt werden.
    if (item.kind === "pet") {
      box = orientRawPreviewBox(box, rawWidth, rawHeight, orientation);
    }

    const imageWidth = orientedDimensions.width;
    const imageHeight = orientedDimensions.height;
    if (
      imageWidth <= 0 ||
      imageHeight <= 0 ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      return;
    }

    updateFacePip(state, item, box, imageWidth, imageHeight);

    const leftPx = Math.max(0, Math.min(imageWidth, box.x));
    const topPx = Math.max(0, Math.min(imageHeight, box.y));
    const rightPx = Math.max(
      leftPx,
      Math.min(imageWidth, box.x + box.width)
    );
    const bottomPx = Math.max(
      topPx,
      Math.min(imageHeight, box.y + box.height)
    );

    const left = leftPx / imageWidth * 100;
    const top = topPx / imageHeight * 100;
    const width = (rightPx - leftPx) / imageWidth * 100;
    const height = (bottomPx - topPx) / imageHeight * 100;

    if (!(width > 0 && height > 0)) {
      return;
    }

    dom.box.style.left = left + "%";
    dom.box.style.top = top + "%";
    dom.box.style.width = width + "%";
    dom.box.style.height = height + "%";
    dom.box.hidden = false;
  });
}

function trimPreloadCache(): void {
  while (preloadCache.size > 40) {
    const first = preloadCache.keys().next().value as string | undefined;
    if (!first) break;
    preloadCache.delete(first);
  }
  while (pipPreloadCache.size > 40) {
    const first = pipPreloadCache.keys().next().value as string | undefined;
    if (!first) break;
    pipPreloadCache.delete(first);
  }
}

function preload(items: SerialItem[]): void {
  for (const item of items.slice(0, 8)) {
    // Nicht nur das nächste Vollbild, sondern auch dessen Originalmaße/EXIF
    // vorladen. Damit steht die korrekte Box beim Umschalten sofort bereit.
    void mediaDetails(item.mediaId);

    if (item.kind === "person") {
      const pipUrl = faceCropUrl(item.detectionId);
      if (!pipPreloadCache.has(pipUrl)) {
        const pipImage = new Image();
        pipImage.decoding = "async";
        pipImage.src = pipUrl;
        pipPreloadCache.set(pipUrl, pipImage);
      }
    }

    const url = previewUrl(item.mediaId);
    if (preloadCache.has(url)) continue;
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    preloadCache.set(url, image);
  }
  trimPreloadCache();
}

function nameOptions(state: SerialState, item: SerialItem): Array<{
  name: string;
  count: number;
  previewUrl: string | null;
}> {
  if (state.kind === "person" && state.personOverview) {
    return state.personOverview.persons.map((person) => ({
      name: person.name,
      count: person.faceCount,
      previewUrl: person.representativeFaceId === null
        ? null
        : faceCropUrl(person.representativeFaceId)
    }));
  }
  if (state.kind === "pet" && state.petOverview) {
    return state.petOverview.pets
      .filter((pet) => !item.petClass || pet.petClass === item.petClass)
      .map((pet) => ({
        name: pet.name,
        count: pet.detectionCount,
        previewUrl: pet.representativePetId === null
          ? null
          : petCropUrl(pet.representativePetId)
      }));
  }
  return [];
}

function createNameField(
  state: SerialState,
  item: SerialItem
): HTMLInputElement {
  const dom = currentDom(state);
  const field = document.createElement("div");
  field.className = "identity-name-field serial-name-field";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = state.kind === "person"
    ? "Person eingeben oder neu anlegen"
    : "Haustier eingeben oder neu anlegen";
  input.autocomplete = "off";

  const menu = document.createElement("div");
  menu.className = "identity-name-menu";
  menu.hidden = true;

  const options = nameOptions(state, item);

  const renderMenu = () => {
    const query = input.value.trim().toLocaleLowerCase("de-DE");
    menu.replaceChildren();
    if (!query) {
      menu.hidden = true;
      return;
    }

    const matches = options
      .filter((option) =>
        option.name.toLocaleLowerCase("de-DE").includes(query)
      )
      .sort((left, right) => {
        const lp = left.name.toLocaleLowerCase("de-DE").startsWith(query) ? 0 : 1;
        const rp = right.name.toLocaleLowerCase("de-DE").startsWith(query) ? 0 : 1;
        return lp - rp || left.name.localeCompare(right.name, "de");
      })
      .slice(0, 8);

    for (const option of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "identity-name-option";

      if (option.previewUrl) {
        const image = document.createElement("img");
        image.src = option.previewUrl;
        image.alt = "";
        button.appendChild(image);
      }

      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = option.name;
      const small = document.createElement("small");
      small.textContent = option.count.toLocaleString("de-DE") + " bestätigt";
      text.append(strong, small);
      button.appendChild(text);

      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        input.value = option.name;
        menu.hidden = true;
        input.focus();
      });
      menu.appendChild(button);
    }

    menu.hidden = matches.length === 0;
  };

  input.addEventListener("input", renderMenu);
  input.addEventListener("focus", renderMenu);
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      menu.hidden = true;
    }, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    dom.assign.click();
  });

  field.append(input, menu);
  dom.nameMount.replaceChildren(field);
  return input;
}

function assignName(
  state: SerialState,
  item: SerialItem,
  name: string
): void {
  const cleanName = name.trim();
  if (
    !cleanName ||
    state.busy ||
    state.completed.has(item.detectionId)
  ) {
    return;
  }

  // Optimistische UI: Die Entscheidung ist lokal sofort abgeschlossen.
  // Dadurch kann das bereits vorgeladene nächste Bild ohne Wartezeit
  // erscheinen, während die DB-/IPC-Zuordnung im Hintergrund gespeichert wird.
  state.completed.add(item.detectionId);
  progressText.textContent =
    "„" + cleanName + "“ bestätigt · wird im Hintergrund gespeichert …";
  renderState(state);

  void (async () => {
    try {
      if (state.kind === "person") {
        if (item.candidateId === null) {
          await window.imageSorter.people.assignDetectionName(
            item.detectionId,
            cleanName
          );
        } else {
          await window.imageSorter.people.assignCandidateSelection(
            item.candidateId,
            [item.detectionId],
            cleanName
          );
        }
      } else {
        if (item.candidateId === null) {
          await window.imageSorter.pets.assignDetectionName(
            item.detectionId,
            cleanName
          );
        } else {
          await window.imageSorter.pets.assignCandidateSelection(
            item.candidateId,
            [item.detectionId],
            cleanName
          );
        }
      }

      progressText.textContent =
        "Fundstelle wurde „" + cleanName + "“ gespeichert.";
      window.dispatchEvent(new CustomEvent("serial-confirmation:changed", {
        detail: { kind: state.kind }
      }));
    } catch (error) {
      // Wenn die Hintergrundspeicherung scheitert, die optimistische
      // Bestätigung zurücknehmen. Der Treffer erscheint wieder in der Runde.
      state.completed.delete(item.detectionId);
      progressText.textContent =
        "Serielle Zuordnung konnte nicht gespeichert werden: " +
        (error instanceof Error ? error.message : String(error));
      renderState(state);
    }
  })();
}

async function rejectPrimary(state: SerialState, item: SerialItem): Promise<void> {
  const primary = item.suggestions[0];
  if (!primary || state.busy) return;

  state.busy = true;
  renderState(state);
  progressText.textContent =
    "Vorschlag „" + primary.name + "“ wird für diese Fundstelle ausgeschlossen …";

  try {
    if (state.kind === "person") {
      await window.imageSorter.people.rejectDetectionSuggestion(
        item.detectionId,
        primary.id
      );
    } else {
      await window.imageSorter.pets.rejectDetectionSuggestion(
        item.detectionId,
        primary.id
      );
    }

    state.rejected.add(rejectionKey(item.detectionId, primary.id));
    progressText.textContent =
      "„" + primary.name + "“ wurde für diese Fundstelle ausgeschlossen.";
    window.dispatchEvent(new CustomEvent("serial-confirmation:changed", {
      detail: { kind: state.kind }
    }));
  } catch (error) {
    progressText.textContent =
      "Ablehnung fehlgeschlagen: " +
      (error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = false;
    renderState(state);
  }
}

function renderAlternative(
  state: SerialState,
  item: SerialItem,
  suggestion: SerialSuggestion
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "serial-alternative";
  button.disabled = state.busy;

  if (suggestion.previewUrl) {
    const image = document.createElement("img");
    image.src = suggestion.previewUrl;
    image.alt = "";
    button.appendChild(image);
  }

  const text = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = suggestion.name;
  const small = document.createElement("small");
  small.textContent = "Ähnlichkeit " + percent(suggestion.similarity);
  text.append(strong, small);
  button.appendChild(text);

  button.addEventListener("click", () => {
    void assignName(state, item, suggestion.name);
  });
  return button;
}

function renderState(state: SerialState): void {
  const dom = currentDom(state);
  const items = itemsForQueue(state);
  const groups = groupItems(state, items);

  dom.suggestedButton.classList.toggle("active", state.queue === "suggested");
  dom.unknownButton.classList.toggle("active", state.queue === "unknown");
  dom.suggestedButton.disabled = state.busy;
  dom.unknownButton.disabled = state.busy;

  if (!groups.some((group) => group.key === state.selectedGroup)) {
    state.selectedGroup = groups[0]?.key ?? null;
  }

  dom.groups.replaceChildren();
  for (const group of groups) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "serial-group-button";
    button.classList.toggle("active", group.key === state.selectedGroup);
    button.disabled = state.busy;

    const name = document.createElement("strong");
    name.textContent = group.name;
    const count = document.createElement("span");
    count.textContent = group.items.length.toLocaleString("de-DE") + " offen";
    button.append(name, count);

    button.addEventListener("click", () => {
      state.selectedGroup = group.key;
      renderState(state);
    });
    dom.groups.appendChild(button);
  }

  const selected = groups.find((group) => group.key === state.selectedGroup) ?? null;
  const current = selected?.items[0] ?? null;
  const currentItems = allItems(state);
  const totalSuggested = currentItems.filter(
    (item) => item.suggestions.length > 0
  ).length;
  const totalUnknown = currentItems.filter(
    (item) =>
      item.suggestions.length === 0 &&
      !state.skippedUnknown.has(unknownSkipKey(item))
  ).length;

  dom.summary.textContent =
    totalSuggested.toLocaleString("de-DE") + " Vorschläge · " +
    totalUnknown.toLocaleString("de-DE") + " unbekannt";

  dom.empty.hidden = current !== null;
  dom.knownActions.hidden = current === null || state.queue !== "suggested";
  dom.unknownActions.hidden = current === null || state.queue !== "unknown";
  dom.alternatives.parentElement!.hidden = current === null || state.queue !== "suggested";

  if (!current) {
    dom.image.removeAttribute("src");
    boxRenderRevision[state.kind] += 1;
    resetBox(dom);
    resetPip(dom);
    dom.path.textContent = "";
    dom.primary.textContent =
      state.queue === "suggested"
        ? "Keine Vorschläge in dieser Runde."
        : "Keine unbekannten Fundstellen in dieser Runde.";
    dom.alternatives.replaceChildren();
    dom.nameMount.replaceChildren();
    return;
  }

  preload(selected?.items ?? []);

  const url = previewUrl(current.mediaId);
  if (dom.image.src !== url) {
    // Eine noch laufende Metadatenantwort des vorherigen Bildes darf niemals
    // dessen Rechteck auf das bereits nächste Bild zeichnen.
    boxRenderRevision[state.kind] += 1;
    resetBox(dom);
    resetPip(dom);
    dom.image.src = url;
  } else {
    renderBox(state, current);
  }
  dom.image.alt = current.relativePath;
  dom.path.textContent = current.relativePath;

  dom.yes.disabled = state.busy;
  dom.no.disabled = state.busy;
  dom.assign.disabled = state.busy;
  dom.skip.disabled = state.busy;
  dom.alternatives.replaceChildren();

  if (state.queue === "suggested") {
    const primary = current.suggestions[0];
    dom.primary.replaceChildren();
    const label = document.createElement("small");
    label.textContent = "Hauptvorschlag";
    const name = document.createElement("strong");
    name.textContent = primary.name;
    const similarity = document.createElement("span");
    similarity.textContent = "Ähnlichkeit " + percent(primary.similarity);
    dom.primary.append(label, name, similarity);

    for (const suggestion of current.suggestions.slice(1)) {
      dom.alternatives.appendChild(
        renderAlternative(state, current, suggestion)
      );
    }
    if (current.suggestions.length === 1) {
      const empty = document.createElement("p");
      empty.className = "serial-side-empty";
      empty.textContent = "Keine weiteren passenden Namen.";
      dom.alternatives.appendChild(empty);
    }

    dom.yes.onclick = () => void assignName(state, current, primary.name);
    dom.no.onclick = () => void rejectPrimary(state, current);
    dom.nameMount.replaceChildren();
  } else {
    dom.primary.replaceChildren();
    const label = document.createElement("small");
    label.textContent = state.kind === "person"
      ? "Unbekannte Person"
      : "Unbekanntes Haustier";
    const name = document.createElement("strong");
    name.textContent = "Name zuordnen";
    dom.primary.append(label, name);

    const input = createNameField(state, current);
    dom.skip.textContent =
      state.kind === "person"
        ? current.candidateId === null
          ? "Dieses Gesicht überspringen"
          : "Diese Gesichtergruppe überspringen"
        : current.candidateId === null
          ? "Diese Haustierfundstelle überspringen"
          : "Diese Haustiergruppe überspringen";
    dom.skip.onclick = () => skipUnknownGroup(state, current);

    dom.assign.onclick = () => {
      const nameValue = input.value.trim();
      if (!nameValue) {
        input.focus();
        return;
      }
      void assignName(state, current, nameValue);
    };
  }
}

function wire(kind: IdentityKind): void {
  const state = stateFor(kind);
  const dom = currentDom(state);

  dom.groupedButton.addEventListener("click", () => setViewMode(kind, false));
  dom.serialButton.addEventListener("click", () => setViewMode(kind, true));
  dom.suggestedButton.addEventListener("click", () => setQueue(state, "suggested"));
  dom.unknownButton.addEventListener("click", () => setQueue(state, "unknown"));
  dom.image.addEventListener("load", () => {
    const items = itemsForQueue(state);
    const groups = groupItems(state, items);
    const selected = groups.find((group) => group.key === state.selectedGroup);
    renderBox(state, selected?.items[0] ?? null);
  });
}

wire("person");
wire("pet");

export function renderPersonSerialOverview(overview: PersonOverview): void {
  personState.personOverview = overview;
  renderState(personState);
}

export function renderPetSerialOverview(overview: PetOverview): void {
  petState.petOverview = overview;
  renderState(petState);
}
