import "./styles.css";
import { GltfViewer } from "./viewer";
import type { EditorMode, PrimitiveKind } from "./viewer";
import { LocalAssetLibrary, supportsDirectoryPicker, supportsFilePicker } from "./localAssets";
import type {
  AnimationTimelineClip,
  AnimationTimelineGroup,
  AnimationTimelineTrack,
  GeometrySelectionInfo,
  LoadedModel,
  LoadStatus,
  LocalAsset,
  ModelStats,
  NodeInspectorInfo,
  PlaybackState
} from "./types";

type SaveFileWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable?: () => Promise<{
      write(data: BlobPart): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
};

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
        <button id="toggleTimelineDockTop" type="button" aria-pressed="true">Timeline</button>
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

        <section class="accordion-section is-collapsed" data-accordion="stats">
          <button class="accordion-header" type="button" aria-expanded="false" aria-controls="accordion-stats">
            <span>Stats</span>
            <span class="accordion-caret" aria-hidden="true"></span>
          </button>
          <div class="accordion-content stats-grid" id="statsGrid" aria-label="Model stats" hidden>
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
            <div class="animation-sidebar-summary">
              <p class="section-caption" id="animationSummary">No animation clips loaded.</p>
              <div class="animation-sidebar-actions">
                <button id="toggleTimelineDockSide" type="button" aria-pressed="true">Hide timeline</button>
              </div>
            </div>
          </div>
        </section>
      </aside>

      <section class="timeline-dock" id="timelineDock" aria-label="Animation timeline">
        <div class="timeline-dock-header">
          <div class="timeline-transport">
            <button id="jumpStart" type="button">Start</button>
            <button id="stepBack" type="button">Back</button>
            <button id="togglePlay" type="button">Play</button>
            <button id="stepForward" type="button">Next</button>
            <button id="jumpEnd" type="button">End</button>
          </div>
          <div class="timeline-readout">
            <strong id="frameReadout">0000 / 0000</strong>
            <span id="fpsReadout">24 fps</span>
            <span id="clipTime">0.00s</span>
            <span id="clipDuration">0.00s</span>
          </div>
          <div class="timeline-header-actions">
            <button id="toggleTimelineDock" type="button" aria-pressed="true">Hide timeline</button>
          </div>
        </div>
        <div class="timeline-dock-subheader">
          <div class="timeline-current-clip">
            <span class="section-title">Clip</span>
            <strong id="activeClipName">No animation</strong>
            <span id="trackSummary">Open a model with animation clips to inspect channels and keys.</span>
          </div>
          <label class="timeline-speed-control" for="speed">
            <span class="field-label">Playback speed</span>
            <input id="speed" type="range" min="0" max="2" step="0.05" value="1" />
          </label>
          <div class="timeline-mode-strip" aria-label="Timeline mode">
            <button type="button" aria-pressed="true">Dope Sheet</button>
            <button type="button" disabled>Curves</button>
          </div>
        </div>
        <div class="timeline-clip-strip" id="clipList"></div>
        <input id="timeline" class="timeline-scrubber" type="range" min="0" max="1" step="0.001" value="0" aria-label="Timeline scrubber" />
        <div class="timeline-sheet" id="timelinePanel">
          <div class="timeline-sheet-header">
            <div class="timeline-sheet-label-head">Channels</div>
            <div class="timeline-ruler" id="timelineRuler"></div>
          </div>
          <div class="timeline-track-groups" id="trackGroupList"></div>
        </div>
      </section>
    </section>
  </main>
