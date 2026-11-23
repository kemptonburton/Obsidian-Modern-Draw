import { InkDoubleTap } from "./ink-double-tap";
import { appendStylusEnd, blockPointer, guardDrawingTouches, isPalmPointer, pointerSamples, updatePalmRest } from "./ink-input";
import { mergeSnapshotRegions } from "./ink-store";
import type { CanvasRegionTarget, ScreenSnapshot } from "./snapshot-surface";
import { InkControls } from "./ink-controls";
import { Menu, Notice, Platform, type App, type TFile } from "obsidian";
import type { CanvasFileData } from "obsidian/canvas";
import { PdfImportModal, type ImportedPdfPage, type PdfImportDestination } from "./pdf-import";
import type { ControllerChange, ModernDrawController } from "./controller";
import { distanceToSegment, lassoIntersects, lassoIntersectsRectangle, pointInRectangle, rectangleFromPoints, rectanglesIntersect, simplifyPoints, STYLUS_SAMPLE_DISTANCE, type Rectangle, type ScreenPoint } from "./geometry";
import { createStrokeOutline, inkDisplayColor, outlineToSvgPath } from "./ink-renderer";
import { LocalInkStyle, moveInkPreset, toggleInkPreset, updateInkPreset } from "./ink-style";
import type { InkDocument, InkStore } from "./ink-store";
import type { RegionCanvas, registerRegionFeatures } from "./pdf-viewer";
import {
  cloneStrokes,
  createStrokeId,
  type DrawingTool,
  type InkPoint,
  type ModernDrawSettings,
  type InkStroke
} from "./model";

interface CanvasViewLike {
  containerEl: HTMLElement;
  file?: TFile;
  canvas?: NativeCanvasLike;
}

interface NativeCanvasBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface NativeCanvasSelectionItemLike {
  getBBox(): NativeCanvasBBox;
}

interface NativeCanvasSelectionBoxLike {
  selectionEl: HTMLElement;
  update(bounds: NativeCanvasBBox): void;
  hide(): void;
}

interface NativeCanvasLike extends RegionCanvas {
  selection?: Set<NativeCanvasSelectionItemLike>;
  deselectAll?(): void;
  zoomBy?(delta: number): void;
  tZoom?: number;
  config?: { zoomMultiplier?: number };
  history?: { canUndo(): boolean; canRedo(): boolean };
  undo?(): void;
  redo?(): void;
  undoBtnEl?: HTMLElement;
  redoBtnEl?: HTMLElement;
  showQuickSettingsMenu?(menu: Menu): void;
  importData?(data: { nodes: CanvasFileData[] }, replace: boolean): void;
  removeNode?(node: NativeCanvasSelectionItemLike): void;
  requestSave?(): void;
  requestPushHistory?: { run(): void };
  generateHDImage?(): Promise<void>;
  menu?: {
    selection?: NativeCanvasSelectionBoxLike;
    containerEl?: HTMLElement;
  };
}

interface CanvasInkDependencies {
  controller: ModernDrawController;
  store: InkStore;
  regions: ReturnType<typeof registerRegionFeatures>;
  saveSettings(settings: ModernDrawSettings): Promise<void>;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const POINTER_CONTROLS = ".canvas-controls, .canvas-card-menu, .modern-draw-region-link-icon, .modern-draw-toolbar";

export class CanvasInkManager {
  private readonly surfaces = new Map<HTMLElement, CanvasInkSurface>();
  private readonly observer: MutationObserver;
  private refreshFrame: number | null = null;

  constructor(private readonly app: App, private readonly dependencies: CanvasInkDependencies) {
    this.observer = new MutationObserver(() => this.scheduleRefresh());
  }

  start(): void {
    this.observer.observe(this.app.workspace.containerEl, { childList: true, subtree: true });
    this.refresh();
  }

  refresh(): void {
    if (this.refreshFrame !== null) {
      cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = null;
    }
    const current = new Set<HTMLElement>();
    const views = this.app.workspace.getLeavesOfType("canvas").map((leaf) => leaf.view);
    const preview = this.dependencies.regions.canvasPreviewView();
    if (preview) views.push(preview);
    for (const candidate of views) {
      const view = candidate as unknown as CanvasViewLike;
      const wrapper = view.containerEl.querySelector<HTMLElement>(".canvas-wrapper");
      const canvas = wrapper?.querySelector<HTMLElement>(":scope > .canvas");
      const nativeControls = wrapper?.querySelector<HTMLElement>(":scope > .canvas-controls");
      const file = view.file;
      if (!wrapper || !canvas || !nativeControls || !file || file.extension !== "canvas") continue;
      current.add(wrapper);
      const existing = this.surfaces.get(wrapper);
      if (existing && !existing.isAttached(file.path)) {
        existing.destroy();
        this.surfaces.delete(wrapper);
      }
      if (!this.surfaces.has(wrapper)) {
        const surface = new CanvasInkSurface(
          wrapper,
          canvas,
          nativeControls,
          view.canvas,
          file,
          this.dependencies,
          this.app
        );
        this.surfaces.set(wrapper, surface);
        void surface.start();
      }
    }
    for (const [wrapper, surface] of this.surfaces) {
      // Native PNG export temporarily moves the Canvas wrapper outside its workspace leaf.
      if (wrapper.isConnected && wrapper.classList.contains("is-screenshotting")) continue;
      if (!wrapper.isConnected || !current.has(wrapper)) {
        surface.destroy();
        this.surfaces.delete(wrapper);
      }
    }
  }

  activePdfImportDestination(): PdfImportDestination | undefined {
    const view = this.app.workspace.getMostRecentLeaf()?.view;
    if (view?.getViewType() !== "canvas") return;
    const wrapper = view.containerEl.querySelector<HTMLElement>(".canvas-wrapper");
    return wrapper ? this.surfaces.get(wrapper)?.pdfImportDestination() : undefined;
  }

  destroy(): void {
    this.observer.disconnect();
    if (this.refreshFrame !== null) cancelAnimationFrame(this.refreshFrame);
    for (const surface of this.surfaces.values()) surface.destroy();
    this.surfaces.clear();
  }

  private scheduleRefresh(): void {
    if (this.refreshFrame !== null) return;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = null;
      this.refresh();
    });
  }
}

