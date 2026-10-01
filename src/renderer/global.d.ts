import type {
  AnalysisWorkerStatus,
  PipelineStatus,
  CatalogStats,
  ConfirmPersonResult,
  DuplicateGroup,
  MediaRecord,
  PersonOverview,
  RestoreResult,
  ResetCatalogResult,
  ScanProgress,
  ScanResult,
  SourceRecord
} from "../shared/protocol";

declare global {
  interface Window {
    imageSorter: {
      pickSource(): Promise<string | null>;
      analysis: {
        getStatus(): Promise<AnalysisWorkerStatus>;
        getPipelineStatus(): Promise<PipelineStatus>;
        onStatus(listener: (status: AnalysisWorkerStatus) => void): () => void;
        onPipelineStatus(listener: (status: PipelineStatus) => void): () => void;
      };
      people: {
        getOverview(sourceId: number, forceRefresh?: boolean): Promise<PersonOverview>;
        confirmCandidate(
          candidateId: number,
          name: string
        ): Promise<ConfirmPersonResult>;
      };
      catalog: {
        listSources(): Promise<SourceRecord[]>;
        addSource(sourcePath: string): Promise<SourceRecord>;
        getStats(sourceId: number): Promise<CatalogStats>;
        listMedia(sourceId: number, limit?: number): Promise<MediaRecord[]>;
        listDuplicateGroups(sourceId: number, limit?: number): Promise<DuplicateGroup[]>;
        listRecycleMedia(sourceId: number, limit?: number): Promise<MediaRecord[]>;
        scanSource(sourceId: number): Promise<ScanResult>;
        restoreMedia(mediaId: number): Promise<RestoreResult>;
        resetCatalog(): Promise<ResetCatalogResult>;
        onProgress(listener: (progress: ScanProgress) => void): () => void;
      };
    };
  }
}

export {};
