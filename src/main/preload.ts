import { contextBridge, ipcRenderer } from "electron";
import type { CatalogStats, MediaRecord, ScanProgress, ScanResult, SourceRecord } from "../shared/protocol";

const api = {
  pickSource: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickSource"),
  catalog: {
    listSources: (): Promise<SourceRecord[]> => ipcRenderer.invoke("catalog:listSources"),
    addSource: (sourcePath: string): Promise<SourceRecord> => ipcRenderer.invoke("catalog:addSource", sourcePath),
    getStats: (sourceId: number): Promise<CatalogStats> => ipcRenderer.invoke("catalog:getStats", sourceId),
    listMedia: (sourceId: number, limit = 500): Promise<MediaRecord[]> =>
      ipcRenderer.invoke("catalog:listMedia", sourceId, limit),
    scanSource: (sourceId: number): Promise<ScanResult> => ipcRenderer.invoke("catalog:scanSource", sourceId),
    onProgress: (listener: (progress: ScanProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => listener(progress);
      ipcRenderer.on("catalog:progress", handler);
      return () => ipcRenderer.removeListener("catalog:progress", handler);
    }
  }
};

contextBridge.exposeInMainWorld("imageSorter", api);
