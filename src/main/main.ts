import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { CatalogService } from "./catalog-service";
import type {
  CatalogStats,
  MediaRecord,
  RestoreResult,
  ScanResult,
  SourceRecord
} from "../shared/protocol";

let windowRef: BrowserWindow | null = null;
let catalog: CatalogService | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  return win;
}

function registerIpc(): void {
  ipcMain.handle("dialog:pickSource", async () => {
    const result = await dialog.showOpenDialog(windowRef!, {
      title: "Festplatte oder Bildordner auswählen",
      properties: ["openDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("catalog:listSources", () =>
    catalog!.request<SourceRecord[]>("listSources")
  );

  ipcMain.handle("catalog:addSource", (_event, sourcePath: string) =>
    catalog!.request<SourceRecord>("addSource", { path: sourcePath })
  );

  ipcMain.handle("catalog:getStats", (_event, sourceId: number) =>
    catalog!.request<CatalogStats>("getStats", { sourceId })
  );

  ipcMain.handle("catalog:listMedia", (_event, sourceId: number, limit: number) =>
    catalog!.request<MediaRecord[]>("listMedia", { sourceId, limit })
  );

  ipcMain.handle("catalog:scanSource", (_event, sourceId: number) =>
    catalog!.request<ScanResult>("scanSource", { sourceId })
  );

  ipcMain.handle("catalog:restoreMedia", (_event, mediaId: number) =>
    catalog!.request<RestoreResult>("restoreMedia", { mediaId })
  );
}

app.whenReady().then(() => {
  const workerPath = path.join(__dirname, "..", "workers", "catalog", "catalog-worker.js");
  const dbPath = path.join(app.getPath("userData"), "catalog.sqlite3");

  catalog = new CatalogService(workerPath, dbPath, (progress) => {
    windowRef?.webContents.send("catalog:progress", progress);
  });
  catalog.start();
  registerIpc();

  windowRef = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) windowRef = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  catalog?.stop();
});
