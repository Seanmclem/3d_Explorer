import {
  AmbientLight,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  Box3Helper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Clock,
  Color,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  LoadingManager,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Raycaster,
  Scene,
  SkinnedMesh,
  SphereGeometry,
  SRGBColorSpace,
  TOUCH,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF, GLTFReference } from "three/examples/jsm/loaders/GLTFLoader.js";
import type {
  GeometrySelectionInfo,
  LoadedModel,
  LocalAsset,
  MaterialInspectorInfo,
  ModelStats,
  NodeInspectorInfo,
  PlaybackState
} from "./types";
import { LocalAssetLibrary } from "./localAssets";

export type ViewerOptions = {
  canvas: HTMLCanvasElement;
  onPlayback?: (state: PlaybackState) => void;
  onGeometrySelection?: (selection: GeometrySelectionInfo | null) => void;
  onSceneEdited?: () => void;
};

export type EditorMode = "select" | "move" | "rotate" | "scale" | "material";
export type PrimitiveKind = "cube" | "sphere" | "plane" | "light";

type PointerStart = {
  x: number;
  y: number;
  button: number;
};

type GeometryIsland = {
  materialIndex: number;
  materialName: string;
  islandIndex: number;
  islandCount: number;
  faceCount: number;
  vertexCount: number;
  triangleOffsets: number[];
};

type IslandPick = {
  mesh: Mesh;
  faceOffset: number;
  ndcZ: number;
  screenDistance: number;
};

type GeometryGroupRecord = {
  start: number;
  count: number;
  materialIndex?: number;
};

type MeshGroupState = {
  originalGroups: GeometryGroupRecord[];
  originalMaterial: Material | Material[];
  materials: Material[];
  hiddenMaterial: MeshBasicMaterial;
};

type GeometryIslandRecord = {
  info: GeometrySelectionInfo;
  mesh: Mesh;
  triangleOffsets: number[];
};

type TransformSnapshot = {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
};

type EditorCommand =
  | {
      kind: "transform";
      object: Object3D;
      before: TransformSnapshot;
      after: TransformSnapshot;
    }
  | {
      kind: "add";
      object: Object3D;
      parent: Object3D;
    };

type GltfJson = {
  scene?: number;
  scenes?: Array<{
    nodes?: number[];
    extras?: Record<string, unknown>;
  }>;
  nodes?: Array<
    Record<string, unknown> & {
      children?: number[];
      mesh?: number;
    }
  >;
  meshes?: Array<{
    primitives?: Array<Record<string, unknown>>;
  }>;
  materials?: Array<Record<string, unknown>>;
};

type ViewerNodeExtras = {
  id?: string;
  hidden?: boolean;
  hiddenPrimitives?: number[];
  hiddenIslands?: Array<{
    materialIndex: number;
    islandIndex: number;
  }>;
};

type ViewerSceneExtras = {
  hiddenObjectIds?: string[];
  deletedObjectIds?: string[];
};

type GltfMaterialJson = {
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
  };
};

type GltfObjectReference = GLTFReference & {
  primitives?: number;
};

export type GltfSaveResult = {
  text: string;
  hiddenNodes: number;
  deletedNodes: number;
  hiddenIslands: number;
  materialColors: number;
  skippedHiddenNodes: number;
};

const DEFAULT_CAMERA_POSITION = new Vector3(4.5, 3, 6);
const VIEWER_EXTRAS_KEY = "gltfExplorer";