`;

const library = new LocalAssetLibrary();
const canvas = query<HTMLCanvasElement>("#viewerCanvas");
let currentGeometrySelection: GeometrySelectionInfo | null = null;
let loadedNodes: NodeInspectorInfo[] = [];
const highlightedNodeIds = new Set<number>();
const nodeVisibilityOverrides = new Map<number, boolean>();
const deletedNodeOverrides = new Map<number, boolean>();
const openDetailState = new Map<string, boolean>();
let selectedNodeId: number | null = null;
let editorMode = "select";
let nodeFilterText = "";
let nodeFilterMode = "all";
const viewer = new GltfViewer({
  canvas,
  onPlayback: updatePlayback,
  onSceneEdited: refreshSceneFromViewer,
  onGeometrySelection: (selection) => {
    const hadSelection = currentGeometrySelection != null;
    currentGeometrySelection = selection;
    if (selection) {
      selectedNodeId = selection.nodeId;
      viewer.selectNode(selection.nodeId);
      revealGeometrySelection(selection);
    }
    renderNodes(loadedNodes);
    if (selection) {
      scrollGeometrySelectionIntoView(selection.id);
    }
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
const TIMELINE_FPS = 24;

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
const animationSummary = query<HTMLElement>("#animationSummary");
const activeClipName = query<HTMLElement>("#activeClipName");
const togglePlayButton = query<HTMLButtonElement>("#togglePlay");
const toggleTimelineDockButton = query<HTMLButtonElement>("#toggleTimelineDock");
const toggleTimelineDockTopButton = query<HTMLButtonElement>("#toggleTimelineDockTop");
const toggleTimelineDockSideButton = query<HTMLButtonElement>("#toggleTimelineDockSide");
const timeline = query<HTMLInputElement>("#timeline");
const clipTime = query<HTMLElement>("#clipTime");
const clipDuration = query<HTMLElement>("#clipDuration");
const frameReadout = query<HTMLElement>("#frameReadout");
const fpsReadout = query<HTMLElement>("#fpsReadout");
const speed = query<HTMLInputElement>("#speed");
const timelineDock = query<HTMLElement>("#timelineDock");
const timelinePanel = query<HTMLElement>("#timelinePanel");
const timelineRuler = query<HTMLElement>("#timelineRuler");
const trackGroupList = query<HTMLElement>("#trackGroupList");
const trackSummary = query<HTMLElement>("#trackSummary");
const jumpStartButton = query<HTMLButtonElement>("#jumpStart");
const stepBackButton = query<HTMLButtonElement>("#stepBack");
const stepForwardButton = query<HTMLButtonElement>("#stepForward");
const jumpEndButton = query<HTMLButtonElement>("#jumpEnd");

let selectedAssetId = "";
let currentAsset: LocalAsset | null = null;
let timelineDockVisible = true;
let timelineClips: AnimationTimelineClip[] = [];
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
  currentAsset = null;
  loadedNodes = [];
  highlightedNodeIds.clear();
  nodeVisibilityOverrides.clear();
  deletedNodeOverrides.clear();
  openDetailState.clear();
  currentGeometrySelection = null;
  selectedNodeId = null;
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
  selectedNodeId = nodeId;

  if (button.dataset.nodeAction === "visible") {
    const isVisible = effectiveNodeVisible(nodeId);
    const nextVisible = !isVisible;
    setNodeVisible(nodeId, nextVisible);
    renderNodes(loadedNodes);
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

  if (button.dataset.nodeAction === "isolate") {
    isolateNode(nodeId);
  }

  if (button.dataset.nodeAction === "restore") {
    restoreAllVisibility();
  }

  if (button.dataset.nodeAction === "delete") {
    const nextDeleted = !effectiveNodeDeleted(nodeId);
    setNodeDeleted(nodeId, nextDeleted);
    renderNodes(loadedNodes);
    setStatus({ label: nextDeleted ? "Node deleted" : "Node restored", tone: "idle" });
  }
});

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-editor-mode]");
  if (!button) return;

  editorMode = button.dataset.editorMode ?? "select";
  viewer.setEditorMode(editorMode as EditorMode);
  renderNodes(loadedNodes);
  setStatus({ label: `${modeLabel(editorMode)} mode`, tone: "idle" });
});

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-add-primitive]");
  if (!button) return;

  const kind = button.dataset.addPrimitive as PrimitiveKind | undefined;
  if (!kind) return;

  loadedNodes = viewer.addPrimitive(kind);
  selectedNodeId = viewer.getSelectedNodeId() ?? selectedNodeId;
  renderNodes(loadedNodes);
  setStatus({ label: `${primitiveLabel(kind)} added`, tone: "ok" });
});

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-history-action]");
  if (!button) return;

  const changed = button.dataset.historyAction === "undo" ? viewer.undo() : viewer.redo();
  if (!changed) {
    setStatus({ label: button.dataset.historyAction === "undo" ? "Nothing to undo" : "Nothing to redo", tone: "idle" });
    return;
  }

  refreshSceneFromViewer();
  setStatus({ label: button.dataset.historyAction === "undo" ? "Undo" : "Redo", tone: "idle" });
});

nodeList.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-save-gltf]");
  if (!button) return;

  await saveGltfEdits();
});

nodeList.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-export-glb]");
  if (!button) return;

  await exportCurrentPreviewGlb();
});

nodeList.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-override-glb]");
  if (!button) return;

  await overrideCurrentGlb();
});

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-outliner-node]");
  if (!button) return;

  const nodeId = Number(button.dataset.outlinerNode);
  if (!Number.isFinite(nodeId)) return;
  selectNode(nodeId);
});

nodeList.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  if (input.dataset.nodeFilterSearch === "true") {
    nodeFilterText = input.value;
    renderNodes(loadedNodes);
    restoreNodeSearchFocus();
    return;
  }

  if (input.dataset.nodeAction !== "color") return;

  const nodeId = Number(input.dataset.nodeId);
  const materialIndex = Number(input.dataset.materialIndex);
  if (!Number.isFinite(nodeId) || !Number.isFinite(materialIndex)) return;

  if (!viewer.setMaterialColor(nodeId, materialIndex, input.value)) return;

  const node = loadedNodes.find((item) => item.id === nodeId);
  const material = node?.materials.find((item) => item.index === materialIndex);
  if (material) {
    material.color = input.value;
  }

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

  if (button.dataset.selectionAction === "delete" && currentGeometrySelection) {
    const nextHidden = !currentGeometrySelection.hidden;
    if (!viewer.setGeometrySelectionHidden(currentGeometrySelection.id, nextHidden)) return;
    currentGeometrySelection = viewer.getGeometryIslands().find((selection) => selection.id === currentGeometrySelection?.id) ?? null;
    renderNodes(loadedNodes);
    setStatus({ label: nextHidden ? "Island deleted" : "Island restored", tone: "idle" });
  }

  if (button.dataset.selectionAction === "isolate" && currentGeometrySelection) {
    isolateIsland(currentGeometrySelection.id);
  }

  if (button.dataset.selectionAction === "hide-siblings" && currentGeometrySelection) {
    hideSiblingIslands(currentGeometrySelection.id);
  }

  if (button.dataset.selectionAction === "restore") {
    restoreAllVisibility();
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
  selectedNodeId = selection.nodeId;

  if (button.dataset.islandAction === "visible") {
    const nextHidden = !selection.hidden;
    if (!viewer.setGeometrySelectionHidden(selectionId, nextHidden)) return;
    currentGeometrySelection = viewer.getGeometryIslands().find((item) => item.id === currentGeometrySelection?.id) ?? currentGeometrySelection;
    renderNodes(loadedNodes);
    setStatus({ label: nextHidden ? "Island hidden" : "Island shown", detail: selection.materialName, tone: "idle" });
  }

  if (button.dataset.islandAction === "delete") {
    const nextHidden = !selection.hidden;
    if (!viewer.setGeometrySelectionHidden(selectionId, nextHidden)) return;
    currentGeometrySelection = viewer.getGeometryIslands().find((item) => item.id === currentGeometrySelection?.id) ?? currentGeometrySelection;
    renderNodes(loadedNodes);
    setStatus({ label: nextHidden ? "Island deleted" : "Island restored", detail: selection.materialName, tone: "idle" });
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

  if (button.dataset.islandAction === "isolate") {
    isolateIsland(selectionId);
  }

  if (button.dataset.islandAction === "hide-siblings") {
    hideSiblingIslands(selectionId);
  }
});

nodeList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>("button[data-node-filter]");
  if (!button) return;

  nodeFilterMode = button.dataset.nodeFilter ?? "all";
  renderNodes(loadedNodes);
});

nodeList.addEventListener(
  "toggle",
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.dataset.detailKey) return;
    openDetailState.set(details.dataset.detailKey, details.open);
  },
  true
);

nodeList.addEventListener("focusin", (event) => {
  if (!(event.target instanceof HTMLElement)) return;
  if (event.target.closest(".node-list")) {
    viewer.controls.enabled = false;
  }
});

nodeList.addEventListener("focusout", () => {
  viewer.controls.enabled = true;
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

toggleTimelineDockButton.addEventListener("click", () => {
  setTimelineDockVisible(!timelineDockVisible);
});

toggleTimelineDockTopButton.addEventListener("click", () => {
  setTimelineDockVisible(!timelineDockVisible);
});

toggleTimelineDockSideButton.addEventListener("click", () => {
  setTimelineDockVisible(!timelineDockVisible);
});

jumpStartButton.addEventListener("click", () => {
  viewer.setPaused(true);
  viewer.scrub(0);
});

stepBackButton.addEventListener("click", () => {
  viewer.setPaused(true);
  viewer.scrub(Math.max(0, currentPlayback.time - 1 / TIMELINE_FPS));
});

stepForwardButton.addEventListener("click", () => {
  viewer.setPaused(true);
  viewer.scrub(Math.min(currentPlayback.duration, currentPlayback.time + 1 / TIMELINE_FPS));
});

jumpEndButton.addEventListener("click", () => {
  viewer.setPaused(true);
  viewer.scrub(currentPlayback.duration);
});

timeline.addEventListener("pointerdown", () => {
  isScrubbing = true;
  viewer.setPaused(true);
});

timeline.addEventListener("pointerup", () => {
  isScrubbing = false;
});

timeline.addEventListener("pointercancel", () => {
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
renderTimelineDockVisibility();

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
  currentAsset = null;
  currentGeometrySelection = null;
  highlightedNodeIds.clear();
  nodeVisibilityOverrides.clear();
  deletedNodeOverrides.clear();
  openDetailState.clear();
  selectedNodeId = null;
  renderAssets();
  selectedName.textContent = asset.name;
  selectedPath.textContent = asset.path;
  setStatus({ label: "Loading model...", detail: asset.name, tone: "idle" });

  try {
    const model = await viewer.loadAsset(asset, library);
    currentAsset = asset;
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
  selectedNodeId = null;
  viewer.selectNode(null);
  nodeVisibilityOverrides.clear();
  deletedNodeOverrides.clear();
  renderStats(model.stats);
  renderNodes(model.nodes);
  renderClips(model.timelineClips);
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
  nodeList.append(renderEditorTools());

  const selectionCard = document.createElement("div");
  selectionCard.id = "geometrySelectionCard";
  selectionCard.className = "geometry-selection-card";
  nodeList.append(selectionCard);
  renderGeometrySelection();

  if (nodes.length === 0) {
    nodeList.insertAdjacentHTML("beforeend", `<div class="empty-state compact">No GLTF scene nodes loaded.</div>`);
    return;
  }

  const allIslands = viewer.getGeometryIslands();
  const animatedCount = nodes.filter((node) => node.tags.includes("animated")).length;
  const meshCount = nodes.filter((node) => node.tags.includes("mesh")).length;
  const materialCount = nodes.reduce((count, node) => count + node.materials.length, 0);
  const hiddenCount = nodes.filter((node) => node.tags.includes("mesh") && !effectiveNodeVisible(node.id)).length;
  const visibleNodes = filteredNodes(nodes, allIslands);
  const filters = ["all", "mesh", "hidden", "highlighted", "islands"];
  const filterControls = document.createElement("div");
  filterControls.className = "node-filter-bar";
  filterControls.innerHTML = `
    <label class="field-label" for="nodeFilterSearch">Find nodes</label>
    <input
      class="text-field"
      id="nodeFilterSearch"
      type="search"
      placeholder="hair, Cube, hidden..."
      value="${escapeHtml(nodeFilterText)}"
      data-node-filter-search="true"
    />
    <div class="filter-chip-row" aria-label="Node filters">
      ${filters
        .map(
          (filter) => `
            <button type="button" data-node-filter="${filter}" aria-pressed="${nodeFilterMode === filter}">${filterLabel(filter)}</button>
          `
        )
        .join("")}
    </div>
  `;
  nodeList.append(filterControls);

  const summary = document.createElement("div");
  summary.className = "node-summary";
  summary.innerHTML = `
    <span>${nodes.length} nodes</span>
    <span>${visibleNodes.length} shown</span>
    <span>${meshCount} meshes</span>
    <span>${animatedCount} animated</span>
    <span>${materialCount} material slots</span>
    <span>${allIslands.length} islands</span>
    <span>${hiddenCount} hidden</span>
    <span>${highlightedNodeIds.size} outlined</span>
  `;
  nodeList.append(summary);

  if (visibleNodes.length === 0) {
    nodeList.insertAdjacentHTML("beforeend", `<div class="empty-state compact">No nodes match this filter.</div>`);
    return;
  }

  if (selectedNodeId != null && !nodes.some((node) => node.id === selectedNodeId)) {
    selectedNodeId = null;
    viewer.selectNode(null);
  }

  const outliner = document.createElement("section");
  outliner.className = "scene-outliner";
  outliner.innerHTML = `
    <div class="section-title-row compact">
      <span class="section-title">Scene outliner</span>
      <span>${visibleNodes.length}</span>
    </div>
    <div class="outliner-list">
      ${visibleNodes.map((node) => renderOutlinerRow(node, allIslands.filter((island) => island.nodeId === node.id))).join("")}
    </div>
  `;
  nodeList.append(outliner);
}

function renderEditorTools(): HTMLElement {
  const editorTools = document.createElement("div");
  editorTools.className = "editor-tool-strip";
  const canSaveGltf = currentAsset?.kind === "gltf";
  const canOverrideGlb = currentAsset?.kind === "glb" && currentAsset.accessMode === "handle";
  const saveModeLabel =
    currentAsset?.kind === "gltf" ? "Overwrite glTF" : currentAsset?.kind === "glb" ? "Overwrite GLB" : "Export only";
  editorTools.innerHTML = `
    <div class="tool-cluster">
      <div class="tool-cluster-header">
        <span class="tool-cluster-title">Save</span>
        <span class="tool-cluster-note">${saveModeLabel}</span>
      </div>
      <div class="tool-group tool-grid tool-grid-files" aria-label="File actions">
        <button class="save-gltf-button" type="button" data-export-glb>Export GLB</button>
        <button
          class="save-gltf-button"
          type="button"
          data-override-glb
          ${canOverrideGlb ? "" : "disabled"}
          title="${
            canOverrideGlb
              ? "Overwrite the original .glb with the current visible preview"
              : "Open an editable .glb file to overwrite it directly"
          }"
        >Override GLB</button>
        <button
          class="save-gltf-button"
          type="button"
          data-save-gltf
          ${canSaveGltf ? "" : "disabled"}
          title="${canSaveGltf ? "Overwrite the current .gltf with the current visible preview" : "Open an editable .gltf file to overwrite it directly"}"
        >Override glTF</button>
      </div>
    </div>
    <div class="tool-cluster">
      <div class="tool-cluster-header">
        <span class="tool-cluster-title">Edit</span>
        <div class="tool-group tool-group-inline" aria-label="History controls">
          <button type="button" data-history-action="undo">Undo</button>
          <button type="button" data-history-action="redo">Redo</button>
        </div>
      </div>
      <div class="tool-group tool-grid tool-grid-modes" aria-label="Editor modes">
        ${["select", "move", "rotate", "scale", "material"]
          .map(
            (mode) => `
              <button type="button" data-editor-mode="${mode}" aria-pressed="${editorMode === mode}">${modeLabel(mode)}</button>
            `
          )
          .join("")}
      </div>
    </div>
    <div class="tool-cluster">
      <div class="tool-cluster-header">
        <span class="tool-cluster-title">Add</span>
        <span class="tool-cluster-note">New scene objects</span>
      </div>
      <div class="tool-group tool-grid tool-grid-shapes add-shape-strip" aria-label="Add shapes">
        <button type="button" data-add-primitive="cube">Cube</button>
        <button type="button" data-add-primitive="sphere">Sphere</button>
        <button type="button" data-add-primitive="plane">Plane</button>
        <button type="button" data-add-primitive="light">Light</button>
      </div>
    </div>
  `;
  return editorTools;
}

function renderOutlinerRow(node: NodeInspectorInfo, islands: GeometrySelectionInfo[]): string {
  const selected = selectedNodeId === node.id && currentGeometrySelection?.nodeId !== node.id;
  const focused = currentGeometrySelection?.nodeId === node.id;
  const open = selected || focused;
  const visible = effectiveNodeVisible(node.id);
  const indent = Math.min(node.depth, 8) * 10;

  return `
    <div class="outliner-item ${open ? "is-open" : ""}">
      <button
        class="outliner-row ${selected ? "is-selected" : ""} ${focused ? "is-focused" : ""} ${visible ? "" : "is-hidden"}"
        type="button"
        data-outliner-node="${node.id}"
        style="--node-indent: ${indent}px"
        aria-pressed="${open}"
      >
        <span class="outliner-name">${escapeHtml(node.name)}</span>
        <span class="outliner-badges">${nodeBadges(node, islands, visible)}</span>
      </button>
      ${open ? `<div class="outliner-inline-properties">${renderNodeProperties(node, islands)}</div>` : ""}
    </div>
  `;
}

function renderNodeProperties(node: NodeInspectorInfo, geometryIslands: GeometrySelectionInfo[]): string {
  const tags = node.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const transform = node.transform.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
  const isMesh = node.tags.includes("mesh");
  const isVisible = effectiveNodeVisible(node.id);
  const isDeleted = effectiveNodeDeleted(node.id);
  const isFocusedNode = currentGeometrySelection?.nodeId === node.id;
  const actions = renderNodeSubsection(
    node.id,
    "actions",
    "Actions",
    `
      <div class="node-actions">
        <button type="button" data-node-action="visible" data-node-id="${node.id}" aria-pressed="${isVisible}">${
          isVisible ? "Hide" : "Show"
        }</button>
        <button
          type="button"
          data-node-action="highlight"
          data-node-id="${node.id}"
          aria-pressed="${highlightedNodeIds.has(node.id)}"
          ${isMesh ? "" : "disabled"}
        >${highlightedNodeIds.has(node.id) ? "Unhighlight" : "Highlight"}</button>
        <button type="button" data-node-action="isolate" data-node-id="${node.id}" ${isMesh ? "" : "disabled"}>${
          isNodeIsolated(node.id) ? "Unisolate mesh" : "Isolate mesh"
        }</button>
        <button type="button" data-node-action="delete" data-node-id="${node.id}" aria-pressed="${isDeleted}">${
          isDeleted ? "Restore node" : "Delete"
        }</button>
        <button type="button" data-node-action="restore" data-node-id="${node.id}">Restore all</button>
      </div>
    `,
    true
  );
  const geometryIslandList = isMesh
    ? renderNodeSubsection(
        node.id,
        "islands",
        `Geometry islands (${geometryIslands.length})`,
        geometryIslands.length > 0
          ? `<div class="island-list">${geometryIslands.map((selection) => renderIslandRow(selection)).join("")}</div>`
          : `<div class="empty-state compact">No triangle islands found for this mesh.</div>`,
        isFocusedNode
      )
    : "";
  const materials =
    node.materials.length > 0
      ? renderNodeSubsection(
          node.id,
          "materials",
          `Materials (${node.materials.length})`,
          `
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
          `,
          isFocusedNode || node.materials.length < 3
        )
      : "";
  const geometry = renderNodeSubsection(
    node.id,
    node.geometry ? "geometry" : "node",
    node.geometry ? "Geometry" : "Node",
    node.geometry
      ? `
        <div class="node-detail-row"><span>Geometry</span><strong>${escapeHtml(node.geometry.name)}</strong></div>
        <div class="node-detail-row"><span>Visible</span><strong>${isVisible ? "yes" : "no"}</strong></div>
        <div class="node-detail-row"><span>Children</span><strong>${node.childCount}</strong></div>
        <div class="node-detail-row"><span>Vertices</span><strong>${node.geometry.vertices.toLocaleString()}</strong></div>
        <div class="node-detail-row"><span>Attributes</span><strong>${escapeHtml(node.geometry.attributes.join(", "))}</strong></div>
      `
      : `
        <div class="node-detail-row"><span>Visible</span><strong>${isVisible ? "yes" : "no"}</strong></div>
        <div class="node-detail-row"><span>Children</span><strong>${node.childCount}</strong></div>
      `,
    false
  );
  const transformBlock = transform
    ? renderNodeSubsection(node.id, "transform", "Transform", `<ul class="node-transform">${transform}</ul>`, false)
    : "";
  const tagsBlock = tags
    ? renderNodeSubsection(node.id, "tags", "Tags", `<div class="node-tags">${tags}</div>`, false)
    : "";

  return `
    <div class="property-sections">
      ${actions}
      ${geometryIslandList}
      ${materials}
      ${geometry}
      ${transformBlock}
      ${tagsBlock}
    </div>
  `;
}

function renderIslandRow(selection: GeometrySelectionInfo): string {
  const selected = currentGeometrySelection?.id === selection.id;

  return `
    <div class="island-row ${selection.hidden ? "is-hidden" : ""} ${selected ? "is-selected" : ""}" data-island-id="${selection.id}">
      <div class="island-main">
        <strong>${escapeHtml(selection.materialName)} · island ${selection.islandIndex}</strong>
        <span>${selection.faceCount.toLocaleString()} faces · ${selection.vertexCount.toLocaleString()} verts · ${
          selection.hidden ? "hidden" : "visible"
        }${selected ? " · selected" : ""}</span>
      </div>
      <div class="island-actions">
        <button type="button" data-island-action="delete" data-selection-id="${selection.id}" aria-pressed="${selection.hidden}">${
          selection.hidden ? "Restore" : "Delete"
        }</button>
        <button type="button" data-island-action="highlight" data-selection-id="${selection.id}" aria-pressed="${selected}">${
          selected ? "Unhighlight" : "Highlight"
        }</button>
        <button type="button" data-island-action="isolate" data-selection-id="${selection.id}">${
          isIslandIsolated(selection.id) ? "Unisolate" : "Isolate"
        }</button>
        <button type="button" data-island-action="hide-siblings" data-selection-id="${selection.id}">Hide siblings</button>
      </div>
    </div>
  `;
}

function renderNodeSubsection(
  nodeId: number,
  section: string,
  title: string,
  content: string,
  defaultOpen: boolean
): string {
  const key = nodeSubsectionKey(nodeId, section);
  return `
    <details class="node-subsection" data-detail-key="${key}" ${detailOpen(key, defaultOpen) ? "open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="node-subsection-content">
        ${content}
      </div>
    </details>
  `;
}

function renderGeometrySelection(): void {
  const card = document.querySelector<HTMLElement>("#geometrySelectionCard");
  if (!card) return;

  if (!currentGeometrySelection) {
    card.innerHTML = `
      <strong>Nothing focused</strong>
      <span>Click a surface, or use a row in Geometry islands.</span>
      <div class="selection-actions">
        <button type="button" data-selection-action="restore">Restore all</button>
      </div>
    `;
    return;
  }

  card.innerHTML = `
    <strong>${escapeHtml(selectionBreadcrumb(currentGeometrySelection))}</strong>
    <span>${currentGeometrySelection.faceCount.toLocaleString()} faces · ${currentGeometrySelection.vertexCount.toLocaleString()} welded verts · ${
      currentGeometrySelection.hidden ? "hidden" : "visible"
    }</span>
    <div class="selection-stats">
      <span>Material ${currentGeometrySelection.materialIndex + 1}</span>
      <span>Island ${currentGeometrySelection.islandIndex} of ${currentGeometrySelection.islandCount}</span>
    </div>
    <div class="selection-actions">
      <button type="button" data-selection-action="delete">${currentGeometrySelection.hidden ? "Restore" : "Delete"}</button>
      <button type="button" data-selection-action="isolate">Isolate</button>
      <button type="button" data-selection-action="hide-siblings">Hide siblings</button>
      <button type="button" data-selection-action="restore">Restore all</button>
      <button type="button" data-selection-action="clear">Clear</button>
    </div>
  `;
}

function filteredNodes(nodes: NodeInspectorInfo[], islands: GeometrySelectionInfo[]): NodeInspectorInfo[] {
  const queryText = nodeFilterText.trim().toLowerCase();
  return nodes.filter((node) => {
    const nodeIslands = islands.filter((island) => island.nodeId === node.id);
    const matchesMode =
      nodeFilterMode === "all" ||
      (nodeFilterMode === "mesh" && node.tags.includes("mesh")) ||
      (nodeFilterMode === "hidden" && (!effectiveNodeVisible(node.id) || nodeIslands.some((island) => island.hidden))) ||
      (nodeFilterMode === "highlighted" && (highlightedNodeIds.has(node.id) || currentGeometrySelection?.nodeId === node.id)) ||
      (nodeFilterMode === "islands" && nodeIslands.length > 0);
    if (!matchesMode) return false;
    if (!queryText) return true;

    const haystack = [
      node.name,
      node.type,
      node.tags.join(" "),
      node.materials.map((material) => material.name).join(" "),
      nodeIslands.map((island) => `${island.materialName} island ${island.islandIndex}`).join(" ")
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(queryText);
  });
}

function nodeBadges(node: NodeInspectorInfo, islands: GeometrySelectionInfo[], visible: boolean): string {
  const badges = [
    node.type,
    node.deleted ? "deleted" : "",
    !visible ? "hidden" : "",
    highlightedNodeIds.has(node.id) ? "outlined" : "",
    currentGeometrySelection?.nodeId === node.id ? "focused" : "",
    islands.length > 0 ? `${islands.length} islands` : ""
  ].filter(Boolean);

  return badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("");
}

function filterLabel(filter: string): string {
  if (filter === "mesh") return "Meshes";
  if (filter === "hidden") return "Hidden";
  if (filter === "highlighted") return "Outlined";
  if (filter === "islands") return "Has islands";
  return "All";
}

function modeLabel(mode: string): string {
  if (mode === "move") return "Move";
  if (mode === "rotate") return "Rotate";
  if (mode === "scale") return "Scale";
  if (mode === "material") return "Material";
  return "Select";
}

function primitiveLabel(kind: PrimitiveKind): string {
  if (kind === "sphere") return "Sphere";
  if (kind === "plane") return "Plane";
  if (kind === "light") return "Light";
  return "Cube";
}

function selectNode(nodeId: number): void {
  selectedNodeId = nodeId;
  viewer.selectNode(nodeId);
  openDetailState.set(nodeKey(nodeId), true);
  if (currentGeometrySelection) {
    viewer.clearGeometrySelection();
  } else {
    renderNodes(loadedNodes);
  }
  setStatus({ label: "Node selected", tone: "idle" });
}

function refreshSceneFromViewer(): void {
  loadedNodes = viewer.getNodes();
  selectedNodeId = viewer.getSelectedNodeId() ?? selectedNodeId;
  nodeVisibilityOverrides.clear();
  deletedNodeOverrides.clear();
  renderNodes(loadedNodes);
}

async function saveGltfEdits(): Promise<void> {
  if (!currentAsset) {
    setStatus({ label: "No model to save", tone: "warn" });
    return;
  }

  if (currentAsset.kind !== "gltf") {
    setStatus({ label: "Save needs .gltf", detail: "GLB export is not wired yet", tone: "warn" });
    return;
  }

  if (currentAsset.accessMode !== "handle") {
    const message = "This model was imported without a writable file handle. Reopen it with Open editable folder or Open files, then save again.";
    window.alert(message);
    setStatus({ label: "Save needs editable access", detail: "reopen with an editable picker", tone: "warn" });
    return;
  }

  try {
    const gltfText = await viewer.exportCurrentGltfText();
    currentAsset = await library.writeAssetText(currentAsset, gltfText);
    selectedAssetId = currentAsset.id;
    renderAssets();
    setStatus({ label: "glTF overridden", detail: currentAsset.name, tone: "ok" });
  } catch (error) {
    setStatus({
      label: "Save failed",
      detail: error instanceof Error ? error.message : "Unknown error",
      tone: "error"
    });
  }
}

async function exportCurrentPreviewGlb(): Promise<void> {
  try {
    const glb = await viewer.exportCurrentGlb();
    const baseName = (currentAsset?.name ?? "scene").replace(/\.(gltf|glb)$/i, "");
    await saveBlobToFile(`${baseName}-preview.glb`, new Blob([glb], { type: "model/gltf-binary" }));
    setStatus({ label: "GLB exported", detail: `${baseName}-preview.glb`, tone: "ok" });
  } catch (error) {
    setStatus({
      label: "Export failed",
      detail: error instanceof Error ? error.message : "Unknown error",
      tone: "error"
    });
  }
}

async function overrideCurrentGlb(): Promise<void> {
  if (!currentAsset) {
    setStatus({ label: "No model to overwrite", tone: "warn" });
    return;
  }

  if (currentAsset.kind !== "glb") {
    setStatus({ label: "Override needs .glb", detail: "use Export GLB for a new file", tone: "warn" });
    return;
  }

  if (currentAsset.accessMode !== "handle") {
    const message = "This GLB was not opened with an editable file handle. Reopen it with Open editable folder or Open files, then try Override GLB again.";
    window.alert(message);
    setStatus({ label: "Override needs editable access", detail: "reopen with an editable picker", tone: "warn" });
    return;
  }

  try {
    const glb = await viewer.exportCurrentGlb();
    currentAsset = await library.writeAssetBlob(currentAsset, new Blob([glb], { type: "model/gltf-binary" }));
    selectedAssetId = currentAsset.id;
    renderAssets();
    setStatus({ label: "GLB overridden", detail: currentAsset.name, tone: "ok" });
  } catch (error) {
    setStatus({
      label: "Override failed",
      detail: error instanceof Error ? error.message : "Unknown error",
      tone: "error"
    });
  }
}

async function saveBlobToFile(filename: string, blob: Blob): Promise<void> {
  const savePicker = (window as SaveFileWindow).showSaveFilePicker;
  if (savePicker) {
    const handle = await savePicker({
      suggestedName: filename,
      types: [
        {
          description: "GLB model",
          accept: {
            "model/gltf-binary": [".glb"],
            "application/octet-stream": [".glb"]
          }
        }
      ]
    });
    const writable = await handle.createWritable?.();
    if (!writable) {
      throw new Error("This browser did not provide a writable file stream for the export.");
    }
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function selectionBreadcrumb(selection: GeometrySelectionInfo): string {
  return `${selection.nodeName} / ${selection.materialName} / Island ${selection.islandIndex}`;
}

function effectiveNodeVisible(nodeId: number): boolean {
  const node = loadedNodes.find((item) => item.id === nodeId);
  return nodeVisibilityOverrides.get(nodeId) ?? node?.visible ?? true;
}

function effectiveNodeDeleted(nodeId: number): boolean {
  const node = loadedNodes.find((item) => item.id === nodeId);
  return deletedNodeOverrides.get(nodeId) ?? node?.deleted ?? false;
}

function setNodeVisible(nodeId: number, visible: boolean): boolean {
  if (!viewer.setNodeVisible(nodeId, visible)) return false;
  nodeVisibilityOverrides.set(nodeId, visible);
  deletedNodeOverrides.set(nodeId, false);
  const node = loadedNodes.find((item) => item.id === nodeId);
  if (node) {
    node.visible = visible;
    node.deleted = false;
  }
  return true;
}

function setNodeDeleted(nodeId: number, deleted: boolean): boolean {
  if (!viewer.setNodeDeleted(nodeId, deleted)) return false;
  nodeVisibilityOverrides.set(nodeId, !deleted);
  deletedNodeOverrides.set(nodeId, deleted);
  const node = loadedNodes.find((item) => item.id === nodeId);
  if (node) {
    node.visible = !deleted;
    node.deleted = deleted;
  }
  return true;
}

function isolateNode(nodeId: number): void {
  if (isNodeIsolated(nodeId)) {
    restoreAllVisibility();
    setStatus({ label: "Mesh unisolated", tone: "idle" });
    return;
  }

  for (const node of loadedNodes.filter((item) => item.tags.includes("mesh"))) {
    setNodeVisible(node.id, node.id === nodeId);
  }
  openDetailState.set(nodeKey(nodeId), true);
  renderNodes(loadedNodes);
  setStatus({ label: "Mesh isolated", tone: "idle" });
}

function isolateIsland(selectionId: string): void {
  const selection = viewer.getGeometryIslands().find((item) => item.id === selectionId);
  if (!selection) return;

  if (isIslandIsolated(selectionId)) {
    restoreAllVisibility();
    setStatus({ label: "Island unisolated", detail: selection.materialName, tone: "idle" });
    return;
  }

  for (const node of loadedNodes.filter((item) => item.tags.includes("mesh"))) {
    setNodeVisible(node.id, node.id === selection.nodeId);
  }
  for (const island of viewer.getGeometryIslands().filter((item) => item.nodeId === selection.nodeId)) {
    viewer.setGeometrySelectionHidden(island.id, island.id !== selection.id);
  }
  if (currentGeometrySelection?.nodeId === selection.nodeId && currentGeometrySelection.id !== selection.id) {
    viewer.clearGeometrySelection();
  }
  revealGeometrySelection(selection);
  renderNodes(loadedNodes);
  setStatus({ label: "Island isolated", detail: selection.materialName, tone: "idle" });
}

function isNodeIsolated(nodeId: number): boolean {
  const meshNodes = loadedNodes.filter((item) => item.tags.includes("mesh"));
  return meshNodes.length > 1 && meshNodes.every((node) => effectiveNodeVisible(node.id) === (node.id === nodeId));
}

function isIslandIsolated(selectionId: string): boolean {
  const selection = viewer.getGeometryIslands().find((item) => item.id === selectionId);
  if (!selection) return false;

  const meshNodes = loadedNodes.filter((item) => item.tags.includes("mesh"));
  const meshVisibilityMatches = meshNodes.every((node) => effectiveNodeVisible(node.id) === (node.id === selection.nodeId));
  const siblingVisibilityMatches = viewer
    .getGeometryIslands()
    .filter((item) => item.nodeId === selection.nodeId)
    .every((island) => island.hidden === (island.id !== selectionId));

  return meshVisibilityMatches && siblingVisibilityMatches;
}

function hideSiblingIslands(selectionId: string): void {
  const selection = viewer.getGeometryIslands().find((item) => item.id === selectionId);
  if (!selection) return;

  setNodeVisible(selection.nodeId, true);
  for (const island of viewer.getGeometryIslands().filter((item) => item.nodeId === selection.nodeId && item.id !== selection.id)) {
    viewer.setGeometrySelectionHidden(island.id, true);
  }
  if (currentGeometrySelection?.nodeId === selection.nodeId && currentGeometrySelection.id !== selection.id) {
    viewer.clearGeometrySelection();
  }
  revealGeometrySelection(selection);
  renderNodes(loadedNodes);
  setStatus({ label: "Sibling islands hidden", detail: selection.materialName, tone: "idle" });
}

function restoreAllVisibility(): void {
  for (const node of loadedNodes) {
    setNodeDeleted(node.id, false);
    setNodeVisible(node.id, true);
  }
  for (const island of viewer.getGeometryIslands()) {
    viewer.setGeometrySelectionHidden(island.id, false);
  }
  renderNodes(loadedNodes);
  setStatus({ label: "Visibility restored", tone: "idle" });
}

function revealGeometrySelection(selection: GeometrySelectionInfo): void {
  openDetailState.set(nodeKey(selection.nodeId), true);
  openDetailState.set(nodeSubsectionKey(selection.nodeId, "islands"), true);
  openDetailState.set(nodeSubsectionKey(selection.nodeId, "materials"), true);
}

function scrollGeometrySelectionIntoView(selectionId: string): void {
  requestAnimationFrame(() => {
    const row = Array.from(nodeList.querySelectorAll<HTMLElement>("[data-island-id]")).find(
      (element) => element.dataset.islandId === selectionId
    );
    row?.scrollIntoView({ block: "nearest" });
  });
}

function restoreNodeSearchFocus(): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>("#nodeFilterSearch");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function nodeKey(nodeId: number): string {
  return `node:${nodeId}`;
}

function nodeSubsectionKey(nodeId: number, section: string): string {
  return `node:${nodeId}:${section}`;
}

function detailOpen(key: string, fallback: boolean): boolean {
  return openDetailState.get(key) ?? fallback;
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

function renderClips(clips: AnimationTimelineClip[]): void {
  timelineClips = clips;
  clipList.innerHTML = "";
  trackGroupList.innerHTML = "";
  timelineRuler.innerHTML = "";

  if (clips.length === 0) {
    animationSummary.textContent = "No animation clips loaded.";
    activeClipName.textContent = "No animation";
    clipList.innerHTML = `<div class="empty-state compact">No animation clips in this model.</div>`;
    trackGroupList.innerHTML = `<div class="empty-state compact">The active clip’s animated channels and keyframes appear here.</div>`;
    trackSummary.textContent = "Open a model with animation clips to inspect channels and keys.";
    timeline.value = "0";
    timeline.max = "1";
    clipTime.textContent = "0.00s";
    clipDuration.textContent = "0.00s";
    frameReadout.textContent = "0000 / 0000";
    fpsReadout.textContent = `${TIMELINE_FPS} fps`;
    togglePlayButton.disabled = true;
    jumpStartButton.disabled = true;
    stepBackButton.disabled = true;
    stepForwardButton.disabled = true;
    jumpEndButton.disabled = true;
    timeline.disabled = true;
    speed.disabled = true;
    toggleTimelineDockButton.disabled = false;
    renderTimelineDockVisibility();
    return;
  }

  const totalTracks = clips.reduce((sum, clip) => sum + clip.trackCount, 0);
  const totalKeys = clips.reduce((sum, clip) => sum + clip.keyCount, 0);
  animationSummary.textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"} · ${totalTracks.toLocaleString()} channels · ${totalKeys.toLocaleString()} keys`;

  togglePlayButton.disabled = false;
  jumpStartButton.disabled = false;
  stepBackButton.disabled = false;
  stepForwardButton.disabled = false;
  jumpEndButton.disabled = false;
  timeline.disabled = false;
  speed.disabled = false;
  toggleTimelineDockButton.disabled = false;

  clips.forEach((clip, index) => {
    const button = document.createElement("button");
    button.className = "timeline-clip-tab";
    button.type = "button";
    button.setAttribute("aria-pressed", String(index === currentPlayback.activeClipIndex));
    button.innerHTML = `
      <strong>${escapeHtml(clip.name)}</strong>
      <span>${clip.duration.toFixed(2)}s · ${clip.trackCount} channels</span>
    `;
    button.addEventListener("click", () => viewer.playClip(index));
    clipList.append(button);
  });

  renderTimelineDetails();
  renderTimelineDockVisibility();
  syncTimelinePlayheads();
}

