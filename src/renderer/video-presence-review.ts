import type {
  VideoIdentityPresencePage, VideoIdentityPresenceName, VideoIdentityPresenceExample
} from "../shared/protocol";

type Kind = "person" | "pet";
type Item = VideoIdentityPresencePage["items"][number];

export class VideoPresenceReviewer {
  private offset = 0;
  private request = 0;
  private timer: number | null = null;
  private readonly pageSize = 6;

  constructor(
    private readonly kind: Kind,
    private readonly container: HTMLElement,
    private readonly visible: () => boolean,
    private readonly known: () => VideoIdentityPresenceName[],
    private readonly openVideo: (mediaId: number, relativePath: string, timestampMs: number) => void
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
      if (this.visible()) void this.load(true).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const status = this.container.querySelector<HTMLElement>(".video-presence-progress");
        if (status) status.textContent = "Aktualisierung fehlgeschlagen: " + message;
      });
    }, 550);
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

    // Never discard unsaved names or an expanded video during index backfill.
    // When a page is already usable, update only the progress indicator.
    if (progressive && this.container.querySelector(".video-presence-card")) {
      const progress = this.container.querySelector<HTMLElement>(".video-presence-progress");
      if (progress) this.updateProgress(progress, page);
      if (!page.indexComplete) this.schedule();
      return;
    }

    if (this.offset >= page.total && this.offset > 0) {
      this.offset = Math.max(0, Math.floor(Math.max(0,page.total-1)/this.pageSize)*this.pageSize);
      return this.load();
    }

    const heading = document.createElement("div");
    heading.className = "video-presence-heading";
    const title = document.createElement("strong");
    title.textContent = this.kind === "person"
      ? "Personen pro Video bestätigen" : "Haustiere pro Video bestätigen";
    const progress = document.createElement("small");
    progress.className = "video-presence-progress";
    this.updateProgress(progress, page);
    heading.append(title, progress);

    const list = document.createElement("div");
    list.className = "video-presence-list";
    for (const item of page.items) list.appendChild(this.createCard(item));
    if (!page.items.length) {
      const empty = document.createElement("p");
      empty.className = "person-empty";
      empty.textContent = page.indexComplete
        ? "Keine Videos mit entsprechenden Erkennungen vorhanden."
        : "Videos werden indexiert. Weitere Ergebnisse erscheinen automatisch.";
      list.appendChild(empty);
    }

    const pager = document.createElement("div");
    pager.className = "identity-candidate-pager";
    const back = document.createElement("button");
    back.className = "ghost";
    back.type = "button";
    back.textContent = "Vorherige";
    back.disabled = this.offset === 0;
    back.addEventListener("click", () => {
      this.offset -= this.pageSize;
      void this.load();
    });
    const index = document.createElement("span");
    index.textContent = page.total === 0 ? "0 Videos" :
      (this.offset + 1) + "–" + (this.offset + page.items.length) +
      " von " + page.total.toLocaleString("de-DE") + " Videos";
    const next = document.createElement("button");
    next.className = "ghost";
    next.type = "button";
    next.textContent = "Nächste";
    next.disabled = this.offset + this.pageSize >= page.total;
    next.addEventListener("click", () => {
      this.offset += this.pageSize;
      void this.load();
    });
    pager.append(back,index,next);
    this.container.replaceChildren(heading,list,pager);
    if (!page.indexComplete) this.schedule();
  }

  private updateProgress(target: HTMLElement, page: VideoIdentityPresencePage): void {
    target.textContent = page.total.toLocaleString("de-DE") +
      " Videos mit " + (this.kind === "person" ? "Personen" : "Haustieren") +
      " · " + page.indexedVideos.toLocaleString("de-DE") + " von " +
      page.totalVideos.toLocaleString("de-DE") + " analysierten Videos indexiert" +
      (page.indexComplete ? "" : " · Suche läuft");
  }

  private cropUrl(mediaId: number, example: VideoIdentityPresenceExample): string {
    const url = new URL("image-sorter-frame://media/" + mediaId);
    url.searchParams.set("ms", String(example.timestampMs));
    url.searchParams.set("width","1600");
    if (example.frameIndex !== null && example.frameHash) {
      url.searchParams.set("i",String(example.frameIndex));
      url.searchParams.set("h",example.frameHash);
    }
    const b = example.bounds;
    if (b) url.searchParams.set("crop",[
      b.x,b.y,b.width,b.height,b.frameWidth,b.frameHeight
    ].join(","));
    return url.toString();
  }

  private createCard(item: Item): HTMLDetailsElement {
    const card = document.createElement("details");
    card.className = "video-presence-card";
    // Collapsed by default: the header still displays four representative crops.
    const summary = document.createElement("summary");
    summary.className = "video-presence-summary";
    const filename = document.createElement("strong");
    filename.textContent = item.relativePath.split(/[\\/]/).pop() ?? item.relativePath;
    filename.title = item.relativePath;
    const status = document.createElement("small");
    status.className = "video-presence-status";
    const updateStatus = (reviewed: boolean, names: VideoIdentityPresenceName[]) => {
      status.textContent = reviewed
        ? names.length ? "Bestätigt: " + names.map((n) => n.name).join(", ")
          : this.kind === "person" ? "Bestätigt: Keine Person" : "Bestätigt: Kein Tier"
        : item.detectedCount.toLocaleString("de-DE") +
          " Erkennungen · Zuordnung offen";
    };
    const heading = document.createElement("div");
    heading.className = "video-presence-title";
    heading.append(filename,status);
    const images = document.createElement("div");
    images.className = "video-presence-examples";
    for (const example of item.examples.slice(0,4)) {
      const figure = document.createElement("span");
      figure.className = "video-presence-example";
      const image = document.createElement("img");
      image.loading = "lazy";
      image.src = this.cropUrl(item.mediaId,example);
      image.alt = this.kind === "person" ? "Erkanntes Gesicht" : "Erkanntes Haustier";
      image.title = (example.name ?? "Noch unbekannt") + " · " +
        Math.round(example.timestampMs / 1000) + " s · Video öffnen";
      image.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openVideo(item.mediaId, item.relativePath, example.timestampMs);
      });
      const name = document.createElement("small");
      name.textContent = example.name ?? (example.petClass === "cat" ? "Katze" :
        this.kind === "pet" ? "Hund" : "Person");
      figure.append(image,name);
      images.appendChild(figure);
    }
    summary.append(heading,images);
    card.appendChild(summary);

    const body = document.createElement("div");
    body.className = "video-presence-body";
    const help = document.createElement("p");
    help.textContent = "Nur festlegen, wer im gesamten Video vorkommt. " +
      "Die gezeigten Ausschnitte sind Vorschläge, keine einzeln zu bestätigenden Frames.";
    const selected: VideoIdentityPresenceName[] = item.confirmed.map(x => ({...x}));
    const choices = document.createElement("div");
    choices.className = "video-presence-choices";
    const redrawChoices = () => {
      choices.replaceChildren();
      for (let i=0;i<selected.length;i++) {
        const current = selected[i];
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "ghost video-presence-chip";
        chip.textContent = current.name + (current.petClass === "cat" ? " (Katze)" :
          current.petClass === "dog" ? " (Hund)" : "") + " ×";
        chip.title = "Aus der Videoauswahl entfernen";
        chip.addEventListener("click", () => {selected.splice(i,1);redrawChoices();});
        choices.appendChild(chip);
      }
    };
    const addName = (name: string, petClass: "dog" | "cat" | null) => {
      name = name.trim();
      if (!name) return;
      if (selected.some((entry) => entry.name.toLocaleLowerCase("de") ===
        name.toLocaleLowerCase("de") && entry.petClass === petClass)) return;
      selected.push({name,petClass});
      redrawChoices();
    };
    redrawChoices();
    const suggested = document.createElement("div");
    suggested.className = "video-presence-suggested";
    const unique = new Set<string>();
    for (const example of item.examples) {
      if (!example.name) continue;
      const petClass = this.kind === "person" ? null : example.petClass ?? "dog";
      const key = (petClass ?? "") + ":" + example.name.toLocaleLowerCase("de");
      if (unique.has(key)) continue;
      unique.add(key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = "+ Vorschlag: " + example.name;
      button.addEventListener("click", () => addName(example.name!,petClass));
      suggested.appendChild(button);
    }
    const entryRow = document.createElement("div");
    entryRow.className = "video-presence-entry";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = 120;
    input.placeholder = this.kind === "person" ? "Person auswählen oder eingeben" :
      "Haustier auswählen oder eingeben";
    const datalist = document.createElement("datalist");
    datalist.id = "presence-names-" + this.kind + "-" + item.mediaId;
    input.setAttribute("list",datalist.id);
    for (const known of this.known()) {
      const option = document.createElement("option");
      option.value = known.name;
      datalist.appendChild(option);
    }
    const klass = document.createElement("select");
    if (this.kind === "pet") {
      for (const [value,label] of [["dog","Hund"],["cat","Katze"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        klass.appendChild(option);
      }
      entryRow.appendChild(klass);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ghost";
    add.textContent = "Hinzufügen";
    const append = () => {
      if (!input.value.trim()) {input.focus();return;}
      const matching = this.kind === "pet"
        ? this.known().filter(pet =>
            pet.name.toLocaleLowerCase("de") === input.value.trim().toLocaleLowerCase("de"))
        : [];
      const inferredClass = matching.length === 1 ? matching[0].petClass : null;
      addName(input.value,this.kind === "person" ? null :
        inferredClass ?? (klass.value === "cat" ? "cat" : "dog"));
      input.value = "";
      input.focus();
    };
    add.addEventListener("click",append);
    input.addEventListener("keydown",event => {
      if (event.key === "Enter") {event.preventDefault();append();}
    });
    entryRow.append(input,datalist,add);
    const footer = document.createElement("div");
    footer.className = "video-presence-footer";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Video bestätigen";
    const none = document.createElement("button");
    none.type = "button";
    none.className = "ghost";
    none.textContent = this.kind === "person" ? "Keine Person im Video" : "Kein Tier im Video";
    const result = document.createElement("small");
    const persist = async (names: VideoIdentityPresenceName[]) => {
      save.disabled = true;
      none.disabled = true;
      result.textContent = "Wird gespeichert …";
      try {
        await window.imageSorter.catalog.setVideoIdentityPresence(item.mediaId,this.kind,names);
        selected.splice(0,selected.length,...names);
        redrawChoices();
        updateStatus(true,names);
        result.textContent = "Gespeichert für das gesamte Video.";
      } catch (error) {
        result.textContent = "Speichern fehlgeschlagen: " +
          (error instanceof Error ? error.message : String(error));
      } finally {
        save.disabled = false;
        none.disabled = false;
      }
    };
    save.addEventListener("click",() => {
      if (!selected.length) {
        result.textContent = "Bitte einen Namen hinzufügen oder „Keine … im Video“ wählen.";
        return;
      }
      void persist(selected.map(x=>({...x})));
    });
    none.addEventListener("click",() => {
      if (selected.length && !window.confirm(
        "Die ausgewählten Namen für dieses Video entfernen und ausdrücklich „" +
        (this.kind === "person" ? "Keine Person" : "Kein Tier") + "“ bestätigen?"
      )) return;
      void persist([]);
    });
    footer.append(save,none,result);
    body.append(help,choices,suggested,entryRow,footer);
    card.appendChild(body);
    updateStatus(item.reviewed,selected);
    return card;
  }
}