export class GltfViewer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly clock = new Clock();
  private readonly modelGroup = new Group();
  private readonly grid = new GridHelper(10, 20, 0x94a39a, 0x27302b);
  private readonly boundsHelper = new Box3Helper(new Box3(), 0x19c37d);
  private readonly transformControls: TransformControls;
  private readonly onPlayback?: (state: PlaybackState) => void;
  private readonly onGeometrySelection?: (selection: GeometrySelectionInfo | null) => void;
  private readonly onSceneEdited?: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly inspectedNodes = new Map<number, Object3D>();
  private readonly nodeIdsByMesh = new WeakMap<Mesh, number>();
  private readonly highlightHelpers = new Map<number, Object3D>();
  private readonly geometryIslands = new Map<string, GeometryIslandRecord>();
  private readonly meshGroupStates = new Map<Mesh, MeshGroupState>();
  private readonly gltfNodeIndicesByNodeId = new Map<number, number>();
  private readonly gltfPrimitiveRefsByNodeId = new Map<number, { nodeIndex: number; primitiveIndex: number }>();
  private readonly objectPersistentIdsByNodeId = new Map<number, string>();
  private readonly exactGltfNodeIndicesByObject = new Map<Object3D, number>();
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private pointerStart?: PointerStart;
  private islandHighlight?: Object3D;
  private islandHighlightMesh?: Mesh;
  private currentGeometrySelectionId?: string;
  private animationFrame = 0;
  private mixer?: AnimationMixer;
  private clips: AnimationClip[] = [];
  private activeAction?: AnimationAction;
  private activeClipIndex = -1;
  private playbackSpeed = 1;
  private editorMode: EditorMode = "select";
  private selectedObject?: Object3D;
  private transformStart?: TransformSnapshot;
  private indexingHiddenStates?: Map<string, boolean>;
  private gltfJson?: GltfJson;
  private gltfAssociations?: Map<Object3D | Material | Texture, GLTFReference>;
  private readonly undoStack: EditorCommand[] = [];
  private readonly redoStack: EditorCommand[] = [];
  private primitiveCounter = 0;
  private paused = true;
  private wireframe = false;
  private boundsVisible = true;
  private disposed = false;

  constructor(options: ViewerOptions) {
    this.onPlayback = options.onPlayback;
    this.onGeometrySelection = options.onGeometrySelection;
    this.onSceneEdited = options.onSceneEdited;
    this.scene.background = new Color(0x101210);
    this.camera = new PerspectiveCamera(45, 1, 0.01, 2000);
    this.camera.position.copy(DEFAULT_CAMERA_POSITION);

    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      preserveDrawingBuffer: true
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 0.7, 0);
    this.controls.update();

    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.visible = false;
    this.transformControls.addEventListener("dragging-changed", (event) => {
      this.controls.enabled = !(event as { value?: boolean }).value;
    });
    this.transformControls.addEventListener("mouseDown", () => {
      this.transformStart = this.selectedObject ? this.captureTransform(this.selectedObject) : undefined;
    });
    this.transformControls.addEventListener("mouseUp", () => {
      this.commitTransformChange();
    });
    this.scene.add(this.transformControls);

    this.modelGroup.name = "Loaded model";
    this.scene.add(this.modelGroup);

    this.grid.position.y = 0;
    this.scene.add(this.grid);

    this.boundsHelper.visible = false;
    this.scene.add(this.boundsHelper);

    const ambient = new AmbientLight(0xe8fff1, 1.4);
    this.scene.add(ambient);

    const key = new DirectionalLight(0xffffff, 4);
    key.position.set(5, 8, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    this.scene.add(key);

    const fill = new DirectionalLight(0xb9d8ff, 1.3);
    fill.position.set(-4, 5, -3);
    this.scene.add(fill);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.renderer.domElement.parentElement ?? this.renderer.domElement);
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.resize();
    this.tick();
  }

  async loadAsset(asset: LocalAsset, library: LocalAssetLibrary): Promise<LoadedModel> {
    this.clearModel();
    library.revokeObjectUrls();

    const manager = new LoadingManager();
    manager.setURLModifier((url) => library.resolveResourceUrl(asset, url));
    const loader = new GLTFLoader(manager);

    const payload = asset.kind === "gltf" ? await asset.file.text() : await asset.file.arrayBuffer();
    if (asset.kind === "gltf") {
      this.gltfJson = JSON.parse(payload as string) as GltfJson;
    }

    const gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(payload, asset.basePath, resolve, reject);
    });
    this.gltfAssociations = gltf.parser.associations;

    const root = gltf.scene || gltf.scenes[0];
    if (!root) {
      throw new Error("The file loaded, but it did not include a scene.");
    }

    root.traverse((node) => {
      if (node instanceof Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        this.applyWireframe(node, this.wireframe);
      }
    });

    this.modelGroup.add(root);
    this.indexExactGltfNodeMappings(root);
    this.clips = gltf.animations;
    this.mixer = this.clips.length > 0 ? new AnimationMixer(root) : undefined;
    this.activeClipIndex = -1;
    this.activeAction = undefined;
    this.paused = true;

    const stats = this.updateBoundsAndStats(root, gltf.animations.length);
    const nodes = this.describeNodes(root, gltf.animations);
    this.fitCameraToObject(root);

    if (this.clips.length > 0) {
      const idleClipIndex = this.clips.findIndex((clip) => clip.name.toLowerCase().includes("idle"));
      this.playClip(idleClipIndex >= 0 ? idleClipIndex : 0);
      this.setPaused(false);
    } else {
      this.emitPlayback();
    }

    return { clips: this.clips, stats, nodes };
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  setBoundsVisible(visible: boolean): void {
    this.boundsVisible = visible;
    this.boundsHelper.visible = visible && !this.boundsHelper.box.isEmpty();
  }

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    this.modelGroup.traverse((node) => {
      if (node instanceof Mesh) this.applyWireframe(node, enabled);
    });
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
  }

  setPanMode(enabled: boolean): void {
    this.controls.mouseButtons.LEFT = enabled ? MOUSE.PAN : MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = enabled ? MOUSE.ROTATE : MOUSE.PAN;
    this.controls.touches.ONE = enabled ? TOUCH.PAN : TOUCH.ROTATE;
    this.renderer.domElement.dataset.mode = enabled ? "pan" : "orbit";
  }

  setEditorMode(mode: EditorMode): void {
    this.editorMode = mode;
    if (mode === "move") {
      this.transformControls.setMode("translate");
    } else if (mode === "rotate") {
      this.transformControls.setMode("rotate");
    } else if (mode === "scale") {
      this.transformControls.setMode("scale");
    }

    this.syncTransformControls();
  }

  selectNode(nodeId: number | null): boolean {
    const node = nodeId == null ? undefined : this.inspectedNodes.get(nodeId);
    if (nodeId != null && !node) return false;

    this.selectedObject = node;
    this.syncTransformControls();
    return true;
  }

  getSelectedNodeId(): number | undefined {
    if (!this.selectedObject) return undefined;
    for (const [nodeId, node] of this.inspectedNodes.entries()) {
      if (node === this.selectedObject) return nodeId;
    }
    return undefined;
  }

  getNodes(): NodeInspectorInfo[] {
    const root = this.modelGroup.children[0];
    if (!root) return [];
    return this.describeNodes(root, this.clips);
  }

  addPrimitive(kind: PrimitiveKind): NodeInspectorInfo[] {
    const parent = this.ensureEditableRoot();
    const object = this.createPrimitive(kind);
    object.position.copy(this.controls.target);
    parent.add(object);
    this.selectedObject = object;
    this.undoStack.push({ kind: "add", object, parent });
    this.redoStack.length = 0;
    this.syncTransformControls();
    this.onSceneEdited?.();
    return this.getNodes();
  }

  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;

    if (command.kind === "transform") {
      this.applyTransform(command.object, command.before);
    } else if (command.kind === "add") {
      command.object.removeFromParent();
      if (this.selectedObject === command.object) {
        this.selectedObject = undefined;
      }
      this.syncTransformControls();
    }

    this.redoStack.push(command);
    this.onSceneEdited?.();
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;

    if (command.kind === "transform") {
      this.applyTransform(command.object, command.after);
    } else if (command.kind === "add") {
      command.parent.add(command.object);
      this.selectedObject = command.object;
      this.syncTransformControls();
    }

    this.undoStack.push(command);
    this.onSceneEdited?.();
    return true;
  }

  setNodeVisible(nodeId: number, visible: boolean): boolean {
    const node = this.inspectedNodes.get(nodeId);
    if (!node) return false;

    node.userData.__viewerDeleted = false;
    node.visible = visible;
    const highlight = this.highlightHelpers.get(nodeId);
    if (highlight) highlight.visible = visible;
    return true;
  }

  setNodeDeleted(nodeId: number, deleted: boolean): boolean {
    const node = this.inspectedNodes.get(nodeId);
    if (!node) return false;

    node.userData.__viewerDeleted = deleted;
    node.visible = !deleted;
    const highlight = this.highlightHelpers.get(nodeId);
    if (highlight) highlight.visible = node.visible;
    if (deleted && this.currentGeometrySelectionId) {
      const selection = this.geometryIslands.get(this.currentGeometrySelectionId);
      if (selection?.info.nodeId === nodeId) {
        this.clearGeometrySelection();
      }
    }
    return true;
  }

  setNodeHighlighted(nodeId: number, highlighted: boolean): boolean {
    const node = this.inspectedNodes.get(nodeId);
    if (!(node instanceof Mesh)) return false;

    if (!highlighted) {
      this.removeHighlight(nodeId);
      return true;
    }

    const existing = this.highlightHelpers.get(nodeId);
    if (existing) {
      existing.visible = node.visible;
      return true;
    }

    const helper = this.createMeshHighlight(node);
    node.add(helper);
    this.highlightHelpers.set(nodeId, helper);
    return true;
  }

  setMaterialColor(nodeId: number, materialIndex: number, color: string): boolean {
    const node = this.inspectedNodes.get(nodeId);
    if (!(node instanceof Mesh)) return false;

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const material = materials[materialIndex] as (Material & { color?: Color }) | undefined;
    if (!material?.color) return false;

    material.color.set(color);
    material.needsUpdate = true;
    return true;
  }

  clearGeometrySelection(): void {
    this.clearIslandHighlight();
    this.currentGeometrySelectionId = undefined;
    this.onGeometrySelection?.(null);
  }

  getGeometrySelections(): GeometrySelectionInfo[] {
    return this.getGeometryIslands();
  }

  getGeometryIslands(): GeometrySelectionInfo[] {
    return Array.from(this.geometryIslands.values()).map((record) => record.info);
  }

  setGeometrySelectionHidden(selectionId: string, hidden: boolean): boolean {
    const record = this.geometryIslands.get(selectionId);
    if (!record) return false;

    record.info = {
      ...record.info,
      hidden
    };
    this.rebuildHiddenGeometry(record.mesh);

    if (this.currentGeometrySelectionId === selectionId) {
      if (hidden) {
        this.clearIslandHighlight();
      } else {
        this.showIslandHighlight(record.mesh, record.triangleOffsets);
      }
      this.onGeometrySelection?.(record.info);
    }

    return true;
  }

  highlightGeometrySelection(selectionId: string): boolean {
    const record = this.geometryIslands.get(selectionId);
    if (!record) return false;

    this.currentGeometrySelectionId = selectionId;
    this.showIslandHighlight(record.mesh, record.triangleOffsets);
    this.onGeometrySelection?.(record.info);
    return true;
  }

  setPlaybackSpeed(speed: number): void {
    this.playbackSpeed = speed;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (this.activeAction) this.activeAction.paused = paused;
    this.emitPlayback();
  }

  togglePlay(): void {
    this.setPaused(!this.paused);
  }

  playClip(index: number): void {
    if (!this.mixer || !this.clips[index]) return;

    this.mixer.stopAllAction();
    this.activeClipIndex = index;
    this.activeAction = this.mixer.clipAction(this.clips[index]);
    this.activeAction.reset();
    this.activeAction.paused = this.paused;
    this.activeAction.play();
    this.clock.getDelta();
    this.emitPlayback();
  }

  scrub(time: number): void {
    if (!this.mixer || this.activeClipIndex < 0) return;
    const clip = this.clips[this.activeClipIndex];
    const nextTime = Math.min(Math.max(time, 0), clip.duration);
    this.mixer.setTime(nextTime);
    this.emitPlayback(nextTime);
  }

  resetCamera(): void {
    const root = this.modelGroup.children[0];
    if (root) {
      this.fitCameraToObject(root);
    } else {
      this.camera.position.copy(DEFAULT_CAMERA_POSITION);
      this.controls.target.set(0, 0.7, 0);
      this.controls.update();
    }
  }

  unloadModel(): void {
    this.clearModel();
    this.emitPlayback();
  }

  capturePng(): string {
    this.controls.update();
    this.camera.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  async exportCurrentGlb(): Promise<ArrayBuffer> {
    const root = this.modelGroup.children[0];
    if (!root) {
      throw new Error("No model is loaded.");
    }

    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(root, {
      binary: true,
      onlyVisible: true,
      includeCustomExtensions: true
    });

    if (!(result instanceof ArrayBuffer)) {
      throw new Error("The exporter returned JSON instead of a binary GLB.");
    }

    return result;
  }

  async exportCurrentGltfText(): Promise<string> {
    const root = this.modelGroup.children[0];
    if (!root) {
      throw new Error("No model is loaded.");
    }

    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(root, {
      binary: false,
      onlyVisible: true,
      includeCustomExtensions: true
    });

    if (!result || typeof result !== "object" || result instanceof ArrayBuffer) {
      throw new Error("The exporter returned a binary result instead of glTF JSON.");
    }

    return `${JSON.stringify(result, null, 2)}\n`;
  }

  createGltfSaveText(): GltfSaveResult {
    if (!this.gltfJson) {
      throw new Error("Only editable .gltf JSON files can be saved right now. GLB export is not wired yet.");
    }

    const nodeStats = this.syncNodeVisibilityToGltf();
    const hiddenIslands = this.syncIslandVisibilityToGltf();
    const materialColors = this.syncMaterialColorsToGltf();

    return {
      text: `${JSON.stringify(this.gltfJson, null, 2)}\n`,
      hiddenNodes: nodeStats.hiddenNodes,
      deletedNodes: nodeStats.deletedNodes,
      hiddenIslands,
      materialColors,
      skippedHiddenNodes: nodeStats.skippedHiddenNodes
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.clearModel();
    this.resizeObserver.disconnect();
    this.transformControls.dispose();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.renderer.dispose();
  }

  private tick = () => {
    if (this.disposed) return;

    const delta = this.clock.getDelta();
    this.controls.update();

    if (this.mixer && !this.paused) {
      this.mixer.update(delta * this.playbackSpeed);
      this.emitPlayback();
    }

    this.updateIslandHighlightTransform();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private resize(): void {
    const parent = this.renderer.domElement.parentElement;
    const width = Math.max(1, parent?.clientWidth ?? window.innerWidth);
    const height = Math.max(1, parent?.clientHeight ?? window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private clearModel(): void {
    this.transformControls.detach();
    this.transformControls.visible = false;
    this.mixer?.stopAllAction();
    this.mixer = undefined;
    this.clips = [];
    this.activeAction = undefined;
    this.activeClipIndex = -1;
    this.selectedObject = undefined;
    this.transformStart = undefined;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.inspectedNodes.clear();
    this.geometryIslands.clear();
    this.gltfNodeIndicesByNodeId.clear();
    this.gltfPrimitiveRefsByNodeId.clear();
    this.objectPersistentIdsByNodeId.clear();
    this.exactGltfNodeIndicesByObject.clear();
    this.gltfJson = undefined;
    this.gltfAssociations = undefined;
    for (const state of this.meshGroupStates.values()) {
      state.hiddenMaterial.dispose();
    }
    this.meshGroupStates.clear();
    this.currentGeometrySelectionId = undefined;
    this.clearIslandHighlight();
    this.onGeometrySelection?.(null);
    this.clearHighlights();

    while (this.modelGroup.children.length > 0) {
      const child = this.modelGroup.children.pop();
      if (child) this.disposeObject(child);
    }

    this.boundsHelper.box.makeEmpty();
    this.boundsHelper.visible = false;
  }

  private disposeObject(object: Object3D): void {
    object.traverse((node) => {
      if (!(node instanceof Mesh)) return;

      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        this.disposeMaterial(material);
      }
    });
  }

  private disposeMaterial(material: Material): void {
    const materialRecord = material as unknown as Record<string, unknown>;
    for (const value of Object.values(materialRecord)) {
      if (value instanceof Texture) value.dispose();
    }
    material.dispose();
  }

  private ensureEditableRoot(): Object3D {
    const existing = this.modelGroup.children[0];
    if (existing) return existing;

    const root = new Group();
    root.name = "Editor scene";
    this.modelGroup.add(root);
    this.boundsHelper.box.makeEmpty();
    return root;
  }

  private createPrimitive(kind: PrimitiveKind): Object3D {
    this.primitiveCounter += 1;

    if (kind === "light") {
      const light = new PointLight(0xffffff, 4, 10);
      light.name = `Light ${this.primitiveCounter}`;
      light.position.set(this.controls.target.x, this.controls.target.y + 1.5, this.controls.target.z + 1);
      return light;
    }

    const material = new MeshStandardMaterial({
      color: kind === "plane" ? 0x8fb7a2 : kind === "sphere" ? 0x8aa7ff : 0x19c37d,
      roughness: 0.62,
      metalness: 0.05
    });
    const geometry =
      kind === "sphere"
        ? new SphereGeometry(0.5, 32, 16)
        : kind === "plane"
          ? new PlaneGeometry(1.5, 1.5)
          : new BoxGeometry(1, 1, 1);
    geometry.name = `${this.capitalize(kind)}Geometry`;

    const mesh = new Mesh(geometry, material);
    mesh.name = `${this.capitalize(kind)} ${this.primitiveCounter}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.applyWireframe(mesh, this.wireframe);
    if (kind === "plane") {
      mesh.rotation.x = -Math.PI / 2;
    }
    return mesh;
  }

  private syncTransformControls(): void {
    const transformMode = this.editorMode === "move" || this.editorMode === "rotate" || this.editorMode === "scale";
    if (transformMode && this.selectedObject) {
      this.transformControls.attach(this.selectedObject);
      this.transformControls.visible = true;
    } else {
      this.transformControls.detach();
      this.transformControls.visible = false;
    }
  }

  private captureTransform(object: Object3D): TransformSnapshot {
    return {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone()
    };
  }

  private applyTransform(object: Object3D, transform: TransformSnapshot): void {
    object.position.copy(transform.position);
    object.quaternion.copy(transform.quaternion);
    object.scale.copy(transform.scale);
    object.updateMatrixWorld(true);
  }

  private commitTransformChange(): void {
    if (!this.selectedObject || !this.transformStart) return;

    const after = this.captureTransform(this.selectedObject);
    if (
      after.position.distanceTo(this.transformStart.position) < 0.000001 &&
      Math.abs(after.quaternion.dot(this.transformStart.quaternion)) > 0.999999 &&
      after.scale.distanceTo(this.transformStart.scale) < 0.000001
    ) {
      this.transformStart = undefined;
      return;
    }

    this.undoStack.push({
      kind: "transform",
      object: this.selectedObject,
      before: this.transformStart,
      after
    });
    this.redoStack.length = 0;
    this.transformStart = undefined;
    this.updateIslandHighlightTransform();
    this.onSceneEdited?.();
  }

  private capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private applyWireframe(mesh: Mesh, enabled: boolean): void {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const wireMaterial = material as Material & { wireframe?: boolean };
      wireMaterial.wireframe = enabled;
      wireMaterial.needsUpdate = true;
    }
  }

  private syncNodeVisibilityToGltf(): { hiddenNodes: number; deletedNodes: number; skippedHiddenNodes: number } {
    let hiddenNodes = 0;
    let deletedNodes = 0;
    let skippedHiddenNodes = 0;

    this.clearViewerVisibilityExtras();
    const hiddenObjectIds: string[] = [];
    const deletedObjectIds: string[] = [];

    for (const [nodeId, node] of this.inspectedNodes.entries()) {
      const objectId = this.objectPersistentIdsByNodeId.get(nodeId);
      if (!objectId) {
        if (!node.visible || node.userData.__viewerDeleted === true) skippedHiddenNodes += 1;
        continue;
      }

      if (node.userData.__viewerDeleted === true) {
        deletedObjectIds.push(objectId);
        deletedNodes += 1;
        continue;
      }

      if (!node.visible) {
        hiddenObjectIds.push(objectId);
        hiddenNodes += 1;
      }
    }

    const sceneExtras = this.ensureViewerExtrasForScene();
    if (hiddenObjectIds.length > 0) {
      sceneExtras.hiddenObjectIds = hiddenObjectIds;
    }
    if (deletedObjectIds.length > 0) {
      sceneExtras.deletedObjectIds = deletedObjectIds;
    }
    this.cleanupViewerSceneExtras();
    return { hiddenNodes, deletedNodes, skippedHiddenNodes };
  }

  private syncIslandVisibilityToGltf(): number {
    const hiddenByNode = new Map<number, ViewerNodeExtras["hiddenIslands"]>();
    for (const record of this.geometryIslands.values()) {
      if (!record.info.hidden) continue;
      const entries = hiddenByNode.get(record.info.nodeId) ?? [];
      entries.push({
        materialIndex: record.info.materialIndex,
        islandIndex: record.info.islandIndex
      });
      hiddenByNode.set(record.info.nodeId, entries);
    }

    let hiddenIslandCount = 0;
    for (const [nodeId, hiddenIslands] of hiddenByNode.entries()) {
      const nodeIndex = this.gltfNodeIndicesByNodeId.get(nodeId);
      if (nodeIndex == null || !hiddenIslands || hiddenIslands.length === 0) continue;
      this.ensureViewerExtrasForNodeIndex(nodeIndex).hiddenIslands = hiddenIslands;
      hiddenIslandCount += hiddenIslands.length;
    }

    return hiddenIslandCount;
  }

  private clearViewerVisibilityExtras(): void {
    const nodes = this.gltfJson?.nodes;
    if (nodes) {
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const extras = this.viewerExtrasForNodeIndex(nodeIndex);
        if (!extras) continue;
        delete extras.hidden;
        delete extras.hiddenPrimitives;
        delete extras.hiddenIslands;
        this.cleanupViewerExtras(nodeIndex);
      }
    }

    const sceneExtras = this.viewerExtrasForScene();
    if (sceneExtras) {
      delete sceneExtras.hiddenObjectIds;
      delete sceneExtras.deletedObjectIds;
      this.cleanupViewerSceneExtras();
    }
  }

  private syncMaterialColorsToGltf(): number {
    if (!this.gltfJson?.materials || !this.gltfAssociations) return 0;

    let materialColors = 0;
    for (const [target, reference] of this.gltfAssociations.entries()) {
      if (!(target instanceof Material) || typeof reference.materials !== "number") continue;

      const material = target as Material & { color?: Color; opacity?: number };
      if (!(material.color instanceof Color)) continue;

      const gltfMaterial = this.gltfJson.materials[reference.materials] as GltfMaterialJson | undefined;
      if (!gltfMaterial) continue;

      const pbr = gltfMaterial.pbrMetallicRoughness ?? {};
      const previous = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [1, 1, 1, 1];
      pbr.baseColorFactor = [
        Number(material.color.r.toFixed(6)),
        Number(material.color.g.toFixed(6)),
        Number(material.color.b.toFixed(6)),
        typeof material.opacity === "number" ? Number(material.opacity.toFixed(6)) : (previous[3] ?? 1)
      ];
      gltfMaterial.pbrMetallicRoughness = pbr;
      materialColors += 1;
    }

    return materialColors;
  }

  private viewerExtrasForNodeIndex(nodeIndex: number): ViewerNodeExtras | undefined {
    const node = this.gltfJson?.nodes?.[nodeIndex];
    const extras = node?.extras as Record<string, unknown> | undefined;
    const viewerExtras = extras?.[VIEWER_EXTRAS_KEY];
    return viewerExtras && typeof viewerExtras === "object" ? (viewerExtras as ViewerNodeExtras) : undefined;
  }

  private viewerExtrasForScene(): ViewerSceneExtras | undefined {
    const scene = this.gltfJson?.scenes?.[this.gltfJson.scene ?? 0];
    const extras = scene?.extras;
    const viewerExtras = extras?.[VIEWER_EXTRAS_KEY];
    return viewerExtras && typeof viewerExtras === "object" ? (viewerExtras as ViewerSceneExtras) : undefined;
  }

  private ensureViewerExtrasForScene(): ViewerSceneExtras {
    const scene = this.gltfJson?.scenes?.[this.gltfJson.scene ?? 0];
    if (!scene) {
      throw new Error("The selected scene could not be mapped back to the glTF JSON.");
    }

    const extras = ((scene.extras as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    scene.extras = extras;

    const existing = extras[VIEWER_EXTRAS_KEY];
    if (existing && typeof existing === "object") {
      return existing as ViewerSceneExtras;
    }

    const viewerExtras: ViewerSceneExtras = {};
    extras[VIEWER_EXTRAS_KEY] = viewerExtras;
    return viewerExtras;
  }

  private ensureViewerExtrasForNodeIndex(nodeIndex: number): ViewerNodeExtras {
    const node = this.gltfJson?.nodes?.[nodeIndex];
    if (!node) {
      throw new Error("The selected node could not be mapped back to the glTF JSON.");
    }

    const extras = ((node.extras as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    node.extras = extras;

    const existing = extras[VIEWER_EXTRAS_KEY];
    if (existing && typeof existing === "object") {
      return existing as ViewerNodeExtras;
    }

    const viewerExtras: ViewerNodeExtras = {};
    extras[VIEWER_EXTRAS_KEY] = viewerExtras;
    return viewerExtras;
  }

  private cleanupViewerExtras(nodeIndex: number): void {
    const node = this.gltfJson?.nodes?.[nodeIndex];
    const extras = node?.extras as Record<string, unknown> | undefined;
    const viewerExtras = extras?.[VIEWER_EXTRAS_KEY] as ViewerNodeExtras | undefined;
    if (!extras || !viewerExtras) return;

    if (
      !viewerExtras.id &&
      !viewerExtras.hidden &&
      (!viewerExtras.hiddenPrimitives || viewerExtras.hiddenPrimitives.length === 0) &&
      (!viewerExtras.hiddenIslands || viewerExtras.hiddenIslands.length === 0)
    ) {
      delete extras[VIEWER_EXTRAS_KEY];
    }
    if (Object.keys(extras).length === 0 && node) {
      delete node.extras;
    }
  }

  private cleanupViewerSceneExtras(): void {
    const scene = this.gltfJson?.scenes?.[this.gltfJson.scene ?? 0];
    const extras = scene?.extras as Record<string, unknown> | undefined;
    const viewerExtras = extras?.[VIEWER_EXTRAS_KEY] as ViewerSceneExtras | undefined;
    if (!extras || !viewerExtras) return;

    if (
      (!viewerExtras.hiddenObjectIds || viewerExtras.hiddenObjectIds.length === 0) &&
      (!viewerExtras.deletedObjectIds || viewerExtras.deletedObjectIds.length === 0)
    ) {
      delete extras[VIEWER_EXTRAS_KEY];
    }
    if (Object.keys(extras).length === 0 && scene) {
      delete scene.extras;
    }
  }

  private ensurePersistentObjectId(node: Object3D, gltfNodeIndex?: number, primitiveIndex?: number): string {
    if (typeof gltfNodeIndex === "number") {
      const extras = this.ensureViewerExtrasForNodeIndex(gltfNodeIndex);
      if (!extras.id) {
        extras.id = this.createViewerObjectId("node");
      }
      return typeof primitiveIndex === "number" ? `${extras.id}:primitive:${primitiveIndex}` : extras.id;
    }

    const existing = node.userData.__viewerObjectId;
    if (typeof existing === "string" && existing.length > 0) {
      return existing;
    }

    const nextId = this.createViewerObjectId("local");
    node.userData.__viewerObjectId = nextId;
    return nextId;
  }

  private createViewerObjectId(kind: "node" | "primitive" | "local"): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `gltfexplorer:${kind}:${crypto.randomUUID()}`;
    }

    return `gltfexplorer:${kind}:${Math.random().toString(36).slice(2, 10)}`;
  }


  private savedIslandHidden(nodeId: number, materialIndex: number, islandIndex: number): boolean {
    const nodeIndex = this.gltfNodeIndicesByNodeId.get(nodeId);
    if (nodeIndex == null) return false;

    return Boolean(
      this.viewerExtrasForNodeIndex(nodeIndex)?.hiddenIslands?.some(
        (island) => island.materialIndex === materialIndex && island.islandIndex === islandIndex
      )
    );
  }

  private gltfNodeIndexForObject(nodeId: number, node: Object3D): number | undefined {
    const associated = this.gltfNodeIndicesByNodeId.get(nodeId);
    if (associated != null) return associated;

    const linked = this.associatedGltfNodeIndex(node);
    if (linked != null) return linked;

    if (!node.name || !this.gltfJson?.nodes) return undefined;

    const matchingIndices = this.gltfJson.nodes
      .map((gltfNode, index) => (gltfNode.name === node.name ? index : -1))
      .filter((index) => index >= 0);

    return matchingIndices.length === 1 ? matchingIndices[0] : undefined;
  }

  private exactGltfNodeIndexForObject(nodeId: number, node: Object3D): number | undefined {
    const exact = this.exactGltfNodeIndicesByObject.get(node);
    if (exact != null) return exact;

    const associated = this.gltfAssociations?.get(node)?.nodes;
    if (typeof associated === "number") return associated;

    if (!node.name || !this.gltfJson?.nodes) return undefined;

    const matchingIndices = this.gltfJson.nodes
      .map((gltfNode, index) => (gltfNode.name === node.name ? index : -1))
      .filter((index) => index >= 0);

    return matchingIndices.length === 1 ? matchingIndices[0] : undefined;
  }

  private associatedGltfNodeIndex(node: Object3D): number | undefined {
    let current: Object3D | null = node;

    while (current) {
      const mapped = this.exactGltfNodeIndicesByObject.get(current);
      if (mapped != null) {
        return mapped;
      }
      current = current.parent;
    }

    return undefined;
  }

  private indexExactGltfNodeMappings(root: Object3D): void {
    this.exactGltfNodeIndicesByObject.clear();

    const sceneIndex = this.gltfJson?.scene ?? 0;
    const sceneNodes = this.gltfJson?.scenes?.[sceneIndex]?.nodes ?? [];
    if (sceneNodes.length === 0) return;

    for (let index = 0; index < sceneNodes.length; index += 1) {
      const object = root.children[index];
      const nodeIndex = sceneNodes[index];
      if (!object || nodeIndex == null) continue;
      this.mapExactGltfNode(object, nodeIndex);
    }
  }

  private mapExactGltfNode(object: Object3D, nodeIndex: number): void {
    this.exactGltfNodeIndicesByObject.set(object, nodeIndex);

    const childNodeIndices = this.gltfJson?.nodes?.[nodeIndex]?.children ?? [];
    if (childNodeIndices.length === 0) return;

    const startIndex = object.children.length - childNodeIndices.length;
    if (startIndex < 0) return;

    for (let index = 0; index < childNodeIndices.length; index += 1) {
      const childObject = object.children[startIndex + index];
      const childNodeIndex = childNodeIndices[index];
      if (!childObject || childNodeIndex == null) continue;
      this.mapExactGltfNode(childObject, childNodeIndex);
    }
  }

  private associatedPrimitiveRef(node: Object3D): { nodeIndex: number; primitiveIndex: number } | undefined {
    const primitiveIndex = (this.gltfAssociations?.get(node) as GltfObjectReference | undefined)?.primitives;
    if (typeof primitiveIndex !== "number") return undefined;

    const nodeIndex = this.associatedGltfNodeIndex(node);
    if (nodeIndex == null) return undefined;

    return { nodeIndex, primitiveIndex };
  }

  private describeNodes(root: Object3D, clips: AnimationClip[]): NodeInspectorInfo[] {
    const previousVisibility = new Map(
      Array.from(this.inspectedNodes.values()).map((node) => [node, node.visible])
    );
    const savedHiddenObjectIds = new Set(this.viewerExtrasForScene()?.hiddenObjectIds ?? []);
    const savedDeletedObjectIds = new Set(this.viewerExtrasForScene()?.deletedObjectIds ?? []);
    this.indexingHiddenStates = new Map(
      Array.from(this.geometryIslands.values()).map((record) => [record.info.id, record.info.hidden])
    );
    this.inspectedNodes.clear();
    this.geometryIslands.clear();
    this.gltfNodeIndicesByNodeId.clear();
    this.gltfPrimitiveRefsByNodeId.clear();
    this.objectPersistentIdsByNodeId.clear();
    const animationTargets = this.animationTargetNames(clips);
    const depths = new Map<Object3D, number>();
    const nodes: NodeInspectorInfo[] = [];
    let id = 0;

    depths.set(root, 0);
    root.traverse((node) => {
      const depth = depths.get(node) ?? 0;
      for (const child of node.children) {
        depths.set(child, depth + 1);
      }

      const gltfNodeIndex = this.associatedGltfNodeIndex(node);
      const primitiveRef = this.associatedPrimitiveRef(node);
      const objectPersistentId = this.ensurePersistentObjectId(node, primitiveRef?.nodeIndex ?? gltfNodeIndex, primitiveRef?.primitiveIndex);
      const hasImportedIdentity = primitiveRef != null || typeof gltfNodeIndex === "number";
      const previousVisible = previousVisibility.get(node);
      if (previousVisible != null) {
        node.visible = previousVisible;
      } else if (savedDeletedObjectIds.has(objectPersistentId)) {
        node.userData.__viewerDeleted = true;
        node.visible = false;
      } else if (savedHiddenObjectIds.has(objectPersistentId)) {
        node.userData.__viewerDeleted = false;
        node.visible = false;
      } else {
        node.userData.__viewerDeleted = false;
      }

      const materials = node instanceof Mesh ? this.describeMaterials(node) : [];
      const transform = this.describeTransform(node);
      const tags = this.describeNodeTags(node, animationTargets, materials);
      const geometry = node instanceof Mesh ? this.describeGeometry(node) : undefined;

      const nodeId = id++;
      this.inspectedNodes.set(nodeId, node);
      if (hasImportedIdentity) {
        this.objectPersistentIdsByNodeId.set(nodeId, objectPersistentId);
      }
      if (typeof gltfNodeIndex === "number") {
        this.gltfNodeIndicesByNodeId.set(nodeId, gltfNodeIndex);
      }
      if (primitiveRef) {
        this.gltfPrimitiveRefsByNodeId.set(nodeId, primitiveRef);
      }
      if (node instanceof Mesh) {
        this.nodeIdsByMesh.set(node, nodeId);
        this.indexGeometryIslands(node, nodeId);
      }

      nodes.push({
        id: nodeId,
        depth,
        name: node.name || "(unnamed)",
        type: node.type,
        deleted: node.userData.__viewerDeleted === true,
        visible: node.visible,
        childCount: node.children.length,
        tags,
        transform,
        geometry,
        materials
      });
    });

    this.indexingHiddenStates = undefined;
    return nodes;
  }

  private describeNodeTags(
    node: Object3D,
    animationTargets: Set<string>,
    materials: MaterialInspectorInfo[]
  ): string[] {
    const tags: string[] = [];
    if (node instanceof Mesh) tags.push("mesh");
    if ("isSkinnedMesh" in node && node.isSkinnedMesh) tags.push("skinned");
    if (animationTargets.has(node.name)) tags.push("animated");
    if (materials.length > 0) tags.push(`${materials.length} material${materials.length === 1 ? "" : "s"}`);
    if (node.userData.__viewerDeleted === true) tags.push("deleted");
    if (!node.visible) tags.push("hidden");
    if (node.children.length > 0) tags.push(`${node.children.length} child${node.children.length === 1 ? "" : "ren"}`);
    return tags;
  }

  private describeGeometry(mesh: Mesh): NodeInspectorInfo["geometry"] {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");

    return {
      name: geometry.name || "Geometry",
      vertices: position?.count ?? 0,
      attributes: Object.keys(geometry.attributes),
      indexed: Boolean(geometry.index)
    };
  }

  private describeMaterials(mesh: Mesh): MaterialInspectorInfo[] {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return materials.map((material, index) => {
      const materialRecord = material as Material & Record<string, unknown>;
      const color = materialRecord.color instanceof Color ? `#${materialRecord.color.getHexString()}` : undefined;
      const textureSlots = [
        "map",
        "normalMap",
        "roughnessMap",
        "metalnessMap",
        "emissiveMap",
        "aoMap",
        "alphaMap"
      ].filter((slot) => materialRecord[slot] instanceof Texture);

      return {
        index,
        name: material.name || "Unnamed material",
        type: material.type,
        color,
        opacity: typeof materialRecord.opacity === "number" ? materialRecord.opacity : undefined,
        metalness: typeof materialRecord.metalness === "number" ? materialRecord.metalness : undefined,
        roughness: typeof materialRecord.roughness === "number" ? materialRecord.roughness : undefined,
        transparent: material.transparent,
        side: this.materialSideLabel(material.side),
        textureSlots,
        vertexColors: Boolean(material.vertexColors)
      };
    });
  }

  private describeTransform(node: Object3D): string[] {
    const transform: string[] = [];
    if (node.position.lengthSq() > 0.000001) {
      transform.push(`pos ${node.position.x.toFixed(2)}, ${node.position.y.toFixed(2)}, ${node.position.z.toFixed(2)}`);
    }
    if (Math.abs(node.rotation.x) > 0.000001 || Math.abs(node.rotation.y) > 0.000001 || Math.abs(node.rotation.z) > 0.000001) {
      transform.push(`rot ${node.rotation.x.toFixed(2)}, ${node.rotation.y.toFixed(2)}, ${node.rotation.z.toFixed(2)}`);
    }
    if (Math.abs(node.scale.x - 1) > 0.000001 || Math.abs(node.scale.y - 1) > 0.000001 || Math.abs(node.scale.z - 1) > 0.000001) {
      transform.push(`scale ${node.scale.x.toFixed(2)}, ${node.scale.y.toFixed(2)}, ${node.scale.z.toFixed(2)}`);
    }
    return transform;
  }

  private animationTargetNames(clips: AnimationClip[]): Set<string> {
    const names = new Set<string>();
    const targetSuffix = /\.(position|quaternion|rotation|scale|morphTargetInfluences)(\.|$|\[)/;

    for (const clip of clips) {
      for (const track of clip.tracks) {
        const match = targetSuffix.exec(track.name);
        if (match?.index && match.index > 0) {
          names.add(track.name.slice(0, match.index));
        }
      }
    }

    return names;
  }

  private materialSideLabel(side: number): string {
    if (side === 0) return "front";
    if (side === 1) return "back";
    if (side === 2) return "double";
    return `side ${side}`;
  }

  private removeHighlight(nodeId: number): void {
    const helper = this.highlightHelpers.get(nodeId);
    if (!helper) return;

    helper.removeFromParent();
    helper.traverse((node) => {
      if (!(node instanceof Mesh || node instanceof LineSegments)) return;
      node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        material.dispose();
      }
    });
    this.highlightHelpers.delete(nodeId);
  }

  private createMeshHighlight(mesh: Mesh): Object3D {
    const group = new Group();
    group.name = `${mesh.name || "mesh"} highlight`;
    group.visible = mesh.visible;
    group.renderOrder = 10;

    const edges = new LineSegments(
      new EdgesGeometry(mesh.geometry, 20),
      new LineBasicMaterial({
        color: 0xffd166,
        depthTest: false,
        transparent: true,
        opacity: 0.95
      })
    );
    edges.renderOrder = 10;
    group.add(edges);

    const wire = new Mesh(
      mesh.geometry,
      new MeshBasicMaterial({
        color: 0xffd166,
        wireframe: true,
        depthTest: false,
        transparent: true,
        opacity: 0.22
      })
    );
    wire.renderOrder = 9;
    group.add(wire);

    return group;
  }

  private selectGeometryIsland(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    const meshes = Array.from(this.inspectedNodes.values()).filter((node): node is Mesh => node instanceof Mesh && node.visible);
    const [hit] = this.raycaster.intersectObjects(meshes, false);
    const rayPick =
      hit && hit.object instanceof Mesh && hit.faceIndex != null && !this.isTriangleHidden(hit.object, hit.faceIndex * 3)
        ? {
            mesh: hit.object,
            faceOffset: hit.faceIndex * 3,
            ndcZ: hit.point.clone().project(this.camera).z,
            screenDistance: 0
          }
        : undefined;
    const screenPick = this.pickProjectedTriangle(clientX, clientY, meshes, rect);
    const pick =
      screenPick && (!rayPick || screenPick.screenDistance < 1 || screenPick.ndcZ <= rayPick.ndcZ + 0.015)
        ? screenPick
        : rayPick;

    if (!pick) {
      this.clearGeometrySelection();
      return;
    }

    const nodeId = this.nodeIdsByMesh.get(pick.mesh);
    if (nodeId == null) {
      this.clearGeometrySelection();
      return;
    }

    const record = this.findGeometryIslandAtOffset(pick.mesh, pick.faceOffset);
    if (!record) {
      this.clearGeometrySelection();
      return;
    }

    this.currentGeometrySelectionId = record.info.id;
    this.showIslandHighlight(pick.mesh, record.triangleOffsets);
    this.onGeometrySelection?.(record.info);
  }

  private findGeometryIslandAtOffset(mesh: Mesh, clickedOffset: number): GeometryIslandRecord | undefined {
    const record = Array.from(this.geometryIslands.values()).find(
      (island) => island.mesh === mesh && island.triangleOffsets.includes(clickedOffset)
    );
    if (record) return record;

    const nodeId = this.nodeIdsByMesh.get(mesh);
    if (nodeId == null) return undefined;
    this.indexGeometryIslands(mesh, nodeId);
    return Array.from(this.geometryIslands.values()).find(
      (island) => island.mesh === mesh && island.triangleOffsets.includes(clickedOffset)
    );
  }

  private indexGeometryIslands(mesh: Mesh, nodeId: number): void {
    for (const [id, record] of Array.from(this.geometryIslands.entries())) {
      if (record.mesh === mesh) {
        this.geometryIslands.delete(id);
      }
    }

    const islands = this.buildGeometryIslands(mesh);
    let hasHiddenIsland = false;
    for (const island of islands) {
      const id = `${nodeId}:${island.materialIndex}:${island.islandIndex}`;
      const hidden =
        this.indexingHiddenStates?.get(id) ?? this.savedIslandHidden(nodeId, island.materialIndex, island.islandIndex);
      hasHiddenIsland ||= hidden;
      this.geometryIslands.set(id, {
        info: {
          id,
          nodeId,
          nodeName: mesh.name || "(unnamed)",
          materialIndex: island.materialIndex,
          materialName: island.materialName,
          islandIndex: island.islandIndex,
          islandCount: island.islandCount,
          faceCount: island.faceCount,
          vertexCount: island.vertexCount,
          hidden
        },
        mesh,
        triangleOffsets: island.triangleOffsets
      });
    }

    if (hasHiddenIsland) {
      this.rebuildHiddenGeometry(mesh);
    }
  }

  private buildGeometryIslands(mesh: Mesh): GeometryIsland[] {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (!position) return [];

    const index = geometry.index;
    const totalEntries = index?.count ?? position.count;
    const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: totalEntries, materialIndex: 0 }];
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const islands: GeometryIsland[] = [];

    for (const group of groups) {
      const groupStart = group.start;
      const groupEnd = group.start + group.count;
      const triangleOffsets: number[] = [];
      const weldedIds = new Map<string, number>();
      const vertexIds = new Map<number, number>();

      const sourceVertex = (entry: number) => index?.getX(entry) ?? entry;
      const weldedIdFor = (vertexIndex: number): number => {
        const existing = vertexIds.get(vertexIndex);
        if (existing != null) return existing;

        const key = [
          Math.round(position.getX(vertexIndex) * 10000),
          Math.round(position.getY(vertexIndex) * 10000),
          Math.round(position.getZ(vertexIndex) * 10000)
        ].join(",");
        let id = weldedIds.get(key);
        if (id == null) {
          id = weldedIds.size;
          weldedIds.set(key, id);
        }
        vertexIds.set(vertexIndex, id);
        return id;
      };

      for (let offset = groupStart; offset < groupEnd; offset += 3) {
        triangleOffsets.push(offset);
        weldedIdFor(sourceVertex(offset));
        weldedIdFor(sourceVertex(offset + 1));
        weldedIdFor(sourceVertex(offset + 2));
      }

      const triangleVertexIds = triangleOffsets.map((offset) => [
        weldedIdFor(sourceVertex(offset)),
        weldedIdFor(sourceVertex(offset + 1)),
        weldedIdFor(sourceVertex(offset + 2))
      ]);
      const vertexToTriangles = new Map<number, number[]>();
      triangleVertexIds.forEach((ids, triangleIndex) => {
        for (const id of ids) {
          const entries = vertexToTriangles.get(id) ?? [];
          entries.push(triangleIndex);
          vertexToTriangles.set(id, entries);
        }
      });

      const components: number[][] = [];
      const visited = new Set<number>();
      for (let start = 0; start < triangleOffsets.length; start += 1) {
        if (visited.has(start)) continue;

        const component: number[] = [];
        const queue = [start];
        visited.add(start);
        while (queue.length > 0) {
          const triangleIndex = queue.shift();
          if (triangleIndex == null) continue;
          component.push(triangleIndex);

          for (const vertexId of triangleVertexIds[triangleIndex]) {
            for (const neighbor of vertexToTriangles.get(vertexId) ?? []) {
              if (visited.has(neighbor)) continue;
              visited.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
        components.push(component);
      }

      const materialIndex = group.materialIndex ?? 0;
      const material = materials[materialIndex];
      components.forEach((component, componentIndex) => {
        const selectedOffsets = component.flatMap((triangleIndex) => {
          const offset = triangleOffsets[triangleIndex];
          return offset == null ? [] : [offset];
        });
        const selectedVertices = new Set<number>();
        for (const offset of selectedOffsets) {
          selectedVertices.add(weldedIdFor(sourceVertex(offset)));
          selectedVertices.add(weldedIdFor(sourceVertex(offset + 1)));
          selectedVertices.add(weldedIdFor(sourceVertex(offset + 2)));
        }

        islands.push({
          materialIndex,
          materialName: material?.name || `Material ${materialIndex + 1}`,
          islandIndex: componentIndex + 1,
          islandCount: components.length,
          faceCount: selectedOffsets.length,
          vertexCount: selectedVertices.size,
          triangleOffsets: selectedOffsets
        });
      });
    }

    return islands;
  }

  private pickProjectedTriangle(
    clientX: number,
    clientY: number,
    meshes: Mesh[],
    rect: DOMRect
  ): IslandPick | undefined {
    let best: IslandPick | undefined;
    const threshold = 14;
    const point = new Vector2(clientX, clientY);

    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const position = geometry.getAttribute("position");
      if (!position) continue;

      const index = geometry.index;
      const totalEntries = index?.count ?? position.count;
      const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: totalEntries }];

      for (const group of groups) {
        for (let offset = group.start; offset < group.start + group.count; offset += 3) {
          if (this.isTriangleHidden(mesh, offset)) continue;

          const a = this.projectVertexToScreen(mesh, index?.getX(offset) ?? offset, rect);
          const b = this.projectVertexToScreen(mesh, index?.getX(offset + 1) ?? offset + 1, rect);
          const c = this.projectVertexToScreen(mesh, index?.getX(offset + 2) ?? offset + 2, rect);
          if (!a || !b || !c) continue;

          const distance = this.pointTriangleDistance(point, a.screen, b.screen, c.screen);
          if (distance > threshold) continue;

          const ndcZ = Math.min(a.ndcZ, b.ndcZ, c.ndcZ);
          if (
            !best ||
            distance < best.screenDistance - 0.5 ||
            (Math.abs(distance - best.screenDistance) <= 0.5 && ndcZ < best.ndcZ)
          ) {
            best = {
              mesh,
              faceOffset: offset,
              ndcZ,
              screenDistance: distance
            };
          }
        }
      }
    }

    return best;
  }

  private isTriangleHidden(mesh: Mesh, offset: number): boolean {
    for (const record of this.geometryIslands.values()) {
      if (record.mesh === mesh && record.info.hidden && record.triangleOffsets.includes(offset)) {
        return true;
      }
    }
    return false;
  }

  private projectVertexToScreen(
    mesh: Mesh,
    vertexIndex: number,
    rect: DOMRect
  ): { screen: Vector2; ndcZ: number } | undefined {
    const position = mesh.geometry.getAttribute("position") as BufferAttribute | undefined;
    if (!position || vertexIndex < 0 || vertexIndex >= position.count) return undefined;

    const vertex = new Vector3().fromBufferAttribute(position, vertexIndex);
    if (mesh instanceof SkinnedMesh) {
      mesh.applyBoneTransform(vertexIndex, vertex);
    }
    mesh.localToWorld(vertex);
    vertex.project(this.camera);
    if (vertex.z < -1 || vertex.z > 1) return undefined;

    return {
      screen: new Vector2(((vertex.x + 1) / 2) * rect.width + rect.left, ((-vertex.y + 1) / 2) * rect.height + rect.top),
      ndcZ: vertex.z
    };
  }

  private pointTriangleDistance(point: Vector2, a: Vector2, b: Vector2, c: Vector2): number {
    if (this.pointInTriangle(point, a, b, c)) return 0;
    return Math.min(
      this.pointSegmentDistance(point, a, b),
      this.pointSegmentDistance(point, b, c),
      this.pointSegmentDistance(point, c, a)
    );
  }

  private pointInTriangle(point: Vector2, a: Vector2, b: Vector2, c: Vector2): boolean {
    const area = (p1: Vector2, p2: Vector2, p3: Vector2) =>
      (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = area(point, a, b);
    const d2 = area(point, b, c);
    const d3 = area(point, c, a);
    const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNegative && hasPositive);
  }

  private pointSegmentDistance(point: Vector2, a: Vector2, b: Vector2): number {
    const segment = b.clone().sub(a);
    const lengthSq = segment.lengthSq();
    if (lengthSq === 0) return point.distanceTo(a);

    const t = Math.max(0, Math.min(1, point.clone().sub(a).dot(segment) / lengthSq));
    return point.distanceTo(a.clone().add(segment.multiplyScalar(t)));
  }

  private showIslandHighlight(mesh: Mesh, triangleOffsets: number[]): void {
    this.clearIslandHighlight();

    const geometry = this.createIslandGeometry(mesh.geometry, triangleOffsets);
    const solid = this.createIslandRenderable(
      mesh,
      geometry,
      new MeshBasicMaterial({
        color: 0x19c37d,
        depthTest: false,
        transparent: true,
        opacity: 0.26
      })
    );
    const wire = this.createIslandRenderable(
      mesh,
      geometry,
      new MeshBasicMaterial({
        color: 0xffd166,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
        wireframe: true
      })
    );
    const group = new Group();
    group.name = "Geometry island selection";
    group.renderOrder = 20;
    solid.renderOrder = 20;
    wire.renderOrder = 21;
    group.add(solid, wire);

    (mesh.parent ?? this.scene).add(group);
    group.position.copy(mesh.position);
    group.quaternion.copy(mesh.quaternion);
    group.scale.copy(mesh.scale);
    this.islandHighlight = group;
    this.islandHighlightMesh = mesh;
  }

  private updateIslandHighlightTransform(): void {
    if (!this.islandHighlight || !this.islandHighlightMesh) return;

    this.islandHighlight.position.copy(this.islandHighlightMesh.position);
    this.islandHighlight.quaternion.copy(this.islandHighlightMesh.quaternion);
    this.islandHighlight.scale.copy(this.islandHighlightMesh.scale);
  }

  private rebuildHiddenGeometry(mesh: Mesh): void {
    const state = this.ensureMeshGroupState(mesh);
    const hiddenOffsets = new Set<number>();

    for (const record of this.geometryIslands.values()) {
      if (record.mesh !== mesh || !record.info.hidden) continue;
      for (const offset of record.triangleOffsets) {
        hiddenOffsets.add(offset);
      }
    }

    const geometry = mesh.geometry;
    geometry.clearGroups();

    if (hiddenOffsets.size === 0) {
      for (const group of state.originalGroups) {
        geometry.addGroup(group.start, group.count, group.materialIndex ?? 0);
      }
      mesh.material = state.originalMaterial;
      return;
    }

    const hiddenMaterialIndex = state.materials.length;
    mesh.material = [...state.materials, state.hiddenMaterial];

    for (const group of state.originalGroups) {
      const groupEnd = group.start + group.count;
      let runStart = group.start;
      let runHidden = hiddenOffsets.has(group.start);

      for (let offset = group.start + 3; offset < groupEnd; offset += 3) {
        const isHidden = hiddenOffsets.has(offset);
        if (isHidden === runHidden) continue;

        this.addGeometryGroup(geometry, runStart, offset - runStart, runHidden ? hiddenMaterialIndex : group.materialIndex ?? 0);
        runStart = offset;
        runHidden = isHidden;
      }

      this.addGeometryGroup(geometry, runStart, groupEnd - runStart, runHidden ? hiddenMaterialIndex : group.materialIndex ?? 0);
    }
  }

  private ensureMeshGroupState(mesh: Mesh): MeshGroupState {
    const existing = this.meshGroupStates.get(mesh);
    if (existing) return existing;

    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    const totalEntries = geometry.index?.count ?? position?.count ?? 0;
    const originalGroups =
      geometry.groups.length > 0
        ? geometry.groups.map((group) => ({
            start: group.start,
            count: group.count,
            materialIndex: group.materialIndex
          }))
        : [
            {
              start: 0,
              count: totalEntries,
              materialIndex: 0
            }
          ];
    const materials = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
    const state: MeshGroupState = {
      originalGroups,
      originalMaterial: mesh.material,
      materials,
      hiddenMaterial: new MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false
      })
    };

    this.meshGroupStates.set(mesh, state);
    return state;
  }

  private addGeometryGroup(geometry: BufferGeometry, start: number, count: number, materialIndex: number): void {
    if (count <= 0) return;
    geometry.addGroup(start, count, materialIndex);
  }

  private createIslandGeometry(source: BufferGeometry, triangleOffsets: number[]): BufferGeometry {
    const index = source.index;
    const sourceVertex = (entry: number) => index?.getX(entry) ?? entry;
    const geometry = new BufferGeometry();
    const attributeNames = Object.keys(source.attributes).filter((name) =>
      ["position", "normal", "skinIndex", "skinWeight"].includes(name)
    );

    for (const name of attributeNames) {
      const attribute = source.getAttribute(name) as BufferAttribute | undefined;
      if (!attribute) continue;

      const values: number[] = [];
      for (const offset of triangleOffsets) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertexIndex = sourceVertex(offset + corner);
          for (let item = 0; item < attribute.itemSize; item += 1) {
            values.push(attribute.getComponent(vertexIndex, item));
          }
        }
      }
      geometry.setAttribute(name, new BufferAttribute(new Float32Array(values), attribute.itemSize));
    }

    return geometry;
  }

  private createIslandRenderable(mesh: Mesh, geometry: BufferGeometry, material: MeshBasicMaterial): Mesh {
    if (mesh instanceof SkinnedMesh) {
      const helper = new SkinnedMesh(geometry, material);
      helper.bind(mesh.skeleton, mesh.bindMatrix);
      return helper;
    }
    return new Mesh(geometry, material);
  }

  private clearIslandHighlight(): void {
    if (!this.islandHighlight) return;

    this.islandHighlight.removeFromParent();
    this.islandHighlight.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        material.dispose();
      }
    });
    this.islandHighlight = undefined;
    this.islandHighlightMesh = undefined;
  }

  private clearHighlights(): void {
    for (const nodeId of Array.from(this.highlightHelpers.keys())) {
      this.removeHighlight(nodeId);
    }
  }

  private updateBoundsAndStats(root: Object3D, animationCount: number): ModelStats {
    root.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());

    root.position.sub(center);
    root.updateWorldMatrix(true, true);

    const centeredBox = new Box3().setFromObject(root);
    this.boundsHelper.box.copy(centeredBox);
    this.boundsHelper.visible = this.boundsVisible;

    const materialSet = new Set<string>();
    const textureSet = new Set<string>();
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;

    root.traverse((node) => {
      if (!(node instanceof Mesh)) return;

      meshes += 1;
      const geometry = node.geometry;
      const position = geometry.getAttribute("position");
      vertices += position?.count ?? 0;
      triangles += geometry.index ? geometry.index.count / 3 : (position?.count ?? 0) / 3;

      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        materialSet.add(material.uuid);
        const materialRecord = material as unknown as Record<string, unknown>;
        for (const value of Object.values(materialRecord)) {
          if (value instanceof Texture) textureSet.add(value.uuid);
        }
      }
    });

    return {
      meshes,
      materials: materialSet.size,
      textures: textureSet.size,
      triangles: Math.round(triangles),
      vertices,
      animations: animationCount,
      bounds: `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`
    };
  }

  private fitCameraToObject(root: Object3D): void {
    root.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(root);
    if (box.isEmpty()) {
      this.resetCamera();
      return;
    }

    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 0.1);
    const distance = maxSize / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const direction = new Vector3(0.75, 0.45, 1).normalize();

    this.controls.target.copy(center);
    this.camera.near = Math.max(distance / 100, 0.01);
    this.camera.far = Math.max(distance * 100, 100);
    this.camera.position.copy(center).add(direction.multiplyScalar(distance * 1.8));
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private emitPlayback(explicitTime?: number): void {
    if (!this.onPlayback) return;

    const clip = this.activeClipIndex >= 0 ? this.clips[this.activeClipIndex] : undefined;
    const duration = clip?.duration ?? 0;
    const time = explicitTime ?? (duration > 0 && this.mixer ? this.mixer.time % duration : 0);

    this.onPlayback({
      activeClipIndex: this.activeClipIndex,
      clipName: clip?.name ?? "No animation",
      duration,
      time,
      isPlaying: Boolean(this.activeAction && !this.paused)
    });
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(this.animationFrame);
  };

  private handleContextRestored = () => {
    this.clock.getDelta();
    this.tick();
  };

  private handlePointerDown = (event: PointerEvent) => {
    this.pointerStart = {
      x: event.clientX,
      y: event.clientY,
      button: event.button
    };
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (!this.pointerStart || this.pointerStart.button !== 0 || event.button !== 0) return;

    const distance = Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y);
    this.pointerStart = undefined;
    if (distance > 4) return;

    this.selectGeometryIsland(event.clientX, event.clientY);
  };
}