function updatePlayback(state: PlaybackState): void {
  const previousActiveClipIndex = currentPlayback.activeClipIndex;
  currentPlayback = state;
  togglePlayButton.textContent = state.isPlaying ? "Pause" : "Play";
  timeline.max = String(Math.max(state.duration, 0.001));
  if (!isScrubbing) timeline.value = String(state.time);
  clipTime.textContent = `${state.time.toFixed(2)}s`;
  clipDuration.textContent = `${state.duration.toFixed(2)}s`;
  frameReadout.textContent = `${formatFrame(state.time)} / ${formatFrame(state.duration)}`;
  fpsReadout.textContent = `${TIMELINE_FPS} fps`;

  for (const [index, button] of Array.from(clipList.querySelectorAll<HTMLButtonElement>("button")).entries()) {
    button.setAttribute("aria-pressed", String(index === state.activeClipIndex));
  }

  if (previousActiveClipIndex !== state.activeClipIndex) {
    renderTimelineDetails();
  }

  syncTimelinePlayheads();
}

function setTimelineDockVisible(visible: boolean): void {
  timelineDockVisible = visible;
  renderTimelineDockVisibility();
}

function renderTimelineDockVisibility(): void {
  timelineDock.classList.toggle("is-collapsed", !timelineDockVisible);
  dropTarget.classList.toggle("timeline-dock-open", timelineDockVisible);

  const label = timelineDockVisible ? "Hide timeline" : "Show timeline";
  for (const button of [toggleTimelineDockButton, toggleTimelineDockTopButton, toggleTimelineDockSideButton]) {
    button.setAttribute("aria-pressed", String(timelineDockVisible));
    button.textContent = button === toggleTimelineDockTopButton ? "Timeline" : label;
  }
}

