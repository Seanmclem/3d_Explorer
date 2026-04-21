import "./styles.css";
import { GltfViewer } from "./viewer";
import { LocalAssetLibrary, supportsDirectoryPicker, supportsFilePicker } from "./localAssets";
import type {
  GeometrySelectionInfo,
  LoadedModel,
  LoadStatus,
  LocalAsset,
  ModelStats,
  NodeInspectorInfo,
  PlaybackState
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root is missing.");
}

app.innerHTML = `
  <main class="shell">
    <aside class="library-panel" aria-label="Asset library">
      <section class="accordion-section intro" data-accordion="overview">
        <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-overview">
          <span>Overview</span>
          <span class="accordion-caret" aria-hidden="true"></span>
        </button>
        <div class="accordion-content" id="accordion-overview">
          <p class="eyebrow">Local GLB and glTF lab</p>
          <h1>Model viewer</h1>
          <p class="summary">Load folders, inspect assets, test animation clips, and tune the camera without uploading files anywhere.</p>
        </div>
      </section>

      <section class="accordion-section" data-accordion="files">
        <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-files">
          <span>Files</span>
          <span class="accordion-caret" aria-hidden="true"></span>
        </button>
        <div class="accordion-content import-actions" id="accordion-files">
          <button class="primary-action" id="pickFolder" type="button">Open editable folder</button>
          <label class="secondary-action" for="folderInput">Import folder</label>
          <input id="folderInput" type="file" webkitdirectory directory multiple hidden />
          <button class="secondary-action" id="pickFiles" type="button">Open files</button>
          <label class="secondary-action" for="fileInput">Import files</label>
          <input id="fileInput" type="file" accept=".glb,.gltf,.bin,image/*,.ktx2,.basis,.dds" multiple hidden />
          <button class="secondary-action" id="clearLibrary" type="button">Clear</button>
        </div>
      </section>

      <section class="accordion-section" data-accordion="search">
        <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-search">
          <span>Search</span>
          <span class="accordion-caret" aria-hidden="true"></span>
        </button>
        <div class="accordion-content" id="accordion-search">
          <label class="field-label" for="assetSearch">Search assets</label>
          <input class="text-field" id="assetSearch" type="search" placeholder="robot, idle, character..." />
        </div>
      </section>

      <section class="accordion-section library-accordion" data-accordion="models">
        <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-models">
          <span>Models</span>
          <span class="accordion-caret" aria-hidden="true"></span>
        </button>
        <div class="accordion-content library-content" id="accordion-models">
          <div class="library-meta" aria-live="polite">
            <span id="assetCount">0 models</span>
            <span id="fileCount">0 files indexed</span>
          </div>
          <section class="asset-list" id="assetList" aria-label="Available models"></section>
        </div>
      </section>
    </aside>

    <section class="viewport-region" aria-label="3D viewport">
      <canvas id="viewerCanvas"></canvas>

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
        <section class="accordion-section" data-accordion="selected">
          <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-selected">
            <span>Selected</span>
            <span class="accordion-caret" aria-hidden="true"></span>
          </button>
          <div class="accordion-content" id="accordion-selected">
            <h2 id="selectedName">No model loaded</h2>
            <p id="selectedPath">Pick a GLB or glTF file to begin.</p>
          </div>
        </section>

        <section class="accordion-section" data-accordion="stats">
          <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-stats">
            <span>Stats</span>
            <span class="accordion-caret" aria-hidden="true"></span>
          </button>
          <div class="accordion-content stats-grid" id="statsGrid" aria-label="Model stats">
            <div><span>Meshes</span><strong>0</strong></div>
            <div><span>Materials</span><strong>0</strong></div>
            <div><span>Textures</span><strong>0</strong></div>
            <div><span>Triangles</span><strong>0</strong></div>
            <div><span>Vertices</span><strong>0</strong></div>
            <div><span>Bounds</span><strong>0 x 0 x 0</strong></div>
          </div>
        </section>

        <section class="accordion-section" data-accordion="nodes">
          <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-nodes">
            <span>Nodes</span>
            <span class="accordion-caret" aria-hidden="true"></span>
          </button>
          <div class="accordion-content node-list" id="nodeList" aria-label="GLTF nodes"></div>
        </section>

        <section class="accordion-section" data-accordion="animations">
          <button class="accordion-header" type="button" aria-expanded="true" aria-controls="accordion-animations">
            <span>Animations</span>
            <span class="accordion-caret" aria-hidden="true"></span>
          </button>
          <div class="accordion-content" id="accordion-animations">
            <div class="section-title-row">
              <span class="section-title">Clips</span>
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
          </div>
        </section>
      </aside>
    </section>
  </main>
`;