class CanvasInkSurface {
  private readonly doubleTap: InkDoubleTap;
  private readonly palmRest: HTMLDivElement;
  private readonly overlay: SVGSVGElement;
  private readonly committedInk: SVGGElement;
  private readonly gestureInk: SVGGElement;
  private readonly strokePaths = new WeakMap<InkStroke, SVGPathElement>();
  private renderedStrokes?: readonly InkStroke[];
  private renderedSmoothing?: number;
  private readonly controls: InkControls;
  private readonly nativeStateObserver: MutationObserver;
  private readonly inkOnlySelection: HTMLDivElement;
  private readonly toolSource = {};
  private readonly inkStyle: LocalInkStyle;
  private readonly unsubscribeController: () => void;
  private readonly detachExport: () => void;
  private readonly detachTouchGuard: () => void;
  private readonly regionSurface: ReturnType<ReturnType<typeof registerRegionFeatures>["attachCanvas"]>;
  private selectedRegionIds = new Set<string>();
  private lassoBaseRegions = new Set<string>();
  private movingRegions: ScreenSnapshot[] = [];
  private regionOffsets = new Map<string, ScreenPoint>();
  private readonly regionInkBounds = new WeakMap<InkStroke, Rectangle>();
  private readonly sourcePath: string;
  private document: InkDocument | null = null;
  private unsubscribeDocument: (() => void) | null = null;
  private destroyed = false;
  private renderFrame: number | null = null;
  private activePointerId: number | null = null;
  private activeStroke: InkStroke | null = null;
  private eraserWorkingSet: InkStroke[] | null = null;
  private erasedStrokeIds = new Set<string>();
  private selectedStrokeIds = new Set<string>();
  private selectionMode: "move" | "lasso" | "native-lasso" | null = null;
  private selectionStart: ScreenPoint | null = null;
  private lassoPath: ScreenPoint[] = [];
  private screenLasso: ScreenPoint[] = [];
  private nativeMarqueeStart?: ScreenPoint;
  private selectionOriginalSet: InkStroke[] | null = null;
  private selectionWorkingSet: InkStroke[] | null = null;
  private selectionMoved = false;
  private lassoBaseSelection = new Set<string>();
  private allowNativeGesture = false;
  private preferInkUndo = false;
  private activeTool: DrawingTool;

