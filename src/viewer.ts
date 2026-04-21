import {
  AmbientLight,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  Box3Helper,
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
  MOUSE,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  TOUCH,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
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
};

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

const DEFAULT_CAMERA_POSITION = new Vector3(4.5, 3, 6);

export class GltfViewer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly clock = new Clock();
  private readonly modelGroup = new Group();
  private readonly grid = new GridHelper(10, 20, 0x94a39a, 0x27302b);
  private readonly boundsHelper = new Box3Helper(new Box3(), 0x19c37d);
  private readonly onPlayback?: (state: PlaybackState) => void;
  private readonly onGeometrySelection?: (selection: GeometrySelectionInfo | null) => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly inspectedNodes = new Map<number, Object3D>();
  private readonly nodeIdsByMesh = new WeakMap<Mesh, number>();
  private readonly highlightHelpers = new Map<number, Object3D>();
  private readonly geometryIslands = new Map<string, GeometryIslandRecord>();
  private readonly meshGroupStates = new Map<Mesh, MeshGroupState>();
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private pointerStart?: PointerStart;
  private islandHighlight?: Object3D;
  private currentGeometrySelectionId?: string;
  private animationFrame = 0;
  private mixer?: AnimationMixer;
  private clips: AnimationClip[] = [];
  private activeAction?: AnimationAction;
  private activeClipIndex = -1;
  private playbackSpeed = 1;
  private paused = true;
  private wireframe = false;
  private boundsVisible = true;
  private disposed = false;

  constructor(options: ViewerOptions) {
    this.onPlayback = options.onPlayback;
    this.onGeometrySelection = options.onGeometrySelection;
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
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(payload, asset.basePath, resolve, reject);
    });

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

  setNodeVisible(nodeId: number, visible: boolean): boolean {
    const node = this.inspectedNodes.get(nodeId);
    if (!node) return false;

    node.visible = visible;
    const highlight = this.highlightHelpers.get(nodeId);
    if (highlight) highlight.visible = visible;
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

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.clearModel();
    this.resizeObserver.disconnect();
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
    this.mixer?.stopAllAction();
    this.mixer = undefined;
    this.clips = [];
    this.activeAction = undefined;
    this.activeClipIndex = -1;
    this.inspectedNodes.clear();
    this.geometryIslands.clear();
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

  private applyWireframe(mesh: Mesh, enabled: boolean): void {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const wireMaterial = material as Material & { wireframe?: boolean };
      wireMaterial.wireframe = enabled;
      wireMaterial.needsUpdate = true;
    }
  }

  private describeNodes(root: Object3D, clips: AnimationClip[]): NodeInspectorInfo[] {
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

      const materials = node instanceof Mesh ? this.describeMaterials(node) : [];
      const transform = this.describeTransform(node);
      const tags = this.describeNodeTags(node, animationTargets, materials);
      const geometry = node instanceof Mesh ? this.describeGeometry(node) : undefined;

      const nodeId = id++;
      this.inspectedNodes.set(nodeId, node);
      if (node instanceof Mesh) {
        this.nodeIdsByMesh.set(node, nodeId);
        this.indexGeometryIslands(node, nodeId);
      }

      nodes.push({
        id: nodeId,
        depth,
        name: node.name || "(unnamed)",
        type: node.type,
        visible: node.visible,
        childCount: node.children.length,
        tags,
        transform,
        geometry,
        materials
      });
    });

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
    for (const island of islands) {
      const id = `${nodeId}:${island.materialIndex}:${island.islandIndex}`;
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
          hidden: false
        },
        mesh,
        triangleOffsets: island.triangleOffsets
      });
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