const library = new LocalAssetLibrary();
const canvas = query<HTMLCanvasElement>("#viewerCanvas");
let currentGeometrySelection: GeometrySelectionInfo | null = null;
let loadedNodes: NodeInspectorInfo[] = [];
const highlightedNodeIds = new Set<number>();
const viewer = new GltfViewer({
  canvas,
  onPlayback: updatePlayback,
  onGeometrySelection: (selection) => {
    const hadSelection = currentGeometrySelection != null;
    currentGeometrySelection = selection;
    renderNodes(loadedNodes);
    if (selection) {
      setAccordionExpanded("nodes", true);
      setStatus({
        label: "Geometry island selected",
        detail: `${selection.materialName}, ${selection.faceCount} faces`,
        tone: "ok"
      });
    } else if (hadSelection) {
      setStatus({ label: "Geometry selection cleared", tone: "idle" });
    }
  }
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
const dropTarget = query<HTMLElement>(".viewport-region");
const statusChip = query<HTMLElement>("#statusChip");
const selectedName = query<HTMLElement>("#selectedName");
const selectedPath = query<HTMLElement>("#selectedPath");
const statsGrid = query<HTMLElement>("#statsGrid");
const nodeList = query<HTMLElement>("#nodeList");
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

initAccordions();

if (supportsDirectoryPicker()) {
  pickFolderButton.title = "Uses the File System Access API and keeps file handles for future edits.";
} else {
  pickFolderButton.title = "Falls back to folder upload in this browser.";
}

if (supportsFilePicker()) {
  pickFilesButton.title = "Uses the File System Access API and keeps file handles for future edits.";
} else {
  pickFilesButton.title = "Falls back to file upload in this browser.";
}

pickFolderButton.addEventListener("click", async () => {
  if (!supportsDirectoryPicker()) {
    alertFileSystemAccessFallback("folder");
    folderInput.click();
    return;
  }

  await runImport(async () => library.addDirectoryFromPicker(), "Editable folder opened");
});

pickFilesButton.addEventListener("click", async () => {
  if (!supportsFilePicker()) {
    alertFileSystemAccessFallback("files");
    fileInput.click();
    return;
  }

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
  loadedNodes = [];
  highlightedNodeIds.clear();
  selectedName.textContent = "No model loaded";
  selectedPath.textContent = "Pick a GLB or glTF file to begin.";
  renderAssets();
  renderStats();
  renderNodes([]);
  renderClips([]);
  setStatus({ label: "Library cleared", tone: "idle" });
});

assetSearch.addEventListener("input", renderAssets);

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-node-action]");
  if (!button) return;

  const nodeId = Number(button.dataset.nodeId);
  if (!Number.isFinite(nodeId)) return;

  if (button.dataset.nodeAction === "visible") {
    const isVisible = button.getAttribute("aria-pressed") === "true";
    const nextVisible = !isVisible;
    if (!viewer.setNodeVisible(nodeId, nextVisible)) return;

    button.setAttribute("aria-pressed", String(nextVisible));
    button.textContent = nextVisible ? "Hide" : "Show";
    button.closest(".node-item")?.classList.toggle("is-node-hidden", !nextVisible);
    setStatus({ label: nextVisible ? "Node shown" : "Node hidden", tone: "idle" });
  }

  if (button.dataset.nodeAction === "highlight") {
    const isHighlighted = highlightedNodeIds.has(nodeId);
    const nextHighlighted = !isHighlighted;
    if (!viewer.setNodeHighlighted(nodeId, nextHighlighted)) return;

    if (nextHighlighted) {
      highlightedNodeIds.add(nodeId);
    } else {
      highlightedNodeIds.delete(nodeId);
    }
    button.setAttribute("aria-pressed", String(nextHighlighted));
    button.textContent = nextHighlighted ? "Unhighlight" : "Highlight";
    setStatus({ label: nextHighlighted ? "Node highlighted" : "Highlight removed", tone: "idle" });
  }
});