  constructor(
    private readonly wrapper: HTMLElement,
    private readonly canvasElement: HTMLElement,
    private readonly nativeControls: HTMLElement,
    private readonly nativeCanvas: NativeCanvasLike | undefined,
    private readonly file: TFile,
    private readonly dependencies: CanvasInkDependencies,
    private readonly app: App
  ) {
    this.doubleTap = new InkDoubleTap(wrapper.ownerDocument.defaultView ?? window);
    this.activeTool = "select";
    this.sourcePath = file.path;
    this.inkStyle = new LocalInkStyle(dependencies.controller.settings);
    this.controls = new InkControls({
      setTool: (tool) => this.setTool(tool),
      setColor: (color) => {
        this.inkStyle.setColor(this.activeTool, color);
        this.updateDrawingMode();
      },
      setStrokeSize: (size) => {
        this.inkStyle.setWidth(this.activeTool, size);
        this.updateDrawingMode();
      },
      setStyle: (tool, style) => {
        this.inkStyle.setColor(tool, style.color);
        this.inkStyle.setWidth(tool, style.width);
        this.setTool(tool);
      },
      togglePinnedStyle: (tool, style) => void dependencies.saveSettings(
        toggleInkPreset(dependencies.controller.settings, tool, style)
      ),
      updatePinnedStyle: (tool, original, replacement) => void dependencies.saveSettings(
        updateInkPreset(dependencies.controller.settings, tool, original, replacement)
      ),
      movePinnedStyle: (source, before) => {
        const current = dependencies.controller.settings;
        const updated = moveInkPreset(current, source, before);
        if (updated !== current) void dependencies.saveSettings(updated);
      },
      undo: () => this.performHistory(false),
      redo: () => this.performHistory(true),
      zoomIn: nativeCanvas?.zoomBy ? () => nativeCanvas.zoomBy?.(nativeCanvas.config?.zoomMultiplier ?? 0.25) : undefined,
      zoomOut: nativeCanvas?.zoomBy ? () => nativeCanvas.zoomBy?.(-(nativeCanvas.config?.zoomMultiplier ?? 0.25)) : undefined,
      resetZoom: nativeCanvas?.zoomBy ? () => nativeCanvas.zoomBy?.(-(nativeCanvas.tZoom ?? Math.log2(this.canvasScale()))) : undefined,
      fitView: nativeCanvas?.zoomToBbox ? () => this.fitView() : undefined,
      openViewMenu: nativeCanvas?.showQuickSettingsMenu ? (anchor) => this.openCanvasMenu(anchor) : undefined,
      importPdf: this.supportsPdfImport() ? () => {
        const target = this.pdfImportDestination();
        if (target) new PdfImportModal(this.app, target).open();
      } : undefined
    }, { includeSpace: false, includeHistory: true }, wrapper.ownerDocument);
    this.controls.root.classList.add("modern-draw-canvas-toolbar");
    this.wrapper.appendChild(this.controls.root);
    this.palmRest = this.wrapper.ownerDocument.createElement("div");
    this.palmRest.className = "modern-draw-palm-rest modern-draw-canvas-palm-rest";
    this.palmRest.setAttribute("aria-hidden", "true");
    this.wrapper.appendChild(this.palmRest);
    this.overlay = document.createElementNS(SVG_NAMESPACE, "svg");
    this.overlay.classList.add("modern-draw-canvas-overlay");
    this.overlay.setAttribute("aria-hidden", "true");
    this.committedInk = document.createElementNS(SVG_NAMESPACE, "g");
    this.gestureInk = document.createElementNS(SVG_NAMESPACE, "g");
    this.overlay.append(this.committedInk, this.gestureInk);
    this.canvasElement.appendChild(this.overlay);

    this.inkOnlySelection = document.createElement("div");
    this.inkOnlySelection.className = "canvas-selection mod-group-selection modern-draw-ink-only-selection";
    this.inkOnlySelection.style.display = "none";
    this.inkOnlySelection.addEventListener("pointerdown", (event) => {
      // The wrapper's capture listener has already started the ink move. Do
      // not let Canvas interpret an ink-only box as an empty native group.
      if ((this.nativeCanvas?.selection?.size ?? 0) === 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    });
    this.canvasElement.appendChild(this.inkOnlySelection);
    this.regionSurface = dependencies.regions.attachCanvas(
      file, wrapper, canvasElement, this.controls.selectionTools, nativeCanvas, () => this.regionTargets()
    );
    this.detachExport = this.installExportHook();

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onNativeControlClick = this.onNativeControlClick.bind(this);
    this.onBlockedNativeClick = this.onBlockedNativeClick.bind(this);
    this.requestRender = this.requestRender.bind(this);
    this.wrapper.addEventListener("pointerdown", this.onPointerDown, true);
    this.detachTouchGuard = guardDrawingTouches(wrapper, wrapper,
      () => dependencies.controller.settings,
      () => this.activePointerId !== null && !this.allowNativeGesture,
      (target) => Boolean((target as Element | null)?.closest(POINTER_CONTROLS)));
    this.wrapper.addEventListener("click", this.onBlockedNativeClick, true);
    this.wrapper.addEventListener("dblclick", this.onBlockedNativeClick, true);
    this.wrapper.addEventListener("keydown", this.onKeyDown, true);
    this.nativeControls.addEventListener("click", this.onNativeControlClick, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("pointercancel", this.onPointerUp, true);
    this.nativeStateObserver = new MutationObserver(() => {
      this.controls.updateZoom(this.canvasScale());
      this.controls.updateHistory(this.canUseHistory(false), this.canUseHistory(true));
      this.controls.updateImportAvailability(this.canImportPdf());
    });
    this.nativeStateObserver.observe(canvasElement, { attributes: true, attributeFilter: ["style"] });
    this.nativeStateObserver.observe(wrapper, { attributes: true, attributeFilter: ["class"] });
    for (const button of [nativeCanvas?.undoBtnEl, nativeCanvas?.redoBtnEl]) {
      if (button) this.nativeStateObserver.observe(button, { attributes: true, attributeFilter: ["class"] });
    }
    this.unsubscribeController = dependencies.controller.subscribe((change) => {
      this.applyControllerChange(change);
      this.updateDrawingMode();
      this.requestRender();
    });
    this.updateDrawingMode();
  }

  async start(): Promise<void> {
    const document = await this.dependencies.store.getDocument(this.sourcePath);
    if (this.destroyed) return;
    this.document = document;
    this.unsubscribeDocument = document.subscribe(() => {
      this.regionSurface.refresh();
      this.updateDrawingMode();
      this.requestRender();
    });
    this.regionSurface.refresh();
    this.updateDrawingMode();
    this.requestRender();
  }

  isAttached(path: string): boolean {
    return this.sourcePath === path && this.overlay.isConnected && this.nativeControls.isConnected;
  }

  destroy(): void {
    this.doubleTap.reset();
    this.destroyed = true;
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
    this.unsubscribeDocument?.();
    this.unsubscribeController();
    this.nativeStateObserver.disconnect();
    this.regionSurface.destroy();
    this.detachExport();
    this.wrapper.removeEventListener("pointerdown", this.onPointerDown, true);
    this.detachTouchGuard();
    this.wrapper.removeEventListener("click", this.onBlockedNativeClick, true);
    this.wrapper.removeEventListener("dblclick", this.onBlockedNativeClick, true);
    this.wrapper.removeEventListener("keydown", this.onKeyDown, true);
    this.nativeControls.removeEventListener("click", this.onNativeControlClick, true);
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("pointercancel", this.onPointerUp, true);
    this.restoreNativeSelectionBox();
    this.inkOnlySelection.remove();
    this.overlay.remove();
    this.controls.destroy();
    this.palmRest.remove();
    this.wrapper.classList.remove("modern-draw-canvas-drawing", "modern-draw-has-canvas-toolbar");
  }

  private installExportHook(): () => void {
    const native = this.nativeCanvas;
    const original = native?.generateHDImage;
    if (!native || !original || !(native.nodes instanceof Map)) return () => {};
    const nodes = native.nodes as unknown as Map<string, {
      x: number; y: number; width: number; height: number;
    }>;
    const exportImage = async (): Promise<void> => {
      const document = this.document ?? await this.dependencies.store.getDocument(this.sourcePath);
      if (!this.document && !this.destroyed) this.document = document;
      this.render();
      const strokes = document.strokes.filter((stroke) => stroke.points.length > 0);
      const bounds = strokes.map((stroke) => rectangleToNativeBounds(this.strokeBounds(stroke)));
      const coverage = bounds.length ? bounds.reduce(mergeNativeBounds) : undefined;
      const id = createStrokeId();
      this.wrapper.classList.toggle("modern-draw-export-monochrome", this.dependencies.controller.settings.monochromeExport);
      try {
        // Canvas snapshots bounds synchronously before awaiting its export dialog.
        // The temporary entry contributes geometry only and is removed before rendering tiles.
        let result: Promise<void>;
        if (coverage) nodes.set(id, {
          x: coverage.minX, y: coverage.minY,
          width: coverage.maxX - coverage.minX, height: coverage.maxY - coverage.minY
        });
        try {
          result = original.call(native);
        } finally {
          nodes.delete(id);
        }
        await result;
      } finally {
        this.wrapper.classList.remove("modern-draw-export-monochrome");
      }
    };
    native.generateHDImage = exportImage;
    return () => {
      if (native.generateHDImage === exportImage) native.generateHDImage = original;
    };
  }

  private applyControllerChange(change: ControllerChange): void {
    if (change.kind !== "tool" || change.source !== undefined || !this.isActivePane()) return;
    const tool = this.dependencies.controller.activeTool;
    if (tool === "space-horizontal") return;
    if (tool !== this.activeTool) this.doubleTap.reset();
    this.doubleTap.remember(tool);
    this.activeTool = tool;
  }

  private isActivePane(): boolean {
    return Boolean(this.wrapper.closest(".workspace-leaf.mod-active"));
  }

  private setTool(tool: DrawingTool): void {
    if (tool !== this.activeTool) this.doubleTap.reset();
    this.doubleTap.remember(tool);
    this.activeTool = tool;
    this.dependencies.controller.setTool(tool, this.toolSource);
    this.updateDrawingMode();
  }

  private updateDrawingMode(): void {
    const tool = this.activeTool;
    const settings = this.dependencies.controller.settings;
    updatePalmRest(this.palmRest, settings);
    if (!settings.doubleTapToErase) this.doubleTap.reset();
    this.wrapper.classList.toggle("modern-draw-canvas-drawing", tool !== "select");
    const showToolbar = settings.showToolbar && Boolean(this.wrapper.closest(".workspace-leaf"));
    this.controls.root.classList.toggle("is-hidden", !showToolbar);
    this.wrapper.classList.toggle("modern-draw-has-canvas-toolbar", showToolbar);
    this.controls.update({
      tool, settings, canvasLayout: "left", zoom: this.canvasScale(),
      color: this.inkStyle.colorFor(tool),
      strokeSize: this.inkStyle.widthFor(tool),
      canUndo: this.canUseHistory(false),
      canRedo: this.canUseHistory(true)
    });
    this.controls.updateImportAvailability(this.canImportPdf());
  }

  pdfImportDestination(): PdfImportDestination | undefined {
    if (!this.canImportPdf()) return;
    return {
      kind: "canvas",
      file: this.file,
      owner: this.wrapper.ownerDocument,
      available: () => this.canImportPdf(),
      insert: (pages) => this.insertPdfPages(pages)
    };
  }

  private supportsPdfImport(): boolean {
    const native = this.nativeCanvas;
    return Boolean(native?.importData && native.removeNode && native.requestSave && native.posCenter && native.nodes);
  }

  private canImportPdf(): boolean {
    return this.supportsPdfImport() && Boolean(this.document) && !this.destroyed
      && this.wrapper.isConnected && !this.nativeCanvas?.readonly;
  }

  private insertPdfPages(pages: ImportedPdfPage[]): void {
    const native = this.nativeCanvas;
    if (!this.canImportPdf() || !native?.importData || !native.posCenter || !native.requestSave || pages.length === 0) {
      throw new Error("The destination Canvas was closed or is read-only.");
    }
    const sizes = pages.map(({ width, height }) => {
      const scale = Math.min(640 / width, 840 / height);
      return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
    });
    const gap = 56;
    const columns = 3;
    const available = this.contentBounds();
    const center = native.posCenter();
    const left = available ? available.maxX + gap : center.x - sizes[0].width / 2;
    let top = available?.minY ?? center.y - sizes[0].height / 2;
    const nodes: CanvasFileData[] = [];
    for (let row = 0; row < pages.length; row += columns) {
      let x = left;
      for (let index = row; index < Math.min(row + columns, pages.length); index += 1) {
        const size = sizes[index];
        nodes.push({ id: createStrokeId(), type: "file", file: pages[index].file.path, x, y: top, ...size });
        x += size.width + gap;
      }
      top += Math.max(...sizes.slice(row, row + columns).map(({ height }) => height)) + gap;
    }

    native.requestPushHistory?.run();
    try {
      native.importData({ nodes }, false);
      native.requestSave();
    } catch (error) {
      for (const { id } of nodes) {
        const node = native.nodes?.get(id);
        if (node) native.removeNode?.(node);
      }
      // Restore the existing board if its save was already queued.
      native.requestSave();
      throw error;
    }
    this.preferInkUndo = false;
    const firstRow = nodes.slice(0, columns).map(({ x, y, width, height }) => ({
      minX: x, minY: y, maxX: x + width, maxY: y + height
    }));
    try {
      native.zoomToBbox?.(firstRow.reduce(mergeNativeBounds));
    } catch (error) {
      console.warn("Modern Draw: Could not zoom to imported pages.", error);
    }
  }

  private contentBounds(): NativeCanvasBBox | undefined {
    const bounds = Array.from(this.nativeCanvas?.nodes?.values() ?? [], (node) => node.getBBox());
    for (const stroke of this.document?.strokes ?? []) {
      if (stroke.points.length) bounds.push(rectangleToNativeBounds(this.strokeBounds(stroke)));
    }
    return bounds.length ? bounds.reduce(mergeNativeBounds) : undefined;
  }

  private fitView(): void {
    const bounds = this.contentBounds();
    if (bounds) this.nativeCanvas?.zoomToBbox?.(bounds);
  }

  private openCanvasMenu(anchor: HTMLElement): void {
    const native = this.nativeCanvas;
    if (!native?.showQuickSettingsMenu) return;
    const menu = new Menu();
    native.showQuickSettingsMenu(menu);
    if (Platform.isDesktopApp && native.generateHDImage) {
      menu.addItem((item) => item.setTitle("Export as image").setIcon("image-down").onClick(() => {
        void native.generateHDImage?.().catch((error: unknown) => {
          console.error("Modern Draw: Could not export Canvas.", error);
          new Notice("Could not export Canvas.");
        });
      }));
    }
    const help = this.nativeControls.querySelector<HTMLElement>(
      ".canvas-control-item:has(.lucide-help-circle, .lucide-circle-help)"
    );
    if (help) menu.addItem((item) => item.setTitle("Canvas help").setIcon("circle-help").onClick(() => help.click()));
    const bounds = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, anchor.ownerDocument);
  }

  private canUseHistory(redo: boolean): boolean {
    const native = this.nativeCanvas?.history;
    const ink = this.document;
    return Boolean(redo ? native?.canRedo() || ink?.canRedo : native?.canUndo() || ink?.canUndo);
  }

  private performHistory(redo: boolean): void {
    this.doubleTap.reset();
    const native = this.nativeCanvas;
    const ink = this.document;
    const canUseInk = redo ? ink?.canRedo : ink?.canUndo;
    const canUseNative = redo ? native?.history?.canRedo() : native?.history?.canUndo();
    if (canUseInk && (this.preferInkUndo || !canUseNative)) {
      if (redo) this.redo();
      else this.undo();
    } else if (canUseNative) {
      if (redo) native?.redo?.();
      else native?.undo?.();
      this.controls.updateHistory(this.canUseHistory(false), this.canUseHistory(true));
      this.requestRender();
    }
  }

  private onPointerDown(event: PointerEvent): void {
    this.dependencies.controller.setTool(this.activeTool, this.toolSource);
    const target = event.target as Element | null;
    if (target?.closest(POINTER_CONTROLS)) {
      this.doubleTap.reset();
      return;
    }
    const settings = this.dependencies.controller.settings;
    if (isPalmPointer(event, this.wrapper, settings)
      || (event.pointerType === "touch" && this.activePointerId !== null && !this.allowNativeGesture)) {
      blockPointer(event);
      return;
    }
    if (!this.document || this.activePointerId !== null) return;
    if (settings.doubleTapToErase) this.doubleTap.begin(event);
    if (settings.penOnly && event.pointerType === "touch") return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    let tool = this.activeTool;
    if (tool !== "lasso" && event.pointerType === "pen" && this.dependencies.controller.settings.autoDrawWithPen) {
      tool = isPenEraser(event) ? "eraser" : tool === "highlighter" || tool === "eraser" ? tool : "pen";
    }
    if (tool === "space" || tool === "space-horizontal") return;
    if (tool === "lasso") {
      if (event.button !== 0) return;
      const point = this.eventToWorldPoint(event);
      const bounds = event.shiftKey ? null : this.selectedInkBounds(this.document.strokes);
      const selectedRegion = !event.shiftKey && this.regionSurface.surface.screenRegions().some(({ region, bounds }) =>
        this.selectedRegionIds.has(region.id) && pointInRectangle({ x: event.clientX, y: event.clientY }, bounds, 4));
      if (selectedRegion || bounds && pointInRectangle(point, bounds, 10)) {
        blockPointer(event);
        this.beginSelectionMove(event, point);
      } else {
        this.beginLasso(event, point);
      }
      return;
    }
    if (tool === "select") {
      const point = this.eventToWorldPoint(event);
      const hit = this.hitTestStroke(point, 7 / this.canvasScale());
      if (event.shiftKey && hit) {
        this.beginSelection(event, hit, point);
        return;
      }
      const nativeSelectionTarget = target?.closest(
        ".canvas-selection.mod-group-selection, .canvas-node.is-selected"
      );
      if (nativeSelectionTarget && (this.selectedStrokeIds.size > 0 || this.selectedRegionIds.size > 0)) {
        this.beginSelectionMove(event, point, true);
        return;
      }
      if (hit) {
        this.beginSelection(event, hit, point);
      } else {
        const targetRegion = this.regionSurface.surface.hitSelection({ x: event.clientX, y: event.clientY }, this.selectedRegionIds);
        if (targetRegion && !target?.closest(".canvas-node")) {
          blockPointer(event);
          if (!event.shiftKey) this.nativeCanvas?.deselectAll?.();
          if (event.shiftKey && this.selectedRegionIds.delete(targetRegion.region.id)) {
            this.requestRender();
            return;
          }
          if (!event.shiftKey && !this.selectedRegionIds.has(targetRegion.region.id)) {
            this.selectedStrokeIds.clear();
            this.selectedRegionIds.clear();
          }
          this.selectedRegionIds.add(targetRegion.region.id);
          this.wrapper.focus();
          this.beginSelectionMove(event, point);
        } else {
          this.beginNativeLasso(event, point);
          this.preferInkUndo = false;
        }
      }
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    this.activePointerId = event.pointerId;
    if (tool === "eraser") {
      this.eraserWorkingSet = [...this.document.strokes];
      this.eraseAt(event);
      return;
    }
    this.activeStroke = {
      id: createStrokeId(),
      tool,
      stylus: event.pointerType === "pen" ? true : undefined,
      pressureSensitive: tool === "pen" && event.pointerType === "pen" && !settings.stylusPressure ? false : undefined,
      color: this.inkStyle.colorFor(tool),
      width: this.inkStyle.widthFor(tool),
      opacity: tool === "highlighter" ? 0.32 : 1,
      anchor: { pos: 0, lineText: "" },
      points: [this.pointFromEvent(event)]
    };
    this.requestRender();
  }

  private onPointerMove(event: PointerEvent): void {
    const tapBecameStroke = this.doubleTap.move(event);
    if (event.pointerId !== this.activePointerId) return;
    if (!this.allowNativeGesture) {
      event.preventDefault();
      event.stopPropagation();
    }
    const point = this.eventToWorldPoint(event);
    if (this.selectionMode === "native-lasso") {
      const lasso = rectangleFromPoints(this.selectionStart ?? point, point);
      const screenStart = this.nativeMarqueeStart ?? { x: event.clientX, y: event.clientY };
      const screen = rectangleFromPoints(screenStart, { x: event.clientX, y: event.clientY });
      this.selectedRegionIds = new Set(this.lassoBaseRegions);
      for (const { region, bounds } of this.regionSurface.surface.screenRegions()) {
        if (rectanglesIntersect(screen, bounds)) this.selectedRegionIds.add(region.id);
      }
      this.selectedStrokeIds = new Set(this.lassoBaseSelection);
      for (const stroke of this.document?.strokes ?? []) {
        if (rectanglesIntersect(lasso, this.strokeBounds(stroke))) this.selectedStrokeIds.add(stroke.id);
      }
      this.requestRender();
      return;
    }
    if (this.selectionMode === "lasso") {
      const previous = this.lassoPath[this.lassoPath.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) * this.canvasScale() >= 2) {
        this.lassoPath.push(point);
        this.screenLasso.push({ x: event.clientX, y: event.clientY });
      }
      this.requestRender();
      return;
    }
    if (this.selectionMode === "move" && this.selectionStart && this.selectionOriginalSet) {
      const deltaX = point.x - this.selectionStart.x;
      const deltaY = point.y - this.selectionStart.y;
      this.selectionMoved = Math.hypot(deltaX, deltaY) > 0.5;
      this.selectionWorkingSet = cloneStrokes(this.selectionOriginalSet);
      for (const stroke of this.selectionWorkingSet) {
        if (!this.selectedStrokeIds.has(stroke.id)) continue;
        for (const inkPoint of stroke.points) {
          inkPoint.x += deltaX;
          inkPoint.y += deltaY;
        }
      }
      const scale = this.canvasScale();
      this.regionOffsets = new Map(this.movingRegions.map(({ region }) => [region.id, { x: deltaX * scale, y: deltaY * scale }]));
      this.requestRender();
      return;
    }
    if (this.eraserWorkingSet) {
      if (tapBecameStroke) this.requestRender();
      this.eraseAt(event);
      return;
    }
    if (!this.activeStroke) return;
    const samples = pointerSamples(event);
    for (const sample of samples) this.activeStroke.points.push(this.pointFromEvent(sample));
    this.requestRender();
  }

  private onPointerUp(event: PointerEvent): void {
    const tap = this.doubleTap.finish(event);
    if (tap === "double") this.setTool(this.doubleTap.switchFrom(this.activeTool));
    if (event.pointerId !== this.activePointerId) {
      if (tap === "double") blockPointer(event);
      return;
    }
    if (!this.allowNativeGesture) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (tap !== "double" && this.selectionMode === "lasso" && event.type === "pointerup") {
      this.lassoPath.push(this.eventToWorldPoint(event));
      this.screenLasso.push({ x: event.clientX, y: event.clientY });
      for (const { region, bounds } of this.regionSurface.surface.screenRegions()) {
        if (lassoIntersectsRectangle(this.screenLasso, bounds)) this.selectedRegionIds.add(region.id);
      }
      for (const stroke of this.document?.strokes ?? []) {
        if (lassoIntersects(this.lassoPath, stroke.points)) this.selectedStrokeIds.add(stroke.id);
      }
    }
    if (tap !== "double" && this.selectionMode === "move" && event.type === "pointerup"
      && this.document && this.selectionWorkingSet && this.selectionMoved) {
      const ink = this.document;
      const moved = this.movingRegions.flatMap((snapshot) => {
        const offset = this.regionOffsets.get(snapshot.region.id);
        return offset ? [this.regionSurface.surface.moveFrom(snapshot, offset.x, offset.y)] : [];
      });
      if (moved.length > 0 || this.selectedStrokeIds.size > 0) {
        ink.commitState(this.selectionWorkingSet, ink.floatingImages, ink.verticalSpaces, true, mergeSnapshotRegions(ink.snapshotRegions, moved));
        this.preferInkUndo = true;
      }
    } else if (this.document && this.activeStroke) {
      const ink = this.document;
      const stroke = this.activeStroke;
      if (stroke.stylus && event.type === "pointerup") appendStylusEnd(stroke.points, this.pointFromEvent(event));
      stroke.points = simplifyPoints(stroke.points, stroke.stylus ? STYLUS_SAMPLE_DISTANCE : undefined);
      this.doubleTap.commit(tap, () => {
        this.doubleTap.remember(stroke.tool);
        ink.append(stroke);
        this.selectedStrokeIds.clear();
        this.preferInkUndo = true;
      });
    } else if (this.document && this.erasedStrokeIds.size > 0) {
      const ink = this.document;
      const erased = this.erasedStrokeIds;
      this.doubleTap.commit(tap, () => {
        if (!ink.eraseStrokes(erased)) return;
        this.selectedStrokeIds.clear();
        this.preferInkUndo = true;
      });
    }
    this.activePointerId = null;
    this.activeStroke = null;
    this.eraserWorkingSet = null;
    this.erasedStrokeIds = new Set();
    this.selectionMode = null;
    this.selectionStart = null;
    this.lassoPath = [];
    this.screenLasso = [];
    this.nativeMarqueeStart = undefined;
    this.lassoBaseRegions.clear();
    this.movingRegions = [];
    this.regionOffsets.clear();
    this.selectionOriginalSet = null;
    this.selectionWorkingSet = null;
    this.selectionMoved = false;
    this.lassoBaseSelection.clear();
    this.allowNativeGesture = false;
    this.requestRender();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === "z" || event.key === "Escape") this.doubleTap.reset();
    if (this.activeTool !== "select" && this.selectedStrokeIds.size === 0 && this.selectedRegionIds.size === 0
      && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "z" && this.preferInkUndo) {
      const handled = event.shiftKey ? this.document?.canRedo : this.document?.canUndo;
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (event.key === "Escape" && (this.selectedStrokeIds.size > 0 || this.selectedRegionIds.size > 0)) {
      this.selectedStrokeIds.clear();
      this.selectedRegionIds.clear();
      this.requestRender();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.document && !this.nativeCanvas?.readonly) {
      const nativeCards = this.selectedCardIds();
      const regions = this.regionSurface.surface.screenRegions().flatMap(({ region }) =>
        this.selectedRegionIds.has(region.id) && !(region.canvasAnchor?.kind === "card" && nativeCards.has(region.canvasAnchor.id))
          ? [{ ...region, deleted: true }] : []);
      if (regions.length === 0 && this.selectedStrokeIds.size === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const { strokes, floatingImages, verticalSpaces, snapshotRegions } = this.document;
      this.document.commitState(strokes.filter(({ id }) => !this.selectedStrokeIds.has(id)),
        floatingImages, verticalSpaces, true, mergeSnapshotRegions(snapshotRegions, regions));
      this.selectedStrokeIds.clear();
      this.selectedRegionIds.clear();
      this.preferInkUndo = true;
    }
  }

  private onNativeControlClick(event: MouseEvent): void {
    const item = (event.target as Element | null)?.closest<HTMLElement>(".canvas-control-item, [aria-label]");
    const label = item?.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (label === "undo" && this.preferInkUndo && this.document?.canUndo) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.undo();
      return;
    }
    if (label === "redo" && this.preferInkUndo && this.document?.canRedo) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.redo();
      return;
    }
    if (label !== "undo" && label !== "redo") this.preferInkUndo = false;
  }

