import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoMediaPoint, SourceRecord } from "../shared/protocol";

let map: L.Map | null = null;
let layer: L.LayerGroup | null = null;
let points: GeoMediaPoint[] = [];
let sources: SourceRecord[] = [];
let loaded = false;
let controlsBound = false;
let searchTimer: number | null = null;

type MapMediaKind = "all" | "image" | "video";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
  ".mts",
  ".m2ts"
]);

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    })[char] ?? char
  );

const basename = (value: string) =>
  value.replace(/\\/g, "/").split("/").pop() || value;

const thumb = (point: GeoMediaPoint) =>
  point.thumbnailVersion
    ? "image-sorter-thumb://media/" +
      point.mediaId +
      "?v=" +
      encodeURIComponent(point.thumbnailVersion)
    : null;

function sourceLabel(sourceId: number): string {
  const source = sources.find((item) => item.id === sourceId);
  return source ? basename(source.path) : "Quelle " + sourceId;
}

function formatDate(value: string | null): string {
  if (!value) return "Datum unbekannt";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("de-DE")
    : value;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return Math.round(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  if (value < 1024 * 1024 * 1024) {
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function mediaKind(point: GeoMediaPoint): "image" | "video" {
  return VIDEO_EXTENSIONS.has(point.extension.toLocaleLowerCase("de-DE"))
    ? "video"
    : "image";
}

function dateBoundary(value: string, endOfDay: boolean): number | null {
  if (!value) return null;
  const date = new Date(value + (endOfDay ? "T23:59:59.999" : "T00:00:00"));
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function activeFilters(): {
  sourceId: number;
  kind: MapMediaKind;
  query: string;
  from: number | null;
  to: number | null;
} {
  const sourceId =
    Number(document.querySelector<HTMLSelectElement>("#mapSourceFilter")?.value) || 0;
  const kindValue =
    document.querySelector<HTMLSelectElement>("#mapMediaTypeFilter")?.value ?? "all";
  const kind: MapMediaKind =
    kindValue === "image" || kindValue === "video" ? kindValue : "all";
  const query =
    document.querySelector<HTMLInputElement>("#mapTextFilter")
      ?.value.trim()
      .toLocaleLowerCase("de-DE") ?? "";
  const fromValue =
    document.querySelector<HTMLInputElement>("#mapDateFrom")?.value ?? "";
  const toValue =
    document.querySelector<HTMLInputElement>("#mapDateTo")?.value ?? "";

  return {
    sourceId,
    kind,
    query,
    from: dateBoundary(fromValue, false),
    to: dateBoundary(toValue, true)
  };
}

function filteredPoints(): GeoMediaPoint[] {
  const filter = activeFilters();

  return points.filter((point) => {
    if (filter.sourceId > 0 && point.sourceId !== filter.sourceId) return false;
    if (filter.kind !== "all" && mediaKind(point) !== filter.kind) return false;
    if (
      filter.query &&
      !point.relativePath.toLocaleLowerCase("de-DE").includes(filter.query)
    ) {
      return false;
    }

    if (filter.from !== null || filter.to !== null) {
      if (!point.capturedAt) return false;
      const capturedAt = new Date(point.capturedAt).getTime();
      if (!Number.isFinite(capturedAt)) return false;
      if (filter.from !== null && capturedAt < filter.from) return false;
      if (filter.to !== null && capturedAt > filter.to) return false;
    }

    return true;
  });
}

function clusters(currentMap: L.Map, items: GeoMediaPoint[]): GeoMediaPoint[][] {
  const zoom = currentMap.getZoom();
  const cell = Math.max(48, 92 - zoom * 3);
  const groups = new Map<string, GeoMediaPoint[]>();

  for (const item of items) {
    const projected = currentMap.project([item.latitude, item.longitude], zoom);
    const key =
      Math.floor(projected.x / cell) + ":" + Math.floor(projected.y / cell);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function visiblePoints(items = filteredPoints()): GeoMediaPoint[] {
  if (!map) return [];
  const bounds = map.getBounds();
  return items.filter((point) =>
    bounds.contains([point.latitude, point.longitude])
  );
}

function sortedVisiblePoints(): GeoMediaPoint[] {
  const sort =
    document.querySelector<HTMLSelectElement>("#mapMediaSort")?.value ?? "newest";
  const rows = visiblePoints();

  rows.sort((left, right) => {
    if (sort === "oldest") {
      return (
        String(left.capturedAt ?? "9999").localeCompare(
          String(right.capturedAt ?? "9999")
        ) || left.relativePath.localeCompare(right.relativePath, "de")
      );
    }

    if (sort === "name") {
      return left.relativePath.localeCompare(right.relativePath, "de");
    }

    return (
      String(right.capturedAt ?? "").localeCompare(
        String(left.capturedAt ?? "")
      ) || left.relativePath.localeCompare(right.relativePath, "de")
    );
  });

  return rows;
}

function openPreview(point: GeoMediaPoint): void {
  window.dispatchEvent(
    new CustomEvent("life-area:preview", {
      detail: {
        mediaId: point.mediaId,
        caption: basename(point.relativePath)
      }
    })
  );
}

function renderFilterSummary(filtered: GeoMediaPoint[]): void {
  const total = document.querySelector<HTMLElement>("#mapGeoCount");
  const filteredCount = document.querySelector<HTMLElement>("#mapFilteredCount");
  const summary = document.querySelector<HTMLElement>("#mapFilterState");

  if (total) total.textContent = points.length.toLocaleString("de-DE");
  if (filteredCount) filteredCount.textContent = filtered.length.toLocaleString("de-DE");
  if (!summary) return;

  const filter = activeFilters();
  const parts: string[] = [];

  if (filter.sourceId > 0) parts.push(sourceLabel(filter.sourceId));
  if (filter.kind === "image") parts.push("nur Fotos");
  if (filter.kind === "video") parts.push("nur Videos");
  if (filter.query) parts.push("Suche „" + filter.query + "“");

  const fromValue =
    document.querySelector<HTMLInputElement>("#mapDateFrom")?.value ?? "";
  const toValue =
    document.querySelector<HTMLInputElement>("#mapDateTo")?.value ?? "";
  if (fromValue || toValue) {
    parts.push(
      "Zeitraum " +
        (fromValue || "offen") +
        " – " +
        (toValue || "offen")
    );
  }

  summary.textContent =
    parts.length > 0
      ? parts.join(" · ")
      : "Alle georeferenzierten Medien";
}

function renderGallery(): void {
  const gallery = document.querySelector<HTMLElement>("#mapMediaGallery");
  const count = document.querySelector<HTMLElement>("#mapVisibleCount");
  const heading = document.querySelector<HTMLElement>("#mapVisibleCountText");
  if (!gallery || !count) return;

  const visible = sortedVisiblePoints();
  count.textContent = visible.length.toLocaleString("de-DE");
  if (heading) {
    heading.textContent =
      visible.length.toLocaleString("de-DE") +
      (visible.length === 1 ? " Medium im Kartenausschnitt" : " Medien im Kartenausschnitt");
  }

  if (visible.length === 0) {
    gallery.innerHTML =
      '<div class="map-gallery-empty"><strong>Keine Medien im aktuellen Ausschnitt</strong><span>Zoome heraus oder passe die Filter an.</span></div>';
    return;
  }

  const renderLimit = 120;
  const rows = visible.slice(0, renderLimit);

  gallery.innerHTML =
    rows
      .map((point) => {
        const image = thumb(point);
        const preview = image
          ? '<img loading="lazy" src="' + image + '" alt="">'
          : '<div class="map-gallery-placeholder">▧</div>';
        const kindLabel = mediaKind(point) === "video" ? "Video" : "Foto";

        return (
          '<button class="map-gallery-card" type="button" data-map-media-id="' +
          point.mediaId +
          '">' +
          '<span class="map-gallery-image">' +
          preview +
          '<span class="map-gallery-type">' +
          kindLabel +
          "</span></span>" +
          '<span class="map-gallery-copy"><strong>' +
          escapeHtml(basename(point.relativePath)) +
          "</strong><small>" +
          escapeHtml(formatDate(point.capturedAt)) +
          "</small><small>" +
          escapeHtml(sourceLabel(point.sourceId)) +
          " · " +
          escapeHtml(formatBytes(point.sizeBytes)) +
          "</small></span></button>"
        );
      })
      .join("") +
    (visible.length > renderLimit
      ? '<div class="map-gallery-limit"><strong>' +
        renderLimit.toLocaleString("de-DE") +
        " von " +
        visible.length.toLocaleString("de-DE") +
        ' Medien angezeigt</strong><span>Weiter hineinzoomen, um die Galerie einzugrenzen.</span></div>'
      : "");

  gallery
    .querySelectorAll<HTMLButtonElement>("[data-map-media-id]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const mediaId = Number(button.dataset.mapMediaId);
        const point = points.find((item) => item.mediaId === mediaId);
        if (point) openPreview(point);
      });
    });
}

function render(): void {
  if (!map || !layer) return;

  const filtered = filteredPoints();
  layer.clearLayers();
  const visible = visiblePoints(filtered);

  for (const group of clusters(map, visible)) {
    const latitude =
      group.reduce((sum, point) => sum + point.latitude, 0) / group.length;
    const longitude =
      group.reduce((sum, point) => sum + point.longitude, 0) / group.length;

    if (group.length === 1) {
      const point = group[0];
      const marker = L.circleMarker([latitude, longitude], {
        radius: 7,
        weight: 2,
        fillOpacity: 0.82
      });
      const image = thumb(point);
      marker.bindPopup(
        '<div class="map-popup">' +
          (image ? '<img src="' + image + '" alt="">' : "") +
          "<strong>" +
          escapeHtml(basename(point.relativePath)) +
          "</strong><small>" +
          escapeHtml(formatDate(point.capturedAt)) +
          "</small><small>" +
          escapeHtml(sourceLabel(point.sourceId)) +
          "</small></div>"
      );
      marker.on("dblclick", () => openPreview(point));
      marker.addTo(layer);
    } else {
      const radius = Math.min(30, 12 + Math.log2(group.length) * 4);
      const marker = L.circleMarker([latitude, longitude], {
        radius,
        weight: 2,
        fillOpacity: 0.86
      });
      marker.bindTooltip(String(group.length), {
        permanent: true,
        direction: "center",
        className: "map-cluster-label"
      });
      marker.on("click", () =>
        map?.setView(
          [latitude, longitude],
          Math.min(18, map.getZoom() + 2),
          { animate: true }
        )
      );
      marker.addTo(layer);
    }
  }

  renderFilterSummary(filtered);
  renderGallery();
}

function focusPrimaryArea(items = filteredPoints()): void {
  if (!map || items.length === 0) return;

  const cellDegrees = 4;
  const buckets = new Map<string, GeoMediaPoint[]>();

  for (const point of items) {
    const key =
      Math.floor(point.latitude / cellDegrees) +
      ":" +
      Math.floor(point.longitude / cellDegrees);
    const bucket = buckets.get(key) ?? [];
    bucket.push(point);
    buckets.set(key, bucket);
  }

  const primary = [...buckets.values()].sort(
    (left, right) => right.length - left.length
  )[0];

  if (!primary || primary.length === 0) return;

  if (primary.length === 1) {
    map.setView([primary[0].latitude, primary[0].longitude], 11);
    return;
  }

  const bounds = L.latLngBounds(
    primary.map(
      (point) => [point.latitude, point.longitude] as [number, number]
    )
  );
  map.fitBounds(bounds.pad(0.15), { maxZoom: 11 });
}

function applyFilters(refocus: boolean): void {
  const filtered = filteredPoints();
  const empty = document.querySelector<HTMLDivElement>("#mapEmptyState");

  if (empty) {
    empty.hidden = filtered.length > 0;
    empty.textContent =
      points.length === 0
        ? "Noch keine Medien mit GPS-Koordinaten im Katalog."
        : "Für die gewählten Filter gibt es keine Medien mit GPS-Koordinaten.";
  }

  if (refocus && filtered.length > 0) {
    focusPrimaryArea(filtered);
  }

  render();
}

function resetFilters(): void {
  const source = document.querySelector<HTMLSelectElement>("#mapSourceFilter");
  const kind = document.querySelector<HTMLSelectElement>("#mapMediaTypeFilter");
  const search = document.querySelector<HTMLInputElement>("#mapTextFilter");
  const from = document.querySelector<HTMLInputElement>("#mapDateFrom");
  const to = document.querySelector<HTMLInputElement>("#mapDateTo");

  if (source) source.value = "";
  if (kind) kind.value = "all";
  if (search) search.value = "";
  if (from) from.value = "";
  if (to) to.value = "";

  applyFilters(true);
}

function populateSources(): void {
  const select = document.querySelector<HTMLSelectElement>("#mapSourceFilter");
  if (!select) return;

  const current = select.value;
  select.innerHTML =
    '<option value="">Alle Quellen</option>' +
    sources
      .filter((source) => source.enabled)
      .map(
        (source) =>
          '<option value="' +
          source.id +
          '">' +
          escapeHtml(basename(source.path)) +
          "</option>"
      )
      .join("");

  if ([...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
}

function bindControls(): void {
  if (controlsBound) return;
  controlsBound = true;

  document
    .querySelector<HTMLSelectElement>("#mapMediaSort")
    ?.addEventListener("change", renderGallery);

  for (const id of ["mapSourceFilter", "mapMediaTypeFilter", "mapDateFrom", "mapDateTo"]) {
    document.querySelector<HTMLElement>("#" + id)?.addEventListener("change", () => {
      applyFilters(true);
    });
  }

  document
    .querySelector<HTMLInputElement>("#mapTextFilter")
    ?.addEventListener("input", () => {
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchTimer = null;
        const filtered = filteredPoints();
        if (filtered.length > 0 && visiblePoints(filtered).length === 0) {
          focusPrimaryArea(filtered);
        }
        render();
      }, 180);
    });

  document
    .querySelector<HTMLButtonElement>("#mapFilterReset")
    ?.addEventListener("click", resetFilters);

  document
    .querySelector<HTMLButtonElement>("#mapFitFiltered")
    ?.addEventListener("click", () => {
      const filtered = filteredPoints();
      if (filtered.length > 0) focusPrimaryArea(filtered);
    });
}

export async function activateMapView(): Promise<void> {
  const element = document.querySelector<HTMLDivElement>("#mediaMap");
  if (!element) return;

  if (!map) {
    map = L.map(element, {
      zoomControl: true,
      preferCanvas: true
    }).setView([48.8, 9.2], 5);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(map);

    layer = L.layerGroup().addTo(map);
    map.on("zoomend moveend", render);
  }

  bindControls();
  map.invalidateSize();

  if (!loaded) {
    const [geoPoints, sourceRows] = await Promise.all([
      window.imageSorter.catalog.listGeoMedia(),
      window.imageSorter.catalog.listSources()
    ]);
    points = geoPoints;
    sources = sourceRows;
    loaded = true;
    populateSources();
    applyFilters(points.length > 0);
  } else {
    populateSources();
    render();
  }
}

export function invalidateMapData(): void {
  loaded = false;
}
