import type {
  AnalysisErrorRecord,
  AnalysisWorkerStatus,
  QwenBenchmarkModel,
  QwenBenchmarkProfile,
  QwenBenchmarkRunResult,
  QwenBenchmarkStageResult,
  PipelineStatus,
  CatalogStats,
  CatalogWatchEvent,
  CatalogWatchSnapshot,
  ConfirmPersonResult,
  ConfirmPetResult,
  DuplicateGroup,
  MediaRecord,
  MediaDetails,
  MergePersonsResult,
  MergePetsResult,
  PersonCorrectionResult,
  PetCorrectionResult,
  PersonOverview,
  PetOverview,
  RestoreResult,
  ResetCatalogResult,
  RetryAnalysisResult,
  ScanProgress,
  ScanResult,
  SearchFacets,
  SearchFilter,
  SourceRecord
} from "../shared/protocol";

declare global {
  interface Window {
    imageSorter: {
      pickSource(): Promise<string | null>;
      analysis: {
        getStatus(): Promise<AnalysisWorkerStatus>;
        getPipelineStatus(sourceId?: number): Promise<PipelineStatus>;
        openDevLog(): Promise<{ opened: true; path: string }>;
        copyDevLog(): Promise<{
          copied: true;
          path: string;
          characters: number;
        }>;
        getAutomaticQwenState(): Promise<{ enabled: boolean }>;
        startAutomaticQwen(): Promise<{ enabled: true }>;
        prepareQwenBenchmark(): Promise<{ paused: true }>;
        finishQwenBenchmark(): Promise<{ resumed: true }>;
        pickQwenBenchmarkImage(): Promise<string | null>;
        runQwenBenchmark(
          filePath: string,
          model: QwenBenchmarkModel,
          profiles: QwenBenchmarkProfile[]
        ): Promise<QwenBenchmarkRunResult>;
        onQwenBenchmarkStage(
          listener: (stage: QwenBenchmarkStageResult) => void
        ): () => void;
        listErrors(sourceId?: number, limit?: number): Promise<AnalysisErrorRecord[]>;
        countErrors(sourceId?: number): Promise<number>;
        retryJob(jobId: number): Promise<RetryAnalysisResult>;
        retryAll(sourceId?: number): Promise<RetryAnalysisResult>;
        openFile(mediaId: number): Promise<{ opened: true }>;
        openFolder(mediaId: number): Promise<{ opened: true }>;
        onStatus(listener: (status: AnalysisWorkerStatus) => void): () => void;
        onPipelineStatus(listener: (status: PipelineStatus) => void): () => void;
      };
      people: {
        getOverview(sourceId: number, forceRefresh?: boolean): Promise<PersonOverview>;
        confirmCandidate(
          candidateId: number,
          name: string
        ): Promise<ConfirmPersonResult>;
        removeCandidateFace(
          candidateId: number,
          faceDetectionId: number
        ): Promise<PersonCorrectionResult>;
        removePersonFace(
          personId: number,
          faceDetectionId: number
        ): Promise<PersonCorrectionResult>;
        mergePersons(
          targetPersonId: number,
          sourcePersonId: number
        ): Promise<MergePersonsResult>;
        renamePerson(
          personId: number,
          name: string
        ): Promise<PersonCorrectionResult>;
        onUpdated(listener: () => void): () => void;
      };
      pets: {
        getOverview(sourceId: number, forceRefresh?: boolean): Promise<PetOverview>;
        confirmCandidate(
          candidateId: number,
          name: string,
          rejectedPetId?: number
        ): Promise<ConfirmPetResult>;
        removeCandidatePet(
          candidateId: number,
          petDetectionId: number
        ): Promise<PetCorrectionResult>;
        removePetDetection(
          petId: number,
          petDetectionId: number
        ): Promise<PetCorrectionResult>;
        confirmPetDetection(
          petId: number,
          petDetectionId: number
        ): Promise<PetCorrectionResult>;
        mergePets(
          targetPetId: number,
          sourcePetId: number
        ): Promise<MergePetsResult>;
        renamePet(
          petId: number,
          name: string
        ): Promise<PetCorrectionResult>;
        onUpdated(listener: () => void): () => void;
      };
      catalog: {
        listSources(): Promise<SourceRecord[]>;
        addSource(sourcePath: string): Promise<SourceRecord>;
        getStats(sourceId: number): Promise<CatalogStats>;
        getWatchSnapshot(): Promise<CatalogWatchSnapshot>;
        listMedia(sourceId: number, limit?: number): Promise<MediaRecord[]>;
        getSearchFacets(sourceId: number): Promise<SearchFacets>;
        searchMedia(
          sourceId: number,
          filter: SearchFilter,
          limit?: number
        ): Promise<MediaRecord[]>;
        listDuplicateGroups(sourceId: number, limit?: number): Promise<DuplicateGroup[]>;
        listRecycleMedia(sourceId: number, limit?: number): Promise<MediaRecord[]>;
        getMediaDetails(mediaId: number): Promise<MediaDetails | null>;
        scanSource(sourceId: number): Promise<ScanResult>;
        restoreMedia(mediaId: number): Promise<RestoreResult>;
        resetCatalog(): Promise<ResetCatalogResult>;
        onProgress(listener: (progress: ScanProgress) => void): () => void;
        onWatchEvent(listener: (event: CatalogWatchEvent) => void): () => void;
      };
    };
  }
}

export {};