  private onBlockedNativeClick(event: MouseEvent): void {
    if (this.activeTool === "select") return;
    const target = event.target as Element | null;
    if (target?.closest(".canvas-controls, .modern-draw-region-link-icon, .modern-draw-toolbar")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private beginSelection(event: PointerEvent, stroke: InkStroke, point: ScreenPoint): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey && this.selectedStrokeIds.has(stroke.id)) {
      this.selectedStrokeIds.delete(stroke.id);
      this.requestRender();
      return;
    }
    if (!event.shiftKey && !this.selectedStrokeIds.has(stroke.id)) {
      this.selectedStrokeIds.clear();
      this.selectedRegionIds.clear();
    }
    this.selectedStrokeIds.add(stroke.id);
    this.beginSelectionMove(event, point);
  }

  private beginSelectionMove(event: PointerEvent, point: ScreenPoint, allowNativeGesture = false): void {
    this.activePointerId = event.pointerId;
    this.selectionMode = "move";
    this.selectionStart = point;
    this.selectionOriginalSet = cloneStrokes(this.document?.strokes ?? []);
    this.selectionWorkingSet = cloneStrokes(this.document?.strokes ?? []);
    this.allowNativeGesture = allowNativeGesture;
    const cards = allowNativeGesture ? this.selectedCardIds() : new Set<string>();
    this.movingRegions = this.nativeCanvas?.readonly ? [] : this.regionSurface.surface.screenRegions().filter(({ region }) => {
      if (!this.selectedRegionIds.has(region.id)) return false;
      const anchor = region.canvasAnchor;
      return !anchor || !(anchor.kind === "card" ? cards : this.selectedStrokeIds).has(anchor.id);
    });
    this.requestRender();
  }

