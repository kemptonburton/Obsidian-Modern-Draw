import type { App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { clampNoteZoom } from "./model";

const zoomKey = (path: string): string => `modern-draw-note-zoom:${path}`;

/** Keep line anchors in note units while CodeMirror's measurements catch up with the new scale. */
export function noteLineOffset(view: EditorView, position: number): number {
  return (view.documentPadding.top + view.lineBlockAt(position).top) / view.scaleY;
}

export function loadNoteZoom(app: App, path: string): number {
  try {
    const value: unknown = typeof app.loadLocalStorage === "function"
      ? app.loadLocalStorage(zoomKey(path))
      : Number(localStorage.getItem(`${app.vault.getName()}:${zoomKey(path)}`) ?? 1);
    return typeof value === "number" ? clampNoteZoom(value) : 1;
  } catch {
    return 1;
  }
}

export function saveNoteZoom(app: App, path: string, zoom: number): void {
  try {
    if (typeof app.saveLocalStorage === "function") {
      app.saveLocalStorage(zoomKey(path), zoom === 1 ? null : zoom);
    } else {
      const key = `${app.vault.getName()}:${zoomKey(path)}`;
      if (zoom === 1) localStorage.removeItem(key);
      else localStorage.setItem(key, String(zoom));
    }
  } catch {
    // The zoom remains active in the pane when local storage is unavailable.
  }
}

export function moveNoteZoom(app: App, oldPath: string, newPath: string): void {
  const zoom = loadNoteZoom(app, oldPath);
  if (zoom === 1) return;
  saveNoteZoom(app, newPath, zoom);
  saveNoteZoom(app, oldPath, 1);
}
