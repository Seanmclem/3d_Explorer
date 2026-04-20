# GLTF Animation Viewer

A local Three.js viewer for inspecting GLB and glTF assets in the browser. It is built with Vite, TypeScript, and plain Three.js.

## Features

- Open editable folders through the File System Access API when the browser supports it.
- Open editable individual files through the File System Access API.
- Fall back to folder or file upload with an alert when editable file handles are unavailable.
- Drag and drop folders or files into the viewport.
- Resolve glTF sidecar files such as `.bin` buffers and textures when they are imported from the same folder selection.
- Search indexed local models.
- Preview GLB and glTF models with orbit, zoom, explicit pan mode, auto-rotate, camera fit, grid, bounds, and wireframe toggles.
- Inspect mesh, material, texture, triangle, vertex, bounds, and animation counts.
- Preview animation clips with play/pause, clip selection, timeline scrubbing, and playback speed control.
- Capture the current viewport as a PNG.
- Collapse and expand left and right sidebar sections; the file section collapses after successful imports.

## Usage

```sh
npm install
npm run dev
```

Open the local Vite URL in a browser. For future edit/save workflows, use a browser that supports the File System Access API. Upload fallback mode still supports previewing assets, but it does not provide persistent editable file handles.

## Build

```sh
npm run build
```
