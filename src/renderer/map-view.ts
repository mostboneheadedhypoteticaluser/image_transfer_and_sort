import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoMediaPoint } from "../shared/protocol";

let map: L.Map | null = null;
let layer: L.LayerGroup | null = null;
let points: GeoMediaPoint[] = [];
let loaded = false;
let controlsBound = false;

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

function visiblePoints(): GeoMediaPoint[] {
  if (!map) return [];
  const bounds = map.getBounds();
  return points.filter((point) =>
    bounds.contains([point.latitude, point.longitude])
  );
}

function sortedVisiblePoints(): GeoMediaPoint[] {
  const sort = document.querySelector<HTMLSelectElement>("#mapMediaSort")?.value ?? "newest";
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

function renderGallery(): void {
  const gallery = document.querySelector<HTMLElement>("#mapMediaGallery");
  const count = document.querySelector<HTMLElement>("#mapVisibleCount");
  if (!gallery || !count) return;

  const visible = sortedVisiblePoints();
  count.textContent =
    visible.length.toLocaleString("de-DE") +
    (visible.length === 1 ? " Medium im Ausschnitt" : " Medien im Ausschnitt");

  if (visible.length === 0) {
    gallery.innerHTML =
      '<div class="map-gallery-empty">Im aktuellen Kartenausschnitt liegen keine Medien.</div>';
    return;
  }

  const renderLimit = 160;
  const rows = visible.slice(0, renderLimit);

  gallery.innerHTML =
    rows
      .map((point) => {
        const image = thumb(point);
        const preview = image
          ? '<img loading="lazy" src="' + image + '" alt="">'
          : '<div class="map-gallery-placeholder">▧</div>';

        return (
          '<button class="map-gallery-card" type="button" data-map-media-id="' +
          point.mediaId +
          '">' +
          preview +
          '<span class="map-gallery-copy"><strong>' +
          escapeHtml(basename(point.relativePath)) +
          "</strong><small>" +
          escapeHtml(formatDate(point.capturedAt)) +
          " · " +
          escapeHtml(formatBytes(point.sizeBytes)) +
          "</small></span></button>"
        );
      })
      .join("") +
    (visible.length > renderLimit
      ? '<div class="map-gallery-limit">Weitere ' +
        (visible.length - renderLimit).toLocaleString("de-DE") +
        " Medien liegen im Ausschnitt. Weiter hineinzoomen, um sie einzugrenzen.</div>"
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

  layer.clearLayers();
  const visible = visiblePoints();

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
          escapeHtml(point.relativePath) +
          "</strong><small>" +
          escapeHtml(formatDate(point.capturedAt)) +
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

  const total = document.querySelector<HTMLElement>("#mapGeoCount");
  if (total) total.textContent = points.length.toLocaleString("de-DE");
  renderGallery();
}

function focusPrimaryArea(): void {
  if (!map || points.length === 0) return;

  const cellDegrees = 4;
  const buckets = new Map<string, GeoMediaPoint[]>();

  for (const point of points) {
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
  map.fitBounds(bounds.pad(0.2), { maxZoom: 10 });
}

export async function activateMapView(): Promise<void> {
  const element = document.querySelector<HTMLDivElement>("#mediaMap");
  const empty = document.querySelector<HTMLDivElement>("#mapEmptyState");
  if (!element) return;

  if (!map) {
    map = L.map(element, {
      zoomControl: true,
      preferCanvas: true
    }).setView([48.8, 9.2], 5);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap"
    }).addTo(map);

    layer = L.layerGroup().addTo(map);
    map.on("zoomend moveend", render);
  }

  if (!controlsBound) {
    controlsBound = true;
    document
      .querySelector<HTMLSelectElement>("#mapMediaSort")
      ?.addEventListener("change", renderGallery);
  }

  map.invalidateSize();

  if (!loaded) {
    points = await window.imageSorter.catalog.listGeoMedia();
    loaded = true;
    if (empty) empty.hidden = points.length > 0;
    if (points.length > 0) focusPrimaryArea();
    render();
  }
}

export function invalidateMapData(): void {
  loaded = false;
}