function renderTimelineDetails(): void {
  trackGroupList.innerHTML = "";
  timelineRuler.innerHTML = "";

  if (timelineClips.length === 0) return;

  const activeClip =
    timelineClips.find((clip) => clip.index === currentPlayback.activeClipIndex) ??
    timelineClips[0];
  const activeDuration = Math.max(activeClip.duration, 0.001);
  activeClipName.textContent = activeClip.name;

  timelineRuler.append(renderTimelineRuler(activeDuration));

  trackSummary.textContent = `${activeClip.trackCount} channels across ${activeClip.groups.length} animated targets`;

  activeClip.groups.forEach((group, groupIndex) => {
    const details = document.createElement("details");
    details.className = "timeline-target-group";
    details.open = isAnimationGroupOpen(activeClip, group, groupIndex);
    details.dataset.groupKey = animationGroupKey(activeClip, group);
    details.innerHTML = `
      <summary>
        <span class="timeline-target-heading">
          <strong>${escapeHtml(group.label)}</strong>
          <span>${escapeHtml(group.context ?? `${group.trackCount} channels`)}</span>
        </span>
        <span class="timeline-group-meta">${group.trackCount} channels · ${group.keyCount.toLocaleString()} keys</span>
      </summary>
      <div class="timeline-target-rows">
        ${group.tracks
          .map((track) => renderTrackRow(track, activeDuration))
          .join("")}
      </div>
    `;
    const summary = details.querySelector("summary");
    summary?.addEventListener("click", () => {
      requestAnimationFrame(() => {
        openDetailState.set(animationGroupKey(activeClip, group), details.open);
      });
    });
    trackGroupList.append(details);
  });

  bindTimelineScrubSurfaces();
}

