export type SourceRecord = {
  id: number;
  path: string;
  enabled: boolean;
};

export type CatalogStats = {
  total: number;
  available: number;
  missing: number;
  recycleBin: number;
  duplicateGroups: number;
  duplicateFiles: number;
  lastScan: string | null;
};

export type MediaRecord = {
  id: number;
  relativePath: string;
  extension: string;
  sizeBytes: number;
  availability: "AVAILABLE" | "MISSING";
  inRecycleBin: boolean;
  recycleState: "NONE" | "RESTORABLE" | "AMBIGUOUS";
  duplicateCount: number;
  lastSeenAt: string;
};

export type DuplicateItem = {
  id: number;
  relativePath: string;
  extension: string;
  sizeBytes: number;
};

export type DuplicateGroup = {
  sha256: string;
  sizeBytes: number;
  count: number;
  wastedBytes: number;
  items: DuplicateItem[];
};

export type ScanResult = {
  discovered: number;
  added: number;
  moved: number;
  changed: number;
  unchanged: number;
  missing: number;
  recycleBin: number;
  errors: number;
};

export type RestoreResult = {
  restored: boolean;
  path: string;
};

export type ResetCatalogResult = {
  reset: true;
};

export type ScanProgress = {
  sourceId: number;
  discovered: number;
  message: string;
};

export type CatalogMethod =
  | "listSources"
  | "addSource"
  | "getStats"
  | "listMedia"
  | "listDuplicateGroups"
  | "listRecycleMedia"
  | "scanSource"
  | "restoreMedia"
  | "resetCatalog";

export type WorkerRequest = {
  kind: "request";
  id: string;
  method: CatalogMethod;
  payload?: Record<string, unknown>;
};

export type WorkerResponse =
  | { kind: "response"; id: string; ok: true; result: unknown }
  | { kind: "response"; id: string; ok: false; error: string }
  | { kind: "event"; event: "scanProgress"; payload: ScanProgress };
