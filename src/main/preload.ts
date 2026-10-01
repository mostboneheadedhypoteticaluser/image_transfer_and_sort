import { contextBridge, ipcRenderer } from "electron";
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

const api = {
  pickSource: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickSource"),
  analysis: {
    getStatus: (): Promise<AnalysisWorkerStatus> => ipcRenderer.invoke("analysis:getStatus"),
    getPipelineStatus: (): Promise<PipelineStatus> => ipcRenderer.invoke("analysis:getPipelineStatus"),
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
      ipcRenderer.invoke("people:confirmCandidate", candidateId, name)
  },
  catalog: {
    listSources: (): Promise<SourceRecord[]> => ipcRenderer.invoke("catalog:listSources"),
    addSource: (sourcePath: string): Promise<SourceRecord> => ipcRenderer.invoke("catalog:addSource", sourcePath),
    getStats: (sourceId: number): Promise<CatalogStats> => ipcRenderer.invoke("catalog:getStats", sourceId),
    listMedia: (sourceId: number, limit = 500): Promise<MediaRecord[]> =>
      ipcRenderer.invoke("catalog:listMedia", sourceId, limit),
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
