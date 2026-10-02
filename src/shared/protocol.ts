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
