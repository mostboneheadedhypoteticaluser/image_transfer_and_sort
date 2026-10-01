export type AnalysisWorkerStatus = {
  state: "STARTING" | "READY" | "STOPPED" | "ERROR";
  pid: number | null;
  python: string | null;
  processPriority: "below-normal";
  cpuBudgetPercent: number;
  maxConcurrentJobs: number;
  queuedJobs: number;
  activeJobs: number;
  message: string;
};

export type AnalysisQueueStats = {
  pending: number;
  running: number;
  done: number;
  failed: number;
};

export type PipelineStatus = {
  technical: AnalysisQueueStats;
  thumbnails: AnalysisQueueStats;
  imageMetadata: AnalysisQueueStats;
  faces: AnalysisQueueStats;
};

export type AnalysisJob = {
  id: number;
  mediaId: number;
  module: string;
  absolutePath: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
};

export type ThumbnailInfo = {
  mediaId: number;
  path: string;
  inputSha256: string;
  width: number;
  height: number;
  format: string;
};

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
  thumbnailReady: boolean;
  thumbnailVersion: string | null;
  capturedAt: string | null;
  faceCount: number;
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
  | "enqueueAnalysisJobs"
  | "getAnalysisQueueStats"
  | "claimAnalysisJob"
  | "completeAnalysisJob"
  | "failAnalysisJob"
  | "completeThumbnailJob"
  | "completeImageMetadataJob"
  | "completeFaceDetectionJob"
  | "getThumbnailInfo"
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
