export type AnalysisWorkerProgress = {
  kind: "qwen3vl" | "minicpm" | "qwen3vl2b" | "qwen3vl4b";
  phase: string;
  current: number | null;
  total: number | null;
  message: string;
};

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
  progress?: AnalysisWorkerProgress | null;
};

export type QwenBenchmarkModel = "minicpm" | "qwen3vl2b" | "qwen3vl4b";

export type QwenBenchmarkProfile =
  | "whole"
  | "tiles4"
  | "tiles9"
  | "tiles16";

export type QwenBenchmarkObject = {
  label: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
  agreementCount: number;
  sources: string[];
};

export type QwenBenchmarkTimings = {
  prepareMs: number;
  imageLoadMs: number;
  modelReadyMs: number;
  discoveryMs: number;
  verificationMs: number;
  totalMs: number;
};

export type QwenBenchmarkSemantic = {
  description: string;
  subjects: string[];
  actions: string[];
  scenes: string[];
  visibleText: string[];
  tags: string[];
  concepts: string[];
  repaired?: boolean;
};

export type QwenBenchmarkRegion = {
  name: string;
  kind: "whole-image" | "tile";
  x: number;
  y: number;
  width: number;
  height: number;
  durationMs: number;
  semantic: QwenBenchmarkSemantic;
};

export type QwenBenchmarkStageResult = {
  path: string;
  profile: QwenBenchmarkProfile;
  label: string;
  description: string;
  model: string;
  imageWidth: number;
  imageHeight: number;
  regionCount: number;
  candidateCount: number;
  verifiedCount: number;
  rejectedCount: number;
  timings: QwenBenchmarkTimings;
  semantic: QwenBenchmarkSemantic;
  regions: QwenBenchmarkRegion[];
  objects: QwenBenchmarkObject[];
};

export type QwenBenchmarkRunResult = {
  path: string;
  model: QwenBenchmarkModel;
  results: QwenBenchmarkStageResult[];
};

export type AnalysisQueueStats = {
  pending: number;
  running: number;
  done: number;
  failed: number;
  unavailable: number;
};

