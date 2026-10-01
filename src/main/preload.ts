import { contextBridge, ipcRenderer } from "electron";
import type {
  AnalysisWorkerStatus,
  CatalogStats,
  DuplicateGroup,
  MediaRecord,
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
    onStatus: (listener: (status: AnalysisWorkerStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: AnalysisWorkerStatus) => listener(status);
      ipcRenderer.on("analysis:status", handler);
      return () => ipcRenderer.removeListener("analysis:status", handler);
    }
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
