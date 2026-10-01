import type {
  AnalysisWorkerStatus,
  PipelineStatus,
  CatalogStats,
  ConfirmPersonResult,
  ConfirmPetResult,
  DuplicateGroup,
  MediaRecord,
  MergePersonsResult,
  MergePetsResult,
  PersonCorrectionResult,
  PetCorrectionResult,
  PersonOverview,
  PetOverview,
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
          name: string
        ): Promise<ConfirmPetResult>;
        removeCandidatePet(
          candidateId: number,
          petDetectionId: number
        ): Promise<PetCorrectionResult>;
        removePetDetection(
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
