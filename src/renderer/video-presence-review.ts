import type {
  VideoIdentityPresencePage,
  VideoIdentityPresenceName,
  VideoIdentityPresenceExample,
  VideoIdentityFrameReviewPage
} from "../shared/protocol";

type Kind = "person" | "pet";
type Video = VideoIdentityPresencePage["items"][number];
type Detection = VideoIdentityFrameReviewPage["items"][number];
type FrameCounts = Pick<VideoIdentityFrameReviewPage, "total" | "open" | "confirmed" | "ignored">;

/**
 * A video is only a collapsible container. Every detected face/animal is
 * reviewed individually; ranked proposals never confirm adjacent frames.
 * Large videos are paged on expansion instead of rendering hundreds of crops.
 */
export class VideoPresenceReviewer {
  private offset = 0;
  private request = 0;
  private timer: number | null = null;
  private readonly pageSize = 6;
  private readonly framePageSize = 24;

  constructor(
    private readonly kind: Kind,
    private readonly container: HTMLElement,
    private readonly visible: () => boolean,
    private readonly known: () => VideoIdentityPresenceName[],
    private readonly openVideo: (mediaId: number, relativePath: string, timestampMs: number) => void,
    private readonly onVideoCompleted: () => Promise<void>
  ) {}

  stop(): void {
    this.request++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  reset(): void {
    this.stop();
    this.offset = 0;
    this.container.replaceChildren();
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.visible()) return;
      void this.load(true).catch((error) => {
        const target = this.container.querySelector<HTMLElement>(".video-presence-progress");
        if (target) target.textContent = "Indexaktualisierung fehlgeschlagen: " +
          (error instanceof Error ? error.message : String(error));
      });
    }, 650);
  }

  async load(progressive = false): Promise<void> {
    if (!this.visible()) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    const request = ++this.request;
    const page = await window.imageSorter.catalog.listVideoIdentityPresenceReview(
      this.kind, this.offset, this.pageSize
    );
    if (request !== this.request || !this.visible()) return;

    // Do not discard expanded videos, drafts and already saved decisions while
    // more old analyses are being indexed in the background.
    if (progressive && this.container.querySelector(".video-presence-card")) {
      const status = this.container.querySelector<HTMLElement>(".video-presence-progress");
      if (status) this.updateProgress(status, page);
      const newVideos = this.container.querySelector<HTMLElement>(".video-presence-refresh-needed");
      if (newVideos) newVideos.hidden = page.items.length ===
        this.container.querySelectorAll(".video-presence-card").length;
      const next = this.container.querySelector<HTMLButtonElement>(".video-presence-next");
      if (next) next.disabled = this.offset + this.pageSize >= page.total;
      if (!page.indexComplete) this.schedule();
      return;
    }

    if (this.offset >= page.total && this.offset > 0) {
      this.offset = Math.max(0,
        Math.floor(Math.max(0, page.total - 1) / this.pageSize) * this.pageSize);
      return this.load();
    }

    const heading = document.createElement("div");
    heading.className = "video-presence-heading";
    const title = document.createElement("strong");
    title.textContent = this.kind === "person"
      ? "Personen in Videobildern bestätigen"
      : "Haustiere in Videobildern bestätigen";
    const progress = document.createElement("small");
    progress.className = "video-presence-progress";
    this.updateProgress(progress, page);
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "ghost";
    reload.textContent = "Videoliste aktualisieren";
    reload.addEventListener("click", () => void this.load());
    const newVideos = document.createElement("small");
    newVideos.className = "video-presence-refresh-needed";
    newVideos.hidden = true;
    newVideos.textContent = "Neue Videos gefunden – Liste aktualisieren.";
    heading.append(title, progress, reload, newVideos);

    const list = document.createElement("div");
    list.className = "video-presence-list";
    for (const video of page.items) list.appendChild(this.createCard(video));
    if (!page.items.length) {
      const empty = document.createElement("p");
      empty.className = "person-empty";
      empty.textContent = page.indexComplete
        ? "Keine Videos mit entsprechenden Erkennungen vorhanden."
        : "Video-Erkennungen werden indexiert.";
      list.appendChild(empty);
    }

    const pager = document.createElement("div");
    pager.className = "identity-candidate-pager";
    const previous = document.createElement("button");
    previous.className = "ghost";
    previous.type = "button";
    previous.textContent = "Vorherige";
    previous.disabled = this.offset === 0;
    previous.addEventListener("click", () => {
      this.offset = Math.max(0, this.offset - this.pageSize);
      void this.load();
    });
    const index = document.createElement("span");
    index.textContent = page.total === 0 ? "0 Videos" :
      (this.offset + 1) + "–" + (this.offset + page.items.length) +
      " von " + page.total.toLocaleString("de-DE") + " Videos";
    const next = document.createElement("button");
    next.className = "ghost video-presence-next";
    next.type = "button";
    next.textContent = "Nächste";
    next.disabled = this.offset + this.pageSize >= page.total;
    next.addEventListener("click", () => {
      this.offset += this.pageSize;
      void this.load();
    });
    pager.append(previous, index, next);
    this.container.replaceChildren(heading, list, pager);
    if (!page.indexComplete) this.schedule();
  }

  private updateProgress(target: HTMLElement, page: VideoIdentityPresencePage): void {
    target.textContent = page.total.toLocaleString("de-DE") +
      " Videos mit " + (this.kind === "person" ? "Personenerkennungen" : "Tiererkennungen") +
      " · " + page.indexedVideos.toLocaleString("de-DE") + " von " +
      page.totalVideos.toLocaleString("de-DE") + " analysierten Videos indexiert" +
      (page.indexComplete ? "" : " · Suche läuft");
  }

  private cropUrl(
    mediaId: number,
    example: Pick<VideoIdentityPresenceExample, "timestampMs" | "frameIndex" | "frameHash"> & {
      bounds: VideoIdentityPresenceExample["bounds"] | null
    }
  ): string {
    const url = new URL("image-sorter-frame://media/" + mediaId);
    url.searchParams.set("ms", String(example.timestampMs));
    url.searchParams.set("width", "720");
    if (example.frameIndex !== null && example.frameHash) {
      url.searchParams.set("i", String(example.frameIndex));
      url.searchParams.set("h", example.frameHash);
    }
    const b = example.bounds;
    if (b) url.searchParams.set("crop", [
      b.x, b.y, b.width, b.height, b.frameWidth, b.frameHeight
    ].join(","));
    return url.toString();
  }

  private time(ms: number): string {
    const sec = Math.floor(Math.max(0, ms) / 1000);
    return String(Math.floor(sec / 60)).padStart(2, "0") + ":" +
      String(sec % 60).padStart(2, "0");
  }

  private createCard(video: Video): HTMLDetailsElement {
    const card = document.createElement("details");
    card.className = "video-presence-card";
    // Explicitly collapsed by default, even on return to this view.
    const summary = document.createElement("summary");
    summary.className = "video-presence-summary";
    const heading = document.createElement("div");
    heading.className = "video-presence-title";
    const name = document.createElement("strong");
    name.textContent = video.relativePath.split(/[\\/]/).pop() ?? video.relativePath;
    name.title = video.relativePath;
    const count = document.createElement("small");
    count.className = "video-presence-status";
    count.textContent = video.detectedCount.toLocaleString("de-DE") +
      " Erkennungen · Zum Bestätigen aufklappen";
    heading.append(name, count);
    const images = document.createElement("div");
    images.className = "video-presence-examples";
    for (const example of video.examples.slice(0,4)) {
      const figure = document.createElement("span");
      figure.className = "video-presence-example";
      const image = document.createElement("img");
      image.loading = "lazy";
      image.src = this.cropUrl(video.mediaId,example);
      image.alt = this.kind === "person" ? "Gesicht" : "Haustier";
      image.title = this.time(example.timestampMs) + " · Video öffnen";
      image.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openVideo(video.mediaId,video.relativePath,example.timestampMs);
      });
      const label = document.createElement("small");
      label.textContent = example.name ??
        (this.kind === "person" ? "Person" : example.petClass === "cat" ? "Katze" : "Hund");
      figure.append(image,label);
      images.appendChild(figure);
    }
    // This per-video action also works when the details panel is collapsed.
    const reanalyze = document.createElement("button");
    reanalyze.type = "button";
    reanalyze.className = "ghost video-presence-reanalyze";
    reanalyze.textContent = "Neu analysieren";
    reanalyze.title = "Dieses Video bevorzugt neu analysieren und bisherige Zuordnungen zurücksetzen.";
    const reanalyzeStatus = document.createElement("small");
    reanalyzeStatus.className = "video-presence-reanalyze-status";
    reanalyzeStatus.setAttribute("role", "status");
    reanalyze.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (reanalyze.disabled) return;
      const confirmed = window.confirm(
        "Video „" + name.textContent + "“ bevorzugt neu analysieren?\n\n" +
        "Dabei werden alle bisherigen Erkennungen sowie Personen- und Haustierbestätigungen " +
        "und ignorierte Fundstellen dieses Videos gelöscht. " +
        "Manuelle Lebensbereiche bleiben erhalten."
      );
      if (!confirmed) return;
      reanalyze.disabled = true;
      reanalyze.textContent = "Wird eingereiht …";
      reanalyzeStatus.textContent = "";
      void window.imageSorter.catalog.reanalyzeMedia(video.mediaId).then((result) => {
        reanalyze.textContent = "Zur Analyse eingereiht";
        reanalyzeStatus.textContent =
          result.requeued.toLocaleString("de-DE") + " Analyseschritte eingereiht.";
        count.textContent = "Zur Neuanalyse eingereiht · Neue Ergebnisse stehen noch aus";
        images.replaceChildren();
        card.open = false;
      }).catch((error) => {
        reanalyze.disabled = false;
        reanalyze.textContent = "Neu analysieren";
        reanalyzeStatus.textContent = "Einreihen fehlgeschlagen: " +
          (error instanceof Error ? error.message : String(error));
      });
    });
    summary.append(heading,images,reanalyze,reanalyzeStatus);
    card.appendChild(summary);

    const body = document.createElement("div");
    body.className = "video-presence-body";
    const info = document.createElement("p");
    info.textContent = "Jede Erkennung einzeln zuordnen: einen der bis zu drei Namen " +
      "anklicken, einen anderen Namen eingeben oder diese Erkennung ignorieren.";
    body.appendChild(info);
    if (video.reviewed) {
      const legacy = document.createElement("p");
      legacy.textContent = "Für dieses Video gibt es noch eine frühere Gesamtbestätigung" +
        (video.confirmed.length ? " (" + video.confirmed.map(x => x.name).join(", ") + ")" : "") +
        ". Die erste Einzelentscheidung ersetzt die Gesamtbestätigung dieser Art.";
      body.appendChild(legacy);
    }
    const message = document.createElement("small");
    message.className = "video-presence-frame-message";
    const frames = document.createElement("div");
    frames.className = "video-presence-frames";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ghost";
    more.textContent = "Weitere Erkennungen laden";
    more.hidden = true;
    body.append(message, frames, more);
    card.appendChild(body);

    let offset = 0;
    let loading = false;
    let loaded = false;
    let completing = false;
    let counts: FrameCounts = {
      total: video.detectedCount, open: video.detectedCount,
      confirmed: 0, ignored: 0
    };
    const updateCounts = () => {
      count.textContent = counts.open.toLocaleString("de-DE") + " offen · " +
        counts.confirmed.toLocaleString("de-DE") + " bestätigt · " +
        counts.ignored.toLocaleString("de-DE") + " ignoriert";
    };
    const updateDecision = (
      previous: Detection["state"], next: Detection["state"]
    ) => {
      if (previous === next) return;
      counts[previous] = Math.max(0,counts[previous]-1);
      counts[next]++;
      updateCounts();
      if (counts.total > 0 && counts.open === 0 && !completing) {
        completing = true;
        message.textContent = "Alle Fundstellen bearbeitet · Übersicht wird aktualisiert …";
        // Let the saved decision and its grey preview render before replacing
        // the review list. A completed video will be absent from the next page.
        window.setTimeout(() => {
          if (!this.visible()) return;
          void (async () => {
            try {
              await this.load();
            } catch (error) {
              message.textContent = "Videoliste konnte nicht aktualisiert werden: " +
                (error instanceof Error ? error.message : String(error));
            }
            // Confirmed identities are rendered in the separate lower section.
            try {
              await this.onVideoCompleted();
            } catch (error) {
              message.textContent = "Bestätigte Identitäten konnten nicht aktualisiert werden: " +
                (error instanceof Error ? error.message : String(error));
            }
          })();
        }, 250);
      }
    };
    const loadFrames = async () => {
      if (loading || !card.open || !card.isConnected || !this.visible()) return;
      loading = true;
      more.disabled = true;
      message.textContent = "Erkennungen werden geladen …";
      try {
        const page = await window.imageSorter.catalog.listVideoIdentityFrameReview(
          video.mediaId,this.kind,offset,this.framePageSize
        );
        if (!card.isConnected || !this.visible()) return;
        // Results have a stable time/index order, regardless of confirmations.
        if (!loaded) {
          counts = {
            total:page.total,open:page.open,
            confirmed:page.confirmed,ignored:page.ignored
          };
          updateCounts();
          loaded = true;
        }
        for (const detection of page.items) {
          frames.appendChild(this.createDetection(
            video,detection,updateDecision,message
          ));
        }
        offset += page.items.length;
        more.hidden = offset >= page.total;
        message.textContent = page.total === 0
          ? "Keine Erkennungen für dieses Video vorhanden."
          : offset.toLocaleString("de-DE") + " von " +
            page.total.toLocaleString("de-DE") + " Fundstellen geladen.";
      } catch (error) {
        message.textContent = "Erkennungen konnten nicht geladen werden: " +
          (error instanceof Error ? error.message : String(error));
        more.hidden = false;
      } finally {
        loading = false;
        more.disabled = false;
      }
    };
    more.addEventListener("click", () => void loadFrames());
    card.addEventListener("toggle", () => {
      if (card.open && !loaded) void loadFrames();
    });
    return card;
  }

  private createDetection(
    video: Video,
    initial: Detection,
    updateCounts: (previous: Detection["state"], next: Detection["state"]) => void,
    message: HTMLElement
  ): HTMLElement {
    const card = document.createElement("article");
    card.className = "video-presence-frame";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "video-presence-frame-preview";
    preview.title = "Video an dieser Stelle öffnen";
    const crop = document.createElement("img");
    crop.loading = "lazy";
    crop.src = this.cropUrl(video.mediaId,initial);
    crop.alt = this.kind === "person" ? "Erkanntes Gesicht" : "Erkanntes Haustier";
    const time = document.createElement("small");
    time.textContent = this.time(initial.timestampMs) + " · Fund " +
      (initial.detectionIndex + 1);
    preview.append(crop,time);
    preview.addEventListener("click", () =>
      this.openVideo(video.mediaId,video.relativePath,initial.timestampMs)
    );

    const content = document.createElement("div");
    content.className = "video-presence-frame-content";
    const status = document.createElement("strong");
    status.className = "video-presence-frame-status";
    const proposals = document.createElement("div");
    proposals.className = "video-presence-frame-proposals";
    const proposalLabel = document.createElement("small");
    proposalLabel.textContent = "Beste Vorschläge:";
    proposals.appendChild(proposalLabel);
    const actions = document.createElement("div");
    actions.className = "video-presence-frame-actions";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = 120;
    input.placeholder = this.kind === "person" ? "Anderen Personennamen eingeben" :
      "Anderen Haustiernamen eingeben";
    input.value = initial.assignedName ?? "";
    const options = document.createElement("datalist");
    options.id = "video-frame-names-" + this.kind + "-" +
      video.mediaId + "-" + initial.timestampMs + "-" + initial.detectionIndex;
    input.setAttribute("list",options.id);
    for (const known of this.known()) {
      if (this.kind === "pet" && known.petClass !== initial.petClass) continue;
      const option = document.createElement("option");
      option.value = known.name;
      options.appendChild(option);
    }
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Zuordnen";
    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.className = "ghost";
    ignore.textContent = this.kind === "person"
      ? "Keine Person / Ignorieren" : "Kein Tier / Ignorieren";
    const feedback = document.createElement("small");
    feedback.className = "video-presence-frame-feedback";
    actions.append(input,options,save,ignore);
    content.append(status,proposals,actions,feedback);
    card.append(preview,content);

    let state: Detection["state"] = initial.state;
    let assignedName = initial.assignedName;
    let busy = false;
    const buttons: HTMLButtonElement[] = [];
    const redraw = () => {
      card.dataset.state = state;
      status.textContent = state === "ignored"
        ? "Ignoriert" : state === "confirmed"
          ? "Bestätigt: " + (assignedName ?? "") :
            this.kind === "person" ? "Person zuordnen" :
              initial.petClass === "cat" ? "Katze zuordnen" : "Hund zuordnen";
      ignore.hidden = state === "confirmed";
      ignore.textContent = state === "ignored" ? "Ignorierung rückgängig" :
        this.kind === "person" ? "Keine Person / Ignorieren" : "Kein Tier / Ignorieren";
      input.disabled = busy || state === "ignored";
      save.disabled = busy || state === "ignored";
      ignore.disabled = busy;
      for (const button of buttons) {
        button.disabled = busy || state === "ignored";
        button.classList.toggle("active",
          state === "confirmed" && button.dataset.name === assignedName);
      }
    };
    const assign = async (name: string) => {
      name = name.trim();
      if (!name || busy || state === "ignored") {
        if (!name) input.focus();
        return;
      }
      busy = true;
      feedback.textContent = "Speichert …";
      redraw();
      try {
        await window.imageSorter.catalog.assignVideoFrameIdentityName(
          video.mediaId,initial.timestampMs,this.kind,initial.detectionIndex,
          initial.petClass,name
        );
        const previous = state;
        state = "confirmed";
        assignedName = name;
        input.value = name;
        updateCounts(previous,state);
        feedback.textContent = "Gespeichert – nur diese Fundstelle.";
        message.textContent = "Zuordnung gespeichert.";
      } catch (error) {
        feedback.textContent = "Speichern fehlgeschlagen: " +
          (error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        redraw();
      }
    };
    const suggestions = initial.suggestions.slice(0,3);
    for (let i = 0; i < suggestions.length; i++) {
      const suggestion = suggestions[i];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost video-presence-proposal";
      button.dataset.name = suggestion.name;
      button.textContent = (i + 1) + ". " + suggestion.name +
        " · " + suggestion.similarity.toFixed(3).replace(".", ",");
      button.title = "Ähnlichkeitswert, keine Trefferwahrscheinlichkeit. " +
        "Anklicken, um nur dieses Bild zu bestätigen.";
      button.addEventListener("click", () => void assign(suggestion.name));
      proposals.appendChild(button);
      buttons.push(button);
    }
    if (suggestions.length < 3) {
      const empty = document.createElement("small");
      empty.textContent = suggestions.length
        ? "Weitere passende Vorschläge sind für diese Erkennung nicht gespeichert."
        : "Kein passender Namensvorschlag vorhanden; Namen manuell eingeben.";
      proposals.appendChild(empty);
    }
    save.addEventListener("click", () => void assign(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void assign(input.value);
      }
    });
    ignore.addEventListener("click", async () => {
      if (busy || state === "confirmed") return;
      const ignored = state !== "ignored";
      busy = true;
      redraw();
      try {
        await window.imageSorter.catalog.setVideoFrameDetectionIgnored(
          video.mediaId,initial.timestampMs,this.kind,initial.detectionIndex,ignored
        );
        const previous = state;
        state = ignored ? "ignored" : "open";
        updateCounts(previous,state);
        feedback.textContent = ignored
          ? "Als Fehl-Erkennung gespeichert."
          : "Ignorierung aufgehoben.";
      } catch (error) {
        feedback.textContent = "Änderung fehlgeschlagen: " +
          (error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        redraw();
      }
    });
    redraw();
    return card;
  }
}
