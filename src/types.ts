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

export type LoadedModel = {
  clips: AnimationClip[];
  stats: ModelStats;
};

export type PlaybackState = {
  activeClipIndex: number;
  clipName: string;
  duration: number;
  time: number;
  isPlaying: boolean;
};
