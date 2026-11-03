import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./life-areas.css";
import type {
  LifeAreaMediaItem,
  LifeAreaRecord,
  LifeAreaRule,
  LifeAreaRuleConditionType,
  SearchFacets
} from "../shared/protocol";

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".mts", ".m2ts"
]);

let areas: LifeAreaRecord[] = [];
let selectedAreaId: number | null = null;
let media: LifeAreaMediaItem[] = [];
let facets: SearchFacets | null = null;
let map: L.Map | null = null;
let mapLayer: L.LayerGroup | null = null;
let mapBoundsFilter: L.LatLngBounds | null = null;
let fitMapOnNextRender = false;
let activationToken = 0;

const lifeAreaList = document.querySelector<HTMLDivElement>("#lifeAreaList")!;
const lifeAreaAddButton = document.querySelector<HTMLButtonElement>("#lifeAreaAddButton")!;
const lifeAreaEmpty = document.querySelector<HTMLDivElement>("#lifeAreaEmpty")!;
const lifeAreaDetail = document.querySelector<HTMLDivElement>("#lifeAreaDetail")!;
const lifeAreaTitle = document.querySelector<HTMLElement>("#lifeAreaTitle")!;
const lifeAreaMeta = document.querySelector<HTMLParagraphElement>("#lifeAreaMeta")!;
const lifeAreaRenameButton = document.querySelector<HTMLButtonElement>("#lifeAreaRenameButton")!;
const lifeAreaDeleteButton = document.querySelector<HTMLButtonElement>("#lifeAreaDeleteButton")!;
const lifeAreaApplyRules = document.querySelector<HTMLButtonElement>("#lifeAreaApplyRules")!;
const lifeAreaRuleType = document.querySelector<HTMLSelectElement>("#lifeAreaRuleType")!;
const lifeAreaRuleValueField = document.querySelector<HTMLElement>("#lifeAreaRuleValueField")!;
const lifeAreaRuleIdentityValue = document.querySelector<HTMLSelectElement>("#lifeAreaRuleIdentityValue")!;
const lifeAreaRuleTextValue = document.querySelector<HTMLInputElement>("#lifeAreaRuleTextValue")!;
const lifeAreaRuleDateFields = document.querySelector<HTMLDivElement>("#lifeAreaRuleDateFields")!;
const lifeAreaRuleDateFrom = document.querySelector<HTMLInputElement>("#lifeAreaRuleDateFrom")!;
const lifeAreaRuleDateTo = document.querySelector<HTMLInputElement>("#lifeAreaRuleDateTo")!;
const lifeAreaRuleGroupMode = document.querySelector<HTMLSelectElement>("#lifeAreaRuleGroupMode")!;
const lifeAreaRuleThenLabel = document.querySelector<HTMLElement>("#lifeAreaRuleThenLabel")!;
const lifeAreaAddRuleButton = document.querySelector<HTMLButtonElement>("#lifeAreaAddRuleButton")!;
const lifeAreaRules = document.querySelector<HTMLDivElement>("#lifeAreaRules")!;
const lifeAreaDateFrom = document.querySelector<HTMLInputElement>("#lifeAreaDateFrom")!;
const lifeAreaDateTo = document.querySelector<HTMLInputElement>("#lifeAreaDateTo")!;
const lifeAreaResetDate = document.querySelector<HTMLButtonElement>("#lifeAreaResetDate")!;
const lifeAreaMediaType = document.querySelector<HTMLSelectElement>("#lifeAreaMediaType")!;
const lifeAreaLocationState = document.querySelector<HTMLElement>("#lifeAreaLocationState")!;
const lifeAreaUseMapBounds = document.querySelector<HTMLButtonElement>("#lifeAreaUseMapBounds")!;
const lifeAreaResetMapBounds = document.querySelector<HTMLButtonElement>("#lifeAreaResetMapBounds")!;
const lifeAreaMapEmpty = document.querySelector<HTMLDivElement>("#lifeAreaMapEmpty")!;
const lifeAreaMap = document.querySelector<HTMLDivElement>("#lifeAreaMap")!;
const lifeAreaGalleryCount = document.querySelector<HTMLElement>("#lifeAreaGalleryCount")!;
const lifeAreaGallery = document.querySelector<HTMLDivElement>("#lifeAreaGallery")!;
const lifeAreaCreateDialog = document.querySelector<HTMLDialogElement>("#lifeAreaCreateDialog")!;
const lifeAreaCreateForm = document.querySelector<HTMLFormElement>("#lifeAreaCreateForm")!;
const lifeAreaCreateName = document.querySelector<HTMLInputElement>("#lifeAreaCreateName")!;
const lifeAreaCreateError = document.querySelector<HTMLParagraphElement>("#lifeAreaCreateError")!;
const closeLifeAreaCreate = document.querySelector<HTMLButtonElement>("#closeLifeAreaCreate")!;
const cancelLifeAreaCreate = document.querySelector<HTMLButtonElement>("#cancelLifeAreaCreate")!;
const saveLifeAreaCreate = document.querySelector<HTMLButtonElement>("#saveLifeAreaCreate")!;

