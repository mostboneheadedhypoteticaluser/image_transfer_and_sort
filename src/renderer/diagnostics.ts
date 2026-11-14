import type {
  AnalysisErrorCause,
  AnalysisErrorOverview,
  AnalysisErrorPageFilter,
  AnalysisErrorRecord,
  DiagnosticLogEntry
} from "../shared/protocol";

const CAUSE_LABELS: Record<AnalysisErrorCause, string> = {
  UNAVAILABLE: "Datei nicht erreichbar",
  DEPENDENCY: "Folgefehler (Voraussetzung fehlt)",
  HEIC: "HEIC / HEIF",
  LARGE_IMAGE: "Sehr großes Bild",
  TIMEOUT: "Zeitüberschreitung",
  FORMAT: "Dateiformat / Decoder",
  DECODE: "Bild konnte nicht gelesen werden",
  OTHER: "Sonstiger Fehler"
};
const PAGE_SIZE = 75;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function displayDate(value: string | null): string {
  return value ? value.replace("T", " ").replace("Z", " UTC") : "—";
}

export function initDiagnosticsPage(
  selectedSourceId: () => number | null,
  notify: (message: string) => void
): { refresh: () => Promise<void> } {
  const get = <T extends HTMLElement>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error("Diagnoseelement fehlt: " + selector);
    return found;
  };

  const total = get<HTMLElement>("#diagnosticsSummary");
  const groups = get<HTMLDivElement>("#diagnosticsGroups");
  const rows = get<HTMLDivElement>("#diagnosticsErrors");
  const paging = get<HTMLElement>("#diagnosticsPageStatus");
  const pageBack = get<HTMLButtonElement>("#diagnosticsPrevious");
  const pageNext = get<HTMLButtonElement>("#diagnosticsNext");
  const moduleFilter = get<HTMLSelectElement>("#diagnosticsModule");
  const causeFilter = get<HTMLSelectElement>("#diagnosticsCause");
  const scope = get<HTMLSelectElement>("#diagnosticsScope");
  const search = get<HTMLInputElement>("#diagnosticsSearch");
  const eventLog = get<HTMLDivElement>("#diagnosticsLog");
  const logOnlyErrors = get<HTMLInputElement>("#diagnosticsLogOnlyProblems");

  let offset = 0;
  let pageToken = 0;
  let logToken = 0;
  let searchTimer: number | null = null;
  let latestOverview: AnalysisErrorOverview | null = null;
  let latestPage: Array<AnalysisErrorRecord & { cause: AnalysisErrorCause }> = [];
  let latestLog: DiagnosticLogEntry[] = [];

  function currentSourceId(): number | undefined {
    return scope.value === "source" ? selectedSourceId() ?? undefined : undefined;
  }

  function filters(): AnalysisErrorPageFilter {
    return {
      sourceId: currentSourceId(),
      module: moduleFilter.value,
      cause: causeFilter.value as AnalysisErrorCause | "",
      search: search.value.trim(),
      offset,
      limit: PAGE_SIZE
    };
  }

  function addAction(
    parent: HTMLElement, title: string, action: () => Promise<void>
  ): void {
    const button = element("button", "ghost", title);
    button.type = "button";
    button.addEventListener("click", () => {
      button.disabled = true;
      void action().catch((error) => {
        notify("Diagnoseaktion fehlgeschlagen: " + String(error));
      }).finally(() => { button.disabled = false; });
    });
    parent.appendChild(button);
  }

  function renderOverview(overview: AnalysisErrorOverview): void {
    latestOverview = overview;
    const real = overview.totalJobs - overview.dependentJobs - overview.unavailableJobs;
    total.textContent =
      overview.totalJobs.toLocaleString("de-DE") + " Fehlerjobs · " +
      overview.mediaCount.toLocaleString("de-DE") + " unterschiedliche Medien · " +
      real.toLocaleString("de-DE") + " direkte Fehler · " +
      overview.dependentJobs.toLocaleString("de-DE") + " Folgefehler · " +
      overview.unavailableJobs.toLocaleString("de-DE") + " nicht erreichbare Dateien";

    const preserved = moduleFilter.value;
    const modules = [...new Set(overview.groups.map((group) => group.module))].sort();
    moduleFilter.replaceChildren(element("option", "", "Alle Analyseschritte"));
    moduleFilter.options[0].value = "";
    for (const module of modules) {
      const option = element("option", "", module);
      option.value = module;
      moduleFilter.appendChild(option);
    }
    moduleFilter.value = modules.includes(preserved) ? preserved : "";

    groups.replaceChildren();
    if (!overview.groups.length) {
      groups.appendChild(element("p", "diagnostics-empty", "Keine aktuellen Fehler."));
      return;
    }
    for (const group of overview.groups) {
      const card = element("button", "diagnostics-cause-group");
      card.type = "button";
      card.title = group.example;
      const label = element("strong", "", CAUSE_LABELS[group.cause]);
      const module = element("span", "", group.module);
      const count = element("b", "", group.count.toLocaleString("de-DE") + " Jobs");
      const media = element("small", "", group.mediaCount.toLocaleString("de-DE") + " Medien");
      card.append(label, module, count, media);
      card.addEventListener("click", () => {
        moduleFilter.value = group.module;
        causeFilter.value = group.cause;
        offset = 0;
        void refreshPage();
      });
      groups.appendChild(card);
    }
  }

  async function refreshOverview(): Promise<void> {
    const summary = await window.imageSorter.analysis.getErrorOverview(currentSourceId());
    renderOverview(summary);
  }

  function renderPage(
    items: Array<AnalysisErrorRecord & { cause: AnalysisErrorCause }>,
    count: number
  ): void {
    latestPage = items;
    rows.replaceChildren();

    for (const item of items) {
      const card = element("article", "diagnostics-error-card");
      const head = element("div", "diagnostics-error-head");
      const title = element("div");
      title.append(
        element("strong", "", item.module),
        element("small", "", CAUSE_LABELS[item.cause] + " · " +
          item.attempts + " Versuch(e) · " + displayDate(item.finishedAt))
      );
      const actions = element("div", "diagnostics-error-actions");
      addAction(actions, "Erneut versuchen", async () => {
        const outcome = await window.imageSorter.analysis.retryJob(item.id);
        notify(outcome.retried + " Job(s) neu eingeplant.");
        await refresh();
      });
      addAction(actions, "Ordner", async () => {
        await window.imageSorter.analysis.openFolder(item.mediaId);
      });
      addAction(actions, "Datei", async () => {
        await window.imageSorter.analysis.openFile(item.mediaId);
      });
      addAction(actions, "Kopieren", async () => {
        await navigator.clipboard.writeText([
          item.module, item.relativePath, item.errorMessage,
          "Versuche: " + item.attempts,
          "Zeitpunkt: " + displayDate(item.finishedAt)
        ].join("\n"));
        notify("Fehlerdetails kopiert.");
      });
      head.append(title, actions);
      const path = element("div", "diagnostics-error-file", item.relativePath);
      const msg = element("pre", "diagnostics-error-message", item.errorMessage);
      card.append(head, path, msg);
      rows.appendChild(card);
    }
    if (!items.length) {
      rows.appendChild(element("p", "diagnostics-empty", "Keine Treffer für die gewählten Filter."));
    }
    const first = count ? offset + 1 : 0;
    paging.textContent =
      first.toLocaleString("de-DE") + "–" +
      Math.min(count,offset + items.length).toLocaleString("de-DE") +
      " von " + count.toLocaleString("de-DE");
    pageBack.disabled = offset === 0;
    pageNext.disabled = offset + items.length >= count;
  }

  async function refreshPage(): Promise<void> {
    const token = ++pageToken;
    rows.replaceChildren(element("p", "diagnostics-empty", "Fehler werden geladen …"));
    const response = await window.imageSorter.analysis.getErrorPage(filters());
    if (token !== pageToken) return;
    if (offset >= response.total && offset > 0) {
      offset = Math.max(0, Math.floor((response.total - 1) / PAGE_SIZE) * PAGE_SIZE);
      return refreshPage();
    }
    renderPage(response.items, response.total);
  }

  async function refreshLog(): Promise<void> {
    const token = ++logToken;
    eventLog.replaceChildren(element("p", "diagnostics-empty", "Protokoll wird gelesen …"));
    const entries = await window.imageSorter.analysis.getRecentLog(250, logOnlyErrors.checked);
    if (token !== logToken) return;
    latestLog = entries;
    eventLog.replaceChildren();
    for (const item of entries) {
      const record = element("div", "diagnostics-log-record");
      record.append(
        element("time", "", item.ts),
        element("strong", "", item.event),
        element("small", "", item.source),
        element("pre", "", item.detail)
      );
      eventLog.appendChild(record);
    }
    if (!entries.length) eventLog.appendChild(
      element("p", "diagnostics-empty", "Im aktuellen Protokollausschnitt keine passenden Einträge.")
    );
  }

  async function refresh(): Promise<void> {
    await Promise.all([refreshOverview(), refreshPage(), refreshLog()]);
  }

  get<HTMLButtonElement>("#diagnosticsRefresh").addEventListener("click", () => {
    void refresh().catch((error) => notify(String(error)));
  });
  get<HTMLButtonElement>("#diagnosticsPrevious").addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    void refreshPage();
  });
  get<HTMLButtonElement>("#diagnosticsNext").addEventListener("click", () => {
    offset += PAGE_SIZE;
    void refreshPage();
  });
  for (const control of [moduleFilter,causeFilter,scope]) {
    control.addEventListener("change", () => {
      offset = 0;
      void Promise.all([refreshOverview(),refreshPage()])
        .catch((error) => notify(String(error)));
    });
  }
  search.addEventListener("input", () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      offset = 0;
      void refreshPage().catch((error) => notify(String(error)));
    }, 350);
  });
  get<HTMLButtonElement>("#diagnosticsResetFilters").addEventListener("click", () => {
    moduleFilter.value = "";
    causeFilter.value = "";
    search.value = "";
    offset = 0;
    void refreshPage().catch((error) => notify(String(error)));
  });
  get<HTMLButtonElement>("#diagnosticsRetrySample").addEventListener("click", () => {
    if (!window.confirm("Bis zu 50 aktuell gefilterte Fehlerjobs erneut einplanen? Erfolgreiche Analysen bleiben erhalten.")) return;
    void window.imageSorter.analysis.retrySample(filters()).then(async (result) => {
      notify(result.retried.toLocaleString("de-DE") + " Jobs aus dem Testlauf neu eingeplant.");
      await refresh();
    }).catch((error) => notify(String(error)));
  });
  get<HTMLButtonElement>("#diagnosticsRetryAll").addEventListener("click", () => {
    if (!window.confirm("Alle Fehlerjobs im gewählten Quellenbereich neu einplanen? Die Modul-/Ursachenfilter gelten bei dieser Aktion NICHT.")) return;
    void window.imageSorter.analysis.retryAll(currentSourceId()).then(async (result) => {
      notify(result.retried.toLocaleString("de-DE") + " Jobs neu eingeplant.");
      await refresh();
    }).catch((error) => notify(String(error)));
  });
  get<HTMLButtonElement>("#diagnosticsCopyVisible").addEventListener("click", () => {
    void navigator.clipboard.writeText(JSON.stringify({
      time: new Date().toISOString(),
      overview: latestOverview,
      filter: filters(),
      visiblePage: latestPage
    }, null, 2)).then(() => notify("Aktuelle Fehlerseite und Zusammenfassung kopiert."))
      .catch((error) => notify(String(error)));
  });
  logOnlyErrors.addEventListener("change", () => {
    void refreshLog().catch((error) => notify(String(error)));
  });
  get<HTMLButtonElement>("#diagnosticsRefreshLog").addEventListener("click", () => {
    void refreshLog().catch((error) => notify(String(error)));
  });
  get<HTMLButtonElement>("#diagnosticsCopyLog").addEventListener("click", () => {
    void navigator.clipboard.writeText(latestLog.map((entry) =>
      [entry.ts, entry.source, entry.event, entry.detail].join(" | ")
    ).join("\n")).then(() => notify("Sichtbare Protokolleinträge kopiert."))
      .catch((error) => notify(String(error)));
  });
  get<HTMLButtonElement>("#diagnosticsOpenLog").addEventListener("click", () => {
    void window.imageSorter.analysis.openDevLog()
      .catch((error) => notify(String(error)));
  });
  return { refresh };
}