function renderTimelineRuler(duration: number): HTMLElement {
  const ruler = document.createElement("div");
  ruler.className = "timeline-ruler-row";
  const totalFrames = Math.max(1, Math.round(duration * TIMELINE_FPS));
  const majorStep = totalFrames <= 48 ? 6 : totalFrames <= 96 ? 12 : 24;

  for (let frame = 0; frame <= totalFrames; frame += majorStep) {
    const ratio = totalFrames === 0 ? 0 : frame / totalFrames;
    const tick = document.createElement("span");
    tick.className = "timeline-ruler-tick";
    tick.style.left = `${ratio * 100}%`;
    tick.textContent = String(frame);
    ruler.append(tick);
  }

  return ruler;
}

function renderTrackRow(track: AnimationTimelineTrack, duration: number): string {
  const ticks = condensedKeyTimes(track.keyTimes, duration)
    .map(
      (time) =>
        `<span class="timeline-key-tick" style="left:${duration <= 0 ? 0 : (time / duration) * 100}%"><span></span></span>`
    )
    .join("");

  return `
    <div class="timeline-sheet-row">
      <div class="timeline-track-label">
        <strong>${escapeHtml(track.targetLabel)} · ${escapeHtml(track.propertyLabel)}</strong>
        <span>${track.keyCount.toLocaleString()} keys · ${escapeHtml(track.interpolation)} · ${escapeHtml(track.valueType)}</span>
      </div>
      <button
        class="timeline-track-rail timeline-scrub-surface"
        type="button"
        data-scrub-duration="${duration}"
        aria-label="Scrub ${escapeHtml(track.targetLabel)} ${escapeHtml(track.propertyLabel)}"
      >
        ${ticks}
        <span class="timeline-playhead"></span>
      </button>
    </div>
  `;
}

