import { contextBridge, ipcRenderer } from "electron";
import type {
  AnalysisErrorRecord,
  AnalysisWorkerStatus,
  QwenBenchmarkProfile,
  QwenBenchmarkRunResult,
  QwenBenchmarkStageResult,
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
  RetryAnalysisResult,
  ScanProgress,
  ScanResult,
  SearchFacets,
  SearchFilter,
  SourceRecord
} from "../shared/protocol";

const api = {
  pickSource: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickSource"),
  analysis: {
    getStatus: (): Promise<AnalysisWorkerStatus> => ipcRenderer.invoke("analysis:getStatus"),
    getPipelineStatus: (): Promise<PipelineStatus> => ipcRenderer.invoke("analysis:getPipelineStatus"),
    openDevLog: (): Promise<{ opened: true; path: string }> =>
      ipcRenderer.invoke("analysis:openDevLog"),
    copyDevLog: (): Promise<{
      copied: true;
      path: string;
      characters: number;
    }> => ipcRenderer.invoke("analysis:copyDevLog"),
    pickQwenBenchmarkImage: (): Promise<string | null> =>
      ipcRenderer.invoke("analysis:pickQwenBenchmarkImage"),
    runQwenBenchmark: (
      filePath: string,
      profiles: QwenBenchmarkProfile[]
    ): Promise<QwenBenchmarkRunResult> =>
      ipcRenderer.invoke("analysis:runQwenBenchmark", filePath, profiles),
    onQwenBenchmarkStage: (
      listener: (stage: QwenBenchmarkStageResult) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        stage: QwenBenchmarkStageResult
      ) => listener(stage);
      ipcRenderer.on("analysis:qwenBenchmarkStage", handler);
      return () => ipcRenderer.removeListener("analysis:qwenBenchmarkStage", handler);
    },
    listErrors: (sourceId?: number, limit = 200): Promise<AnalysisErrorRecord[]> =>
      ipcRenderer.invoke("analysis:listErrors", sourceId, limit),
    retryJob: (jobId: number): Promise<RetryAnalysisResult> =>
      ipcRenderer.invoke("analysis:retryJob", jobId),
    retryAll: (sourceId?: number): Promise<RetryAnalysisResult> =>
      ipcRenderer.invoke("analysis:retryAll", sourceId),
    openFile: (mediaId: number): Promise<{ opened: true }> =>
      ipcRenderer.invoke("analysis:openFile", mediaId),
    openFolder: (mediaId: number): Promise<{ opened: true }> =>
      ipcRenderer.invoke("analysis:openFolder", mediaId),
    onStatus: (listener: (status: AnalysisWorkerStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: AnalysisWorkerStatus) => listener(status);
      ipcRenderer.on("analysis:status", handler);
      return () => ipcRenderer.removeListener("analysis:status", handler);
    },
    onPipelineStatus: (listener: (status: PipelineStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: PipelineStatus) => listener(status);
      ipcRenderer.on("analysis:pipelineStatus", handler);
      return () => ipcRenderer.removeListener("analysis:pipelineStatus", handler);
    }
  },
  people: {
    getOverview: (sourceId: number, forceRefresh = false): Promise<PersonOverview> =>
      ipcRenderer.invoke("people:getOverview", sourceId, forceRefresh),
    confirmCandidate: (
      candidateId: number,
      name: string
    ): Promise<ConfirmPersonResult> =>
      ipcRenderer.invoke("people:confirmCandidate", candidateId, name),
    removeCandidateFace: (
      candidateId: number,
      faceDetectionId: number
    ): Promise<PersonCorrectionResult> =>
      ipcRenderer.invoke("people:removeCandidateFace", candidateId, faceDetectionId),
    removePersonFace: (
      personId: number,
      faceDetectionId: number
    ): Promise<PersonCorrectionResult> =>
      ipcRenderer.invoke("people:removePersonFace", personId, faceDetectionId),
    mergePersons: (
      targetPersonId: number,
      sourcePersonId: number
    ): Promise<MergePersonsResult> =>
      ipcRenderer.invoke("people:mergePersons", targetPersonId, sourcePersonId),
    renamePerson: (
      personId: number,
      name: string
    ): Promise<PersonCorrectionResult> =>
      ipcRenderer.invoke("people:renamePerson", personId, name),
    onUpdated: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("people:updated", handler);
      return () => ipcRenderer.removeListener("people:updated", handler);
    }
  },
  pets: {
    getOverview: (sourceId: number, forceRefresh = false): Promise<PetOverview> =>
      ipcRenderer.invoke("pets:getOverview", sourceId, forceRefresh),
    confirmCandidate: (
      candidateId: number,
      name: string,
      rejectedPetId?: number
    ): Promise<ConfirmPetResult> =>
      ipcRenderer.invoke(
        "pets:confirmCandidate",
        candidateId,
        name,
        rejectedPetId
      ),
    removeCandidatePet: (
      candidateId: number,
      petDetectionId: number
    ): Promise<PetCorrectionResult> =>
      ipcRenderer.invoke("pets:removeCandidatePet", candidateId, petDetectionId),
    removePetDetection: (
      petId: number,
      petDetectionId: number
    ): Promise<PetCorrectionResult> =>
      ipcRenderer.invoke("pets:removePetDetection", petId, petDetectionId),
    confirmPetDetection: (
      petId: number,
      petDetectionId: number
    ): Promise<PetCorrectionResult> =>
      ipcRenderer.invoke("pets:confirmPetDetection", petId, petDetectionId),
    mergePets: (
      targetPetId: number,
      sourcePetId: number
    ): Promise<MergePetsResult> =>
      ipcRenderer.invoke("pets:mergePets", targetPetId, sourcePetId),
    renamePet: (
      petId: number,
      name: string
    ): Promise<PetCorrectionResult> =>
      ipcRenderer.invoke("pets:renamePet", petId, name),
    onUpdated: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("pets:updated", handler);
      return () => ipcRenderer.removeListener("pets:updated", handler);
    }
  },
  catalog: {
    listSources: (): Promise<SourceRecord[]> => ipcRenderer.invoke("catalog:listSources"),
    addSource: (sourcePath: string): Promise<SourceRecord> => ipcRenderer.invoke("catalog:addSource", sourcePath),
    getStats: (sourceId: number): Promise<CatalogStats> => ipcRenderer.invoke("catalog:getStats", sourceId),
    listMedia: (sourceId: number, limit = 500): Promise<MediaRecord[]> =>
      ipcRenderer.invoke("catalog:listMedia", sourceId, limit),
    getSearchFacets: (sourceId: number): Promise<SearchFacets> =>
      ipcRenderer.invoke("catalog:getSearchFacets", sourceId),
    searchMedia: (
      sourceId: number,
      filter: SearchFilter,
      limit = 500
    ): Promise<MediaRecord[]> =>
      ipcRenderer.invoke("catalog:searchMedia", sourceId, filter, limit),
    listDuplicateGroups: (sourceId: number, limit = 100): Promise<DuplicateGroup[]> =>
      ipcRenderer.invoke("catalog:listDuplicateGroups", sourceId, limit),
    listRecycleMedia: (sourceId: number, limit = 500): Promise<MediaRecord[]> =>
      ipcRenderer.invoke("catalog:listRecycleMedia", sourceId, limit),
    scanSource: (sourceId: number): Promise<ScanResult> => ipcRenderer.invoke("catalog:scanSource", sourceId),
    restoreMedia: (mediaId: number): Promise<RestoreResult> => ipcRenderer.invoke("catalog:restoreMedia", mediaId),
    resetCatalog: (): Promise<ResetCatalogResult> => ipcRenderer.invoke("catalog:resetCatalog"),
    onProgress: (listener: (progress: ScanProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => listener(progress);
      ipcRenderer.on("catalog:progress", handler);
      return () => ipcRenderer.removeListener("catalog:progress", handler);
    }
  }
};

contextBridge.exposeInMainWorld("imageSorter", api);
