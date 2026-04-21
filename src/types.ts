import type { AnimationClip } from "three";

export type AssetKind = "glb" | "gltf";

export type LocalFileRecord = {
  file: File;
  path: string;
  folder: string;
  url?: string;
  fileHandle?: unknown;
  directoryHandle?: unknown;
  accessMode: "handle" | "upload" | "drop";
};

export type LocalAsset = LocalFileRecord & {
  id: string;
  kind: AssetKind;
  name: string;
  basePath: string;
  sizeLabel: string;
};

export type LoadStatus = {
  label: string;
  detail?: string;
  tone?: "idle" | "ok" | "warn" | "error";
};

export type ModelStats = {
  meshes: number;
  materials: number;
  textures: number;
  triangles: number;
  vertices: number;
  animations: number;
  bounds: string;
};

export type MaterialInspectorInfo = {
  index: number;
  name: string;
  type: string;
  color?: string;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  transparent: boolean;
  side: string;
  textureSlots: string[];
  vertexColors: boolean;
};

export type NodeInspectorInfo = {
  id: number;
  depth: number;
  name: string;
  type: string;
  visible: boolean;
  childCount: number;
  tags: string[];
  transform: string[];
  geometry?: {
    name: string;
    vertices: number;
    attributes: string[];
    indexed: boolean;
  };
  materials: MaterialInspectorInfo[];
};

export type GeometrySelectionInfo = {
  id: string;
  nodeId: number;
  nodeName: string;
  materialIndex: number;
  materialName: string;
  islandIndex: number;
  islandCount: number;
  faceCount: number;
  vertexCount: number;
  hidden: boolean;
};

export type LoadedModel = {
  clips: AnimationClip[];
  stats: ModelStats;
  nodes: NodeInspectorInfo[];
};

export type PlaybackState = {
  activeClipIndex: number;
  clipName: string;
  duration: number;
  time: number;
  isPlaying: boolean;
};
