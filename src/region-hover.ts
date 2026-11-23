import { WorkspaceLeaf, type App, type FileView, type TFile } from "obsidian";

type PreviewLeaf = WorkspaceLeaf & { containerEl: HTMLElement; resizeObserver?: ResizeObserver };

interface Preview {
  origin: WorkspaceLeaf;
  originFile: TFile | null;
  leaf: PreviewLeaf;
  overlay: HTMLElement;
  abort: AbortController;
}

/** The preview has its own native view so the open tab keeps its document, scroll, and history. */
export class RegionHover {
  private current?: Preview;

  constructor(private readonly app: App) {}

  show(file: TFile, eState: Record<string, unknown> | undefined, reveal: (view: FileView, signal: AbortSignal) => void): () => void {
    this.clear();
    const origin = this.app.workspace.getMostRecentLeaf();
    const host = origin?.view.containerEl;
    if (!origin || !host?.isConnected) return () => {};

    // Obsidian exports the native leaf, but only declares its workspace factory in the public typings.
    const Leaf = WorkspaceLeaf as unknown as new (app: App) => PreviewLeaf;
    const leaf = new Leaf(this.app);
    const overlay = host.ownerDocument.createElement("div");
    overlay.className = "modern-draw-hover-preview";
    overlay.inert = true;
    overlay.setAttribute("aria-hidden", "true");
    overlay.append(leaf.containerEl);
    host.append(overlay);
    const preview = { origin, originFile: (origin.view as FileView).file ?? null, leaf, overlay, abort: new AbortController() };
    this.current = preview;
    void this.load(preview, file, eState, reveal);
    return () => {
      if (this.current === preview) this.clear();
    };
  }

  sync(): void {
    if (this.current && (!this.current.overlay.isConnected
      || this.current.origin !== this.app.workspace.getMostRecentLeaf()
      || this.current.originFile !== ((this.current.origin.view as FileView).file ?? null)
      || this.current.overlay.parentElement !== this.current.origin.view.containerEl)) this.clear();
  }

  canvasView(): FileView | undefined {
    const view = this.current?.leaf.view;
    return view?.getViewType() === "canvas" ? view as FileView : undefined;
  }

  clear(): void {
    const preview = this.current;
    if (!preview) return;
    this.current = undefined;
    preview.overlay.remove();
    preview.abort.abort();
  }

  private async load(
    preview: Preview, file: TFile, eState: Record<string, unknown> | undefined,
    reveal: (view: FileView, signal: AbortSignal) => void
  ): Promise<void> {
    const { abort, leaf } = preview;
    const { signal } = abort;
    try {
      await leaf.openFile(file, { active: false, eState, state: file.extension === "md" ? { mode: "source", source: false } : undefined });
      if (!signal.aborted) {
        const view = leaf.view as FileView;
        if (view.file !== file) throw new Error(`Obsidian did not open ${file.path} in the preview.`);
        reveal(view, signal);
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error("Modern Draw: Could not preview the linked region.", error);
        this.clear();
      }
    } finally {
      leaf.resizeObserver?.disconnect();
      try {
        const view = leaf.view as WorkspaceLeaf["view"] & { close(): Promise<void> };
        await view.close();
      } catch (error) {
        console.error("Modern Draw: Could not close the linked region preview.", error);
      }
    }
  }
}
