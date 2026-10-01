import type {
  CatalogStats,
  DuplicateGroup,
  MediaRecord,
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
