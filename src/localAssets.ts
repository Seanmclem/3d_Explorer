import type { LocalAsset, LocalFileRecord } from "./types";

type FileSystemFileHandleLike = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

type FileSystemDirectoryHandleLike = {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, FileSystemFileHandleLike | FileSystemDirectoryHandleLike]>;
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

type FileSystemAccessWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandleLike>;
  showOpenFilePicker?: (options?: {
    id?: string;
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandleLike[]>;
};

type DroppedFileEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(callback: (file: File) => void, errorCallback?: (error: DOMException) => void): void;
  createReader?: () => {
    readEntries(callback: (entries: DroppedFileEntry[]) => void, errorCallback?: (error: DOMException) => void): void;
  };
};

type WebkitDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => unknown;
};

const GLTF_EXTENSIONS = new Set(["glb", "gltf"]);

export function supportsDirectoryPicker(): boolean {
  return Boolean((window as FileSystemAccessWindow).showDirectoryPicker);
}

export function supportsFilePicker(): boolean {
  return Boolean((window as FileSystemAccessWindow).showOpenFilePicker);
}

export function normalizePath(path: string): string {
  return decodeURIComponent(path)
    .replace(/^file:\/\//, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .split(/[?#]/)[0];
}

function folderFromPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.indexOf("/");
  return index === -1 ? "Loose files" : normalized.slice(0, index);
}

function extensionFor(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function basePathFor(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash + 1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function isModelPath(path: string): boolean {
  return GLTF_EXTENSIONS.has(extensionFor(path));
}

function idFor(path: string, size: number, modified: number): string {
  return `${normalizePath(path)}::${size}::${modified}`;
}

function readWebkitFile(entry: DroppedFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readWebkitEntries(entry: DroppedFileEntry): Promise<DroppedFileEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader?.();
    if (!reader) {
      resolve([]);
      return;
    }

    const allEntries: DroppedFileEntry[] = [];

    const readBatch = () => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(allEntries);
          return;
        }

        allEntries.push(...entries);
        readBatch();
      }, reject);
    };

    readBatch();
  });
}

async function collectFromWebkitEntry(entry: DroppedFileEntry, prefix = ""): Promise<Array<{ file: File; path: string }>> {
  if (entry.isFile) {
    const file = await readWebkitFile(entry);
    return [{ file, path: normalizePath(`${prefix}${entry.name}`) }];
  }

  if (!entry.isDirectory) return [];

  const entries = await readWebkitEntries(entry);
  const folderPrefix = `${prefix}${entry.name}/`;
  const nested = await Promise.all(entries.map((child) => collectFromWebkitEntry(child, folderPrefix)));
  return nested.flat();
}

export class LocalAssetLibrary {
  private files = new Map<string, LocalFileRecord>();
  private objectUrls = new Map<string, string>();

