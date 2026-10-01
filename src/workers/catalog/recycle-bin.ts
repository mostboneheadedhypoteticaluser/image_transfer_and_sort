import { execFile } from "node:child_process";

export type RecycleBinItem = {
  originalPath: string;
  recyclePath: string | null;
  sizeBytes: number | null;
};

function runPowerShell(script: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...extraEnv }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

const LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace(0xA)
$result = @()

if ($null -ne $folder) {
  foreach ($item in @($folder.Items())) {
    $deletedFrom = [string]$item.ExtendedProperty('System.Recycle.DeletedFrom')
    $name = [string]$item.ExtendedProperty('System.ItemNameDisplay')
    if ([string]::IsNullOrWhiteSpace($name)) {
      $name = [string]$item.Name
    }

    if (-not [string]::IsNullOrWhiteSpace($deletedFrom) -and -not [string]::IsNullOrWhiteSpace($name)) {
      $originalPath = [System.IO.Path]::Combine($deletedFrom, $name)
      $sizeValue = $item.ExtendedProperty('System.Size')
      $size = $null
      if ($null -ne $sizeValue -and "$sizeValue" -ne '') {
        try { $size = [int64]$sizeValue } catch {}
      }

      $result += [PSCustomObject]@{
        originalPath = $originalPath
        recyclePath = if ($item.Path) { [string]$item.Path } else { $null }
        sizeBytes = $size
      }
    }
  }
}

if ($result.Count -eq 0) {
  Write-Output '[]'
} else {
  Write-Output ($result | ConvertTo-Json -Compress -Depth 4)
}
`;

const RESTORE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [string]$env:IMAGE_SORTER_RESTORE_TARGET
$recycleTarget = [string]$env:IMAGE_SORTER_RECYCLE_PATH

if ([string]::IsNullOrWhiteSpace($target)) {
  throw 'Zielpfad fehlt.'
}

$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace(0xA)
if ($null -eq $folder) {
  throw 'Windows-Papierkorb ist nicht verfügbar.'
}

$match = $null
foreach ($item in @($folder.Items())) {
  $itemPath = if ($item.Path) { [string]$item.Path } else { '' }

  if (
    -not [string]::IsNullOrWhiteSpace($recycleTarget) -and
    [string]::Equals($itemPath, $recycleTarget, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    $match = $item
    break
  }

  $deletedFrom = [string]$item.ExtendedProperty('System.Recycle.DeletedFrom')
  $name = [string]$item.ExtendedProperty('System.ItemNameDisplay')
  if ([string]::IsNullOrWhiteSpace($name)) {
    $name = [string]$item.Name
  }

  if (-not [string]::IsNullOrWhiteSpace($deletedFrom) -and -not [string]::IsNullOrWhiteSpace($name)) {
    $originalPath = [System.IO.Path]::Combine($deletedFrom, $name)
    if ([string]::Equals($originalPath, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
      $match = $item
      break
    }
  }
}

if ($null -eq $match) {
  throw 'Datei wurde im Papierkorb nicht gefunden.'
}

$restoreVerb = $null
foreach ($verb in @($match.Verbs())) {
  $verbName = ([string]$verb.Name).Replace('&', '').Trim()
  if ($verbName -match '^(Restore|Wiederherstellen)

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").toLocaleLowerCase("de-DE");
}

export async function listRecycleBinItems(): Promise<RecycleBinItem[]> {
  if (process.platform !== "win32") return [];

  const output = await runPowerShell(LIST_SCRIPT);
  if (!output) return [];

  const parsed: unknown = JSON.parse(output);
  const values = Array.isArray(parsed) ? parsed : [parsed];

  return values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    .map((value) => ({
      originalPath: String(value.originalPath ?? ""),
      recyclePath: value.recyclePath ? String(value.recyclePath) : null,
      sizeBytes: value.sizeBytes === null || value.sizeBytes === undefined
        ? null
        : Number(value.sizeBytes)
    }))
    .filter((item) => item.originalPath.length > 0);
}

export async function recycleBinIndex(): Promise<Map<string, RecycleBinItem>> {
  const items = await listRecycleBinItems();
  const result = new Map<string, RecycleBinItem>();

  for (const item of items) {
    result.set(normalizeWindowsPath(item.originalPath), item);
  }

  return result;
}

export async function restoreRecycleBinItem(
  originalPath: string,
  recyclePath: string | null = null
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Wiederherstellen aus dem Papierkorb wird derzeit nur unter Windows unterstützt.");
  }

  await runPowerShell(RESTORE_SCRIPT, {
    IMAGE_SORTER_RESTORE_TARGET: originalPath,
    IMAGE_SORTER_RECYCLE_PATH: recyclePath ?? ""
  });
}

export function recycleLookupKey(originalPath: string): string {
  return normalizeWindowsPath(originalPath);
}
) {
    $restoreVerb = $verb
    break
  }
}

if ($null -ne $restoreVerb) {
  $restoreVerb.DoIt()
} else {
  $match.InvokeVerb('RESTORE')
}

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 150
  if (Test-Path -LiteralPath $target) {
    Write-Output 'RESTORED'
    exit 0
  }
}

throw 'Windows hat die Datei nicht am ursprünglichen Pfad wiederhergestellt.'
`;

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").toLocaleLowerCase("de-DE");
}

export async function listRecycleBinItems(): Promise<RecycleBinItem[]> {
  if (process.platform !== "win32") return [];

  const output = await runPowerShell(LIST_SCRIPT);
  if (!output) return [];

  const parsed: unknown = JSON.parse(output);
  const values = Array.isArray(parsed) ? parsed : [parsed];

  return values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    .map((value) => ({
      originalPath: String(value.originalPath ?? ""),
      recyclePath: value.recyclePath ? String(value.recyclePath) : null,
      sizeBytes: value.sizeBytes === null || value.sizeBytes === undefined
        ? null
        : Number(value.sizeBytes)
    }))
    .filter((item) => item.originalPath.length > 0);
}

export async function recycleBinIndex(): Promise<Map<string, RecycleBinItem>> {
  const items = await listRecycleBinItems();
  const result = new Map<string, RecycleBinItem>();

  for (const item of items) {
    result.set(normalizeWindowsPath(item.originalPath), item);
  }

  return result;
}

export async function restoreRecycleBinItem(originalPath: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Wiederherstellen aus dem Papierkorb wird derzeit nur unter Windows unterstützt.");
  }

  await runPowerShell(RESTORE_SCRIPT, {
    IMAGE_SORTER_RESTORE_TARGET: originalPath
  });
}

export function recycleLookupKey(originalPath: string): string {
  return normalizeWindowsPath(originalPath);
}
