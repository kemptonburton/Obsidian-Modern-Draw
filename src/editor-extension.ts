import { Compartment, EditorSelection, EditorState, Prec, StateEffect, Transaction, type Extension, type SelectionRange, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { invertedEffects, isolateHistory, redo as redoEditor, redoDepth, undo as undoEditor, undoDepth } from "@codemirror/commands";
import { editorInfoField, MarkdownView, Menu, Platform, setIcon, type App, type MarkdownFileInfo } from "obsidian";
import type { ControllerChange, ModernDrawController } from "./controller";
import {
  distanceToSegment,
  lassoIntersects,
  lassoIntersectsRectangle,
  pointInRectangle,
  rectanglesIntersect,
  simplifyPoints,
  STYLUS_SAMPLE_DISTANCE,
  type Rectangle,
  type ScreenPoint
} from "./geometry";
import { mergeSnapshotRegions, type IndexedInkStroke, type InkDocument, type InkStore } from "./ink-store";
import { planHorizontalSpace, type HorizontalSpaceItem } from "./horizontal-space";
import type { SnapshotRegion } from "./snapshot-region";
import type { ScreenSnapshot } from "./snapshot-surface";
import { InkDoubleTap } from "./ink-double-tap";
import { appendStylusEnd, blockPointer, drawingToolForPointer, guardDrawingTouches, isInkDrawingTool, isPalmPointer, pointerSamples, updatePalmRest, type PinchGesture } from "./ink-input";
import { importedPageImages } from "./imported-page";
import { InkControls } from "./ink-controls";
import { createStrokeOutline, inkDisplayColor, outlineToSvgPath } from "./ink-renderer";
import { LocalInkStyle, moveInkPreset, toggleInkPreset, updateInkPreset } from "./ink-style";
import { lassoTextDrop, lassoTextRanges, pointerHitsSelectedText } from "./lasso-text";
import { FloatingImageManager } from "./floating-images";
import { imageDeletionRanges } from "./image-syntax";
import { resolveAnchor } from "./anchors";
import { measureDrawingScale, scaleDrawingContent } from "./drawing-scale";
import { ScaleNoteModal } from "./scale-note-modal";
import { noteLineOffset } from "./note-zoom";
import type { NoteViewStore } from "./note-view";
import { blankLineRemovalRange, markdownSpaceBoundary, removableBlankLinesBefore, spaceAnchorLineDelta, trailingInkSpace, type TrailingInkSpace } from "./markdown-space";
import { fullySelectedLines, textRangeCoversInkLine } from "./text-ink-selection";
import { floatingImagePointerMode } from "./selection-gesture";
import type { registerRegionFeatures } from "./pdf-viewer";
import {
  clampNoteZoom,
  cloneFloatingImages,
  cloneStrokes,
  createStrokeId,
  stepNoteZoom,
  type CanvasLayout,
  type DrawingTool,
  type FloatingImagePlacement,
  type InkPoint,
  type InkStroke,
  type ModernDrawSettings,
  type VerticalSpace
} from "./model";

export type InkEditorAction = "undo" | "redo" | "clear" | "toggle-layout" | "zoom-in" | "zoom-out" | "zoom-reset";
export const inkEditorAction = StateEffect.define<InkEditorAction>();

export interface InkEditorDependencies {
  app: App;
  noteViews: NoteViewStore;
  controller: ModernDrawController;
  store: InkStore;
  regions: ReturnType<typeof registerRegionFeatures>;
  importPdf: (target: MarkdownFileInfo) => void;
  saveSettings: (settings: ModernDrawSettings) => Promise<void>;
}

type SurfaceHistoryAction = { kind: "ink" } | {
  kind: "space";
  from: number;
  inserted: string;
  removed: string;
  beforeStrokes: InkStroke[];
  afterStrokes: InkStroke[];
  beforeImages: FloatingImagePlacement[];
  afterImages: FloatingImagePlacement[];
};
const refreshVerticalSpaces = StateEffect.define<null>();
const continueBelowInk = StateEffect.define<null>();

interface HorizontalSpaceDrag {
  document: InkDocument;
  start: number;
  delta: number;
  minDelta: number;
  originalWidth: number;
  strokeIds: ReadonlySet<string>;
  imageShifts: ReadonlyMap<string, number>;
  regions: readonly SnapshotRegion[];
}

interface CursorInkDrag {
  pointerId: number;
  start: number;
  end: number;
  pointerStart: ScreenPoint;
  moved: boolean;
  finished: boolean;
}

interface NoteZoomAnchor {
  viewportX: number;
  viewportY: number;
  contentX: number;
  contentY: number;
}

interface TextInkEdit {
  document: InkDocument;
  strokes: IndexedInkStroke[];
  restore: boolean;
  regionsBefore?: SnapshotRegion[];
  regionsAfter?: SnapshotRegion[];
  images?: { index: number; image: FloatingImagePlacement }[];
}

const textInkEdit = StateEffect.define<TextInkEdit>();
const INK_SCROLL_BUFFER = 160;
const NOTE_EDIT_EVENTS = ["focusin", "click", "beforeinput", "paste", "cut", "drop"] as const;
const NOTE_POINTER_CONTROLS = "button, a, .clickable-icon, .embed-action, .embed-actions, .image-resize-corner";
const NEXT_CANVAS_LAYOUT: Record<CanvasLayout, CanvasLayout> = { center: "left", left: "left-scroll", "left-scroll": "center" };

export function createInkEditorExtension(dependencies: InkEditorDependencies): Extension {
    const surfaces = new WeakMap<EditorState, InkEditorSurface>();
    const drawingEditability = new Compartment();
    class InkEditorSurface {
      private readonly canvas: HTMLCanvasElement;
      private readonly inkLayer: HTMLDivElement;
      private readonly strokePaths = new WeakMap<InkStroke, { smoothing: number; path: Path2D; bounds: Rectangle }>();
      private readonly strokePointBounds = new WeakMap<InkStroke, Rectangle>();
      private readonly strokeHorizontalExtents = new WeakMap<InkStroke, { left: number; right: number }>();
      private readonly strokeBottoms = new WeakMap<InkStroke, number>();
      private inkTail?: { doc: Text; space?: TrailingInkSpace };
      private importedPages = new Map<string, DOMRect>();
      private readonly doubleTap: InkDoubleTap;
      private readonly palmRest: HTMLDivElement;
      private readonly context: CanvasRenderingContext2D;
      private readonly controls: InkControls;
      private readonly regionSurface: ReturnType<ReturnType<typeof registerRegionFeatures>["attachNote"]>;
      private readonly floatingImages: FloatingImageManager;
      private readonly selectionToolbar: HTMLDivElement;
      private readonly selectionMenu: HTMLDivElement;
      private readonly selectionColorInput: HTMLInputElement;
      private readonly extent: HTMLDivElement;
      private readonly resizeObserver: ResizeObserver;
      private readonly themeObserver: MutationObserver;
      private readonly unsubscribeController: () => void;
      private readonly unsubscribeNoteLayout: () => void;
      private noteLayout: CanvasLayout = "center";
      private readonly detachTouchGuard: () => void;
      private readonly toolSource = {};
      private readonly inkStyle: LocalInkStyle;
      decorations: DecorationSet = Decoration.none;
      private activeTool: DrawingTool;
      private noteZoom = 1;
      private typingLocked = false;
      private typingUpdateQueued = false;

      private document: InkDocument | null = null;
      private unsubscribeDocument: (() => void) | null = null;
      private sourcePath: string | null = null;
      private renderFrame: number | null = null;
      private destroyed = false;
      private activePointerId: number | null = null;
      private activeStroke: InkStroke | null = null;
      private eraserWorkingSet: InkStroke[] | null = null;
      private erasedStrokeIds = new Set<string>();
      private selectedStrokeIds = new Set<string>();
      private readonly selectedRegionIds = new Set<string>();
      private movingRegions: ScreenSnapshot[] = [];
      private regionMoveDelta: ScreenPoint = { x: 0, y: 0 };
      private selectedFloatingImageIds = new Set<string>();
      private selectionWorkingSet: InkStroke[] | null = null;
      private selectionOriginalSet: InkStroke[] | null = null;
      private selectionWorkingImages: FloatingImagePlacement[] | null = null;
      private selectionOriginalImages: FloatingImagePlacement[] | null = null;
      private readonly selectionMovingPages = new Set<string>();
      private selectionStart: ScreenPoint | null = null;
      private selectionMoved = false;
      private selectionMode: "move" | "lasso" | "text-move" | null = null;
      private textDropPosition: number | null = null;
      private lassoPath: ScreenPoint[] = [];
      private lassoAddsToSelection = false;
      private lassoSelectedText = false;
      private trailingInkTapId: number | null = null;
      private cursorInkDrag?: CursorInkDrag;
      private viewportPanStart: {
        clientX: number;
        clientY: number;
        scrollLeft: number;
        scrollTop: number;
      } | null = null;
      private preferInkUndo = false;
      private spaceStart: { lineFrom: number; screenY: number } | null = null;
      private spaceCurrentY: number | null = null;
      private spaceWorkingSet: VerticalSpace[] | null = null;
      private spaceTargetId: string | null = null;
      private spaceOriginalStrokes: InkStroke[] | null = null;
      private spaceOriginalImages: FloatingImagePlacement[] | null = null;
      private readonly spaceAnchorTops = new Map<number, number>();
      private readonly spaceMovingStrokes = new Set<string>();
      private readonly spaceImageShiftFactors = new Map<string, number>();
      private spaceChanged = false;
      private spaceLineDelta = 0;
      private spaceLineHeight = 20;
      private spaceMaxRemovableLines = 0;
      private horizontalSpace: HorizontalSpaceDrag | null = null;
      private spaceDecorationFrame: number | null = null;
      private workspaceOrigin = 0;
      private workspaceWidth = 0;
      private workspaceLeft = 0;
      private alignScrollablePage = false;
      private pinchFrame: number | null = null;
      private pinchZoom?: { zoom: number; anchor: NoteZoomAnchor };
      private surfaceUndoStack: SurfaceHistoryAction[] = [];
      private surfaceRedoStack: SurfaceHistoryAction[] = [];

      constructor(private readonly view: EditorView) {
        surfaces.set(view.state, this);
        this.doubleTap = new InkDoubleTap(view.dom.ownerDocument.defaultView ?? window);
        this.activeTool = "select";
        this.inkStyle = new LocalInkStyle(dependencies.controller.settings);

        this.extent = document.createElement("div");
        this.extent.className = "modern-draw-extent";
        this.extent.setAttribute("aria-hidden", "true");
        view.scrollDOM.appendChild(this.extent);

        this.inkLayer = document.createElement("div");
        this.inkLayer.className = "modern-draw-ink-layer";
        this.inkLayer.setAttribute("aria-hidden", "true");
        this.canvas = document.createElement("canvas");
        this.canvas.className = "modern-draw-overlay";
        this.canvas.setAttribute("aria-hidden", "true");
        const context = this.canvas.getContext("2d");
        if (!context) throw new Error("Modern Draw could not create a 2D canvas context.");
        this.context = context;
        this.inkLayer.appendChild(this.canvas);
        view.scrollDOM.appendChild(this.inkLayer);
        this.palmRest = document.createElement("div");
        this.palmRest.className = "modern-draw-palm-rest";
        this.palmRest.setAttribute("aria-hidden", "true");
        view.dom.appendChild(this.palmRest);

        this.controls = new InkControls(
          {
            setTool: (tool) => this.setActiveTool(tool),
            setColor: (color) => this.applyColor(color),
            setStrokeSize: (size) => this.applyStrokeSize(size),
            setStyle: (tool, style) => {
              this.inkStyle.setColor(tool, style.color);
              this.inkStyle.setWidth(tool, style.width);
              this.setActiveTool(tool);
              this.updateControls();
            },
            recolorSelection: (color) => this.activeTool === "lasso" && this.recolorSelectedStrokes(color),
            togglePinnedStyle: (tool, style) => void dependencies.saveSettings(toggleInkPreset(dependencies.controller.settings, tool, style)),
            updatePinnedStyle: (tool, original, replacement) => void dependencies.saveSettings(
              updateInkPreset(dependencies.controller.settings, tool, original, replacement)
            ),
            movePinnedStyle: (source, before) => {
              const current = dependencies.controller.settings;
              const updated = moveInkPreset(current, source, before);
              if (updated !== current) void dependencies.saveSettings(updated);
            },
            undo: () => this.undo(),
            redo: () => this.redo(),
            toggleLayout: () => this.toggleLayout(),
            zoomIn: () => this.setZoom(stepNoteZoom(this.noteZoom, 1)),
            zoomOut: () => this.setZoom(stepNoteZoom(this.noteZoom, -1)),
            resetZoom: () => this.setZoom(1),
            scaleNote: () => {
              const ink = this.document;
              if (!ink) return;
              new ScaleNoteModal(dependencies.app, dependencies.store, ink.sourcePath,
                () => measureDrawingScale(ink.strokes, ink.floatingImages),
                (factor) => {
                  if (this.document !== ink) throw new Error("Reopen the scale tool in the note you want to scale.");
                  this.scaleNote(factor);
                }).open();
            },
            importPdf: () => {
              const target = this.view.state.field(editorInfoField, false);
              if (target?.file && target.editor) dependencies.importPdf(target);
            }
          },
          {
            includeSpace: true,
            includeHistory: true
          },
          view.dom.ownerDocument
        );
        view.dom.insertBefore(this.controls.root, view.scrollDOM);
        this.regionSurface = dependencies.regions.attachNote(
          view, () => view.state.field(editorInfoField, false)?.file ?? null,
          this.controls.selectionTools, () => 1
        );

        this.floatingImages = new FloatingImageManager(
          view,
          dependencies.app,
          () => this.document,
          () => this.noteZoom,
          () => this.requestRender(),
          (position) => this.renderedVerticalSpaceAt(position),
          (right) => this.previewFloatingExtent(right),
          () => !dependencies.controller.settings.penOnly,
          () => this.activeTool === "select"
        );

        this.selectionToolbar = document.createElement("div");
        this.selectionToolbar.className = "modern-draw-selection-toolbar canvas-menu-container is-hidden";
        this.selectionMenu = document.createElement("div");
        this.selectionMenu.className = "canvas-menu";
        this.selectionMenu.setAttribute("aria-label", "Selected ink actions");
        this.selectionToolbar.appendChild(this.selectionMenu);
        this.selectionToolbar.addEventListener("pointerdown", stopEvent);
        this.selectionToolbar.addEventListener("click", stopEvent);
        this.createSelectionActionButton("trash-2", "Delete selection", () => this.deleteSelectedStrokes());
        this.selectionColorInput = document.createElement("input");
        this.selectionColorInput.className = "modern-draw-selection-color-input";
        this.selectionColorInput.type = "color";
        this.selectionColorInput.setAttribute("aria-label", "Selected ink color");
        this.selectionColorInput.addEventListener("change", () => this.recolorSelectedStrokes(this.selectionColorInput.value));
        this.selectionMenu.appendChild(this.selectionColorInput);
        const paletteButton = this.createSelectionActionButton("palette", "Change selected ink color", () => {
          const colors = new Set(dependencies.controller.settings.penPresets.map(({ color }) => color));
          if (!colors.size) {
            this.selectionColorInput.click();
            return;
          }
          const menu = new Menu();
          for (const color of colors) {
            const title = this.view.dom.ownerDocument.createDocumentFragment();
            const swatch = title.appendChild(document.createElement("span"));
            swatch.className = "modern-draw-color-menu-swatch";
            swatch.style.backgroundColor = color;
            title.append(color);
            menu.addItem((item) => item.setTitle(title).onClick(() => this.recolorSelectedStrokes(color)));
          }
          menu.addSeparator();
          menu.addItem((item) => item.setTitle("Custom color").onClick(() => this.selectionColorInput.click()));
          const bounds = paletteButton.getBoundingClientRect();
          menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, paletteButton.ownerDocument);
        });
        view.dom.appendChild(this.selectionToolbar);

        this.onHostPointerDownCapture = this.onHostPointerDownCapture.bind(this);
        this.onNoteEditEvent = this.onNoteEditEvent.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);
        this.onKeyDownCapture = this.onKeyDownCapture.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.requestRender = this.requestRender.bind(this);

        view.dom.addEventListener("pointerdown", this.onHostPointerDownCapture, true);
        for (const type of NOTE_EDIT_EVENTS) view.dom.addEventListener(type, this.onNoteEditEvent, true);
        this.detachTouchGuard = guardDrawingTouches(view.dom, view.scrollDOM,
          () => this.activeTool === "select" ? { ...dependencies.controller.settings, writingHand: "off" }
            : dependencies.controller.settings,
          () => this.activePointerId !== null,
          (target) => this.isPointerControl(target),
          (gesture) => this.onPinch(gesture),
          () => this.endPinch());
        window.addEventListener("pointermove", this.onPointerMove, true);
        window.addEventListener("pointerup", this.onPointerUp, true);
        window.addEventListener("pointercancel", this.onPointerUp, true);
        view.dom.addEventListener("keydown", this.onKeyDownCapture, true);
        view.scrollDOM.addEventListener("wheel", this.onWheel, { passive: false });
        view.scrollDOM.addEventListener("scroll", this.requestRender, { passive: true });

        this.resizeObserver = new ResizeObserver(() => {
          this.updateNoteWidth();
          this.floatingImages.refresh();
          this.requestRender();
        });
        this.resizeObserver.observe(view.dom);
        this.resizeObserver.observe(this.controls.root);
        this.updateNoteWidth();
        this.themeObserver = new MutationObserver(() => this.requestRender());
        this.themeObserver.observe(view.dom.ownerDocument.body, { attributes: true, attributeFilter: ["class"] });
        this.unsubscribeController = dependencies.controller.subscribe((change) => {
          this.applyControllerChange(change);
          this.updateControls();
          this.requestRender();
        });
        this.unsubscribeNoteLayout = dependencies.noteViews.onLayoutChange((path, layout) => {
          if (path !== this.sourcePath) return;
          this.noteLayout = layout;
          this.alignScrollablePage = layout === "left-scroll";
          this.updateControls();
          this.floatingImages.refresh();
          this.requestRender();
        });

        this.updateControls();
        void this.bindDocument();
        this.requestRender();
      }

      update(update: ViewUpdate): void {
        surfaces.delete(update.startState);
        surfaces.set(update.state, this);
        if (update.docChanged || (update.selectionSet && this.cursorInkDrag?.finished
          && !update.transactions.some((transaction) => transaction.isUserEvent("select.pointer")))) {
          this.cursorInkDrag = undefined;
        }
        if (update.selectionSet) this.requestRender();
        if (update.selectionSet && !update.transactions.some((transaction) => transaction.isUserEvent("select.lasso"))) {
          this.lassoSelectedText = false;
        }
        if (update.docChanged && this.document) {
          this.preferInkUndo = false;
          const oldText = update.startState.doc.toString();
          const newText = update.state.doc.toString();
          const transactions = update.transactions;
          this.document.syncDocumentText(oldText, newText, (position) => mapPosition(position, transactions));
          this.updateControls();
        }

        if (update.docChanged || update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshVerticalSpaces)))) {
          this.rebuildVerticalSpaceDecorations();
        }
        if (update.heightChanged && !this.pinchZoom && !this.spaceStart && this.document?.strokes.length) {
          this.requestVerticalSpaceRefresh();
        }

        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            if (effect.is(inkEditorAction)) this.runAction(effect.value);
            if (effect.is(textInkEdit) && effect.value.document === this.document) {
              this.preferInkUndo = false;
              this.cursorInkDrag = undefined;
              const { document, strokes, restore } = effect.value;
              document.applyTextInkEdit(strokes, restore, update.state.doc.toString());
              document.updateRegions((restore ? effect.value.regionsBefore : effect.value.regionsAfter) ?? [], false);
              if (effect.value.images) {
                const images = effect.value.images;
                const ids = new Set(images.map(({ image }) => image.id));
                const remaining = document.floatingImages.filter((image) => !ids.has(image.id));
                if (restore) for (const { index, image } of images) remaining.splice(index, 0, { ...image,
                  anchor: resolveAnchor(update.state.doc.toString(), image.anchor) });
                document.commitFloatingImages(remaining);
                this.clearSelection();
                this.floatingImages.refresh();
              }
              this.selectedRegionIds.clear();
              this.requestRender();
            }
          }
        }

        const nextPath = this.getSourcePath();
        if (nextPath !== this.sourcePath) void this.bindDocument();
        if (update.geometryChanged || update.viewportChanged || update.docChanged) {
          this.applyLayout();
          this.floatingImages.refresh();
          this.requestRender();
        }
      }

      destroy(): void {
        surfaces.delete(this.view.state);
        this.doubleTap.reset();
        this.destroyed = true;
        this.cancelRender();
        if (this.spaceDecorationFrame !== null) cancelAnimationFrame(this.spaceDecorationFrame);
        this.unsubscribeDocument?.();
        this.unsubscribeController();
        this.unsubscribeNoteLayout();
        this.themeObserver.disconnect();
        this.resizeObserver.disconnect();
        this.view.dom.removeEventListener("pointerdown", this.onHostPointerDownCapture, true);
        for (const type of NOTE_EDIT_EVENTS) this.view.dom.removeEventListener(type, this.onNoteEditEvent, true);
        this.detachTouchGuard();
        window.removeEventListener("pointermove", this.onPointerMove, true);
        window.removeEventListener("pointerup", this.onPointerUp, true);
        window.removeEventListener("pointercancel", this.onPointerUp, true);
        this.view.dom.removeEventListener("keydown", this.onKeyDownCapture, true);
        this.view.scrollDOM.removeEventListener("wheel", this.onWheel);
        this.view.scrollDOM.removeEventListener("scroll", this.requestRender);
        if (this.pinchFrame !== null) cancelAnimationFrame(this.pinchFrame);
        this.extent.remove();
        this.view.scrollDOM.classList.remove("modern-draw-left-overflow", "modern-draw-zoomed");
        this.view.scrollDOM.style.removeProperty("--modern-draw-left-overflow");
        this.view.scrollDOM.style.removeProperty("--modern-draw-guide-inset");
        this.inkLayer.remove();
        this.palmRest.remove();
        this.controls.destroy();
        this.regionSurface.destroy();
        this.floatingImages.destroy();
        this.selectionToolbar.remove();
        this.clearPinnedHeader();
        this.view.scrollDOM.style.removeProperty("--modern-draw-note-zoom");
        this.view.scrollDOM.style.removeProperty("--modern-draw-viewport-top");
        this.view.scrollDOM.style.removeProperty("--modern-draw-note-width");
      }

      private async bindDocument(): Promise<void> {
        this.doubleTap.reset();
        this.floatingImages.focusImage(null);
        this.trailingInkTapId = null;
        this.cursorInkDrag = undefined;
        const sourcePath = this.getSourcePath();
        this.endPinch();
        this.sourcePath = sourcePath;
        const preferences = sourcePath ? dependencies.noteViews.load(sourcePath) : {};
        this.noteLayout = preferences.layout ?? "center";
        this.alignScrollablePage = this.noteLayout === "left-scroll";
        this.applyZoom(preferences.zoom ?? 1);
        this.unsubscribeDocument?.();
        this.unsubscribeDocument = null;
        this.document = null;
        if (!sourcePath) {
          this.updateControls();
          this.requestRender();
          return;
        }

        const document = await dependencies.store.getDocument(sourcePath);
        if (this.destroyed || this.sourcePath !== sourcePath) return;
        this.noteLayout = dependencies.noteViews.initializeLayout(sourcePath, document.canvasLayout ?? "center");
        this.document = document;
        this.clearSelection();
        this.unsubscribeDocument = document.subscribe((persist) => {
          if (!persist) {
            this.surfaceUndoStack = [];
            this.surfaceRedoStack = [];
            const text = this.view.state.doc.toString();
            document.syncDocumentText("", text, (position) => position);
          }
          this.updateControls();
          this.requestVerticalSpaceRefresh();
          this.floatingImages.refresh();
          this.requestRender();
        });
        const currentText = this.view.state.doc.toString();
        document.syncDocumentText("", currentText, (position) => position);
        this.migrateVerticalSpacesToMarkdown();
        this.requestVerticalSpaceRefresh();
        this.updateControls();
        this.floatingImages.refresh();
        this.requestRender();
      }

      /**
       * Older builds stored vertical gaps outside the Markdown document. Turn
       * those gaps into real blank lines once, then remove the legacy records.
       * Negative legacy offsets are discarded because they made lines overlap
       * without creating editable Markdown structure.
       */
      private migrateVerticalSpacesToMarkdown(): void {
        if (!this.document || this.document.verticalSpaces.length === 0) return;
        const lineHeight = Math.max(1, this.view.defaultLineHeight / this.view.scaleY);
        const legacyHeights = new Map<number, number>();
        for (const space of this.document.verticalSpaces) {
          const safePosition = Math.max(0, Math.min(this.view.state.doc.length, space.anchor.pos));
          const line = this.view.state.doc.lineAt(safePosition);
          const position = markdownSpaceBoundary(this.view.state.doc, line.from);
          legacyHeights.set(position, (legacyHeights.get(position) ?? 0) + space.height);
        }

        this.document.commitState(this.document.strokes, this.document.floatingImages, [], false);
        const insertions = Array.from(legacyHeights.entries())
          .map(([from, height]) => ({ from, lineCount: Math.round(height / lineHeight) }))
          .filter(({ lineCount }) => lineCount > 0);
        if (insertions.length === 0) return;
        this.view.dispatch({
          changes: insertions
            .sort((first, second) => first.from - second.from)
            .map(({ from, lineCount }) => ({ from, insert: "\n".repeat(lineCount) })),
          annotations: Transaction.addToHistory.of(false)
        });
      }

      private getSourcePath(): string | null {
        return this.view.state.field(editorInfoField, false)?.file?.path ?? null;
      }

      private createSelectionActionButton(icon: string, label: string, action: () => void): HTMLButtonElement {
        const button = document.createElement("button");
        button.className = "clickable-icon";
        button.type = "button";
        button.setAttribute("aria-label", label);
        button.setAttribute("data-tooltip-position", "top");
        setIcon(button, icon);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          action();
        });
        this.selectionMenu.appendChild(button);
        return button;
      }

      private setActiveTool(tool: DrawingTool): void {
        if (this.activeTool === tool) return;
        this.doubleTap.reset();
        this.doubleTap.remember(tool);
        this.activeTool = tool;
        dependencies.controller.setTool(tool, this.toolSource);
        this.updateControls();
        this.requestRender();
      }

      private applyControllerChange(change: ControllerChange): void {
        if (change.kind !== "tool" || change.source !== undefined || !this.isActivePane()) return;
        const tool = dependencies.controller.activeTool;
        if (tool !== this.activeTool) this.doubleTap.reset();
        this.doubleTap.remember(tool);
        this.activeTool = tool;
      }

      private isActivePane(): boolean {
        return Boolean(this.view.dom.closest(".workspace-leaf.mod-active"));
      }

      private updateControls(): void {
        const tool = this.activeTool;
        if (tool !== "select") {
          this.floatingImages.focusImage(null);
          this.cursorInkDrag = undefined;
          this.trailingInkTapId = null;
        }
        const settings = dependencies.controller.settings;
        this.inkLayer.dataset.tool = tool;
        this.inkLayer.classList.toggle("is-interactive", tool !== "select");
        this.controls.root.classList.toggle("is-hidden", !settings.showToolbar);
        this.inkLayer.classList.toggle("modern-draw-pen-only", settings.penOnly);
        this.updateTypingLock();
        if (!settings.doubleTapToErase) this.doubleTap.reset();
        updatePalmRest(this.palmRest, settings);
        this.applyLayout();
        this.updateWorkspaceExtent();
        this.applyPinnedHeader();
        this.view.requestMeasure();
        this.controls.update({
          tool,
          settings,
          zoom: this.noteZoom,
          canvasLayout: this.canvasLayout(),
          color: this.inkStyle.colorFor(tool),
          strokeSize: this.inkStyle.widthFor(tool),
          canUndo: undoDepth(this.view.state) > 0
            || this.surfaceUndoStack.length > 0
            || Boolean(this.document?.canUndo),
          canRedo: redoDepth(this.view.state) > 0
            || this.surfaceRedoStack.length > 0
            || Boolean(this.document?.canRedo)
        });
      }

      private updateTypingLock(): void {
        if (this.activeTool !== "select") this.blurNoteTypingFocus();
        const locked = this.activeTool !== "select" || this.floatingImages.hasFocusedImage;
        if (this.typingUpdateQueued || this.typingLocked === locked) return;
        this.typingUpdateQueued = true;
        queueMicrotask(() => {
          this.typingUpdateQueued = false;
          const locked = this.activeTool !== "select" || this.floatingImages.hasFocusedImage;
          if (this.destroyed || this.typingLocked === locked) return;
          this.typingLocked = locked;
          this.view.dispatch({
            effects: drawingEditability.reconfigure(locked ? Prec.highest(EditorView.editable.of(false)) : [])
          });
        });
      }

      private isNoteTextInput(target: EventTarget | null): target is HTMLElement {
        return target instanceof HTMLElement && this.view.scrollDOM.contains(target) && (target.isContentEditable
          || target.matches("textarea, input:not([type]), input:is([type=text], [type=search], [type=number], [type=email], [type=url], [type=tel], [type=password])"));
      }

      private blocksNoteFocus(target: HTMLElement): boolean {
        return this.isNoteTextInput(target) || (Platform.isMobile && this.view.contentDOM.contains(target));
      }

      private blurNoteTypingFocus(): void {
        const focused = this.view.dom.ownerDocument.activeElement;
        if (focused instanceof HTMLElement && this.blocksNoteFocus(focused)) focused.blur();
      }

      private onNoteEditEvent(event: Event): void {
        const { target } = event;
        if (!(target instanceof HTMLElement)) return;
        if (this.activeTool === "select") {
          if (!this.floatingImages.hasFocusedImage) return;
          if (event.type === "click") {
            if (!(event instanceof MouseEvent) || event.ctrlKey || event.metaKey || event.altKey
              || !target.closest(".modern-draw-image-focused") || target.closest(NOTE_POINTER_CONTROLS)) return;
            // Obsidian's native image click selects the embed syntax and focuses CodeMirror.
          } else if (event.type !== "beforeinput" || !this.view.contentDOM.contains(target)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (event.type === "focusin") {
          if (!this.blocksNoteFocus(target)) return;
          target.blur();
        } else {
          const textInput = this.isNoteTextInput(target);
          if (!textInput && (event.type === "click" || !this.view.contentDOM.contains(target))) return;
          event.preventDefault();
        }
        event.stopImmediatePropagation();
      }

      private applyLayout(): void {
        this.inkLayer.dataset.layout = this.noteLayout;
      }

      private applyPinnedHeader(): void {
        const enabled = dependencies.controller.settings.pinHeaderDuringHorizontalScroll;
        const offset = enabled ? this.view.scrollDOM.scrollLeft - this.workspaceLeft : 0;
        for (const element of this.headerElements()) {
          element.classList.toggle("modern-draw-pinned-header", enabled);
          if (enabled) element.style.setProperty("translate", `${offset}px 0px`);
          else element.style.removeProperty("translate");
        }
      }

      private clearPinnedHeader(): void {
        for (const element of this.headerElements()) {
          element.classList.remove("modern-draw-pinned-header");
          element.style.removeProperty("translate");
        }
      }

      private headerElements(): HTMLElement[] {
        return Array.from(this.view.dom.querySelectorAll<HTMLElement>(".inline-title, .metadata-container"));
      }

      private applyColor(color: string): void {
        this.inkStyle.setColor(this.activeTool, color);
        this.updateControls();
      }

      private applyStrokeSize(size: number): void {
        this.inkStyle.setWidth(this.activeTool, size);
        this.updateControls();
      }

      private canvasLayout(): CanvasLayout {
        return this.noteLayout;
      }

      private toggleLayout(): void {
        if (!this.document || !this.sourcePath) return;
        this.initializeHorizontalOrigins();
        dependencies.noteViews.saveLayout(this.sourcePath, NEXT_CANVAS_LAYOUT[this.noteLayout]);
      }

      private initializeHorizontalOrigins(): void {
        if (this.view.scrollDOM.clientWidth > 0) {
          this.document?.initializeHorizontalOrigins(this.horizontalOriginWorld());
        }
      }

      private updateNoteWidth(): void {
        const scroll = this.view.scrollDOM;
        const width = this.view.dom.clientWidth - (scroll.offsetWidth - scroll.clientWidth);
        if (width > 0) scroll.style.setProperty("--modern-draw-note-width", `${width}px`);
        const toolbar = this.controls.root;
        scroll.style.setProperty("--modern-draw-viewport-top", `${toolbar.offsetTop + toolbar.offsetHeight}px`);
      }

      private setZoom(value: number, clientX?: number, clientY?: number): void {
        const zoom = clampNoteZoom(value);
        if (zoom === this.noteZoom) return;
        this.applyZoom(zoom, this.captureZoomAnchor(clientX, clientY));
        this.persistZoom();
      }

      private captureZoomAnchor(clientX?: number, clientY?: number): NoteZoomAnchor {
        const viewport = this.view.scrollDOM.getBoundingClientRect();
        const content = this.view.contentDOM.getBoundingClientRect();
        const x = clientX ?? viewport.left + viewport.width / 2;
        const y = clientY ?? viewport.top + viewport.height / 2;
        return {
          viewportX: x - viewport.left,
          viewportY: y - viewport.top,
          contentX: (x - content.left) / this.noteZoom,
          contentY: (y - content.top) / this.noteZoom
        };
      }

      private positionZoomAnchor(anchor: NoteZoomAnchor): void {
        const scroll = this.view.scrollDOM;
        const viewport = scroll.getBoundingClientRect();
        const content = this.view.contentDOM.getBoundingClientRect();
        scroll.scrollLeft += (content.left - viewport.left - anchor.viewportX) / this.noteZoom + anchor.contentX;
        scroll.scrollTop += (content.top - viewport.top - anchor.viewportY) / this.noteZoom + anchor.contentY;
      }

      private applyZoom(zoom: number, anchor?: NoteZoomAnchor): void {
        this.noteZoom = zoom;
        const scroll = this.view.scrollDOM;
        if (zoom === 1) {
          scroll.classList.remove("modern-draw-zoomed");
          scroll.style.removeProperty("--modern-draw-note-zoom");
        } else {
          scroll.style.setProperty("--modern-draw-note-zoom", String(zoom));
          scroll.classList.add("modern-draw-zoomed");
        }
        if (anchor) this.positionZoomAnchor(anchor);
        this.controls.updateZoom(zoom);
        const path = this.sourcePath;
        this.view.requestMeasure({
          key: this,
          read: () => null,
          write: () => queueMicrotask(() => {
            if (this.destroyed || this.sourcePath !== path || this.noteZoom !== zoom) return;
            // Restore the gesture's anchor after CodeMirror adjusts its own scroll position.
            if (anchor) this.positionZoomAnchor(anchor);
            this.floatingImages.refreshLayout();
            this.cancelRender();
            this.render();
          })
        });
        this.requestRender();
      }

      private persistZoom(): void {
        if (this.sourcePath) dependencies.noteViews.saveZoom(this.sourcePath, this.noteZoom);
      }

      private onPinch({ clientX, clientY, deltaX, deltaY, scale }: PinchGesture): void {
        this.doubleTap.reset();
        const pinch = this.pinchZoom ??= {
          zoom: this.noteZoom,
          anchor: this.captureZoomAnchor(clientX - deltaX, clientY - deltaY)
        };
        pinch.zoom = clampNoteZoom(pinch.zoom * scale);
        pinch.anchor.viewportX += deltaX;
        pinch.anchor.viewportY += deltaY;
        if (this.pinchFrame === null) this.pinchFrame = requestAnimationFrame(() => {
          this.pinchFrame = null;
          this.applyZoom(pinch.zoom, pinch.anchor);
          // Flush the new line heights in this frame so CodeMirror's scroll
          // correction and our gesture anchor are resolved before painting.
          this.view.elementAtHeight(0);
        });
      }

      private endPinch(): void {
        const pinch = this.pinchZoom;
        if (!pinch) return;
        if (this.pinchFrame !== null) cancelAnimationFrame(this.pinchFrame);
        this.pinchFrame = null;
        this.pinchZoom = undefined;
        this.applyZoom(pinch.zoom, pinch.anchor);
        this.requestVerticalSpaceRefresh();
        this.persistZoom();
      }

      private onWheel(event: WheelEvent): void {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          this.setZoom(stepNoteZoom(this.noteZoom, event.deltaY < 0 ? 1 : -1), event.clientX, event.clientY);
          return;
        }
        if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          event.preventDefault();
          this.view.scrollDOM.scrollLeft += event.deltaY;
          return;
        }
      }

      private onKeyDownCapture(event: KeyboardEvent): void {
        if (event.key.toLowerCase() === "z" || event.key === "Escape") this.doubleTap.reset();
        const modifier = event.metaKey || event.ctrlKey;
        const { doc, selection } = this.view.state;
        if (this.activeTool === "select" && event.key === "Enter" && !event.isComposing && !modifier && !event.altKey && !event.shiftKey
          && selection.ranges.length === 1 && selection.main.empty && selection.main.head === doc.length
          && doc.line(doc.lines).from === doc.length
          && (event.target as Element | null)?.closest(".cm-content") === this.view.contentDOM
          && this.insertWritingLineBelowInk()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (modifier && event.key.toLowerCase() === "z" && this.preferInkUndo) {
          const canHandle = event.shiftKey
            ? this.surfaceRedoStack.length > 0 || Boolean(this.document?.canRedo)
            : this.surfaceUndoStack.length > 0 || Boolean(this.document?.canUndo);
          if (!canHandle) {
            this.preferInkUndo = false;
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) this.redo();
          else this.undo();
          return;
        }
        const deleteKey = event.key === "Delete" || event.key === "Backspace";
        if (deleteKey && this.cursorInkDrag?.finished && selection.ranges.every((range) => range.empty)
          && !this.view.state.readOnly && this.document) {
          const strokes = this.cursorSelectedInk([]);
          const regions = this.cursorSelectedRegions([]);
          if (strokes.length > 0 || regions.length > 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.view.dispatch({
              effects: textInkEdit.of({
                document: this.document, strokes, restore: false,
                regionsBefore: regions, regionsAfter: regions.map((region) => ({ ...region, deleted: true }))
              }),
              annotations: isolateHistory.of("full"),
              userEvent: "delete"
            });
            return;
          }
        }
        if (this.cursorInkDrag?.finished && (/^Arrow/.test(event.key) || event.key === "Escape"
          || event.key === "Home" || event.key === "End")) {
          this.cursorInkDrag = undefined;
          this.requestRender();
        }
        if (event.key === "Escape" && (this.hasSelection() || this.lassoSelectedText || this.floatingImages.hasFocusedImage)) {
          if (this.lassoSelectedText) {
            this.view.dispatch({ selection: { anchor: this.view.state.selection.main.head } });
          }
          this.clearSelection();
          this.floatingImages.focusImage(null);
          this.updateTypingLock();
          this.requestRender();
          return;
        }
        if (deleteKey && this.hasSelection()
          && !this.view.state.readOnly && !this.view.state.selection.ranges.some((range) => !range.empty)) {
          event.preventDefault();
          event.stopPropagation();
          this.deleteSelectedStrokes();
          return;
        }
        if (this.activeTool !== "select" && (this.view.contentDOM.contains(event.target as Node)
          || this.isNoteTextInput(event.target)) && (deleteKey || event.key === "Enter"
          || !modifier && !event.altKey && event.key.length === 1)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }

      private onDrawingPointerDown(event: PointerEvent): void {
        if (
          (this.activeTool === "space" || this.activeTool === "space-horizontal")
          && (event.pointerType === "touch" || event.pointerType === "mouse" && event.button === 1)
        ) {
          this.beginViewportPan(event);
          return;
        }
        this.beginPointer(event, drawingToolForPointer(this.activeTool, event, dependencies.controller.settings.autoDrawWithPen));
      }

      private beginViewportPan(event: PointerEvent): void {
        if (this.activePointerId !== null) return;
        event.preventDefault();
        event.stopPropagation();
        this.activePointerId = event.pointerId;
        this.viewportPanStart = {
          clientX: event.clientX,
          clientY: event.clientY,
          scrollLeft: this.view.scrollDOM.scrollLeft,
          scrollTop: this.view.scrollDOM.scrollTop
        };
        this.inkLayer.classList.add("modern-draw-is-panning");
      }

      private isPointerControl(target: EventTarget | null): boolean {
        return this.controls.root.contains(target as Node | null) || this.selectionToolbar.contains(target as Node | null);
      }

      private onHostPointerDownCapture(event: PointerEvent): void {
        if (this.isPointerControl(event.target)) {
          const button = (event.target as Element | null)?.closest<HTMLElement>(".modern-draw-button[data-tool]");
          if (button && button.dataset.tool !== "select") this.blurNoteTypingFocus();
          this.doubleTap.reset();
          return;
        }
        if (this.pinchZoom && event.pointerType !== "touch") {
          blockPointer(event);
          return;
        }
        if (this.activeTool !== "select" && event.target instanceof HTMLElement && this.blocksNoteFocus(event.target)) {
          event.preventDefault();
        }
        const settings = dependencies.controller.settings;
        if ((this.activeTool !== "select" && isPalmPointer(event, this.view.scrollDOM, settings))
          || (event.pointerType === "touch" && this.activePointerId !== null)) {
          blockPointer(event);
          return;
        }
        if (this.cursorInkDrag) {
          this.cursorInkDrag = undefined;
          this.requestRender();
        }
        dependencies.controller.setTool(this.activeTool, this.toolSource);
        const selectedTool = this.activeTool;
        const target = event.target as Element | null;
        const control = target?.closest(NOTE_POINTER_CONTROLS);
        if (settings.doubleTapToErase && isInkDrawingTool(selectedTool) && this.document
          && !control
          && pointInRectangle({ x: event.clientX, y: event.clientY }, this.view.scrollDOM.getBoundingClientRect())) {
          this.doubleTap.begin(event);
        } else {
          this.doubleTap.reset();
        }
        const image = selectedTool === "select" && event.button === 0 ? this.floatingImages.focusImage(target) : undefined;
        const imageId = image ? this.floatingImages.placementIdForTarget(image) : null;
        if (image) {
          this.trailingInkTapId = null;
          const { selection } = this.view.state;
          if (selection.ranges.length > 1 || !selection.main.empty) {
            this.view.dispatch({ selection: { anchor: selection.main.head } });
          }
          this.blurNoteTypingFocus();
          if (!control) {
            // Keep keyboard actions in the note while letting the text editor lose focus.
            event.preventDefault();
            if (!image.hasAttribute("tabindex")) image.tabIndex = -1;
            image.focus({ preventScroll: true });
          }
        }
        if (selectedTool === "select") this.updateTypingLock();
        if (event.pointerType === "touch" && settings.penOnly) {
          if (image && !control) this.selectOnlyImage(imageId);
          return;
        }
        if (selectedTool === "lasso" && event.button === 0 && this.document && this.activePointerId === null) {
          const point = this.eventToCanvasPoint(event);
          const bounds = event.shiftKey ? null : this.selectedBounds();
          if (bounds && pointInRectangle(point, bounds, 4) || !event.shiftKey && this.regionSurface.surface.screenRegions()
            .some(({ region, bounds }) => this.selectedRegionIds.has(region.id)
              && pointInRectangle({ x: event.clientX, y: event.clientY }, bounds, 4))) {
            this.beginSelectionMove(event);
          } else if (!event.shiftKey && this.lassoSelectedText && !this.view.state.readOnly
            && pointerHitsSelectedText(this.view, { x: event.clientX, y: event.clientY })) {
            blockPointer(event);
            this.activePointerId = event.pointerId;
            this.selectionMode = "text-move";
            this.selectionStart = point;
            this.inkLayer.classList.add("modern-draw-is-drawing");
          } else {
            this.beginLasso(event);
          }
          return;
        }
        if (selectedTool !== "select"
          && pointInRectangle({ x: event.clientX, y: event.clientY }, this.view.scrollDOM.getBoundingClientRect())) {
          this.onDrawingPointerDown(event);
          return;
        }
        if (selectedTool === "select" && event.button === 0 && this.document) {
          if (control) return;
          if (imageId) {
            const mode = floatingImagePointerMode({
              isSelected: this.selectedFloatingImageIds.has(imageId),
              selectedImageCount: this.selectedFloatingImageIds.size,
              selectedStrokeCount: this.selectedStrokeIds.size,
              shiftKey: event.shiftKey
            });
            if (mode === "toggle" || mode === "group") {
              this.beginImageSelection(event, imageId);
            } else {
              this.selectOnlyImage(imageId);
              // Start the compositor-only path at the outer capture listener,
              // before Obsidian's native image handlers can run. This also
              // guarantees the expensive group-selection renderer is never
              // used for a normal single-image drag.
              this.floatingImages.beginDirectDrag(event);
            }
            return;
          }
          if (image) {
            this.selectOnlyImage(null);
            return;
          }
          const pointer = this.eventToCanvasPoint(event);
          const hit = this.hitTestStroke(pointer, 7);
          const selectionBounds = this.selectedBounds();
          if (hit) this.beginSelection(event, hit);
          else if (selectionBounds && pointInRectangle(pointer, selectionBounds)) this.beginSelectionMove(event);
          else {
            const outline = this.regionSurface.surface.hitSelection({ x: event.clientX, y: event.clientY }, this.selectedRegionIds);
            if (outline) {
              blockPointer(event);
              if (event.shiftKey && this.selectedRegionIds.delete(outline.region.id)) {
                this.requestRender();
                return;
              }
              if (!event.shiftKey && !this.selectedRegionIds.has(outline.region.id)) this.clearSelection();
              this.selectedRegionIds.add(outline.region.id);
              const selection = this.view.state.selection;
              if (selection.ranges.some((range) => !range.empty)) {
                this.view.dispatch({ selection: { anchor: selection.main.head } });
              }
              this.view.focus();
              this.beginSelectionMove(event);
              return;
            }
            if (this.hasSelection()) {
              this.clearSelection();
              this.requestRender();
            }
            this.beginCursorInkDrag(event);
            if (this.isBelowTrailingInk(event)) this.trailingInkTapId = event.pointerId;
          }
        }
      }

      private beginCursorInkDrag(event: PointerEvent): void {
        if (!event.isPrimary || event.pointerType !== "mouse" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        const viewport = this.view.scrollDOM.getBoundingClientRect();
        const pointerStart = { x: event.clientX, y: event.clientY };
        if (!pointInRectangle(pointerStart, viewport)) return;
        const start = event.clientY - viewport.top + this.view.scrollDOM.scrollTop * this.noteZoom;
        this.cursorInkDrag = { pointerId: event.pointerId, start, end: start, pointerStart, moved: false, finished: false };
      }

      private updateCursorInkDrag(event: PointerEvent): void {
        const drag = this.cursorInkDrag;
        if (!drag || drag.pointerId !== event.pointerId || drag.finished) return;
        const viewport = this.view.scrollDOM.getBoundingClientRect();
        drag.end = Math.max(viewport.top, Math.min(viewport.bottom, event.clientY)) - viewport.top
          + this.view.scrollDOM.scrollTop * this.noteZoom;
        drag.moved ||= Math.hypot(event.clientX - drag.pointerStart.x, event.clientY - drag.pointerStart.y) > 4;
        if (drag.moved) this.requestRender();
      }

      private beginPointer(event: PointerEvent, tool: DrawingTool): void {
        if (!this.document || this.activePointerId !== null || tool === "select" || tool === "lasso") return;
        if (tool === "space-horizontal" && this.view.state.readOnly) return;
        if (event.pointerType === "touch" && dependencies.controller.settings.penOnly) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.activePointerId = event.pointerId;
        this.inkLayer.classList.add("modern-draw-is-drawing");

        if (tool === "space") {
          const anchor = this.anchorAt(event);
          this.beginSpaceDrag(event, anchor);
          return;
        }
        if (tool === "space-horizontal") {
          this.beginHorizontalSpace(event, this.document);
          return;
        }

        if (tool === "eraser") {
          this.eraserWorkingSet = [...this.document.strokes];
          this.eraseAt(event);
          return;
        }

        const anchor = this.anchorAt(event);
        const horizontalOrigin = this.horizontalOriginWorld();
        this.measureImportedPages();
        const page = Array.from(this.importedPages).find(([, bounds]) => (
          event.clientX >= bounds.left && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom
        ));
        const contentLeft = this.view.contentDOM.getBoundingClientRect().left;
        const pageAnchor = page && page[1].width > 0 ? {
          name: page[0],
          x: (page[1].left - contentLeft) / this.noteZoom,
          y: (page[1].top - anchor.screenTop) / this.noteZoom,
          width: page[1].width / this.noteZoom
        } : undefined;
        this.activeStroke = {
          page: pageAnchor,
          id: createStrokeId(),
          tool,
          stylus: event.pointerType === "pen" ? true : undefined,
          pressureSensitive: tool === "pen" && event.pointerType === "pen" && !dependencies.controller.settings.stylusPressure ? false : undefined,
          color: this.inkStyle.colorFor(tool),
          width: this.inkStyle.widthFor(tool),
          opacity: tool === "highlighter" ? 0.32 : 1,
          horizontalOrigin,
          anchor: { pos: anchor.pos, lineText: anchor.lineText },
          points: [this.pointFromEvent(event, anchor.screenTop)]
        };
        this.requestRender();
      }

      private beginSpaceDrag(
        event: PointerEvent,
        anchor: { pos: number; lineText: string; screenTop: number }
      ): void {
        if (!this.document) return;
        const lineFrom = markdownSpaceBoundary(this.view.state.doc, anchor.pos);
        const line = this.view.state.doc.lineAt(lineFrom);
        this.spaceStart = { lineFrom, screenY: event.clientY };
        this.spaceCurrentY = event.clientY;
        this.spaceTargetId = createStrokeId();
        this.spaceLineHeight = Math.max(1, this.view.defaultLineHeight / this.view.scaleY);
        this.spaceMaxRemovableLines = removableBlankLinesBefore(this.view.state.doc, lineFrom);
        this.spaceLineDelta = 0;
        this.spaceWorkingSet = [{
          id: this.spaceTargetId,
          anchor: { pos: lineFrom, lineText: line.text },
          height: 0
        }];

        this.spaceOriginalStrokes = cloneStrokes(this.document.strokes);
        this.spaceOriginalImages = cloneFloatingImages(this.document.floatingImages);
        this.spaceAnchorTops.clear();
        this.spaceMovingStrokes.clear();
        this.spaceImageShiftFactors.clear();
        const viewport = this.view.scrollDOM.getBoundingClientRect();
        const barY = event.clientY - viewport.top;
        const scrollTop = this.view.scrollDOM.scrollTop * this.noteZoom;
        for (const stroke of this.document.strokes) {
          if (!this.spaceAnchorTops.has(stroke.anchor.pos)) {
            this.spaceAnchorTops.set(stroke.anchor.pos, this.anchorScreenTop(stroke.anchor.pos) - viewport.top + scrollTop);
          }
          if (this.strokeBounds(stroke).top >= barY) this.spaceMovingStrokes.add(stroke.id);
        }
        const imageBounds = new Map(
          this.floatingImages.selectionItems(this.view.scrollDOM.getBoundingClientRect())
            .map((item) => [item.id, item.bounds] as const)
        );
        for (const image of this.document.floatingImages) {
          const shouldMove = (imageBounds.get(image.id)?.top ?? -Infinity) >= barY;
          const naturallyMoves = image.anchor.pos >= lineFrom;
          const factor = Number(shouldMove) - Number(naturallyMoves);
          if (factor !== 0) this.spaceImageShiftFactors.set(image.id, factor);
        }
        this.spaceChanged = false;
        this.requestVerticalSpaceRefresh();
        this.requestRender();
      }

      private beginHorizontalSpace(event: PointerEvent, document: InkDocument): void {
        const viewport = this.view.scrollDOM.getBoundingClientRect();
        const contentLeft = this.view.contentDOM.getBoundingClientRect().left;
        const scale = this.noteZoom;
        const origin = this.horizontalOriginWorld();
        const start = (event.clientX - contentLeft) / scale;
        const items: HorizontalSpaceItem[] = [];
        for (const stroke of document.strokes) {
          // Ink pinned to an imported page follows its image.
          if (stroke.page || !stroke.points.length) continue;
          const { left, right } = this.strokeHorizontalExtent(stroke);
          const base = stroke.horizontalOrigin ?? origin;
          items.push({ id: stroke.id, kind: "stroke", left: left - base - stroke.width / 2,
            right: right - base + stroke.width / 2 });
        }
        const imageWidths = new Map(this.floatingImages.selectionItems(viewport)
          .map(({ id, bounds }) => [id, (bounds.right - bounds.left) / scale]));
        const imageIds = new Set<string>();
        for (const { id, x, width } of document.floatingImages) {
          imageIds.add(id);
          items.push({ id, kind: "image", left: x, right: x + (width ?? imageWidths.get(id) ?? 300) });
        }
        const regions = this.regionSurface.surface.screenRegions(true).map(({ region }) => region);
        for (const region of regions) {
          if (region.noteImageAnchor && imageIds.has(region.noteImageAnchor.id)) continue;
          items.push({ id: region.id, kind: "region", left: region.bounds.left, right: region.bounds.right });
        }

        const plan = planHorizontalSpace(items, start, -origin / scale);
        if (!plan.moving.length) return;
        const strokeIds = new Set<string>();
        const imageShifts = new Map<string, number>();
        const regionIds = new Set<string>();
        for (const { id, kind } of plan.moving) {
          if (kind === "stroke") strokeIds.add(id);
          else if (kind === "image") imageShifts.set(id, 1);
          else regionIds.add(id);
        }
        this.horizontalSpace = {
          document, start, delta: 0, minDelta: plan.minDelta, originalWidth: this.workspaceWidth, strokeIds, imageShifts,
          regions: regions.filter((region) => regionIds.has(region.id)
            || (region.noteImageAnchor && imageShifts.has(region.noteImageAnchor.id)))
        };
        this.requestRender();
      }

      private moveHorizontalSpace(event: PointerEvent, drag: HorizontalSpaceDrag): void {
        const scroll = this.view.scrollDOM;
        const viewport = scroll.getBoundingClientRect();
        if (event.clientX > viewport.right - 44) scroll.scrollLeft += 18;
        else if (event.clientX < viewport.left + 44) scroll.scrollLeft -= 18;
        const position = (event.clientX - this.view.contentDOM.getBoundingClientRect().left) / this.noteZoom;
        drag.delta = Math.max(drag.minDelta, position - drag.start);
        this.floatingImages.showSpaceShift(drag.imageShifts, { x: drag.delta, y: 0 });
        this.requestRender();
      }

      private commitHorizontalSpace(drag: HorizontalSpaceDrag): void {
        const { document, delta, strokeIds, imageShifts } = drag;
        if (document !== this.document || Math.abs(delta * this.noteZoom) < 1) return;
        const strokes = document.strokes.map((stroke) => strokeIds.has(stroke.id) ? {
          ...stroke, points: stroke.points.map((point) => ({ ...point, x: point.x + delta }))
        } : stroke);
        const images = document.floatingImages.map((image) => imageShifts.has(image.id) ? { ...image, x: image.x + delta } : image);
        const moved = drag.regions.map((region) => ({
          ...region, bounds: { ...region.bounds, left: region.bounds.left + delta, right: region.bounds.right + delta }
        }));
        document.commitState(strokes, images, document.verticalSpaces, true, mergeSnapshotRegions(document.snapshotRegions, moved));
        this.recordSurfaceAction({ kind: "ink" });
        this.preferInkUndo = true;
        this.clearSelection();
      }

      private onPointerMove(event: PointerEvent): void {
        this.updateCursorInkDrag(event);
        const tapBecameStroke = this.doubleTap.move(event);
        if (event.pointerId !== this.activePointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.viewportPanStart) {
          this.view.scrollDOM.scrollLeft = this.viewportPanStart.scrollLeft
            - (event.clientX - this.viewportPanStart.clientX) / this.noteZoom;
          this.view.scrollDOM.scrollTop = this.viewportPanStart.scrollTop
            - (event.clientY - this.viewportPanStart.clientY) / this.noteZoom;
          this.requestRender();
          return;
        }
        if (this.selectionMode === "lasso") {
          const point = this.eventToCanvasPoint(event);
          const previous = this.lassoPath[this.lassoPath.length - 1];
          if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) this.lassoPath.push(point);
          this.requestRender();
          return;
        }
        if (this.horizontalSpace) {
          this.moveHorizontalSpace(event, this.horizontalSpace);
          return;
        }
        if (event.pointerType !== "pen" || (!this.activeStroke && !this.eraserWorkingSet)) this.autoPan(event);
        if (this.selectionMode === "text-move" && this.selectionStart) {
          const point = this.eventToCanvasPoint(event);
          this.textDropPosition = Math.hypot(point.x - this.selectionStart.x, point.y - this.selectionStart.y) > 3
            ? this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false) : null;
          this.requestRender();
          return;
        }
        if (
          this.selectionMode === "move"
          && this.selectionWorkingSet
          && this.selectionOriginalSet
          && this.selectionWorkingImages
          && this.selectionOriginalImages
          && this.selectionStart
        ) {
          const current = this.eventToCanvasPoint(event);
          const renderedDeltaX = current.x - this.selectionStart.x;
          const renderedDeltaY = current.y - this.selectionStart.y;
          const deltaX = renderedDeltaX / this.noteZoom;
          const deltaY = renderedDeltaY / this.noteZoom;
          this.selectionMoved = Math.hypot(deltaX, deltaY) > 1;
          this.regionMoveDelta = { x: renderedDeltaX, y: renderedDeltaY };
          for (let strokeIndex = 0; strokeIndex < this.selectionWorkingSet.length; strokeIndex += 1) {
            const stroke = this.selectionWorkingSet[strokeIndex];
            if (!this.selectedStrokeIds.has(stroke.id)) continue;
            // Page-relative ink already moves with its selected page image.
            if (stroke.page && this.selectionMovingPages.has(stroke.page.name)) continue;
            const original = this.selectionOriginalSet[strokeIndex];
            const page = stroke.page && this.importedPages.get(stroke.page.name);
            const scale = page && stroke.page ? page.width / stroke.page.width : this.noteZoom;
            for (let pointIndex = 0; pointIndex < stroke.points.length; pointIndex += 1) {
              stroke.points[pointIndex].x = original.points[pointIndex].x + renderedDeltaX / scale;
              stroke.points[pointIndex].y = original.points[pointIndex].y + renderedDeltaY / scale;
            }
          }
          for (let imageIndex = 0; imageIndex < this.selectionWorkingImages.length; imageIndex += 1) {
            const image = this.selectionWorkingImages[imageIndex];
            if (!this.selectedFloatingImageIds.has(image.id)) continue;
            const original = this.selectionOriginalImages[imageIndex];
            image.x = original.x + deltaX;
            image.y = original.y + deltaY;
          }
          this.floatingImages.showSelection(this.selectedFloatingImageIds, {
            x: deltaX,
            y: deltaY
          });
          this.requestRender();
          return;
        }
        if (
          this.spaceStart
          && this.spaceWorkingSet
          && this.spaceOriginalImages
          && this.spaceTargetId
        ) {
          const requestedDelta = (event.clientY - this.spaceStart.screenY) / this.noteZoom;
          const requestedLines = Math.round(requestedDelta / this.spaceLineHeight);
          this.spaceLineDelta = Math.max(-this.spaceMaxRemovableLines, Math.min(2_500, requestedLines));
          const appliedDelta = this.spaceLineDelta * this.spaceLineHeight;
          this.spaceCurrentY = this.spaceStart.screenY + appliedDelta * this.noteZoom;
          this.spaceWorkingSet = this.spaceWorkingSet.map((space) =>
            space.id === this.spaceTargetId ? { ...space, height: appliedDelta } : space
          );
          this.spaceChanged = this.spaceLineDelta !== 0;
          this.floatingImages.showSpaceShift(this.spaceImageShiftFactors, { x: 0, y: appliedDelta });
          this.requestVerticalSpaceRefresh();
          this.requestRender();
          return;
        }
        if (this.eraserWorkingSet) {
          if (tapBecameStroke) this.requestRender();
          this.eraseAt(event);
          return;
        }
        if (!this.activeStroke) return;
        const anchorTop = this.anchorScreenTop(this.activeStroke.anchor.pos);
        const samples = pointerSamples(event);
        for (const sample of samples) {
          this.activeStroke.points.push(this.pointFromEvent(sample, anchorTop, this.activeStroke.horizontalOrigin));
        }
        this.requestRender();
      }

      private onPointerUp(event: PointerEvent): void {
        this.updateCursorInkDrag(event);
        const drag = this.cursorInkDrag?.pointerId === event.pointerId ? this.cursorInkDrag : undefined;
        if (drag) {
          if (drag.moved && event.type === "pointerup") drag.finished = true;
          else this.cursorInkDrag = undefined;
        }
        const tap = this.doubleTap.finish(event);
        if (tap === "double") this.setActiveTool(this.doubleTap.switchFrom(this.activeTool));
        if (this.trailingInkTapId === event.pointerId) {
          this.trailingInkTapId = null;
          const document = this.document;
          const text = this.view.state.doc;
          if (!drag?.moved && event.type === "pointerup" && tap !== "double") {
            this.doubleTap.commit(tap, () => queueMicrotask(() => {
              if (!this.destroyed && this.activeTool === "select" && document === this.document
                && text === this.view.state.doc && this.insertWritingLineBelowInk()) {
                this.clearSelection();
                this.view.focus();
              }
            }));
          }
        }
        if (event.pointerId !== this.activePointerId) {
          if (tap === "double") blockPointer(event);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (tap !== "double" && this.selectionMode === "lasso" && event.type === "pointerup") {
          this.lassoPath.push(this.eventToCanvasPoint(event));
          const viewport = this.view.scrollDOM.getBoundingClientRect();
          const screenPath = this.lassoPath.map(({ x, y }) => ({ x: x + viewport.left, y: y + viewport.top }));
          for (const { region, bounds } of this.regionSurface.surface.screenRegions()) {
            if (lassoIntersectsRectangle(screenPath, bounds)) this.selectedRegionIds.add(region.id);
          }
          for (const stroke of this.document?.strokes ?? []) {
            if (lassoIntersects(this.lassoPath, this.toCanvasPoints(stroke))) this.selectedStrokeIds.add(stroke.id);
          }
          for (const image of this.floatingImages.selectionItems(viewport)) {
            if (lassoIntersectsRectangle(this.lassoPath, image.bounds)) this.selectedFloatingImageIds.add(image.id);
          }
          this.floatingImages.showSelection(this.selectedFloatingImageIds);
          const ranges = lassoTextRanges(this.view, this.lassoPath, viewport);
          if (this.lassoAddsToSelection) {
            ranges.push(...this.view.state.selection.ranges.filter((range) => !range.empty));
          }
          this.lassoSelectedText = ranges.length > 0;
          if (this.lassoSelectedText && !Platform.isMobile) this.view.focus();
          this.view.dispatch({
            selection: ranges.length ? EditorSelection.create(ranges) : { anchor: this.view.state.selection.main.head },
            userEvent: "select.lasso"
          });
        } else if (tap !== "double" && this.selectionMode === "text-move" && event.type === "pointerup"
          && this.lassoSelectedText && this.textDropPosition !== null) {
          const pointer = { x: event.clientX, y: event.clientY };
          const viewport = this.view.scrollDOM.getBoundingClientRect();
          const position = pointInRectangle(pointer, viewport) ? this.view.posAtCoords(pointer, false) : null;
          const drop = position === null ? undefined : lassoTextDrop(this.view.state, position);
          if (drop) {
            this.view.dispatch(drop);
            this.lassoSelectedText = true;
          }
        }

        if (this.horizontalSpace) {
          if (event.type !== "pointercancel") this.commitHorizontalSpace(this.horizontalSpace);
        } else if (
          tap !== "double"
          && event.type !== "pointercancel"
          && this.spaceStart
          && this.document
          && this.spaceChanged
          && this.spaceWorkingSet
          && this.spaceOriginalStrokes
          && this.spaceOriginalImages
        ) {
          const boundary = this.spaceStart.lineFrom;
          const lineDelta = this.spaceLineDelta;
          const removal = lineDelta < 0
            ? blankLineRemovalRange(this.view.state.doc, boundary, -lineDelta)
            : null;
          const from = removal?.from ?? boundary;
          const to = removal?.to ?? boundary;
          const inserted = lineDelta > 0 ? "\n".repeat(lineDelta) : "";
          const removed = this.view.state.doc.sliceString(from, to);
          const afterStrokes = cloneStrokes(this.spaceOriginalStrokes);
          for (const stroke of afterStrokes) {
            if (stroke.page) continue;
            const desired = this.spaceMovingStrokes.has(stroke.id) ? lineDelta : 0;
            const natural = spaceAnchorLineDelta(this.view.state.doc, stroke.anchor.pos, boundary, lineDelta, removal);
            const correction = (desired - natural) * this.spaceLineHeight;
            if (correction !== 0) for (const point of stroke.points) point.y += correction;
          }
          const afterImages = cloneFloatingImages(this.spaceOriginalImages);
          for (const image of afterImages) {
            image.y += lineDelta * this.spaceLineHeight * (this.spaceImageShiftFactors.get(image.id) ?? 0);
          }
          // Clear the temporary pixel preview before committing real Markdown.
          this.spaceWorkingSet = null;
          if (inserted.length > 0 || removed.length > 0) {
            const action: SurfaceHistoryAction = {
              kind: "space",
              from,
              inserted,
              removed,
              beforeStrokes: this.spaceOriginalStrokes,
              afterStrokes,
              beforeImages: this.spaceOriginalImages,
              afterImages
            };
            this.document.commitState(action.afterStrokes, action.afterImages, [], false);
            this.view.dispatch({
              changes: { from, to, insert: inserted },
              annotations: Transaction.addToHistory.of(false),
              userEvent: inserted.length > 0 ? "input" : "delete"
            });
            this.recordSurfaceAction(action);
            this.preferInkUndo = true;
          }
        } else if (tap !== "double" && event.type === "pointerup" && this.document && this.selectionMoved) {
          const nextStrokes = this.selectionWorkingSet ?? this.document.strokes;
          const nextImages = this.selectionWorkingImages ?? this.document.floatingImages;
          const moved = this.movingRegions.map((snapshot) => this.regionSurface.surface.moveFrom(
            snapshot, this.regionMoveDelta.x, this.regionMoveDelta.y
          ));
          this.document.commitState(nextStrokes, nextImages, this.document.verticalSpaces, true,
            mergeSnapshotRegions(this.document.snapshotRegions, moved));
          this.recordSurfaceAction({ kind: "ink" });
          this.preferInkUndo = true;
        } else if (this.document && this.activeStroke) {
          const ink = this.document;
          const stroke = this.activeStroke;
          if (stroke.stylus && event.type === "pointerup") {
            appendStylusEnd(stroke.points, this.pointFromEvent(event, this.anchorScreenTop(stroke.anchor.pos), stroke.horizontalOrigin));
          }
          stroke.points = simplifyPoints(stroke.points, stroke.stylus ? STYLUS_SAMPLE_DISTANCE : undefined);
          this.doubleTap.commit(tap, () => {
            this.doubleTap.remember(stroke.tool);
            ink.append(stroke);
            this.recordSurfaceAction({ kind: "ink" });
            this.clearSelection();
            this.preferInkUndo = true;
          });
        } else if (this.document && this.erasedStrokeIds.size > 0) {
          const ink = this.document;
          const erased = this.erasedStrokeIds;
          this.doubleTap.commit(tap, () => {
            if (!ink.eraseStrokes(erased)) return;
            this.recordSurfaceAction({ kind: "ink" });
            this.clearSelection();
            this.preferInkUndo = true;
          });
        }

        if (this.selectionMode === "move" && this.selectedFloatingImageIds.size > 0) {
          requestAnimationFrame(() => {
            this.floatingImages.showSelection(this.selectedFloatingImageIds);
            this.requestRender();
          });
        }
        if (this.spaceStart || this.horizontalSpace) {
          this.floatingImages.showSpaceShift(new Map());
          this.floatingImages.refresh();
        }
        this.activePointerId = null;
        this.activeStroke = null;
        this.eraserWorkingSet = null;
        this.erasedStrokeIds = new Set();
        this.selectionWorkingSet = null;
        this.selectionOriginalSet = null;
        this.selectionWorkingImages = null;
        this.selectionOriginalImages = null;
        this.selectionMovingPages.clear();
        this.selectionStart = null;
        this.selectionMoved = false;
        this.selectionMode = null;
        this.movingRegions = [];
        this.regionMoveDelta = { x: 0, y: 0 };
        this.textDropPosition = null;
        this.lassoPath = [];
        this.viewportPanStart = null;
        this.horizontalSpace = null;
        this.spaceStart = null;
        this.spaceCurrentY = null;
        this.spaceWorkingSet = null;
        this.spaceTargetId = null;
        this.spaceOriginalStrokes = null;
        this.spaceOriginalImages = null;
        this.spaceAnchorTops.clear();
        this.spaceMovingStrokes.clear();
        this.spaceImageShiftFactors.clear();
        this.spaceChanged = false;
        this.spaceLineDelta = 0;
        this.spaceLineHeight = 20;
        this.spaceMaxRemovableLines = 0;
        this.requestVerticalSpaceRefresh();
        this.inkLayer.classList.remove("modern-draw-is-drawing", "modern-draw-is-panning");
        this.requestRender();
      }

      private beginSelection(event: PointerEvent, stroke: InkStroke): void {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey && this.selectedStrokeIds.has(stroke.id)) {
          this.selectedStrokeIds.delete(stroke.id);
          this.requestRender();
          return;
        }
        if (!event.shiftKey && !this.selectedStrokeIds.has(stroke.id)) this.clearSelection();
        this.selectedStrokeIds.add(stroke.id);
        this.beginSelectionMove(event);
      }

      private beginImageSelection(event: PointerEvent, imageId: string): void {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey && this.selectedFloatingImageIds.has(imageId)) {
          this.selectedFloatingImageIds.delete(imageId);
          this.floatingImages.showSelection(this.selectedFloatingImageIds);
          this.requestRender();
          return;
        }
        if (!event.shiftKey && !this.selectedFloatingImageIds.has(imageId)) this.clearSelection();
        this.selectedFloatingImageIds.add(imageId);
        this.floatingImages.showSelection(this.selectedFloatingImageIds);
        this.beginSelectionMove(event);
      }

      private beginSelectionMove(event: PointerEvent): void {
        blockPointer(event);
        this.activePointerId = event.pointerId;
        this.selectionStart = this.eventToCanvasPoint(event);
        this.selectionOriginalSet = cloneStrokes(this.document?.strokes ?? []);
        this.selectionWorkingSet = cloneStrokes(this.document?.strokes ?? []);
        this.selectionOriginalImages = cloneFloatingImages(this.document?.floatingImages ?? []);
        this.selectionWorkingImages = cloneFloatingImages(this.document?.floatingImages ?? []);
        if (this.selectedFloatingImageIds.size > 0) {
          for (const [name, image] of importedPageImages(this.view.contentDOM)) {
            const id = this.floatingImages.placementIdForTarget(image);
            if (id && this.selectedFloatingImageIds.has(id)) this.selectionMovingPages.add(name);
          }
        }
        const viewport = this.view.scrollDOM.getBoundingClientRect();
        this.movingRegions = this.view.state.readOnly ? [] : this.regionSurface.surface.screenRegions().filter(({ region, bounds }) => {
          if (region.noteImageAnchor && this.selectedFloatingImageIds.has(region.noteImageAnchor.id)) return false;
          if (this.selectedRegionIds.has(region.id)) return true;
          if (!this.selectedStrokeIds.size) return false;
          const captured = (this.document?.strokes ?? []).filter((stroke) => stroke.points.length > 0
            && this.toCanvasPoints(stroke).every(({ x, y }) => pointInRectangle({ x: x + viewport.left, y: y + viewport.top }, bounds)));
          return captured.length > 0 && captured.every(({ id }) => this.selectedStrokeIds.has(id));
        });
        this.selectionMoved = false;
        this.selectionMode = "move";
        this.inkLayer.classList.add("modern-draw-is-drawing");
        this.requestRender();
      }

      private beginLasso(event: PointerEvent): void {
        event.preventDefault();
        event.stopPropagation();
        if (!event.shiftKey) this.clearSelection();
        this.activePointerId = event.pointerId;
        this.selectionMode = "lasso";
        this.lassoAddsToSelection = event.shiftKey;
        this.lassoPath = [this.eventToCanvasPoint(event)];
        this.inkLayer.classList.add("modern-draw-is-drawing");
        this.requestRender();
      }

      private hasSelection(): boolean {
        return this.selectedStrokeIds.size > 0 || this.selectedFloatingImageIds.size > 0 || this.selectedRegionIds.size > 0;
      }

      private selectOnlyImage(imageId: string | null): void {
        if (imageId
          ? this.selectedFloatingImageIds.size === 1 && this.selectedFloatingImageIds.has(imageId)
            && !this.selectedStrokeIds.size && !this.selectedRegionIds.size
          : !this.hasSelection()) return;
        this.clearSelection();
        if (imageId) {
          this.selectedFloatingImageIds.add(imageId);
          this.floatingImages.showSelection(this.selectedFloatingImageIds);
        }
        this.requestRender();
      }

      private clearSelection(): void {
        this.selectedRegionIds.clear();
        this.selectedStrokeIds.clear();
        this.selectedFloatingImageIds.clear();
        this.floatingImages.showSelection(this.selectedFloatingImageIds);
      }

      private deleteSelectedStrokes(): void {
        if (!this.document || this.view.state.readOnly || !this.hasSelection()) return;
        const selectedRegions = this.regionSurface.surface.screenRegions()
          .flatMap(({ region }) => this.selectedRegionIds.has(region.id) ? [region] : []);
        const regions = selectedRegions.map((region) => ({ ...region, deleted: true }));
        const document = this.document;
        const images = document.floatingImages.flatMap((image, index) => this.selectedFloatingImageIds.has(image.id)
          ? [{ index, image: cloneFloatingImages([image])[0] }] : []);
        if (images.length > 0) {
          this.view.dispatch({
            changes: imageDeletionRanges(this.view.state.doc.toString(), images.map(({ image }) => image)).map((range) => ({ ...range, insert: "" })),
            effects: textInkEdit.of({ document,
              strokes: document.strokes.flatMap((stroke, index) => this.selectedStrokeIds.has(stroke.id) ? [{ stroke, index }] : []),
              restore: false, images, regionsBefore: selectedRegions, regionsAfter: regions }),
            annotations: isolateHistory.of("full"),
            userEvent: "delete"
          });
          return;
        }
        document.commitState(document.strokes.filter(({ id }) => !this.selectedStrokeIds.has(id)),
          document.floatingImages, document.verticalSpaces, true, mergeSnapshotRegions(document.snapshotRegions, regions));
        this.recordSurfaceAction({ kind: "ink" });
        this.selectedStrokeIds.clear();
        this.selectedRegionIds.clear();
        this.preferInkUndo = true;
        this.requestRender();
      }

      private scaleNote(factor: number): void {
        const ink = this.document;
        if (!ink || this.view.state.readOnly || factor === 1) return;
        const anchors = [...ink.strokes.map((stroke) => stroke.anchor), ...ink.floatingImages.map((image) => image.anchor),
          ...ink.snapshotRegions.flatMap((region) => region.noteAnchor ? [region.noteAnchor] : [])];
        if (!anchors.length) return;
        const origin = this.anchorScreenTop(Math.min(...anchors.map((anchor) => anchor.pos)));
        const widths = new Map(this.floatingImages.selectionItems(this.view.scrollDOM.getBoundingClientRect())
          .map((item) => [item.id, (item.bounds.right - item.bounds.left) / this.noteZoom]));
        const images = ink.floatingImages.map((image) => ({ ...image, width: image.width ?? widths.get(image.id) }));
        if (images.some((image) => image.width === undefined)) throw new Error("Wait for all images to load before scaling this note.");
        const result = scaleDrawingContent(ink.strokes, images, ink.snapshotRegions, factor,
          (anchor) => (this.anchorScreenTop(anchor.pos) - origin) / this.noteZoom);
        ink.commitState(result.strokes, result.images, ink.verticalSpaces, true, result.regions);
        this.recordSurfaceAction({ kind: "ink" });
        this.preferInkUndo = true;
        this.clearSelection();
        this.floatingImages.refresh();
        this.updateControls();
        this.requestRender();
      }

      private recolorSelectedStrokes(color: string): boolean {
        if (!this.document || !this.selectedStrokeIds.size) return false;
        if (this.document.recolorStrokes(this.selectedStrokeIds, color)) {
          this.recordSurfaceAction({ kind: "ink" });
          this.preferInkUndo = true;
        }
        return true;
      }

      private anchorAt(event: PointerEvent): { pos: number; lineText: string; screenTop: number } {
        const contentTop = this.view.contentDOM.getBoundingClientRect().top;
        const measuredY = (event.clientY - contentTop) * this.view.scaleY / this.noteZoom;
        const block = this.view.lineBlockAtHeight(measuredY - this.view.documentPadding.top);
        const line = this.view.state.doc.lineAt(block.from);
        return { pos: line.from, lineText: line.text, screenTop: this.anchorScreenTop(line.from) };
      }

      private anchorScreenTop(position: number): number {
        const safePosition = Math.max(0, Math.min(this.view.state.doc.length, position));
        const contentTop = this.view.contentDOM.getBoundingClientRect().top;
        return contentTop + (noteLineOffset(this.view, safePosition) + this.renderedVerticalSpaceAt(safePosition)) * this.noteZoom;
      }

      private isBelowTrailingInk(event: PointerEvent): boolean {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
        const viewport = this.view.scrollDOM.getBoundingClientRect();
        if (event.clientY >= viewport.bottom || event.clientX < viewport.left || event.clientX >= viewport.right) return false;
        const doc = this.view.state.doc;
        return this.inkTail?.doc === doc && !!this.inkTail.space
          && event.clientY >= this.anchorScreenTop(doc.length) + this.inkTail.space.bottom * this.noteZoom;
      }

      private insertWritingLineBelowInk(): boolean {
        const { doc, readOnly } = this.view.state;
        const space = this.inkTail?.doc === doc ? this.inkTail.space : undefined;
        if (readOnly || this.floatingImages.hasFocusedImage || !space) return false;
        this.view.dispatch({
          changes: { from: doc.length, insert: "\n".repeat(space.lines) },
          selection: { anchor: doc.length + space.lines },
          effects: continueBelowInk.of(null),
          userEvent: "input",
          scrollIntoView: true
        });
        return true;
      }

      private measureTrailingInk(): TrailingInkSpace | undefined {
        const { doc } = this.view.state;
        const strokes = this.document?.strokes;
        if (!strokes?.length) return;
        const last = doc.line(doc.lines);
        const lastBlock = this.view.lineBlockAt(last.from);
        const scale = this.view.scaleY;
        const lastTop = lastBlock.top / scale + this.renderedVerticalSpaceAt(last.from);
        const anchorTops = new Map<number, number>();
        let bottom = -Infinity;
        for (const stroke of strokes) {
          if (stroke.page || stroke.points.length === 0) continue;
          let strokeBottom = this.strokeBottoms.get(stroke);
          if (strokeBottom === undefined) {
            strokeBottom = -Infinity;
            for (const point of stroke.points) strokeBottom = Math.max(strokeBottom, point.y);
            strokeBottom += stroke.width / 2;
            this.strokeBottoms.set(stroke, strokeBottom);
          }
          let anchorTop = anchorTops.get(stroke.anchor.pos);
          if (anchorTop === undefined) {
            const anchor = Math.max(0, Math.min(doc.length, stroke.anchor.pos));
            anchorTop = this.view.lineBlockAt(anchor).top / scale + this.renderedVerticalSpaceAt(anchor);
            anchorTops.set(stroke.anchor.pos, anchorTop);
          }
          bottom = Math.max(bottom, anchorTop + strokeBottom - lastTop);
        }
        const lineHeight = Math.max(1, this.view.defaultLineHeight / scale);
        const lastLineBlank = !last.text.trim();
        const priorPadding = this.inkTail?.doc === doc ? this.inkTail.space?.padding ?? 0 : 0;
        const lastLineHeight = lastLineBlank ? lineHeight : Math.max(lineHeight, lastBlock.height / scale - priorPadding);
        return trailingInkSpace(bottom, lastLineHeight, lineHeight, lastLineBlank);
      }

      private requestVerticalSpaceRefresh(): void {
        if (this.destroyed || this.spaceDecorationFrame !== null) return;
        this.spaceDecorationFrame = requestAnimationFrame(() => {
          this.spaceDecorationFrame = null;
          if (this.destroyed) return;
          this.view.dispatch({ effects: refreshVerticalSpaces.of(null) });
        });
      }

      private rebuildVerticalSpaceDecorations(): void {
        const totals = new Map<number, number>();
        for (const space of this.spaceWorkingSet ?? this.document?.verticalSpaces ?? []) {
          if (Math.abs(space.height) <= 0.5) continue;
          const safePosition = Math.max(0, Math.min(this.view.state.doc.length, space.anchor.pos));
          const lineFrom = this.view.state.doc.lineAt(safePosition).from;
          totals.set(lineFrom, (totals.get(lineFrom) ?? 0) + space.height);
        }
        const { doc } = this.view.state;
        if (!this.spaceStart || this.inkTail?.doc !== doc) this.inkTail = { doc, space: this.measureTrailingInk() };
        const last = doc.line(doc.lines).from;
        const tailPadding = this.inkTail.space?.padding ?? 0;
        const positions = new Set(totals.keys());
        if (tailPadding > 0) positions.add(last);
        this.decorations = Decoration.set(
          Array.from(positions).flatMap((position) => {
            const renderedHeight = totals.get(position) ?? 0;
            const styles = [];
            if (renderedHeight > 0.5) styles.push(`padding-top: ${renderedHeight}px !important`);
            if (renderedHeight < -0.5) styles.push(`margin-top: ${renderedHeight}px !important`);
            if (position === last && tailPadding > 0) styles.push(`padding-bottom: ${tailPadding}px !important`);
            if (!styles.length) return [];
            return [Decoration.line({ attributes: { style: styles.join("; ") } }).range(position)];
          }),
          true
        );
        this.view.requestMeasure({
          read: () => null,
          write: () => {
            this.floatingImages.refresh();
            this.requestRender();
          }
        });
      }

      private renderedVerticalSpaceAt(position: number): number {
        const safePosition = Math.max(0, Math.min(this.view.state.doc.length, position));
        const lineFrom = this.view.state.doc.lineAt(safePosition).from;
        let height = 0;
        for (const space of this.spaceWorkingSet ?? this.document?.verticalSpaces ?? []) {
          const anchorPosition = Math.max(0, Math.min(this.view.state.doc.length, space.anchor.pos));
          if (this.view.state.doc.lineAt(anchorPosition).from === lineFrom) height += space.height;
        }
        // Positive space is top padding inside the anchored line, so the line's
        // content starts after it. Negative space is a line margin and is
        // already reflected in CodeMirror's measured line position.
        return Math.max(0, height);
      }

      private pointFromEvent(event: PointerEvent, anchorScreenTop: number, strokeOrigin?: number): InkPoint {
        const contentLeft = this.view.contentDOM.getBoundingClientRect().left;
        const pressure = event.pressure > 0 ? event.pressure : event.pointerType === "mouse" ? 0.5 : 0.35;
        return {
          x: (event.clientX - contentLeft) / this.noteZoom + (strokeOrigin ?? this.horizontalOriginWorld()),
          y: (event.clientY - anchorScreenTop) / this.noteZoom,
          pressure: Math.max(0.05, Math.min(1, pressure))
        };
      }

      private autoPan(event: PointerEvent): void {
        const rect = this.view.scrollDOM.getBoundingClientRect();
        const edge = 44;
        const speed = 18;
        if (event.clientX > rect.right - edge) this.view.scrollDOM.scrollLeft += speed;
        else if (event.clientX < rect.left + edge) this.view.scrollDOM.scrollLeft -= speed;
        if (event.clientY > rect.bottom - edge) this.view.scrollDOM.scrollTop += speed;
        else if (event.clientY < rect.top + edge) this.view.scrollDOM.scrollTop -= speed;
      }

      private eraseAt(event: PointerEvent): void {
        if (!this.eraserWorkingSet) return;
        const pointer = this.eventToCanvasPoint(event);
        const radius = dependencies.controller.settings.eraserRadius * this.noteZoom;
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
        const points = this.toCanvasPoints(stroke);
        if (points.length === 1) return Math.hypot(pointer.x - points[0].x, pointer.y - points[0].y) <= radius;
        const strokeRadius = stroke.width * this.noteZoom / 2;
        for (let index = 1; index < points.length; index += 1) {
          if (distanceToSegment(pointer, points[index - 1], points[index]) <= radius + strokeRadius) return true;
        }
        return false;
      }

      private hitTestStroke(pointer: ScreenPoint, radius: number): InkStroke | null {
        const strokes = this.selectionWorkingSet ?? this.document?.strokes ?? [];
        for (let index = strokes.length - 1; index >= 0; index -= 1) {
          if (this.strokeIntersects(strokes[index], pointer, radius)) return strokes[index];
        }
        return null;
      }

      private strokeBounds(stroke: InkStroke, viewport?: DOMRect, origin?: number, lineTops?: Map<number, number>): Rectangle {
        if (!stroke.points.length) return { left: 0, top: 0, right: 0, bottom: 0 };
        const cacheable = stroke !== this.activeStroke && !this.selectionWorkingSet;
        let bounds = cacheable ? this.strokePointBounds.get(stroke) : undefined;
        if (!bounds) {
          bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
          for (const { x, y } of stroke.points) {
            bounds.left = Math.min(bounds.left, x);
            bounds.right = Math.max(bounds.right, x);
            bounds.top = Math.min(bounds.top, y);
            bounds.bottom = Math.max(bounds.bottom, y);
          }
          if (cacheable) this.strokePointBounds.set(stroke, bounds);
        }
        const { x, y, scale } = this.strokeTransform(stroke, viewport, origin, lineTops);
        const padding = stroke.width * scale / 2;
        return {
          left: x + bounds.left * scale - padding,
          top: y + bounds.top * scale - padding,
          right: x + bounds.right * scale + padding,
          bottom: y + bounds.bottom * scale + padding
        };
      }

      private eventToCanvasPoint(event: PointerEvent): ScreenPoint {
        const rect = this.view.scrollDOM.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }

      private measureImportedPages(): void {
        this.importedPages = new Map(
          Array.from(importedPageImages(this.view.dom), ([name, image]) => [name, image.getBoundingClientRect()])
        );
      }

      private strokeTransform(
        stroke: InkStroke,
        scrollRect = this.view.scrollDOM.getBoundingClientRect(),
        origin = this.horizontalOriginWorld(),
        lineTops?: Map<number, number>
      ): { x: number; y: number; scale: number } {
        const page = stroke.page;
        const bounds = page && this.importedPages.get(page.name);
        if (page && bounds?.width && this.activeStroke !== stroke) {
          const scale = bounds.width / page.width;
          return {
            x: bounds.left - scrollRect.left - ((stroke.horizontalOrigin ?? 0) + page.x) * scale,
            y: bounds.top - scrollRect.top - page.y * scale,
            scale
          };
        }
        const scale = this.noteZoom;
        // CodeMirror's line heights can lag the DOM during a negative space
        // preview. Move freehand ink from its original position until commit.
        const scrollLeft = this.view.scrollDOM.scrollLeft;
        const horizontal = this.horizontalSpace;
        const shift = horizontal?.strokeIds.has(stroke.id) ? horizontal.delta * scale : 0;
        const x = (origin - (stroke.horizontalOrigin ?? origin) - scrollLeft) * scale + shift;
        const startTop = this.spaceAnchorTops.get(stroke.anchor.pos);
        if (startTop !== undefined) {
          const displacement = this.spaceMovingStrokes.has(stroke.id) ? this.spaceLineDelta * this.spaceLineHeight * scale : 0;
          return {
            x,
            y: startTop - this.view.scrollDOM.scrollTop * scale + displacement,
            scale
          };
        }
        let lineTop = lineTops?.get(stroke.anchor.pos);
        if (lineTop === undefined) {
          lineTop = this.anchorScreenTop(stroke.anchor.pos);
          lineTops?.set(stroke.anchor.pos, lineTop);
        }
        return {
          x,
          y: lineTop - scrollRect.top,
          scale
        };
      }

      private toCanvasPoints(stroke: InkStroke): ScreenPoint[] {
        const { x, y, scale } = this.strokeTransform(stroke);
        return stroke.points.map((point) => ({ x: x + point.x * scale, y: y + point.y * scale }));
      }

      private horizontalOriginWorld(): number {
        const scrollRect = this.view.scrollDOM.getBoundingClientRect();
        const contentRect = this.view.contentDOM.getBoundingClientRect();
        return (contentRect.left - scrollRect.left) / this.noteZoom + this.view.scrollDOM.scrollLeft;
      }

      private requestRender(): void {
        if (this.destroyed || this.renderFrame !== null) return;
        this.renderFrame = requestAnimationFrame(() => {
          this.renderFrame = null;
          this.render();
        });
      }

      private cancelRender(): void {
        if (this.renderFrame === null) return;
        cancelAnimationFrame(this.renderFrame);
        this.renderFrame = null;
      }

      private prepareInkBuffer(viewport: DOMRect): Rectangle {
        const { scrollDOM, contentDOM } = this.view;
        const { clientWidth, clientHeight } = scrollDOM;
        const content = (contentDOM.closest(".cm-sizer") ?? contentDOM).getBoundingClientRect();
        let right = content.right;
        let bottom = content.bottom;
        for (const page of this.importedPages.values()) {
          right = Math.max(right, page.right);
          bottom = Math.max(bottom, page.bottom);
        }
        const layerWidth = Math.max(clientWidth, this.workspaceWidth, Math.round(scrollDOM.scrollLeft + (right - viewport.left) / this.noteZoom));
        const layerHeight = Math.max(clientHeight, Math.round(scrollDOM.scrollTop + (bottom - viewport.top) / this.noteZoom));
        this.inkLayer.style.width = `${layerWidth}px`;
        this.inkLayer.style.height = `${layerHeight}px`;
        const { scrollLeft, scrollTop } = scrollDOM;

        // Keep nearby ink painted in scroll coordinates so the compositor can
        // move it with the note even before the next main-thread render.
        const buffer = INK_SCROLL_BUFFER / this.noteZoom;
        const left = Math.max(0, scrollLeft - buffer);
        const top = Math.max(0, scrollTop - buffer);
        const width = Math.max(1, Math.min(layerWidth - left, scrollLeft + clientWidth + buffer - left));
        const height = Math.max(1, Math.min(layerHeight - top, scrollTop + clientHeight + buffer - top));
        this.canvas.style.left = `${left}px`;
        this.canvas.style.top = `${top}px`;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;

        const rect = this.canvas.getBoundingClientRect();
        const screenWidth = Math.max(0.01, rect.width);
        const screenHeight = Math.max(0.01, rect.height);
        const ratio = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(screenWidth, screenHeight),
          Math.sqrt(12_000_000 / (screenWidth * screenHeight)));
        const pixelWidth = Math.max(1, Math.round(screenWidth * ratio));
        const pixelHeight = Math.max(1, Math.round(screenHeight * ratio));
        if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
          this.canvas.width = pixelWidth;
          this.canvas.height = pixelHeight;
        }
        const x = rect.left - viewport.left;
        const y = rect.top - viewport.top;
        const pixelScaleX = pixelWidth / screenWidth;
        const pixelScaleY = pixelHeight / screenHeight;
        this.context.setTransform(pixelScaleX, 0, 0, pixelScaleY, -x * pixelScaleX, -y * pixelScaleY);
        this.context.clearRect(x, y, screenWidth, screenHeight);
        return { left: x, top: y, right: x + screenWidth, bottom: y + screenHeight };
      }

      private render(): void {
        this.regionSurface.refresh();
        this.applyLayout();
        this.initializeHorizontalOrigins();
        this.updateWorkspaceExtent();
        this.applyPinnedHeader();
        const hostRect = this.view.dom.getBoundingClientRect();
        const scrollRect = this.view.scrollDOM.getBoundingClientRect();
        const width = Math.max(1, this.view.scrollDOM.clientWidth * this.noteZoom);
        const height = Math.max(1, this.view.scrollDOM.clientHeight * this.noteZoom);
        this.palmRest.style.left = `${scrollRect.left - hostRect.left}px`;
        this.palmRest.style.top = `${scrollRect.top - hostRect.top + height * (1 - dependencies.controller.settings.palmRestHeight / 100)}px`;
        this.palmRest.style.width = `${width}px`;
        this.palmRest.style.height = `${height * dependencies.controller.settings.palmRestHeight / 100}px`;
        this.measureImportedPages();
        const buffer = this.prepareInkBuffer(scrollRect);
        const strokes = (this.doubleTap.tracking ? null : this.eraserWorkingSet)
          ?? this.selectionWorkingSet
          ?? this.spaceOriginalStrokes
          ?? this.document?.strokes
          ?? [];
        const lineTops = new Map<number, number>();
        const selectedWithText = new Set(this.cursorSelectedInk(this.view.state.selection.ranges, scrollRect, lineTops)
          .map(({ stroke }) => stroke.id));
        const selectedRegions = new Set([
          ...this.selectedRegionIds,
          ...this.cursorSelectedRegions(this.view.state.selection.ranges).map(({ id }) => id),
          ...this.movingRegions.map(({ region }) => region.id)
        ]);
        const regionOffsets = new Map(this.movingRegions.map(({ region }) => [region.id, this.regionMoveDelta]));
        const horizontal = this.horizontalSpace;
        if (horizontal?.delta) {
          const dx = horizontal.delta * this.noteZoom;
          for (const region of horizontal.regions) {
            selectedRegions.add(region.id);
            if (!region.noteImageAnchor || !horizontal.imageShifts.has(region.noteImageAnchor.id)) {
              regionOffsets.set(region.id, { x: dx, y: 0 });
            }
          }
        }
        this.regionSurface.surface.setSelection(selectedRegions, regionOffsets);
        const textSelectionColor = selectedWithText.size
          ? getComputedStyle(this.view.dom).getPropertyValue("--interactive-accent").trim() || "#7aa2f7"
          : undefined;
        for (const stroke of strokes) {
          this.drawStroke(stroke, scrollRect, buffer, lineTops, selectedWithText.has(stroke.id) ? textSelectionColor : undefined);
        }
        if (this.activeStroke && !this.doubleTap.tracking) this.drawStroke(this.activeStroke, scrollRect, buffer, lineTops);
        this.drawSelection();
        this.drawSpaceIndicator(scrollRect);
        this.updateSelectionToolbar(hostRect, scrollRect);
      }

      textSelectionEdit(transaction: Transaction): TextInkEdit | undefined {
        const move = transaction.isUserEvent("move.drop");
        if (!this.document || (!move && !this.canSelectInkWithText() && !this.selectedRegionIds.size)
          || this.view.state !== transaction.startState) return;
        const ranges = transaction.startState.selection.ranges.filter((range) => !range.empty);
        const removedRanges = ranges.filter((range) => {
          let removed = false;
          transaction.changes.iterChangedRanges((from, to) => { removed ||= from <= range.from && to >= range.to; });
          return removed;
        });
        if (!removedRanges.length) return;
        if (move) {
          const regionsBefore = this.regionSurface.surface.screenRegions(true).map(({ region }) => region)
            .filter(({ noteAnchor }) => !!noteAnchor && removedRanges.some(({ from, to }) => noteAnchor.pos >= from && noteAnchor.pos < to));
          if (!regionsBefore.length || transaction.newSelection.main.empty) return;
          const regionsAfter = regionsBefore.map((region) => {
            const pos = region.noteAnchor!.pos;
            let offset = 0;
            for (const range of removedRanges) {
              if (pos >= range.from && pos < range.to) {
                offset += pos - range.from;
                break;
              }
              offset += range.to - range.from + 1;
            }
            const line = transaction.newDoc.lineAt(Math.min(transaction.newDoc.length, transaction.newSelection.main.from + offset));
            return { ...region, noteAnchor: { pos: line.from, lineText: line.text } };
          });
          return { document: this.document, strokes: [], restore: false, regionsBefore, regionsAfter };
        }
        const strokes = this.cursorSelectedInk(removedRanges);
        const regions = mergeSnapshotRegions(this.cursorSelectedRegions(removedRanges), this.regionSurface.surface.screenRegions()
          .flatMap(({ region }) => this.selectedRegionIds.has(region.id) ? [region] : []));
        return strokes.length || regions.length ? {
          document: this.document, strokes, restore: false,
          regionsBefore: regions, regionsAfter: regions.map((region) => ({ ...region, deleted: true }))
        } : undefined;
      }

      private cursorSelectedRegions(ranges: readonly SelectionRange[]): SnapshotRegion[] {
        if (this.activeTool !== "select") return [];
        const drag = this.cursorInkDrag;
        const useDrag = drag?.moved && Math.abs(drag.end - drag.start) > 4;
        if (!useDrag && ranges.every(({ empty }) => empty)) return [];
        const doc = this.view.state.doc;
        const origin = this.view.scrollDOM.getBoundingClientRect().top - this.view.scrollDOM.scrollTop * this.noteZoom;
        return this.regionSurface.surface.screenRegions().flatMap(({ region, bounds }) => {
          const pos = region.noteAnchor?.pos;
          if (pos === undefined) return [];
          if (useDrag && (!doc.lineAt(Math.min(doc.length, pos)).text.trim() || ranges.every(({ empty }) => empty))) {
            return bounds.bottom - origin >= Math.min(drag.start, drag.end) && bounds.top - origin <= Math.max(drag.start, drag.end)
              ? [region] : [];
          }
          return ranges.some((range) => textRangeCoversInkLine(doc, pos, range)) ? [region] : [];
        });
      }

      private canSelectInkWithText(): boolean {
        return this.activeTool === "select"
          || (dependencies.controller.settings.penOnly && this.activeTool !== "lasso" && !this.lassoSelectedText);
      }

      private cursorSelectedInk(
        ranges: readonly SelectionRange[], viewport = this.view.scrollDOM.getBoundingClientRect(), lineTops = new Map<number, number>()
      ): IndexedInkStroke[] {
        if (!this.document || !this.canSelectInkWithText()) return [];
        const selectedRanges = ranges.filter((range) => !range.empty);
        const bounds = this.cursorInkSelectionBounds(selectedRanges, viewport);
        if (!bounds.length) return [];
        const origin = this.horizontalOriginWorld();
        return this.document.strokes.flatMap((stroke, index) => {
          if (!stroke.points.length) return [];
          const strokeBounds = this.strokeBounds(stroke, viewport, origin, lineTops);
          return bounds.some((area) => rectanglesIntersect(strokeBounds, area)) ? [{ index, stroke }] : [];
        });
      }

      private cursorInkSelectionBounds(ranges: readonly SelectionRange[], viewport: DOMRect): Rectangle[] {
        const { doc } = this.view.state;
        const fullWidth = (top: number, bottom: number): Rectangle => ({
          left: -Infinity, right: Infinity, top, bottom
        });
        if (ranges.some(({ from, to }) => from === 0 && to === doc.length)) return [fullWidth(-Infinity, Infinity)];

        const drag = this.cursorInkDrag;
        const useDrag = drag?.moved && Math.abs(drag.end - drag.start) > 4;
        if (!useDrag && !ranges.length) return [];
        const origin = this.view.documentTop - viewport.top;
        const tailPadding = (this.inkTail?.doc === doc ? this.inkTail.space?.padding ?? 0 : 0) * this.noteZoom;
        const lastBottom = () => origin + this.view.lineBlockAt(doc.length).bottom - tailPadding;
        const bounds: Rectangle[] = [];
        for (const range of ranges) {
          // Strokes can share an anchor far above the row where they render.
          const whole = fullySelectedLines(doc, range);
          if (whole) {
            bounds.push(fullWidth(
              origin + this.view.lineBlockAt(whole.first.from).top,
              whole.last.number === doc.lines ? lastBottom() : origin + this.view.lineBlockAt(whole.last.from).bottom
            ));
          }
          const start = doc.lineAt(range.from);
          const end = doc.lineAt(range.to);
          for (const line of start.number === end.number ? [start] : [start, end]) {
            if (whole && line.number >= whole.first.number && line.number <= whole.last.number) continue;
            const from = Math.max(range.from, line.from);
            const to = Math.min(range.to, line.to);
            if (from >= to) continue;
            const first = this.view.coordsAtPos(from, 1);
            const last = this.view.coordsAtPos(to, -1);
            if (!first || !last) continue;
            const wraps = first.bottom <= last.top;
            bounds.push({
              left: wraps ? 0 : Math.min(first.left, last.left) - viewport.left,
              right: wraps ? viewport.width : Math.max(first.right, last.right) - viewport.left,
              top: first.top - viewport.top,
              bottom: last.bottom - viewport.top
            });
          }
        }
        if (useDrag) {
          const scroll = this.view.scrollDOM.scrollTop * this.noteZoom;
          const start = Math.min(drag.start, drag.end) - scroll;
          const end = Math.max(drag.start, drag.end) - scroll;
          const top = ranges.length ? Math.max(start, lastBottom()) : start;
          if (top < end) bounds.push(fullWidth(top, end));
        }
        return bounds;
      }

      private drawStroke(
        stroke: InkStroke, scrollRect: DOMRect, buffer: Rectangle, lineTops: Map<number, number>, selectionColor?: string
      ): void {
        if (stroke.points.length === 0) return;
        const complete = this.activeStroke !== stroke;
        // Selected preview strokes change in place during a drag.
        const cacheable = complete && !this.selectionWorkingSet;
        const smoothing = dependencies.controller.settings.strokeSmoothing;
        const { x, y, scale } = this.strokeTransform(stroke, scrollRect, this.workspaceOrigin, lineTops);
        let entry = cacheable ? this.strokePaths.get(stroke) : undefined;
        if (!entry || entry.smoothing !== smoothing) {
          const outline = createStrokeOutline(stroke, stroke.points, 1, smoothing, complete);
          if (!outline.length) return;
          const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
          for (const [px, py] of outline) {
            bounds.left = Math.min(bounds.left, px);
            bounds.top = Math.min(bounds.top, py);
            bounds.right = Math.max(bounds.right, px);
            bounds.bottom = Math.max(bounds.bottom, py);
          }
          entry = { smoothing, path: new Path2D(outlineToSvgPath(outline)), bounds };
          if (cacheable) this.strokePaths.set(stroke, entry);
        }
        const { bounds, path } = entry;
        if (x + bounds.right * scale < buffer.left || y + bounds.bottom * scale < buffer.top
          || x + bounds.left * scale > buffer.right || y + bounds.top * scale > buffer.bottom) return;
        const context = this.context;
        context.save();
        context.translate(x, y);
        context.scale(scale, scale);
        if (selectionColor) {
          context.strokeStyle = selectionColor;
          context.globalAlpha = 0.75;
          context.lineWidth = 4 / scale;
          context.lineJoin = "round";
          context.stroke(path);
        }
        context.fillStyle = inkDisplayColor(stroke, this.view.dom.ownerDocument.body.classList.contains("theme-dark"));
        context.globalAlpha = stroke.opacity;
        context.fill(path);
        context.restore();
      }

      private drawSelection(): void {
        const context = this.context;
        const computedStyle = getComputedStyle(this.view.dom);
        const accent = computedStyle.getPropertyValue("--color-accent").trim()
          || computedStyle.getPropertyValue("--interactive-accent").trim()
          || "#7aa2f7";
        const bounds = this.selectedBounds();
        if (bounds) {
          const left = bounds.left - 4;
          const top = bounds.top - 4;
          const width = bounds.right - bounds.left + 8;
          const height = bounds.bottom - bounds.top + 8;
          context.save();
          context.strokeStyle = accent;
          context.fillStyle = accent;
          context.lineWidth = 3;
          context.beginPath();
          context.roundRect(left, top, width, height, 3);
          context.globalAlpha = 0.03;
          context.fill();
          context.globalAlpha = 0.3;
          context.stroke();
          context.restore();
        }
        if (this.textDropPosition !== null) {
          const caret = this.view.coordsAtPos(this.textDropPosition);
          if (caret) {
            const viewport = this.view.scrollDOM.getBoundingClientRect();
            context.save();
            context.fillStyle = accent;
            context.fillRect(caret.left - viewport.left, caret.top - viewport.top, 2, caret.bottom - caret.top);
            context.restore();
          }
        }
        if (this.lassoPath.length > 1) {
          context.save();
          context.strokeStyle = accent;
          context.fillStyle = accent;
          context.lineWidth = 2;
          context.beginPath();
          for (const point of this.lassoPath) context.lineTo(point.x, point.y);
          context.closePath();
          context.globalAlpha = 0.1;
          context.fill();
          context.globalAlpha = 1;
          context.stroke();
          context.restore();
        }
      }

      private updateSelectionToolbar(hostRect: DOMRect, scrollRect: DOMRect): void {
        const selected = (this.selectionWorkingSet ?? this.document?.strokes ?? []).filter((stroke) =>
          this.selectedStrokeIds.has(stroke.id)
        );
        if (selected.length === 0 || this.selectionMode === "lasso") {
          this.selectionToolbar.classList.add("is-hidden");
          return;
        }
        const bounds = this.selectedBounds() ?? selected.map((stroke) => this.strokeBounds(stroke)).reduce(mergeRectangles);
        const canvasLeft = scrollRect.left - hostRect.left;
        const canvasTop = scrollRect.top - hostRect.top;
        this.selectionColorInput.value = selected[0].color;
        this.selectionToolbar.classList.remove("is-hidden");
        const menuRect = this.selectionMenu.getBoundingClientRect();
        const menuLeft = Math.max(
          10,
          Math.min(scrollRect.width - menuRect.width - 10, (bounds.left + bounds.right - menuRect.width) / 2)
        );
        const menuTop = Math.max(10, Math.min(scrollRect.height - menuRect.height - 10, bounds.top - menuRect.height - 10));
        this.selectionToolbar.style.left = `${canvasLeft + menuLeft}px`;
        this.selectionToolbar.style.top = `${canvasTop + menuTop}px`;
      }

      private selectedBounds(): Rectangle | null {
        const rectangles = (this.selectionWorkingSet ?? this.document?.strokes ?? [])
          .filter((stroke) => this.selectedStrokeIds.has(stroke.id))
          .map((stroke) => this.strokeBounds(stroke));
        const scrollRect = this.view.scrollDOM.getBoundingClientRect();
        for (const image of this.floatingImages.selectionItems(scrollRect)) {
          if (this.selectedFloatingImageIds.has(image.id)) rectangles.push(image.bounds);
        }
        return rectangles.length > 0 ? rectangles.reduce(mergeRectangles) : null;
      }

      private drawSpaceIndicator(scrollRect: DOMRect): void {
        const horizontal = this.horizontalSpace;
        let start: number;
        let current: number;
        if (horizontal) {
          const scale = this.noteZoom;
          start = this.view.contentDOM.getBoundingClientRect().left - scrollRect.left + horizontal.start * scale;
          current = start + horizontal.delta * scale;
        } else {
          if (!this.spaceStart || this.spaceCurrentY === null) return;
          start = this.spaceStart.screenY - scrollRect.top;
          current = this.spaceCurrentY - scrollRect.top;
        }
        const from = Math.min(start, current);
        const distance = Math.abs(current - start);
        const context = this.context;
        context.save();
        context.fillStyle = "rgba(122, 162, 247, 0.1)";
        if (horizontal) context.fillRect(from, 0, distance, scrollRect.height);
        else context.fillRect(0, from, scrollRect.width, distance);
        context.strokeStyle = "#7aa2f7";
        context.lineWidth = 2;
        context.setLineDash([10, 6]);
        context.beginPath();
        if (horizontal) {
          context.moveTo(current, 0);
          context.lineTo(current, scrollRect.height);
        } else {
          context.moveTo(0, current);
          context.lineTo(scrollRect.width, current);
        }
        context.stroke();
        context.restore();
      }

      private updateWorkspaceExtent(): void {
        const origin = this.horizontalOriginWorld();
        // The sizer offset is already in the measured origin. Subtract it
        // before recomputing how much space the leftmost item needs.
        const baseOrigin = origin - this.workspaceLeft;
        const horizontal = this.horizontalSpace;
        let leftEdge = Infinity;
        let rightEdge = -Infinity;
        const extend = (left: number, right: number) => {
          leftEdge = Math.min(leftEdge, left);
          rightEdge = Math.max(rightEdge, right);
        };
        const preview = this.selectionWorkingSet ?? this.spaceOriginalStrokes;
        const strokes = preview ?? this.document?.strokes ?? [];
        const extendForStroke = (stroke: InkStroke, cacheable: boolean) => {
          const { left, right } = this.strokeHorizontalExtent(stroke, cacheable);
          const shift = horizontal?.strokeIds.has(stroke.id) ? horizontal.delta : 0;
          const base = stroke.horizontalOrigin ?? origin;
          extend(left - base - stroke.width / 2 + shift, right - base + stroke.width / 2 + shift);
        };
        for (const stroke of strokes) extendForStroke(stroke, !preview);
        if (this.activeStroke) extendForStroke(this.activeStroke, false);
        for (const image of this.document?.floatingImages ?? []) {
          const shift = horizontal?.imageShifts.has(image.id) ? horizontal.delta : 0;
          extend(image.x + shift, image.x + (image.width ?? 300) + shift);
        }
        for (const region of this.document?.snapshotRegions ?? []) {
          if (!region.deleted) extend(region.bounds.left, region.bounds.right);
        }
        if (horizontal) {
          for (const region of horizontal.regions) {
            extend(region.bounds.left + horizontal.delta, region.bounds.right + horizontal.delta);
          }
        }
        const scroll = this.view.scrollDOM;
        const sideRoom = this.noteLayout === "left-scroll" ? scroll.clientWidth : 0;
        const left = horizontal ? this.workspaceLeft
          : Math.ceil(Math.max(sideRoom, 8 - baseOrigin - leftEdge));
        const shift = left - this.workspaceLeft;
        const scrollLeft = scroll.scrollLeft;
        if (sideRoom) {
          const guideInset = Math.max(0, Math.min(28, baseOrigin - 4));
          scroll.style.setProperty("--modern-draw-guide-inset", `${guideInset}px`);
        }
        if (shift !== 0) {
          this.workspaceLeft = left;
          scroll.classList.toggle("modern-draw-left-overflow", left > 0);
          scroll.style.setProperty("--modern-draw-left-overflow", `${left}px`);
        }
        this.workspaceOrigin = baseOrigin + left;
        const minimumWidth = scroll.clientWidth + (sideRoom ? left + sideRoom : 0);
        this.workspaceWidth = Math.ceil(Math.max(minimumWidth, horizontal?.originalWidth ?? 0,
          this.workspaceOrigin + rightEdge + 160));
        this.extent.style.width = `${this.workspaceWidth}px`;
        if (this.alignScrollablePage && sideRoom) {
          this.alignScrollablePage = false;
          scroll.scrollLeft = left;
        } else if (shift !== 0 && (sideRoom || scrollLeft > 1)) {
          scroll.scrollLeft = Math.max(0, scrollLeft + shift);
        }
        if (shift !== 0) {
          this.floatingImages.refresh();
        }
      }

      private strokeHorizontalExtent(stroke: InkStroke, cacheable = true): { left: number; right: number } {
        const cached = cacheable ? this.strokeHorizontalExtents.get(stroke) : undefined;
        if (cached) return cached;
        let left = Infinity;
        let right = -Infinity;
        for (const { x } of stroke.points) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
        const extent = { left, right };
        if (cacheable) this.strokeHorizontalExtents.set(stroke, extent);
        return extent;
      }

      private previewFloatingExtent(right: number | null): void {
        if (right === null) return;
        const requiredWidth = this.workspaceOrigin + right + 160;
        // Expanding scroll overflow forces CodeMirror to perform layout. Grow
        // in generous chunks and only near the current edge, never every drag
        // frame. The normal post-drag render shrinks it to the exact content.
        if (requiredWidth <= this.workspaceWidth - 80) return;
        this.workspaceWidth = Math.ceil(requiredWidth + 480);
        this.extent.style.width = `${this.workspaceWidth}px`;
      }

      private recordSurfaceAction(action: SurfaceHistoryAction): void {
        this.surfaceUndoStack.push(action);
        if (this.surfaceUndoStack.length > 80) this.surfaceUndoStack.shift();
        this.surfaceRedoStack = [];
        this.updateControls();
      }

      private undo(): void {
        this.doubleTap.reset();
        if (!this.preferInkUndo && undoDepth(this.view.state) > 0) {
          undoEditor(this.view);
          this.updateControls();
          return;
        }
        const action = this.surfaceUndoStack.pop();
        if (action?.kind === "space" && this.document) {
          this.view.dispatch({
            changes: {
              from: action.from,
              to: action.from + action.inserted.length,
              insert: action.removed
            },
            annotations: Transaction.addToHistory.of(false)
          });
          this.document.commitState(action.beforeStrokes, action.beforeImages, [], false);
          this.surfaceRedoStack.push(action);
          this.clearSelection();
          this.preferInkUndo = true;
          this.updateControls();
          this.floatingImages.refresh();
          this.requestRender();
          return;
        }
        if (this.document?.undo()) {
          this.surfaceRedoStack.push(action ?? { kind: "ink" });
          this.clearSelection();
          this.preferInkUndo = true;
          this.updateControls();
          this.requestRender();
        } else if (action) {
          this.surfaceUndoStack.push(action);
        } else if (undoDepth(this.view.state) > 0) {
          undoEditor(this.view);
          this.preferInkUndo = false;
          this.updateControls();
        }
      }

      private redo(): void {
        this.doubleTap.reset();
        if (!this.preferInkUndo && redoDepth(this.view.state) > 0) {
          redoEditor(this.view);
          this.updateControls();
          return;
        }
        const action = this.surfaceRedoStack.pop();
        if (action?.kind === "space" && this.document) {
          this.document.commitState(action.afterStrokes, action.afterImages, [], false);
          this.view.dispatch({
            changes: {
              from: action.from,
              to: action.from + action.removed.length,
              insert: action.inserted
            },
            annotations: Transaction.addToHistory.of(false)
          });
          this.surfaceUndoStack.push(action);
          this.clearSelection();
          this.preferInkUndo = true;
          this.updateControls();
          this.floatingImages.refresh();
          this.requestRender();
          return;
        }
        if (this.document?.redo()) {
          this.surfaceUndoStack.push(action ?? { kind: "ink" });
          this.clearSelection();
          this.preferInkUndo = true;
          this.updateControls();
          this.requestRender();
        } else if (action) {
          this.surfaceRedoStack.push(action);
        } else if (redoDepth(this.view.state) > 0) {
          redoEditor(this.view);
          this.preferInkUndo = false;
          this.updateControls();
        }
      }

      private runAction(action: InkEditorAction): void {
        if (action === "undo") this.undo();
        else if (action === "redo") this.redo();
        else if (action === "toggle-layout") this.toggleLayout();
        else if (action === "zoom-in") this.setZoom(stepNoteZoom(this.noteZoom, 1));
        else if (action === "zoom-out") this.setZoom(stepNoteZoom(this.noteZoom, -1));
        else if (action === "zoom-reset") this.setZoom(1);
        else if (action === "clear" && this.document && this.document.strokes.length > 0) {
          this.document.commit([]);
          this.recordSurfaceAction({ kind: "ink" });
          this.clearSelection();
          this.preferInkUndo = true;
        }
      }
    }

    const surfacePlugin = ViewPlugin.fromClass(class {
      private surface: InkEditorSurface | null = null;

      constructor(view: EditorView) {
        this.attach(view);
      }

      get decorations(): DecorationSet {
        return this.surface?.decorations ?? Decoration.none;
      }

      update(update: ViewUpdate): void {
        if (this.surface) this.surface.update(update);
        else this.attach(update.view);
      }

      destroy(): void {
        this.surface?.destroy();
      }

      private attach(view: EditorView): void {
        const owner = view.state.field(editorInfoField, false);
        // Obsidian shares editor extensions with nested editors, including
        // individual table cells. Only a pane's top-level CM editor owns ink.
        if (owner instanceof MarkdownView && owner.file?.extension === "md"
          && view.dom.parentElement?.matches(".markdown-source-view.mod-cm6")
          && !view.dom.closest(".markdown-embed")) {
          this.surface = new InkEditorSurface(view);
        }
      }
    }, { decorations: (plugin) => plugin.decorations });
    return [
      drawingEditability.of([]),
      surfacePlugin,
      EditorState.transactionExtender.of((transaction) => {
        if (transaction.effects.some((effect) => effect.is(textInkEdit))) return null;
        if (!transaction.docChanged || transaction.annotation(Transaction.addToHistory) === false
          || (!transaction.isUserEvent("delete") && !transaction.isUserEvent("input") && !transaction.isUserEvent("move.drop"))) return null;
        const edit = surfaces.get(transaction.startState)?.textSelectionEdit(transaction);
        return edit ? { effects: textInkEdit.of(edit), annotations: isolateHistory.of("full") } : null;
      }),
      invertedEffects.of((transaction) => transaction.effects.flatMap<StateEffect<unknown>>((effect) => {
        if (effect.is(continueBelowInk)) return [effect];
        if (effect.is(textInkEdit)) return [textInkEdit.of({ ...effect.value, restore: !effect.value.restore })];
        return [];
      }))
    ];
}

function mapPosition(position: number, transactions: readonly Transaction[]): number {
  let mapped = position;
  for (const transaction of transactions) {
    const continuingBelow = transaction.effects.some((effect) => effect.is(continueBelowInk));
    mapped = transaction.changes.mapPos(mapped, continuingBelow ? -1 : 1);
  }
  return mapped;
}

function mergeRectangles(first: Rectangle, second: Rectangle): Rectangle {
  return {
    left: Math.min(first.left, second.left),
    top: Math.min(first.top, second.top),
    right: Math.max(first.right, second.right),
    bottom: Math.max(first.bottom, second.bottom)
  };
}

function stopEvent(event: Event): void {
  event.stopPropagation();
}
