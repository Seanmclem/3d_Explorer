import "./styles.css";
import { GltfViewer } from "./viewer";
import { LocalAssetLibrary, supportsDirectoryPicker, supportsFilePicker } from "./localAssets";
import type { LoadedModel, LoadStatus, LocalAsset, ModelStats, PlaybackState } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root is missing.");
}

app.innerHTML = `
  <main class="shell">
    <aside class="library-panel" aria-label="Asset library">
      <section class="panel-section intro">
        <p class="eyebrow">Local GLB and glTF lab</p>
        <h1>Model viewer</h1>
        <p class="summary">Load folders, inspect assets, test animation clips, and tune the camera without uploading files anywhere.</p>
      </section>

      <section class="panel-section import-actions" aria-label="Import controls">
        <button class="primary-action" id="pickFolder" type="button">Open editable folder</button>
        <label class="secondary-action" for="folderInput">Import folder</label>
        <input id="folderInput" type="file" webkitdirectory directory multiple hidden />
        <button class="secondary-action" id="pickFiles" type="button">Open files</button>
        <label class="secondary-action" for="fileInput">Import files</label>
        <input id="fileInput" type="file" accept=".glb,.gltf,.bin,image/*,.ktx2,.basis,.dds" multiple hidden />
        <button class="secondary-action" id="clearLibrary" type="button">Clear</button>
      </section>

      <section class="panel-section">
        <label class="field-label" for="assetSearch">Search assets</label>
        <input class="text-field" id="assetSearch" type="search" placeholder="robot, idle, character..." />
      </section>

      <section class="panel-section library-meta" aria-live="polite">
        <span id="assetCount">0 models</span>
        <span id="fileCount">0 files indexed</span>
      </section>

      <section class="asset-list" id="assetList" aria-label="Available models"></section>
    </aside>

    <section class="viewport-region" aria-label="3D viewport">
      <canvas id="viewerCanvas"></canvas>

      <div class="drop-target" id="dropTarget">
        <strong>Drop folders or files</strong>
        <span>GLB loads directly. glTF sidecars work when they come from the same folder selection.</span>
      </div>

      <div class="status-chip" id="statusChip">Ready</div>

      <div class="toolbar" aria-label="Viewport controls">
        <button id="resetCamera" type="button">Fit</button>
        <button id="toggleRotate" type="button" aria-pressed="false">Rotate</button>
        <button id="togglePan" type="button" aria-pressed="false">Pan</button>
        <button id="toggleGrid" type="button" aria-pressed="true">Grid</button>
        <button id="toggleBounds" type="button" aria-pressed="true">Bounds</button>
        <button id="toggleWireframe" type="button" aria-pressed="false">Wire</button>
        <button id="capturePng" type="button">PNG</button>
      </div>

      <aside class="inspector-panel" aria-label="Model inspector">
        <section class="inspector-section">
          <p class="eyebrow">Selected</p>
          <h2 id="selectedName">No model loaded</h2>
          <p id="selectedPath">Pick a GLB or glTF file to begin.</p>
        </section>

        <section class="stats-grid" id="statsGrid" aria-label="Model stats">
          <div><span>Meshes</span><strong>0</strong></div>
          <div><span>Materials</span><strong>0</strong></div>
          <div><span>Textures</span><strong>0</strong></div>
          <div><span>Triangles</span><strong>0</strong></div>
          <div><span>Vertices</span><strong>0</strong></div>
          <div><span>Bounds</span><strong>0 x 0 x 0</strong></div>
        </section>

        <section class="inspector-section">
          <div class="section-title-row">
            <h3>Animations</h3>
            <button id="togglePlay" type="button">Play</button>
          </div>
          <div class="clip-list" id="clipList"></div>
          <label class="field-label" for="timeline">Timeline</label>
          <input id="timeline" type="range" min="0" max="1" step="0.001" value="0" />
          <div class="time-row">
            <span id="clipTime">0.00s</span>
            <span id="clipDuration">0.00s</span>
          </div>
          <label class="field-label" for="speed">Playback speed</label>
          <input id="speed" type="range" min="0" max="2" step="0.05" value="1" />
        </section>
      </aside>
    </section>
  </main>
`;

const library = new LocalAssetLibrary();
const canvas = query<HTMLCanvasElement>("#viewerCanvas");
const viewer = new GltfViewer({
  canvas,
  onPlayback: updatePlayback
});

const pickFolderButton = query<HTMLButtonElement>("#pickFolder");
const pickFilesButton = query<HTMLButtonElement>("#pickFiles");
const folderInput = query<HTMLInputElement>("#folderInput");
const fileInput = query<HTMLInputElement>("#fileInput");
const clearLibraryButton = query<HTMLButtonElement>("#clearLibrary");
const assetSearch = query<HTMLInputElement>("#assetSearch");
const assetList = query<HTMLElement>("#assetList");
const assetCount = query<HTMLElement>("#assetCount");
const fileCount = query<HTMLElement>("#fileCount");
const dropTarget = query<HTMLElement>("#dropTarget");
const statusChip = query<HTMLElement>("#statusChip");
const selectedName = query<HTMLElement>("#selectedName");
const selectedPath = query<HTMLElement>("#selectedPath");
const statsGrid = query<HTMLElement>("#statsGrid");
const clipList = query<HTMLElement>("#clipList");
const togglePlayButton = query<HTMLButtonElement>("#togglePlay");
const timeline = query<HTMLInputElement>("#timeline");
const clipTime = query<HTMLElement>("#clipTime");
const clipDuration = query<HTMLElement>("#clipDuration");
const speed = query<HTMLInputElement>("#speed");