export type PipelineStatus = {
  technical: AnalysisQueueStats;
  thumbnails: AnalysisQueueStats;
  imageMetadata: AnalysisQueueStats;
  faces: AnalysisQueueStats;
  faceEmbeddings: AnalysisQueueStats;
  petDetection: AnalysisQueueStats;
  petFusion: AnalysisQueueStats;
  petEmbeddings: AnalysisQueueStats;
  objectVerification: AnalysisQueueStats;
  semanticEmbeddings: AnalysisQueueStats;
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

export type AnalysisErrorRecord = {
  id: number;
  status: "FAILED" | "UNAVAILABLE";
  mediaId: number;
  module: string;
  relativePath: string;
  extension: string;
  attempts: number;
  errorMessage: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RetryAnalysisResult = {
  retried: number;
};

export type SemanticTextEmbedding = {
  model: string;
  query: string;
  prompt: string;
  dimension: number;
  vector: number[];
  logitScale: number;
  logitBias: number;
};

export type MediaPreviewInfo = {
  mediaId: number;
  absolutePath: string;
  inputSha256: string;
};

export type MediaDetailFace = {
  id: number;
  detectorVersion: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
  embeddingReady: boolean;
  embeddingModel: string | null;
  personId: number | null;
  personName: string | null;
  assignmentSource: string | null;
  assignmentConfidence: number | null;
  candidateId: number | null;
  candidateSimilarity: number | null;
};

export type MediaDetailPet = {
  id: number;
  petClass: "dog" | "cat";
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fusionVersion: string;
  agreementCount: number;
  sources: string[];
  embeddingReady: boolean;
  embeddingModel: string | null;
  petId: number | null;
  petName: string | null;
  assignmentSource: string | null;
  assignmentConfidence: number | null;
  candidateId: number | null;
  candidateSimilarity: number | null;
};

export type MediaDetailObject = {
  label: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
  version: string;
  agreementCount: number | null;
  sources: string[];
  raw: boolean;
};

export type MediaDetailAnalysisJob = {
  module: string;
  status: string;
  attempts: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type MediaDetails = {
  mediaId: number;
  sourceId: number;
  relativePath: string;
  absolutePath: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  availability: string;
  deviceId: string | null;
  inode: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  lastMovedAt: string | null;
  recyclePath: string | null;
  duplicateCount: number;
  technicalProbe: Record<string, unknown> | null;
  imageMetadata: {
    width: number;
    height: number;
    format: string | null;
    colorMode: string | null;
    orientation: number | null;
    capturedAt: string | null;
    cameraMake: string | null;
    cameraModel: string | null;
    lensModel: string | null;
    gpsLatitude: number | null;
    gpsLongitude: number | null;
    updatedAt: string;
  } | null;
  faces: MediaDetailFace[];
  pets: MediaDetailPet[];
  objects: MediaDetailObject[];
  semanticEmbedding: {
    model: string;
    dimension: number;
    maxNumPatches: number;
    precision: string;
    updatedAt: string;
  } | null;
  semantic: {
    model: string;
    profileVersion: string;
    description: string;
    subjects: string[];
    actions: string[];
    scenes: string[];
    visibleText: string[];
    tags: string[];
    concepts: string[];
    repaired: boolean;
    regionCount: number;
    regions: unknown[];
    timings: Record<string, unknown>;
    updatedAt: string;
  } | null;
  analysisJobs: MediaDetailAnalysisJob[];
};

export type PetDetectionForEmbedding = {
  id: number;
  petClass: "dog" | "cat";
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
};

export type PetEmbeddingForClustering = {
  petDetectionId: number;
  mediaId: number;
  contentKey: string;
  petClass: "dog" | "cat";
  vector: number[];
};

export type PetEmbeddingSet = {
  revision: string;
  needsRebuild: boolean;
  pets: PetEmbeddingForClustering[];
  cannotLinks: Array<{
    petAId: number;
    petBId: number;
  }>;
};

export type PetClusterInput = {
  representativePetId: number;
  averageSimilarity: number;
  minSimilarity: number;
  members: Array<{
    petDetectionId: number;
    similarity: number;
  }>;
};

export type PetCandidateItem = {
  petDetectionId: number;
  mediaId: number;
  relativePath: string;
  similarity: number;
};

export type PetCandidate = {
  id: number;
  petClass: "dog" | "cat";
  detectionCount: number;
  representativePetId: number | null;
  averageSimilarity: number;
  minSimilarity: number;
  suggestedPetId: number | null;
  suggestedPetName: string | null;
  suggestedPetSimilarity: number | null;
  pets: PetCandidateItem[];
};

export type PetRecord = {
  id: number;
  name: string;
  petClass: "dog" | "cat";
  detectionCount: number;
  confirmedCount: number;
  automaticCount: number;
  representativePetId: number | null;
  pets: Array<{
    petDetectionId: number;
    mediaId: number;
    relativePath: string;
    confidence: number | null;
    assignmentSource: "CONFIRMED" | "AUTO_HIGH_CONFIDENCE";
  }>;
};

export type PetOverview = {
  candidates: PetCandidate[];
  pets: PetRecord[];
  clusteringPending: boolean;
};

export type ConfirmPetResult = {
  petId: number;
  name: string;
  detectionCount: number;
};

export type PetCorrectionResult = {
  changed: true;
  affectedPets: number;
};

export type MergePetsResult = {
  petId: number;
  name: string;
  detectionCount: number;
};

export type PetCropInfo = {
  petDetectionId: number;
  absolutePath: string;
  inputSha256: string;
  x: number;
  y: number;
  width: number;
  height: number;
  petClass: "dog" | "cat";
};

export type FaceEmbeddingForClustering = {
  faceDetectionId: number;
  mediaId: number;
  contentKey: string;
  vector: number[];
};

export type FaceEmbeddingSet = {
  revision: string;
  needsRebuild: boolean;
  faces: FaceEmbeddingForClustering[];
  cannotLinks: Array<{
    faceAId: number;
    faceBId: number;
  }>;
};

export type PersonClusterInput = {
  representativeFaceId: number;
  averageSimilarity: number;
  minSimilarity: number;
  members: Array<{
    faceDetectionId: number;
    similarity: number;
  }>;
};

export type PersonCandidateFace = {
  faceDetectionId: number;
  mediaId: number;
  relativePath: string;
  similarity: number;
};

export type PersonCandidate = {
  id: number;
  faceCount: number;
  representativeFaceId: number | null;
  averageSimilarity: number;
  minSimilarity: number;
  faces: PersonCandidateFace[];
};

export type PersonFace = {
  faceDetectionId: number;
  mediaId: number;
  relativePath: string;
  confidence: number | null;
};

export type PersonRecord = {
  id: number;
  name: string;
  faceCount: number;
  representativeFaceId: number | null;
  faces: PersonFace[];
};

export type PersonOverview = {
  candidates: PersonCandidate[];
  persons: PersonRecord[];
  clusteringPending: boolean;
};

export type ConfirmPersonResult = {
  personId: number;
  name: string;
  faceCount: number;
};

export type PersonCorrectionResult = {
  changed: true;
  affectedFaces: number;
};

export type MergePersonsResult = {
  personId: number;
  name: string;
  faceCount: number;
};

export type FaceCropInfo = {
  faceDetectionId: number;
  absolutePath: string;
  inputSha256: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FaceDetectionForEmbedding = {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  landmarks: Array<{ x: number; y: number }>;
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
  personCandidates: number;
  persons: number;
  petCandidates: number;
  pets: number;
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
  faceEmbeddingCount: number;
  petCount: number;
  dogCount: number;
  catCount: number;
  petMultiModelCount: number;
  petSingleModelCount: number;
  objectCount: number;
  objectLabels: string[];
  semanticReady: boolean;
  semanticModel: string | null;
  semanticScore: number | null;
  catalogSemanticReady: boolean;
  catalogSemanticModel: string | null;
  catalogSemanticScore: number | null;
  combinedSemanticScore: number | null;
  semanticMatchReasons: string[];
  semanticDescription: string | null;
  semanticConcepts: string[];
  lastSeenAt: string;
};

export type SearchFilter = {
  personIds: number[];
  petIds: number[];
  objectLabels: string[];
  minDogs: number;
  minCats: number;
  semanticQuery: string;
  semanticMinProbability: number;
};

export type SearchFacets = {
  persons: Array<{ id: number; name: string; mediaCount: number }>;
  pets: Array<{
    id: number;
    name: string;
    petClass: "dog" | "cat";
    mediaCount: number;
  }>;
  objects: Array<{ label: string; mediaCount: number }>;
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

export type CatalogChangeKind =
  | "ADDED"
  | "MOVED"
  | "CHANGED"
  | "MISSING"
  | "RECYCLE"
  | "RECYCLE_AMBIGUOUS";

export type CatalogChange = {
  kind: CatalogChangeKind;
  mediaId: number;
  path: string;
  previousPath: string | null;
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
  changes: CatalogChange[];
};

export type CatalogWatchEventKind =
  | "WATCHING"
  | "CHANGE_DETECTED"
  | "SCAN_STARTED"
  | "SCAN_FINISHED"
  | "FALLBACK"
  | "ERROR";

export type CatalogWatchEvent = {
  sourceId: number;
  sourcePath: string;
  kind: CatalogWatchEventKind;
  occurredAt: string;
  message: string;
  changedPath: string | null;
  automatic: boolean;
  scanResult: ScanResult | null;
};

export type CatalogWatchSourceState = {
  sourceId: number;
  sourcePath: string;
  state: "WATCHING" | "FALLBACK" | "SCANNING" | "ERROR";
  recursive: boolean;
  lastEventAt: string | null;
  lastScanAt: string | null;
};

export type CatalogWatchSnapshot = {
  sources: CatalogWatchSourceState[];
  history: CatalogWatchEvent[];
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
  | "getSearchFacets"
  | "searchMedia"
  | "listDuplicateGroups"
  | "listRecycleMedia"
  | "enqueueAnalysisJobs"
  | "getAnalysisQueueStats"
  | "listAnalysisErrors"
  | "retryAnalysisJob"
  | "retryFailedAnalysisJobs"
  | "claimAnalysisJob"
  | "completeAnalysisJob"
  | "failAnalysisJob"
  | "completeThumbnailJob"
  | "completeImageMetadataJob"
  | "completeFaceDetectionJob"
  | "getFaceDetectionsForEmbedding"
  | "completeFaceEmbeddingJob"
  | "completePetDetectionJob"
  | "getPetDetectionsForFusion"
  | "getObjectDetectionsForFusion"
  | "completePetFusionJob"
  | "completeVerifiedObjectDetectionJob"
  | "completeCatalogSemanticJob"
  | "getPetDetectionsForEmbedding"
  | "completePetEmbeddingJob"
  | "completeSemanticEmbeddingJob"
  | "getPetEmbeddingsForClustering"
  | "replacePetCandidates"
  | "autoAssignKnownPetCandidates"
  | "listPetCandidates"
  | "listPets"
  | "confirmPetCandidate"
  | "removePetFromCandidate"
  | "removePetFromPet"
  | "confirmPetDetection"
  | "mergePets"
  | "renamePet"
  | "getPetCropInfo"
  | "getFaceEmbeddingsForClustering"
  | "replacePersonCandidates"
  | "listPersonCandidates"
  | "listPersons"
  | "confirmPersonCandidate"
  | "removeFaceFromPersonCandidate"
  | "removeFaceFromPerson"
  | "mergePersons"
  | "renamePerson"
  | "getFaceCropInfo"
  | "getThumbnailInfo"
  | "getMediaPreviewInfo"
  | "getMediaDetails"
  | "getMediaPath"
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