function selectedArea(): LifeAreaRecord | null {
  return areas.find((area) => area.id === selectedAreaId) ?? null;
}

function mediaDate(item: LifeAreaMediaItem): number {
  if (item.capturedAt) {
    const parsed = Date.parse(item.capturedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return item.mtimeMs;
}

function dateInputTimestamp(value: string, end = false): number | null {
  if (!value) return null;
  const parsed = Date.parse(value + (end ? "T23:59:59.999" : "T00:00:00"));
  return Number.isFinite(parsed) ? parsed : null;
}

function isVideo(item: LifeAreaMediaItem): boolean {
  return VIDEO_EXTENSIONS.has(item.extension.toLocaleLowerCase("de-DE"));
}

function filteredWithoutMap(): LifeAreaMediaItem[] {
  const from = dateInputTimestamp(lifeAreaDateFrom.value);
  const to = dateInputTimestamp(lifeAreaDateTo.value, true);
  const mediaType = lifeAreaMediaType.value;

  return media.filter((item) => {
    const date = mediaDate(item);
    if (from !== null && date < from) return false;
    if (to !== null && date > to) return false;
    if (mediaType === "video" && !isVideo(item)) return false;
    if (mediaType === "image" && isVideo(item)) return false;
    return true;
  });
}

function filteredMedia(): LifeAreaMediaItem[] {
  const basic = filteredWithoutMap();
  if (!mapBoundsFilter) return basic;
  return basic.filter(
    (item) =>
      item.latitude !== null &&
      item.longitude !== null &&
      mapBoundsFilter!.contains([item.latitude, item.longitude])
  );
}

function thumbUrl(item: LifeAreaMediaItem): string | null {
  return item.thumbnailVersion
    ? "image-sorter-thumb://media/" +
        item.mediaId +
        "?v=" +
        encodeURIComponent(item.thumbnailVersion)
    : null;
}

function renderAreaList(): void {
  lifeAreaList.replaceChildren();

  if (areas.length === 0) {
    const empty = document.createElement("div");
    empty.className = "life-area-list-empty";
    empty.textContent = "Noch keine Lebensbereiche angelegt.";
    lifeAreaList.appendChild(empty);
    return;
  }

  for (const area of areas) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "life-area-list-item";
    button.classList.toggle("active", area.id === selectedAreaId);

    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = area.name;
    const meta = document.createElement("small");
    meta.textContent =
      area.mediaCount.toLocaleString("de-DE") +
      (area.mediaCount === 1 ? " Medium" : " Medien") +
      " · " +
      area.ruleCount.toLocaleString("de-DE") +
      (area.ruleCount === 1 ? " Regelgruppe" : " Regelgruppen");
    text.append(name, meta);

    const count = document.createElement("span");
    count.className = "life-area-list-count";
    count.textContent = area.mediaCount.toLocaleString("de-DE");

    button.append(text, count);
    button.addEventListener("click", () => {
      void selectArea(area.id);
    });
    lifeAreaList.appendChild(button);
  }
}

function ruleTypeLabel(type: LifeAreaRuleConditionType): string {
  if (type === "pet") return "Haustier";
  if (type === "person") return "Person";
  if (type === "tag") return "Merkmal";
  if (type === "path") return "Pfad";
  return "Zeitraum";
}

function identityName(rule: LifeAreaRule): string {
  if (!facets || rule.conditionValue === null) return rule.conditionValue ?? "—";
  const id = Number(rule.conditionValue);
  if (rule.conditionType === "person") {
    return facets.persons.find((item) => item.id === id)?.name ?? "#" + id;
  }
  if (rule.conditionType === "pet") {
    return facets.pets.find((item) => item.id === id)?.name ?? "#" + id;
  }
  return rule.conditionValue;
}

function ruleDescription(rule: LifeAreaRule): string {
  if (rule.conditionType === "person" || rule.conditionType === "pet") {
    return ruleTypeLabel(rule.conditionType) + " = " + identityName(rule);
  }
  if (rule.conditionType === "date") {
    return (
      "Aufnahmezeit " +
      (rule.dateFrom ?? "…") +
      " bis " +
      (rule.dateTo ?? "…")
    );
  }
  if (rule.conditionType === "path") {
    return "Pfad enthält „" + (rule.conditionValue ?? "") + "“";
  }
  return "Merkmal enthält „" + (rule.conditionValue ?? "") + "“";
}

function groupRules(rules: LifeAreaRule[]): Map<number, LifeAreaRule[]> {
  const groups = new Map<number, LifeAreaRule[]>();
  for (const rule of rules) {
    const items = groups.get(rule.groupId) ?? [];
    items.push(rule);
    groups.set(rule.groupId, items);
  }
  return groups;
}

function groupSummary(rules: LifeAreaRule[]): string {
  return rules.map(ruleDescription).join(" UND ");
}

function renderRules(): void {
  const area = selectedArea();
  lifeAreaRules.replaceChildren();
  if (!area) return;

  if (area.rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "life-area-rules-empty";
    empty.textContent = "Noch keine automatische Regel für diesen Lebensbereich.";
    lifeAreaRules.appendChild(empty);
    return;
  }

  const groups = [...groupRules(area.rules).entries()];

  groups.forEach(([groupId, rules], groupIndex) => {
    if (groupIndex > 0) {
      const or = document.createElement("div");
      or.className = "life-area-rule-or";
      or.textContent = "ODER";
      lifeAreaRules.appendChild(or);
    }

    const card = document.createElement("section");
    card.className = "life-area-rule-group";

    const header = document.createElement("div");
    header.className = "life-area-rule-group-header";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rules.every((rule) => rule.enabled);
    toggle.setAttribute("aria-label", "Regelgruppe aktiv");
    toggle.addEventListener("change", () => {
      void withUiError(async () => {
        await window.imageSorter.catalog.setLifeAreaRuleEnabled(
          rules[0].id,
          toggle.checked
        );
        await reloadSelectedArea(false);
      });
    });

    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Regelgruppe " + (groupIndex + 1).toLocaleString("de-DE");
    const meta = document.createElement("small");
    const hits = rules[0]?.matchedMediaCount ?? 0;
    meta.textContent =
      hits.toLocaleString("de-DE") +
      (hits === 1 ? " Treffer" : " Treffer") +
      " · " +
      rules.length.toLocaleString("de-DE") +
      (rules.length === 1 ? " Bedingung" : " Bedingungen");
    heading.append(title, meta);

    const addAnd = document.createElement("button");
    addAnd.type = "button";
    addAnd.className = "secondary";
    addAnd.textContent = "+ UND-Bedingung";
    addAnd.addEventListener("click", () => {
      lifeAreaRuleGroupMode.value = String(groupId);
      lifeAreaRuleType.focus();
      lifeAreaRuleType.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    header.append(toggle, heading, addAnd);
    card.appendChild(header);

    const conditions = document.createElement("div");
    conditions.className = "life-area-rule-conditions";

    rules.forEach((rule, conditionIndex) => {
      const row = document.createElement("div");
      row.className = "life-area-rule-condition";

      const operator = document.createElement("span");
      operator.className = "life-area-rule-condition-operator";
      operator.textContent = conditionIndex === 0 ? "WENN" : "UND";

      const description = document.createElement("strong");
      description.textContent = ruleDescription(rule);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "Entfernen";
      remove.title =
        rules.length === 1
          ? "Diese ODER-Regelgruppe löschen"
          : "Nur diese UND-Bedingung entfernen";
      remove.addEventListener("click", () => {
        void withUiError(async () => {
          await window.imageSorter.catalog.deleteLifeAreaRule(rule.id);
          await reloadSelectedArea(false);
        });
      });

      row.append(operator, description, remove);
      conditions.appendChild(row);
    });

    const result = document.createElement("div");
    result.className = "life-area-rule-group-result";
    result.textContent = "DANN → " + area.name;

    card.append(conditions, result);
    lifeAreaRules.appendChild(card);
  });
}

function updateRuleGroupOptions(): void {
  const area = selectedArea();
  const current = lifeAreaRuleGroupMode.value;
  lifeAreaRuleGroupMode.replaceChildren();

  const newGroup = document.createElement("option");
  newGroup.value = "new";
  newGroup.textContent = "Neue ODER-Regel";
  lifeAreaRuleGroupMode.appendChild(newGroup);

  if (!area) return;

  const groups = [...groupRules(area.rules).entries()];
  groups.forEach(([groupId, rules], index) => {
    const option = document.createElement("option");
    option.value = String(groupId);
    const summary = groupSummary(rules);
    option.textContent =
      "UND zu Regelgruppe " +
      (index + 1).toLocaleString("de-DE") +
      (summary ? " · " + summary : "");
    lifeAreaRuleGroupMode.appendChild(option);
  });

  if (
    current &&
    [...lifeAreaRuleGroupMode.options].some((option) => option.value === current)
  ) {
    lifeAreaRuleGroupMode.value = current;
  } else {
    lifeAreaRuleGroupMode.value = "new";
  }
}

function updateRuleBuilder(): void {
  const type = lifeAreaRuleType.value as LifeAreaRuleConditionType;
  const area = selectedArea();
  lifeAreaRuleThenLabel.textContent = area
    ? "→ " + area.name
    : "Lebensbereich zuweisen";

  updateRuleGroupOptions();

  lifeAreaRuleDateFields.hidden = type !== "date";
  lifeAreaRuleValueField.hidden = type === "date";
  lifeAreaRuleIdentityValue.hidden = type !== "person" && type !== "pet";
  lifeAreaRuleTextValue.hidden =
    type === "person" || type === "pet" || type === "date";

  if (type === "tag") {
    lifeAreaRuleTextValue.placeholder = "z. B. Rettungshund, Einsatzfahrzeug";
  } else if (type === "path") {
    lifeAreaRuleTextValue.placeholder = "z. B. DRK\\Rettungshunde";
  }

  if (!facets || (type !== "person" && type !== "pet")) return;

  const current = lifeAreaRuleIdentityValue.value;
  lifeAreaRuleIdentityValue.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent =
    type === "person" ? "Person auswählen …" : "Haustier auswählen …";
  lifeAreaRuleIdentityValue.appendChild(placeholder);

  const entries = type === "person" ? facets.persons : facets.pets;
  for (const item of entries) {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = item.name;
    lifeAreaRuleIdentityValue.appendChild(option);
  }

  if (
    [...lifeAreaRuleIdentityValue.options].some(
      (option) => option.value === current
    )
  ) {
    lifeAreaRuleIdentityValue.value = current;
  }
}

function ensureMap(): void {
  if (map) return;
  map = L.map(lifeAreaMap, {
    zoomControl: true,
    preferCanvas: true
  }).setView([48.8, 9.2], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap"
  }).addTo(map);

  mapLayer = L.layerGroup().addTo(map);
}

function renderMap(): void {
  ensureMap();
  if (!map || !mapLayer) return;

  map.invalidateSize();
  mapLayer.clearLayers();

  const basic = filteredWithoutMap();
  const points = basic.filter(
    (item) => item.latitude !== null && item.longitude !== null
  );

  lifeAreaMapEmpty.hidden = points.length > 0;
  lifeAreaUseMapBounds.disabled = points.length === 0;

  for (const item of points) {
    const marker = L.circleMarker(
      [item.latitude!, item.longitude!],
      { radius: 6, weight: 2, fillOpacity: 0.82 }
    );
    marker.bindTooltip(item.relativePath);
    marker.addTo(mapLayer);
  }

  if (fitMapOnNextRender && points.length > 0) {
    const bounds = L.latLngBounds(
      points.map((item) => [item.latitude!, item.longitude!] as [number, number])
    );
    map.fitBounds(bounds.pad(0.12), { maxZoom: 14 });
    fitMapOnNextRender = false;
  }

  if (mapBoundsFilter) {
    lifeAreaLocationState.textContent = "Kartenausschnitt aktiv";
    lifeAreaResetMapBounds.disabled = false;
  } else {
    lifeAreaLocationState.textContent =
      points.length.toLocaleString("de-DE") +
      (points.length === 1 ? " Aufnahme mit Ort" : " Aufnahmen mit Ort");
    lifeAreaResetMapBounds.disabled = true;
  }
}

function renderGallery(): void {
  const items = filteredMedia();
  lifeAreaGallery.replaceChildren();
  lifeAreaGalleryCount.textContent =
    items.length.toLocaleString("de-DE") +
    (items.length === 1 ? " Medium" : " Medien");

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "life-area-gallery-empty";
    empty.textContent = mapBoundsFilter
      ? "Im gewählten Zeitraum und Kartenausschnitt gibt es keine Medien."
      : "Für die gewählten Filter gibt es keine Medien.";
    lifeAreaGallery.appendChild(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "life-area-media-card";

    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "life-area-media-preview";

    const imageUrl = thumbUrl(item);
    if (imageUrl && !isVideo(item)) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      preview.appendChild(image);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "life-area-video-placeholder";
      placeholder.innerHTML = isVideo(item) ? "<b>▶</b><small>Video</small>" : "<b>▧</b><small>Medium</small>";
      preview.appendChild(placeholder);
    }

    preview.addEventListener("click", () => {
      if (isVideo(item)) {
        void window.imageSorter.analysis.openFile(item.mediaId);
      } else {
        window.dispatchEvent(
          new CustomEvent("life-area:preview", {
            detail: {
              mediaId: item.mediaId,
              caption: item.relativePath
            }
          })
        );
      }
    });

    const body = document.createElement("div");
    body.className = "life-area-media-body";

    const date = document.createElement("strong");
    date.textContent = new Date(mediaDate(item)).toLocaleString("de-DE");

    const path = document.createElement("small");
    path.textContent = item.relativePath;
    path.title = item.relativePath;

    const origin = document.createElement("span");
    origin.className =
      "life-area-origin " +
      (item.assignmentSource === "MANUAL" ? "manual" : "rule");
    origin.textContent =
      item.assignmentSource === "MANUAL"
        ? "Manuell"
        : item.ruleLabel ?? "Automatische Regel";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost life-area-remove-media";
    remove.textContent = "Aus Bereich entfernen";
    remove.title =
      "Manuell entfernen. Automatische Regeln dürfen dieses Medium danach nicht erneut zuordnen.";
    remove.addEventListener("click", () => {
      void withUiError(async () => {
        if (selectedAreaId === null) return;
        await window.imageSorter.catalog.setMediaLifeArea(
          item.mediaId,
          selectedAreaId,
          false
        );
        await reloadSelectedArea(false);
      });
    });

    body.append(date, path, origin, remove);
    card.append(preview, body);
    lifeAreaGallery.appendChild(card);
  }
}

function renderFilters(): void {
  renderMap();
  renderGallery();
}

async function loadFacets(): Promise<void> {
  facets = await window.imageSorter.catalog.getSearchFacets();
  updateRuleBuilder();
}

async function reloadAreas(keepSelection = true): Promise<void> {
  areas = await window.imageSorter.catalog.listLifeAreas();

  if (
    !keepSelection ||
    selectedAreaId === null ||
    !areas.some((area) => area.id === selectedAreaId)
  ) {
    selectedAreaId = areas[0]?.id ?? null;
  }

  renderAreaList();
}

async function reloadSelectedArea(fitMap = true): Promise<void> {
  if (selectedAreaId === null) {
    media = [];
    lifeAreaEmpty.hidden = false;
    lifeAreaDetail.hidden = true;
    renderAreaList();
    return;
  }

  await reloadAreas(true);
  const area = selectedArea();
  if (!area) {
    selectedAreaId = null;
    await reloadSelectedArea(fitMap);
    return;
  }

  media = await window.imageSorter.catalog.listLifeAreaMedia(area.id);
  lifeAreaEmpty.hidden = true;
  lifeAreaDetail.hidden = false;
  lifeAreaTitle.textContent = area.name;
  lifeAreaMeta.textContent =
    area.mediaCount.toLocaleString("de-DE") +
    (area.mediaCount === 1 ? " Medium" : " Medien") +
    " · " +
    area.manualCount.toLocaleString("de-DE") +
    " manuell · " +
    area.ruleCount.toLocaleString("de-DE") +
    (area.ruleCount === 1 ? " Regelgruppe" : " Regelgruppen") +
    " · " +
    area.conditionCount.toLocaleString("de-DE") +
    (area.conditionCount === 1 ? " Bedingung" : " Bedingungen");
  lifeAreaRuleThenLabel.textContent = "→ " + area.name;
  mapBoundsFilter = null;
  lifeAreaResetMapBounds.disabled = true;
  fitMapOnNextRender = fitMap;
  renderAreaList();
  renderRules();
  updateRuleBuilder();
  renderFilters();
}

async function selectArea(id: number): Promise<void> {
  if (selectedAreaId === id) return;
  selectedAreaId = id;
  lifeAreaDateFrom.value = "";
  lifeAreaDateTo.value = "";
  lifeAreaMediaType.value = "all";
  mapBoundsFilter = null;
  await reloadSelectedArea(true);
}

async function withUiError(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}

function openLifeAreaCreateDialog(): void {
  lifeAreaCreateName.value = "";
  lifeAreaCreateError.hidden = true;
  lifeAreaCreateError.textContent = "";
  saveLifeAreaCreate.disabled = false;

  if (!lifeAreaCreateDialog.open) {
    lifeAreaCreateDialog.showModal();
  }

  window.setTimeout(() => lifeAreaCreateName.focus(), 0);
}

function closeLifeAreaCreateDialog(): void {
  if (lifeAreaCreateDialog.open) lifeAreaCreateDialog.close();
}

lifeAreaAddButton.addEventListener("click", openLifeAreaCreateDialog);
closeLifeAreaCreate.addEventListener("click", closeLifeAreaCreateDialog);
cancelLifeAreaCreate.addEventListener("click", closeLifeAreaCreateDialog);

lifeAreaCreateDialog.addEventListener("click", (event) => {
  if (event.target === lifeAreaCreateDialog) closeLifeAreaCreateDialog();
});

lifeAreaCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = lifeAreaCreateName.value.trim();
  if (!name) {
    lifeAreaCreateError.textContent = "Bitte einen Namen eingeben.";
    lifeAreaCreateError.hidden = false;
    lifeAreaCreateName.focus();
    return;
  }

  void (async () => {
    saveLifeAreaCreate.disabled = true;
    lifeAreaCreateError.hidden = true;
    try {
      const created = await window.imageSorter.catalog.createLifeArea(name);
      selectedAreaId = created.id;
      await reloadAreas(true);

      if (!areas.some((area) => area.id === created.id)) {
        throw new Error(
          "Der Lebensbereich wurde gespeichert, konnte aber nicht wieder geladen werden."
        );
      }

      await reloadSelectedArea(true);
      closeLifeAreaCreateDialog();
    } catch (error) {
      lifeAreaCreateError.textContent =
        error instanceof Error ? error.message : String(error);
      lifeAreaCreateError.hidden = false;
    } finally {
      saveLifeAreaCreate.disabled = false;
    }
  })();
});