  private beginNativeLasso(event: PointerEvent, point: ScreenPoint): void {
    this.activePointerId = event.pointerId;
    this.selectionMode = "native-lasso";
    this.selectionStart = point;
    this.nativeMarqueeStart = { x: event.clientX, y: event.clientY };
    this.lassoBaseRegions = event.shiftKey ? new Set(this.selectedRegionIds) : new Set<string>();
    this.selectedRegionIds = new Set(this.lassoBaseRegions);
    this.lassoBaseSelection = event.shiftKey ? new Set(this.selectedStrokeIds) : new Set<string>();
    this.selectedStrokeIds = new Set(this.lassoBaseSelection);
    this.allowNativeGesture = true;
    this.requestRender();
  }

  private beginLasso(event: PointerEvent, point: ScreenPoint): void {
    event.preventDefault();
    event.stopPropagation();
    if (!event.shiftKey) {
      this.nativeCanvas?.deselectAll?.();
      this.selectedStrokeIds.clear();
      this.selectedRegionIds.clear();
    }
    this.wrapper.focus();
    this.activePointerId = event.pointerId;
    this.selectionMode = "lasso";
    this.lassoPath = [point];
    this.screenLasso = [{ x: event.clientX, y: event.clientY }];
    this.requestRender();
  }

  private pointFromEvent(event: PointerEvent): InkPoint {
    const point = this.eventToWorldPoint(event);
    const pressure = event.pressure > 0 ? event.pressure : event.pointerType === "mouse" ? 0.5 : 0.35;
    return { ...point, pressure: Math.max(0.05, Math.min(1, pressure)) };
  }