nodeList.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.nodeAction !== "color") return;

  const nodeId = Number(input.dataset.nodeId);
  const materialIndex = Number(input.dataset.materialIndex);
  if (!Number.isFinite(nodeId) || !Number.isFinite(materialIndex)) return;

  if (!viewer.setMaterialColor(nodeId, materialIndex, input.value)) return;

  const row = input.closest<HTMLElement>(".material-row");
  row?.querySelector<HTMLElement>(".material-swatch")?.style.setProperty("--swatch", input.value);
  const hexLabel = row?.querySelector<HTMLElement>(".material-hex");
  if (hexLabel) hexLabel.textContent = input.value;
});

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-selection-action]");
  if (!button) return;

  if (button.dataset.selectionAction === "clear") {
    viewer.clearGeometrySelection();
  }

  if (button.dataset.selectionAction === "toggle-visibility" && currentGeometrySelection) {
    const nextHidden = !currentGeometrySelection.hidden;
    if (!viewer.setGeometrySelectionHidden(currentGeometrySelection.id, nextHidden)) return;
    currentGeometrySelection = viewer.getGeometryIslands().find((selection) => selection.id === currentGeometrySelection?.id) ?? null;
    renderNodes(loadedNodes);
    setStatus({ label: nextHidden ? "Selection hidden" : "Selection shown", tone: "idle" });
  }
});

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-island-action]");
  if (!button) return;

  const selectionId = button.dataset.selectionId;
  if (!selectionId) return;

  const selection = viewer.getGeometryIslands().find((item) => item.id === selectionId);
  if (!selection) return;

  if (button.dataset.islandAction === "visible") {
    const nextHidden = !selection.hidden;
    if (!viewer.setGeometrySelectionHidden(selectionId, nextHidden)) return;
    currentGeometrySelection = viewer.getGeometryIslands().find((item) => item.id === currentGeometrySelection?.id) ?? currentGeometrySelection;
    renderNodes(loadedNodes);
    setStatus({ label: nextHidden ? "Island hidden" : "Island shown", detail: selection.materialName, tone: "idle" });
  }

  if (button.dataset.islandAction === "highlight") {
    if (currentGeometrySelection?.id === selectionId) {
      viewer.clearGeometrySelection();
      setStatus({ label: "Island highlight removed", detail: selection.materialName, tone: "idle" });
      return;
    }

    if (!viewer.highlightGeometrySelection(selectionId)) return;
    setStatus({ label: "Island highlighted", detail: selection.materialName, tone: "ok" });
  }
});

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
renderNodes([]);
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
    if (count > 0) {
      setAccordionExpanded("files", false);
    }
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

function initAccordions(): void {
  for (const section of Array.from(document.querySelectorAll<HTMLElement>("[data-accordion]"))) {
    const header = section.querySelector<HTMLButtonElement>(".accordion-header");
    const content = section.querySelector<HTMLElement>(".accordion-content");
    if (!header || !content) continue;

    header.addEventListener("click", () => {
      setAccordionExpanded(section.dataset.accordion ?? "", header.getAttribute("aria-expanded") !== "true");
    });
  }
}

function setAccordionExpanded(name: string, expanded: boolean): void {
  const section = document.querySelector<HTMLElement>(`[data-accordion="${name}"]`);
  const header = section?.querySelector<HTMLButtonElement>(".accordion-header");
  const content = section?.querySelector<HTMLElement>(".accordion-content");
  if (!section || !header || !content) return;

  section.classList.toggle("is-collapsed", !expanded);
  header.setAttribute("aria-expanded", String(expanded));
  content.hidden = !expanded;
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
  currentGeometrySelection = null;
  highlightedNodeIds.clear();
  renderAssets();
  selectedName.textContent = asset.name;
  selectedPath.textContent = asset.path;
  setStatus({ label: "Loading model...", detail: asset.name, tone: "idle" });

  try {
    const model = await viewer.loadAsset(asset, library);
    renderLoadedModel(model);
    setStatus({ label: "Model loaded", detail: `${model.stats.meshes} meshes, ${model.clips.length} clips`, tone: "ok" });
  } catch (error) {
    loadedNodes = [];
    renderStats();
    renderNodes([]);
    renderClips([]);
    setStatus({
      label: "Load failed",
      detail: error instanceof Error ? error.message : "Unknown error",
      tone: "error"
    });
  }
}

