import {
  AmbientLight,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  Box3Helper,
  Clock,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  LoadingManager,
  Material,
  Mesh,
  MOUSE,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  TOUCH,
  Texture,
  Vector3,
  WebGLRenderer
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { LoadedModel, LocalAsset, ModelStats, PlaybackState } from "./types";
import { LocalAssetLibrary } from "./localAssets";

export type ViewerOptions = {
  canvas: HTMLCanvasElement;
  onPlayback?: (state: PlaybackState) => void;
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
  private readonly resizeObserver: ResizeObserver;
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
    this.fitCameraToObject(root);

    if (this.clips.length > 0) {
      this.playClip(0);
      this.setPaused(false);
    } else {
      this.emitPlayback();
    }

    return { clips: this.clips, stats };
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
}