  private eraseAt(event: PointerEvent): void {
    if (!this.eraserWorkingSet) return;
    const pointer = this.eventToWorldPoint(event);
    const radius = this.dependencies.controller.settings.eraserRadius;
    const retained = this.eraserWorkingSet.filter((stroke) => {
      if (!this.strokeIntersects(stroke, pointer, radius)) return true;
      this.erasedStrokeIds.add(stroke.id);
      return false;
    });
    if (retained.length !== this.eraserWorkingSet.length) {
      this.eraserWorkingSet = retained;
      this.requestRender();
    }
  }

  private strokeIntersects(stroke: InkStroke, pointer: ScreenPoint, radius: number): boolean {
    if (stroke.points.length === 1) {
      return Math.hypot(pointer.x - stroke.points[0].x, pointer.y - stroke.points[0].y) <= radius;
    }
    for (let index = 1; index < stroke.points.length; index += 1) {
      if (distanceToSegment(pointer, stroke.points[index - 1], stroke.points[index]) <= radius + stroke.width / 2) return true;
    }
    return false;
  }

  private hitTestStroke(point: ScreenPoint, radius: number): InkStroke | null {
    const strokes = this.selectionWorkingSet ?? this.document?.strokes ?? [];
    for (let index = strokes.length - 1; index >= 0; index -= 1) {
      if (this.strokeIntersects(strokes[index], point, radius)) return strokes[index];
    }
    return null;
  }