let selectedAssetId = "";
let currentPlayback: PlaybackState = {
  activeClipIndex: -1,
  clipName: "No animation",
  duration: 0,
  time: 0,
  isPlaying: false
};
let isScrubbing = false;

if (supportsDirectoryPicker()) {
  pickFolderButton.title = "Uses the File System Access API and keeps file handles for future edits.";
} else {
  pickFolderButton.disabled = true;
  pickFolderButton.title = "Use Import folder in this browser.";
}

if (supportsFilePicker()) {
  pickFilesButton.title = "Uses the File System Access API and keeps file handles for future edits.";
} else {
  pickFilesButton.disabled = true;
  pickFilesButton.title = "Use Import files in this browser.";
}

pickFolderButton.addEventListener("click", async () => {
  await runImport(async () => library.addDirectoryFromPicker(), "Editable folder opened");
});

pickFilesButton.addEventListener("click", async () => {
  await runImport(async () => library.addFilesFromPicker(), "Editable files opened");
});

folderInput.addEventListener("change", async () => {
  await runImport(async () => library.addFileList(folderInput.files ?? []), "Folder indexed");
  folderInput.value = "";
});

fileInput.addEventListener("change", async () => {
  await runImport(async () => library.addFileList(fileInput.files ?? []), "Files indexed");
  fileInput.value = "";
});

clearLibraryButton.addEventListener("click", () => {
  library.clear();
  viewer.unloadModel();
  selectedAssetId = "";
  selectedName.textContent = "No model loaded";
  selectedPath.textContent = "Pick a GLB or glTF file to begin.";
  renderAssets();
  renderStats();
  renderClips([]);
  setStatus({ label: "Library cleared", tone: "idle" });
});

assetSearch.addEventListener("input", renderAssets);

dropTarget.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropTarget.classList.add("is-over");
});

dropTarget.addEventListener("dragleave", () => {
  dropTarget.classList.remove("is-over");
});

dropTarget.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropTarget.classList.remove("is-over");

  if (!event.dataTransfer) return;

  await runImport(async () => {
    if (event.dataTransfer?.items?.length) {
      return library.addDataTransferItems(event.dataTransfer.items);
    }

    return library.addFileList(event.dataTransfer?.files ?? []);
  }, "Drop indexed");
});

query<HTMLButtonElement>("#resetCamera").addEventListener("click", () => viewer.resetCamera());
wireToggle("#toggleRotate", (enabled) => viewer.setAutoRotate(enabled));
wireToggle("#togglePan", (enabled) => {
  viewer.setPanMode(enabled);
  setStatus({
    label: enabled ? "Pan mode" : "Orbit mode",
    detail: enabled ? "left-drag moves the camera" : "left-drag rotates the model",
    tone: "idle"
  });
});
wireToggle("#toggleGrid", (enabled) => viewer.setGridVisible(enabled), true);
wireToggle("#toggleBounds", (enabled) => viewer.setBoundsVisible(enabled), true);
wireToggle("#toggleWireframe", (enabled) => viewer.setWireframe(enabled));

query<HTMLButtonElement>("#capturePng").addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = `${selectedName.textContent || "gltf-view"}.png`;
  link.href = viewer.capturePng();
  link.click();
  setStatus({ label: "PNG captured", tone: "ok" });
});

togglePlayButton.addEventListener("click", () => {
  viewer.togglePlay();
});

timeline.addEventListener("pointerdown", () => {
  isScrubbing = true;
  viewer.setPaused(true);
});

timeline.addEventListener("pointerup", () => {
  isScrubbing = false;
});

timeline.addEventListener("input", () => {
  viewer.scrub(Number(timeline.value));
});

speed.addEventListener("input", () => {
  viewer.setPlaybackSpeed(Number(speed.value));
});

window.addEventListener("beforeunload", () => {
  viewer.dispose();
  library.revokeObjectUrls();
});

renderAssets();
renderStats();
renderClips([]);

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