  get assets(): LocalAsset[] {
    return Array.from(this.files.values())
      .filter((record) => isModelPath(record.path))
      .map((record) => {
        const kind = extensionFor(record.path) as LocalAsset["kind"];
        return {
          ...record,
          id: idFor(record.path, record.file.size, record.file.lastModified),
          kind,
          name: record.path.split("/").pop() ?? record.path,
          basePath: basePathFor(record.path),
          sizeLabel: formatBytes(record.file.size)
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  get fileCount(): number {
    return this.files.size;
  }

  clear(): void {
    this.revokeObjectUrls();
    this.files.clear();
  }

  revokeObjectUrls(): void {
    for (const url of this.objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
    for (const file of this.files.values()) {
      file.url = undefined;
    }
  }

  addFile(
    file: File,
    path = file.name,
    options: {
      fileHandle?: unknown;
      directoryHandle?: unknown;
      accessMode?: LocalFileRecord["accessMode"];
    } = {}
  ): void {
    const normalizedPath = normalizePath(path || file.name);
    this.files.set(normalizedPath.toLowerCase(), {
      file,
      path: normalizedPath,
      folder: folderFromPath(normalizedPath),
      fileHandle: options.fileHandle,
      directoryHandle: options.directoryHandle,
      accessMode: options.accessMode ?? "upload"
    });
  }

  addFileList(fileList: FileList | File[]): number {
    const files = Array.from(fileList);
    for (const file of files) {
      const fileWithPath = file as File & { webkitRelativePath?: string };
      this.addFile(file, fileWithPath.webkitRelativePath || file.name, { accessMode: "upload" });
    }
    return files.length;
  }

  async addFilesFromPicker(): Promise<number> {
    const picker = (window as FileSystemAccessWindow).showOpenFilePicker;
    if (!picker) {
      throw new Error("File picker handles are not available in this browser.");
    }

    const handles = await (window as FileSystemAccessWindow).showOpenFilePicker?.({
      id: "gltf-viewer-files",
      multiple: true,
      excludeAcceptAllOption: false,
      types: [
        {
          description: "glTF assets and sidecars",
          accept: {
            "model/gltf-binary": [".glb"],
            "model/gltf+json": [".gltf"],
            "application/octet-stream": [".bin", ".ktx2", ".basis", ".dds"],
            "image/png": [".png"],
            "image/jpeg": [".jpg", ".jpeg"],
            "image/webp": [".webp"]
          }
        }
      ]
    });

    if (!handles) return 0;

    for (const handle of handles) {
      const file = await handle.getFile();
      this.addFile(file, file.name, {
        fileHandle: handle,
        accessMode: "handle"
      });
    }

    return handles.length;
  }

  async addDirectoryFromPicker(): Promise<number> {
    const picker = (window as FileSystemAccessWindow).showDirectoryPicker;
    if (!picker) {
      throw new Error("Folder picker is not available in this browser.");
    }

    const directory = await (window as FileSystemAccessWindow).showDirectoryPicker?.({
      id: "gltf-viewer-folder",
      mode: "readwrite"
    });
    if (!directory) return 0;

    const files = await this.collectDirectoryHandle(directory, directory.name, directory);
    for (const item of files) {
      this.addFile(item.file, item.path, {
        fileHandle: item.fileHandle,
        directoryHandle: directory,
        accessMode: "handle"
      });
    }
    return files.length;
  }

  async addDataTransferItems(items: DataTransferItemList): Promise<number> {
    const collected: Array<{ file: File; path: string }> = [];
    const webkitItems = Array.from(items) as WebkitDataTransferItem[];

    for (const item of webkitItems) {
      const entry = item.webkitGetAsEntry?.() as DroppedFileEntry | null | undefined;
      if (entry) {
        collected.push(...(await collectFromWebkitEntry(entry)));
        continue;
      }

      const file = item.getAsFile();
      if (file) {
        collected.push({ file, path: file.name });
      }
    }

    for (const item of collected) {
      this.addFile(item.file, item.path, { accessMode: "drop" });
    }

    return collected.length;
  }

  resolveResourceUrl(asset: LocalAsset, requestedUrl: string): string {
    const normalizedRequest = normalizePath(requestedUrl);
    const candidates = [
      normalizedRequest,
      normalizePath(`${asset.basePath}${normalizedRequest}`),
      normalizePath(normalizedRequest.replace(asset.basePath, "")),
      normalizePath(`${asset.basePath}${normalizedRequest.split("/").pop() ?? normalizedRequest}`)
    ];

    for (const candidate of candidates) {
      const record = this.files.get(candidate.toLowerCase());
      if (record) return this.objectUrlFor(record);
    }

    return requestedUrl;
  }

  private objectUrlFor(record: LocalFileRecord): string {
    const key = record.path.toLowerCase();
    const existing = this.objectUrls.get(key);
    if (existing) return existing;

    const url = URL.createObjectURL(record.file);
    this.objectUrls.set(key, url);
    record.url = url;
    return url;
  }

  private async collectDirectoryHandle(
    directory: FileSystemDirectoryHandleLike,
    prefix: string,
    rootHandle: FileSystemDirectoryHandleLike
  ): Promise<Array<{ file: File; path: string; fileHandle: FileSystemFileHandleLike }>> {
    const files: Array<{ file: File; path: string; fileHandle: FileSystemFileHandleLike }> = [];

    for await (const [, entry] of directory.entries()) {
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === "file") {
        files.push({ file: await entry.getFile(), path, fileHandle: entry });
      } else {
        files.push(...(await this.collectDirectoryHandle(entry, path, rootHandle)));
      }
    }

    return files;
  }
}
