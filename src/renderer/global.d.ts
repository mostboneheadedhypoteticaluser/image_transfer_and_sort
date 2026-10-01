import type {
  CatalogStats,
  MediaRecord,
  RestoreResult,
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
        scanSource(sourceId: number): Promise<ScanResult>;
        restoreMedia(mediaId: number): Promise<RestoreResult>;
        onProgress(listener: (progress: ScanProgress) => void): () => void;
      };
    };
  }
}

export {};
