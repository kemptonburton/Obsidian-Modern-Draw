import type { App } from "obsidian";
import { clampNoteZoom, type CanvasLayout } from "./model";

interface SyncDevice {
  deviceName?: string;
  getDefaultDeviceName?(): string;
}

type SyncApp = App & {
  internalPlugins?: {
    getPluginById?(id: "sync"): { instance?: SyncDevice } | undefined;
    getEnabledPluginById?(id: "sync"): SyncDevice | undefined;
  };
};

interface NoteView {
  zoom?: number;
  layout?: CanvasLayout;
}

const legacyZoomKey = (path: string): string => `modern-draw-note-zoom:${path}`;

// Sync's device name is not exposed by the public Obsidian plugin API.
function syncDeviceName(app: SyncApp): string | null {
  try {
    const plugins = app.internalPlugins;
    const sync = plugins?.getEnabledPluginById?.("sync") ?? plugins?.getPluginById?.("sync")?.instance;
    return sync?.deviceName || sync?.getDefaultDeviceName?.() || null;
  } catch {
    return null;
  }
}

export class NoteViewStore {
  private readonly views = new Map<string, NoteView>();
  private readonly layoutListeners = new Set<(path: string, layout: CanvasLayout) => void>();

  constructor(private readonly app: App) {}

  load(path: string): NoteView {
    const key = this.key(path);
    const current = this.readView(key);
    if (current) return current;
    const localKey = this.key(path, null);
    const unnamed = key === localKey ? undefined : this.readView(localKey);
    if (unnamed) return this.migrate(localKey, key, unnamed);
    const oldKey = legacyZoomKey(path);
    const zoom = this.read(oldKey);
    if (typeof zoom !== "number") return {};
    return this.migrate(oldKey, key, { zoom: clampNoteZoom(zoom) });
  }

  saveZoom(path: string, zoom: number): void {
    this.write(this.key(path), { ...this.load(path), zoom: clampNoteZoom(zoom) });
  }

  initializeLayout(path: string, initialLayout: CanvasLayout): CanvasLayout {
    const current = this.load(path);
    if (current.layout) return current.layout;
    this.write(this.key(path), { ...current, layout: initialLayout });
    return initialLayout;
  }

  saveLayout(path: string, layout: CanvasLayout): void {
    this.write(this.key(path), { ...this.load(path), layout });
    for (const listener of this.layoutListeners) listener(path, layout);
  }

  onLayoutChange(listener: (path: string, layout: CanvasLayout) => void): () => void {
    this.layoutListeners.add(listener);
    return () => this.layoutListeners.delete(listener);
  }

  move(oldPath: string, newPath: string): void {
    const previous = this.load(oldPath);
    if (previous.zoom === undefined && previous.layout === undefined) return;
    const destination = this.load(newPath);
    this.migrate(this.key(oldPath), this.key(newPath), {
      zoom: previous.zoom ?? destination.zoom,
      layout: previous.layout ?? destination.layout
    });
  }

  private key(path: string, name = syncDeviceName(this.app)): string {
    return `modern-draw-note-view:${JSON.stringify([name, path])}`;
  }

  private migrate(from: string, to: string, view: NoteView): NoteView {
    this.write(to, view);
    if (from !== to && this.read(to)) this.write(from, null);
    return view;
  }

  private readView(key: string): NoteView | undefined {
    const current = this.views.get(key);
    if (current) return current;
    const saved = this.read(key);
    if (!saved || typeof saved !== "object") return;
    const { zoom, layout } = saved as NoteView;
    const view = {
      zoom: typeof zoom === "number" ? clampNoteZoom(zoom) : undefined,
      layout: layout === "left" || layout === "center" || layout === "left-scroll" ? layout : undefined
    };
    this.views.set(key, view);
    return view;
  }

  private read(key: string): unknown {
    try {
      return typeof this.app.loadLocalStorage === "function" ? this.app.loadLocalStorage(key)
        : JSON.parse(localStorage.getItem(`${this.app.vault.getName()}:${key}`) ?? "null");
    } catch {
      return null;
    }
  }

  private write(key: string, view: NoteView | null): void {
    if (view) this.views.set(key, view);
    else this.views.delete(key);
    try {
      if (typeof this.app.saveLocalStorage === "function") {
        this.app.saveLocalStorage(key, view);
      } else {
        const storageKey = `${this.app.vault.getName()}:${key}`;
        if (view) localStorage.setItem(storageKey, JSON.stringify(view));
        else localStorage.removeItem(storageKey);
      }
    } catch {
      // Retain the view in memory if local storage is unavailable.
    }
  }
}