  private strokeBounds(stroke: InkStroke): Rectangle {
    if (stroke.points.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
    let left = stroke.points[0].x;
    let right = left;
    let top = stroke.points[0].y;
    let bottom = top;
    for (const point of stroke.points) {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
      top = Math.min(top, point.y);
      bottom = Math.max(bottom, point.y);
    }
    const padding = stroke.width / 2;
    return { left: left - padding, top: top - padding, right: right + padding, bottom: bottom + padding };
  }

  private eventToWorldPoint(event: PointerEvent): ScreenPoint {
    const wrapperRect = this.wrapper.getBoundingClientRect();
    const transform = getComputedStyle(this.canvasElement).transform;
    const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
    const world = new DOMPoint(event.clientX - wrapperRect.left, event.clientY - wrapperRect.top).matrixTransform(matrix.inverse());
    return { x: world.x, y: world.y };
  }

  private canvasScale(): number {
    const transform = getComputedStyle(this.canvasElement).transform;
    if (transform === "none") return 1;
    return Math.max(0.01, new DOMMatrixReadOnly(transform).a);
  }

  private requestRender(): void {
    if (this.destroyed || this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  private render(): void {
    const strokes = (this.doubleTap.tracking ? null : this.eraserWorkingSet) ?? this.selectionWorkingSet ?? this.document?.strokes ?? [];
    const smoothing = this.dependencies.controller.settings.strokeSmoothing;
    if (strokes !== this.renderedStrokes || smoothing !== this.renderedSmoothing) {
      const previousSmoothing = this.renderedSmoothing;
      const fragment = document.createDocumentFragment();
      for (const stroke of strokes) {
        let path = smoothing === previousSmoothing ? this.strokePaths.get(stroke) : undefined;
        if (!path) {
          path = this.createStrokePath(stroke);
          this.strokePaths.set(stroke, path);
        }
        fragment.appendChild(path);
      }
      this.committedInk.replaceChildren(fragment);
      this.renderedStrokes = strokes;
      this.renderedSmoothing = smoothing;
    }
    this.gestureInk.replaceChildren();
    if (this.activeStroke && !this.doubleTap.tracking) this.gestureInk.appendChild(this.createStrokePath(this.activeStroke));
    if (this.lassoPath.length > 1) {
      const shape = document.createElementNS(SVG_NAMESPACE, "polygon");
      shape.classList.add("modern-draw-canvas-marquee");
      shape.setAttribute("points", this.lassoPath.map(({ x, y }) => `${x},${y}`).join(" "));
      this.gestureInk.appendChild(shape);
    }
    this.syncNativeSelectionBox(strokes);
    this.regionSurface.surface.setSelection(this.selectedRegionIds, this.regionOffsets);
    this.regionSurface.refresh();
  }

  private selectedCardIds(): Set<string> {
    const selection = this.nativeCanvas?.selection;
    return new Set(Array.from(this.nativeCanvas?.nodes ?? []).flatMap(([id, node]) => selection?.has(node) ? [id] : []));
  }

  private regionTargets(): CanvasRegionTarget[] {
    const targets: CanvasRegionTarget[] = [];
    for (const [id, node] of this.nativeCanvas?.nodes ?? []) {
      if (!node.getBBox) continue;
      const { minX, minY, maxX, maxY } = node.getBBox();
      targets.push({ id, kind: "card", bounds: { left: minX, top: minY, right: maxX, bottom: maxY } });
    }
    for (const stroke of this.selectionWorkingSet ?? this.document?.strokes ?? []) {
      if (!stroke.points.length) continue;
      let bounds = this.regionInkBounds.get(stroke);
      if (!bounds) {
        bounds = this.strokeBounds(stroke);
        this.regionInkBounds.set(stroke, bounds);
      }
      targets.push({ id: stroke.id, kind: "ink", bounds });
    }
    return targets;
  }

  private selectedInkBounds(strokes: readonly InkStroke[]): Rectangle | null {
    if (this.selectedStrokeIds.size === 0) return null;
    const selected = strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id));
    if (selected.length === 0) return null;
    const bounds = selected.map((stroke) => rectangleToNativeBounds(this.strokeBounds(stroke))).reduce(mergeNativeBounds);
    return { left: bounds.minX, top: bounds.minY, right: bounds.maxX, bottom: bounds.maxY };
  }

  /**
   * Obsidian owns the Canvas group-selection element and its drag behavior.
   * Feed it the union of native card bounds and selected ink bounds so cards,
   * images, and ink appear in one native selection instead of parallel boxes.
   */
  private syncNativeSelectionBox(strokes: readonly InkStroke[]): void {
    const selectionBox = this.nativeCanvas?.menu?.selection;
    if (!selectionBox) return;
    const inkBounds = this.selectedInkBounds(strokes);
    if (!inkBounds) {
      this.inkOnlySelection.style.display = "none";
      this.restoreNativeSelectionBox();
      return;
    }
    const nativeBounds = this.nativeSelectionBounds();
    if (nativeBounds.length === 0) {
      this.restoreNativeSelectionBox();
      this.updateInkOnlySelectionBox(rectangleToNativeBounds(inkBounds));
      return;
    }
    this.inkOnlySelection.style.display = "none";
    const combined = [...nativeBounds, rectangleToNativeBounds(inkBounds)].reduce(mergeNativeBounds);
    selectionBox.selectionEl.classList.add("modern-draw-combined-selection");
    selectionBox.update(combined);
    this.positionNativeSelectionMenu(combined);
  }

  private updateInkOnlySelectionBox(bounds: NativeCanvasBBox): void {
    const padded = {
      minX: bounds.minX - 10,
      minY: bounds.minY - 10,
      maxX: bounds.maxX + 10,
      maxY: bounds.maxY + 10
    };
    this.inkOnlySelection.style.display = "";
    this.inkOnlySelection.style.transform = `translate(${padded.minX}px, ${padded.minY}px)`;
    this.inkOnlySelection.style.width = `${padded.maxX - padded.minX}px`;
    this.inkOnlySelection.style.height = `${padded.maxY - padded.minY}px`;
  }

  private restoreNativeSelectionBox(): void {
    const selectionBox = this.nativeCanvas?.menu?.selection;
    if (!selectionBox) return;
    selectionBox.selectionEl.classList.remove("modern-draw-combined-selection");
    const nativeBounds = this.nativeSelectionBounds();
    if (nativeBounds.length > 1) {
      const combined = nativeBounds.reduce(mergeNativeBounds);
      selectionBox.update(combined);
      this.positionNativeSelectionMenu(combined);
    } else {
      selectionBox.hide();
      if (nativeBounds.length === 1) this.positionNativeSelectionMenu(nativeBounds[0]);
    }
  }

  private positionNativeSelectionMenu(bounds: NativeCanvasBBox): void {
    const menu = this.nativeCanvas?.menu?.containerEl;
    if (!menu?.isConnected) return;
    const transform = getComputedStyle(this.canvasElement).transform;
    const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
    const scale = Math.max(0.01, matrix.a);
    const anchor = new DOMPoint(
      (bounds.minX + bounds.maxX) / 2,
      bounds.minY - 10 / scale
    ).matrixTransform(matrix);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(10, Math.min(this.wrapper.clientWidth - width - 10, anchor.x - width / 2));
    const top = Math.max(10, Math.min(this.wrapper.clientHeight - height - 10, anchor.y - height));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private nativeSelectionBounds(): NativeCanvasBBox[] {
    const items = Array.from(this.nativeCanvas?.selection ?? []);
    const bounds: NativeCanvasBBox[] = [];
    for (const item of items) {
      const box = item.getBBox();
      if ([box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite)) bounds.push(box);
    }
    return bounds;
  }

  private createStrokePath(stroke: InkStroke): SVGPathElement {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    const points = stroke.points.map(({ x, y }) => ({ x, y }));
    const outline = createStrokeOutline(
      stroke,
      points,
      1,
      this.dependencies.controller.settings.strokeSmoothing,
      this.activeStroke?.id !== stroke.id
    );
    path.setAttribute("d", outlineToSvgPath(outline));
    path.setAttribute("fill", stroke.color);
    if (inkDisplayColor(stroke, true) !== stroke.color) path.dataset.importedNeutralInk = "true";
    path.setAttribute("fill-opacity", String(stroke.opacity));
    path.dataset.strokeId = stroke.id;
    path.dataset.inkTool = stroke.tool;
    return path;
  }

  private undo(): void {
    this.doubleTap.reset();
    if (this.document?.undo()) {
      this.selectedStrokeIds.clear();
      this.selectedRegionIds.clear();
      this.preferInkUndo = true;
      this.requestRender();
    }
  }

  private redo(): void {
    this.doubleTap.reset();
    if (this.document?.redo()) {
      this.selectedStrokeIds.clear();
      this.selectedRegionIds.clear();
      this.preferInkUndo = true;
      this.requestRender();
    }
  }
}

function rectangleToNativeBounds(rectangle: Rectangle): NativeCanvasBBox {
  return {
    minX: rectangle.left,
    minY: rectangle.top,
    maxX: rectangle.right,
    maxY: rectangle.bottom
  };
}

function mergeNativeBounds(first: NativeCanvasBBox, second: NativeCanvasBBox): NativeCanvasBBox {
  return {
    minX: Math.min(first.minX, second.minX),
    minY: Math.min(first.minY, second.minY),
    maxX: Math.max(first.maxX, second.maxX),
    maxY: Math.max(first.maxY, second.maxY)
  };
}

function isPenEraser(event: PointerEvent): boolean {
  return event.button === 5 || (event.buttons & 32) !== 0;
}