lifeAreaRenameButton.addEventListener("click", () => {
  const area = selectedArea();
  if (!area) return;
  const name = window.prompt("Lebensbereich umbenennen:", area.name)?.trim();
  if (!name || name === area.name) return;

  void withUiError(async () => {
    await window.imageSorter.catalog.renameLifeArea(area.id, name);
    await reloadSelectedArea(false);
  });
});

lifeAreaDeleteButton.addEventListener("click", () => {
  const area = selectedArea();
  if (!area) return;
  if (!window.confirm("Lebensbereich „" + area.name + "“ wirklich löschen? Die Medien selbst bleiben unverändert.")) {
    return;
  }

  void withUiError(async () => {
    await window.imageSorter.catalog.deleteLifeArea(area.id);
    selectedAreaId = null;
    media = [];
    await reloadAreas(false);
    await reloadSelectedArea(true);
  });
});

lifeAreaRuleType.addEventListener("change", updateRuleBuilder);

lifeAreaAddRuleButton.addEventListener("click", () => {
  const area = selectedArea();
  if (!area) return;
  const type = lifeAreaRuleType.value as LifeAreaRuleConditionType;
  const conditionValue =
    type === "person" || type === "pet"
      ? lifeAreaRuleIdentityValue.value || null
      : type === "date"
        ? null
        : lifeAreaRuleTextValue.value.trim() || null;
  const dateFrom = type === "date" ? lifeAreaRuleDateFrom.value || null : null;
  const dateTo = type === "date" ? lifeAreaRuleDateTo.value || null : null;

  void withUiError(async () => {
    const groupId =
      lifeAreaRuleGroupMode.value === "new"
        ? null
        : Number(lifeAreaRuleGroupMode.value);

    await window.imageSorter.catalog.addLifeAreaRule(
      area.id,
      type,
      conditionValue,
      dateFrom,
      dateTo,
      groupId
    );
    lifeAreaRuleTextValue.value = "";
    lifeAreaRuleDateFrom.value = "";
    lifeAreaRuleDateTo.value = "";
    lifeAreaRuleGroupMode.value = "new";
    await reloadSelectedArea(false);
  });
});