function bindTimelineScrubSurfaces(): void {
  for (const surface of Array.from(document.querySelectorAll<HTMLElement>(".timeline-scrub-surface"))) {
    let dragging = false;

    const scrubFromPointer = (event: PointerEvent) => {
      const duration = Number(surface.dataset.scrubDuration ?? currentPlayback.duration);
      if (!duration) return;

      const clipIndex = Number(surface.dataset.clipIndex ?? currentPlayback.activeClipIndex);
      if (Number.isFinite(clipIndex) && clipIndex >= 0 && clipIndex !== currentPlayback.activeClipIndex) {
        viewer.playClip(clipIndex);
      }

      const rect = surface.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1)));
      viewer.scrub(ratio * duration);
    };

    surface.addEventListener("pointerdown", (event) => {
      dragging = true;
      isScrubbing = true;
      viewer.setPaused(true);
      surface.setPointerCapture(event.pointerId);
      scrubFromPointer(event);
    });

    surface.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      scrubFromPointer(event);
    });

    const stopDragging = () => {
      dragging = false;
      isScrubbing = false;
    };

    surface.addEventListener("pointerup", stopDragging);
    surface.addEventListener("pointercancel", stopDragging);
    surface.addEventListener("lostpointercapture", stopDragging);
  }
}

function syncTimelinePlayheads(): void {
  for (const surface of Array.from(document.querySelectorAll<HTMLElement>(".timeline-scrub-surface"))) {
    const duration = Number(surface.dataset.scrubDuration ?? currentPlayback.duration);
    const left = duration > 0 ? `${(Math.min(currentPlayback.time, duration) / duration) * 100}%` : "0%";
    const playhead = surface.querySelector<HTMLElement>(".timeline-playhead");
    if (playhead) {
      playhead.style.left = left;
      playhead.hidden = Number(surface.dataset.clipIndex ?? currentPlayback.activeClipIndex) !== currentPlayback.activeClipIndex;
    }
  }
}

function condensedKeyTimes(times: number[], duration: number): number[] {
  if (times.length <= 1 || duration <= 0) return times;

  const maxVisible = 240;
  const buckets = new Map<number, number>();
  for (const time of times) {
    const bucket = Math.round((time / duration) * maxVisible);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, time);
    }
  }

  return Array.from(buckets.values()).sort((left, right) => left - right);
}

function animationGroupKey(clip: AnimationTimelineClip, group: AnimationTimelineGroup): string {
  return `animation-group:${clip.id}:${group.id}`;
}

function isAnimationGroupOpen(clip: AnimationTimelineClip, group: AnimationTimelineGroup, index: number): boolean {
  return openDetailState.get(animationGroupKey(clip, group)) ?? (index < 3 || group.trackCount <= 2);
}

function formatFrame(time: number): string {
  return String(Math.max(0, Math.round(time * TIMELINE_FPS))).padStart(4, "0");
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