function renderLoadedModel(model: LoadedModel): void {
  loadedNodes = model.nodes;
  renderStats(model.stats);
  renderNodes(model.nodes);
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

function renderNodes(nodes: NodeInspectorInfo[]): void {
  nodeList.innerHTML = "";

  const selectionCard = document.createElement("div");
  selectionCard.id = "geometrySelectionCard";
  selectionCard.className = "geometry-selection-card";
  nodeList.append(selectionCard);
  renderGeometrySelection();

  if (nodes.length === 0) {
    nodeList.insertAdjacentHTML("beforeend", `<div class="empty-state compact">No GLTF scene nodes loaded.</div>`);
    return;
  }

  const animatedCount = nodes.filter((node) => node.tags.includes("animated")).length;
  const meshCount = nodes.filter((node) => node.tags.includes("mesh")).length;
  const materialCount = nodes.reduce((count, node) => count + node.materials.length, 0);
  const summary = document.createElement("div");
  summary.className = "node-summary";
  summary.innerHTML = `
    <span>${nodes.length} nodes</span>
    <span>${meshCount} meshes</span>
    <span>${animatedCount} animated</span>
    <span>${materialCount} material slots</span>
  `;
  nodeList.append(summary);

  for (const node of nodes) {
    const item = document.createElement("details");
    item.className = "node-item";
    item.open = node.tags.includes("mesh");

    const tags = node.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
    const transform = node.transform.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
    const isMesh = node.tags.includes("mesh");
    const geometryIslands = viewer.getGeometryIslands().filter((island) => island.nodeId === node.id);
    const actions = isMesh
      ? `
        <div class="node-actions">
          <button type="button" data-node-action="visible" data-node-id="${node.id}" aria-pressed="${node.visible}">${node.visible ? "Hide" : "Show"}</button>
          <button type="button" data-node-action="highlight" data-node-id="${node.id}" aria-pressed="${highlightedNodeIds.has(node.id)}">${
            highlightedNodeIds.has(node.id) ? "Unhighlight" : "Highlight"
          }</button>
        </div>
      `
      : "";
    const geometryIslandList = isMesh
      ? `
        <details class="node-subsection" ${currentGeometrySelection?.nodeId === node.id ? "open" : ""}>
          <summary>Geometry islands (${geometryIslands.length})</summary>
          ${
            geometryIslands.length > 0
              ? `
                <div class="island-list">
                  ${geometryIslands
                    .map(
                      (selection) => `
                        <div class="island-row ${selection.hidden ? "is-hidden" : ""} ${
                          currentGeometrySelection?.id === selection.id ? "is-selected" : ""
                        }">
                          <div>
                            <strong>${escapeHtml(selection.materialName)} island ${selection.islandIndex}</strong>
                            <span>${selection.faceCount.toLocaleString()} faces · ${selection.vertexCount.toLocaleString()} verts · ${
                              selection.hidden ? "hidden" : "visible"
                            }${currentGeometrySelection?.id === selection.id ? " · selected" : ""}</span>
                          </div>
                          <div class="island-actions">
                            <button
                              type="button"
                              data-island-action="visible"
                              data-selection-id="${selection.id}"
                              aria-pressed="${!selection.hidden}"
                            >${selection.hidden ? "Show" : "Hide"}</button>
                            <button
                              type="button"
                              data-island-action="highlight"
                              data-selection-id="${selection.id}"
                              aria-pressed="${currentGeometrySelection?.id === selection.id}"
                            >${currentGeometrySelection?.id === selection.id ? "Unhighlight" : "Highlight"}</button>
                          </div>
                        </div>
                      `
                    )
                    .join("")}
                </div>
              `
              : `<div class="empty-state compact">No triangle islands found for this mesh.</div>`
          }
        </details>
      `
      : "";
    const geometry = node.geometry
      ? `
        <div class="node-detail-row"><span>Geometry</span><strong>${escapeHtml(node.geometry.name)}</strong></div>
        <div class="node-detail-row"><span>Vertices</span><strong>${node.geometry.vertices.toLocaleString()}</strong></div>
        <div class="node-detail-row"><span>Attributes</span><strong>${escapeHtml(node.geometry.attributes.join(", "))}</strong></div>
      `
      : "";
    const materials =
      node.materials.length > 0
        ? `
          <div class="node-materials">
            ${node.materials
              .map(
                (material) => `
                  <div class="material-row">
                    <span class="material-swatch" style="--swatch: ${material.color ?? "#6e7a72"}"></span>
                    <div>
                      <strong>${escapeHtml(material.name)}</strong>
                      <span>${materialLabel(material)}</span>
                      ${
                        material.color
                          ? `
                            <label class="material-color-edit">
                              <span>Color</span>
                              <input
                                type="color"
                                value="${material.color}"
                                data-node-action="color"
                                data-node-id="${node.id}"
                                data-material-index="${material.index}"
                              />
                              <span class="material-hex">${material.color}</span>
                            </label>
                          `
                          : ""
                      }
                    </div>
                  </div>
                `
              )
              .join("")}
          </div>
        `
        : "";

    item.innerHTML = `
      <summary style="--node-indent: ${Math.min(node.depth, 8) * 10}px">
        <span class="node-title">${escapeHtml(node.name)}</span>
        <span class="node-type">${escapeHtml(node.type)}</span>
      </summary>
      <div class="node-details">
        ${actions}
        ${tags ? `<div class="node-tags">${tags}</div>` : ""}
        <div class="node-detail-row"><span>Visible</span><strong>${node.visible ? "yes" : "no"}</strong></div>
        <div class="node-detail-row"><span>Children</span><strong>${node.childCount}</strong></div>
        ${geometry}
        ${transform ? `<ul class="node-transform">${transform}</ul>` : ""}
        ${materials}
        ${geometryIslandList}
      </div>
    `;

    nodeList.append(item);
  }
}

function renderGeometrySelection(): void {
  const card = document.querySelector<HTMLElement>("#geometrySelectionCard");
  if (!card) return;

  if (!currentGeometrySelection) {
    card.innerHTML = `
      <strong>Click a surface</strong>
      <span>Pick a connected geometry island inside a mesh/material slot.</span>
    `;
    return;
  }

  card.innerHTML = `
    <strong>1 island selected</strong>
    <span>${escapeHtml(currentGeometrySelection.nodeName)} · ${escapeHtml(currentGeometrySelection.materialName)}</span>
    <div class="selection-stats">
      <span>Island ${currentGeometrySelection.islandIndex} of ${currentGeometrySelection.islandCount}</span>
      <span>${currentGeometrySelection.faceCount.toLocaleString()} faces</span>
      <span>${currentGeometrySelection.vertexCount.toLocaleString()} welded verts</span>
      <span>${currentGeometrySelection.hidden ? "hidden" : "visible"}</span>
    </div>
    <div class="selection-actions">
      <button type="button" data-selection-action="toggle-visibility">${currentGeometrySelection.hidden ? "Show selection" : "Hide selection"}</button>
      <button type="button" data-selection-action="clear">Clear selection</button>
    </div>
  `;
}

function materialLabel(material: NodeInspectorInfo["materials"][number]): string {
  const parts = [
    material.color,
    material.type,
    `side ${material.side}`,
    material.transparent ? "transparent" : "",
    material.vertexColors ? "vertex colors" : "",
    material.textureSlots.length > 0 ? `textures: ${material.textureSlots.join(", ")}` : "",
    typeof material.roughness === "number" ? `rough ${material.roughness.toFixed(2)}` : "",
    typeof material.metalness === "number" ? `metal ${material.metalness.toFixed(2)}` : "",
    typeof material.opacity === "number" && material.opacity < 1 ? `opacity ${material.opacity.toFixed(2)}` : ""
  ].filter(Boolean);

  return escapeHtml(parts.join(" + "));
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

function alertFileSystemAccessFallback(kind: "folder" | "files"): void {
  const target = kind === "folder" ? "folders" : "files";
  window.alert(
    `This browser does not support editable ${target} through the File System Access API yet. Falling back to upload mode. You can still preview assets, but future edit/save features will need an editable browser picker.`
  );
  setStatus({
    label: "Upload fallback",
    detail: "preview works, editable handles are unavailable",
    tone: "warn"
  });
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