lifeAreaApplyRules.addEventListener("click", () => {
  const area = selectedArea();
  if (!area) return;
  void withUiError(async () => {
    lifeAreaApplyRules.disabled = true;
    try {
      await window.imageSorter.catalog.applyLifeAreaRules(area.id);
      await reloadSelectedArea(false);
    } finally {
      lifeAreaApplyRules.disabled = false;
    }
  });
});

for (const input of [lifeAreaDateFrom, lifeAreaDateTo]) {
  input.addEventListener("change", renderFilters);
}
lifeAreaMediaType.addEventListener("change", renderFilters);

lifeAreaResetDate.addEventListener("click", () => {
  lifeAreaDateFrom.value = "";
  lifeAreaDateTo.value = "";
  renderFilters();
});

lifeAreaUseMapBounds.addEventListener("click", () => {
  ensureMap();
  if (!map) return;
  mapBoundsFilter = map.getBounds();
  fitMapOnNextRender = false;
  renderFilters();
});

lifeAreaResetMapBounds.addEventListener("click", () => {
  mapBoundsFilter = null;
  fitMapOnNextRender = true;
  renderFilters();
});

export async function activateLifeAreasView(): Promise<void> {
  const token = ++activationToken;
  await window.imageSorter.catalog.applyLifeAreaRules();
  if (token !== activationToken) return;

  await Promise.all([reloadAreas(true), loadFacets()]);
  if (token !== activationToken) return;

  if (selectedAreaId !== null) {
    await reloadSelectedArea(true);
  } else {
    lifeAreaEmpty.hidden = false;
    lifeAreaDetail.hidden = true;
    renderAreaList();
  }

  window.setTimeout(() => map?.invalidateSize(), 0);
}

export function invalidateLifeAreas(): void {
  activationToken++;
}