async function runImport(action: () => Promise<number> | number, successLabel: string): Promise<void> {
  try {
    setStatus({ label: "Indexing files...", tone: "idle" });
    const count = await action();
    renderAssets();
    setStatus({ label: successLabel, detail: `${count} files added`, tone: "ok" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      setStatus({ label: "Folder selection canceled", tone: "idle" });
      return;
    }

    setStatus({
      label: "Import failed",
      detail: error instanceof Error ? error.message : "Unknown error",
      tone: "error"
    });
  }
}

function renderAssets(): void {
  const assets = filteredAssets();
  const allAssets = library.assets;

  assetCount.textContent = `${allAssets.length} model${allAssets.length === 1 ? "" : "s"}`;
  fileCount.textContent = `${library.fileCount} file${library.fileCount === 1 ? "" : "s"} indexed`;
  assetList.innerHTML = "";

  if (allAssets.length === 0) {
    assetList.innerHTML = `
      <div class="empty-state">
        <strong>No local models yet</strong>
        <span>Add a folder, choose files, or drop GLB/glTF assets here.</span>
      </div>
    `;
    return;
  }

  if (assets.length === 0) {
    assetList.innerHTML = `
      <div class="empty-state">
        <strong>No matching models</strong>
        <span>Try a different search term.</span>
      </div>
    `;
    return;
  }

  for (const asset of assets) {
    const button = document.createElement("button");
    button.className = "asset-row";
    button.type = "button";
    button.setAttribute("aria-pressed", String(asset.id === selectedAssetId));
    button.innerHTML = `
      <span class="asset-name">${escapeHtml(asset.name)}</span>
      <span class="asset-path">${escapeHtml(asset.path)}</span>
      <span class="asset-meta">${asset.kind.toUpperCase()} · ${asset.sizeLabel}</span>
    `;
    button.addEventListener("click", () => loadAsset(asset));
    assetList.append(button);
  }
}

function filteredAssets(): LocalAsset[] {
  const queryText = assetSearch.value.trim().toLowerCase();
  const assets = library.assets;
  if (!queryText) return assets;
  return assets.filter((asset) => asset.path.toLowerCase().includes(queryText));
}

async function loadAsset(asset: LocalAsset): Promise<void> {
  selectedAssetId = asset.id;
  renderAssets();
  selectedName.textContent = asset.name;
  selectedPath.textContent = asset.path;
  setStatus({ label: "Loading model...", detail: asset.name, tone: "idle" });

  try {
    const model = await viewer.loadAsset(asset, library);
    renderLoadedModel(model);
    setStatus({ label: "Model loaded", detail: `${model.stats.meshes} meshes, ${model.clips.length} clips`, tone: "ok" });
  } catch (error) {
    renderStats();
    renderClips([]);
    setStatus({
      label: "Load failed",
      detail: error instanceof Error ? error.message : "Unknown error",
      tone: "error"
    });
  }
}

function renderLoadedModel(model: LoadedModel): void {
  renderStats(model.stats);
  renderClips(model.clips.map((clip) => clip.name || "Unnamed clip"));
}

function renderStats(stats?: ModelStats): void {
  const values = stats
    ? [
        ["Meshes", stats.meshes.toLocaleString()],
        ["Materials", stats.materials.toLocaleString()],
        ["Textures", stats.textures.toLocaleString()],
        ["Triangles", stats.triangles.toLocaleString()],
        ["Vertices", stats.vertices.toLocaleString()],
        ["Bounds", stats.bounds]
      ]
    : [
        ["Meshes", "0"],
        ["Materials", "0"],
        ["Textures", "0"],
        ["Triangles", "0"],
        ["Vertices", "0"],
        ["Bounds", "0 x 0 x 0"]
      ];

  statsGrid.innerHTML = values
    .map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderClips(clips: string[]): void {
  clipList.innerHTML = "";

  if (clips.length === 0) {
    clipList.innerHTML = `<div class="empty-state compact">No animation clips in this model.</div>`;
    timeline.value = "0";
    timeline.max = "1";
    clipTime.textContent = "0.00s";
    clipDuration.textContent = "0.00s";
    togglePlayButton.disabled = true;
    return;
  }

  togglePlayButton.disabled = false;

  clips.forEach((clip, index) => {
    const button = document.createElement("button");
    button.className = "clip-row";
    button.type = "button";
    button.textContent = clip;
    button.setAttribute("aria-pressed", String(index === currentPlayback.activeClipIndex));
    button.addEventListener("click", () => viewer.playClip(index));
    clipList.append(button);
  });
}

function updatePlayback(state: PlaybackState): void {
  currentPlayback = state;
  togglePlayButton.textContent = state.isPlaying ? "Pause" : "Play";
  timeline.max = String(Math.max(state.duration, 0.001));
  if (!isScrubbing) timeline.value = String(state.time);
  clipTime.textContent = `${state.time.toFixed(2)}s`;
  clipDuration.textContent = `${state.duration.toFixed(2)}s`;

  for (const [index, button] of Array.from(clipList.querySelectorAll("button")).entries()) {
    button.setAttribute("aria-pressed", String(index === state.activeClipIndex));
  }
}

function wireToggle(selector: string, callback: (enabled: boolean) => void, initial = false): void {
  const button = query<HTMLButtonElement>(selector);
  let enabled = initial;
  button.setAttribute("aria-pressed", String(enabled));
  callback(enabled);

  button.addEventListener("click", () => {
    enabled = !enabled;
    button.setAttribute("aria-pressed", String(enabled));
    callback(enabled);
  });
}

function setStatus(status: LoadStatus): void {
  statusChip.dataset.tone = status.tone ?? "idle";
  statusChip.textContent = status.detail ? `${status.label}: ${status.detail}` : status.label;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char] ?? char;
  });
}
