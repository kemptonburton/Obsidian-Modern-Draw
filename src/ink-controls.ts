import { setIcon } from "obsidian";
import { orderedInkPresets, type SavedInkPreset } from "./ink-style";
import {
  sameInkStyle,
  type CanvasLayout,
  type DrawingTool,
  type InkStylePreset,
  type InkTool,
  type ModernDrawSettings
} from "./model";

export interface InkControlActions {
  setTool(tool: DrawingTool): void;
  setColor(color: string): void;
  setStrokeSize(size: number): void;
  setStyle(tool: InkTool, style: InkStylePreset): void;
  togglePinnedStyle(tool: InkTool, style: InkStylePreset): void;
  updatePinnedStyle(tool: InkTool, original: InkStylePreset, replacement: InkStylePreset | null): void;
  movePinnedStyle(source: SavedInkPreset, before: SavedInkPreset | null): void;
  undo(): void;
  redo(): void;
  toggleLayout?(): void;
  zoomIn?(): void;
  zoomOut?(): void;
  resetZoom?(): void;
  fitView?(): void;
  openViewMenu?(anchor: HTMLElement): void;
  importPdf?(): void;
  scaleNote?(): void;
}

export interface InkControlOptions {
  includeSpace: boolean;
  includeHistory: boolean;
}

export interface InkControlState {
  tool: DrawingTool;
  settings: ModernDrawSettings;
  canvasLayout: CanvasLayout;
  zoom: number;
  color: string;
  strokeSize: number;
  canUndo: boolean;
  canRedo: boolean;
}

interface PresetEdit {
  tool: InkTool;
  original: InkStylePreset;
  draft: InkStylePreset;
}

const PRESET_HOLD_MS = 350;
const PRESET_MOVE_THRESHOLD = 6;

interface PresetPress {
  button: HTMLButtonElement;
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  x: number;
  y: number;
  phase: "pressed" | "scroll" | "drag";
  timer?: number;
  frame?: number;
  indicator?: HTMLButtonElement;
}

export class InkControls {
  readonly root: HTMLDivElement;
  readonly selectionTools: HTMLDivElement;
  private readonly toolButtons = new Map<DrawingTool, HTMLDivElement>();
  private readonly stylePresets: HTMLDivElement;
  private presetRenderKey = "";
  private readonly presetButtons = new Map<HTMLButtonElement, SavedInkPreset>();
  private presetPress?: PresetPress;
  private suppressPresetClick = false;
  private lastPresetClick?: HTMLButtonElement;
  private lastTapTime = -Infinity;
  private lastPresetPointerType = "";
  private presetEditClick?: HTMLButtonElement;
  private readonly swatches = new Map<string, HTMLButtonElement>();
  private readonly popover: HTMLDivElement;
  private readonly styleTitle: HTMLDivElement;
  private readonly customColorInput: HTMLInputElement;
  private readonly pinButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly sizeInput: HTMLInputElement;
  private readonly sizeValue: HTMLSpanElement;
  private readonly undoButton: HTMLDivElement | null;
  private readonly redoButton: HTMLDivElement | null;
  private readonly layoutButton: HTMLDivElement | null;
  private readonly zoomLabel: HTMLButtonElement | null;
  private readonly importButton: HTMLDivElement | null;
  private currentColor = "#000000";
  private currentSize = 1;
  private currentTool: DrawingTool = "select";
  private currentPresets: InkStylePreset[] = [];
  private editingPreset?: PresetEdit;
  private popoverAnchor?: HTMLElement;
  private readonly closePopover = (event: PointerEvent): void => {
    if (!this.popover.contains(event.target as Node) && !this.root.contains(event.target as Node)) {
      this.hidePopover();
    }
  };

  constructor(
    private readonly actions: InkControlActions, options: InkControlOptions, private readonly owner: Document
  ) {
    const document = owner;
    this.root = document.createElement("div");
    this.root.className = "modern-draw-toolbar";
    this.root.setAttribute("role", "toolbar");
    this.root.addEventListener("pointerdown", stopEvent);
    this.root.addEventListener("click", stopEvent);

    this.selectionTools = this.createGroup();
    this.createToolButton("select", "mouse-pointer-2", "Select", this.selectionTools);
    this.createToolButton("lasso", "lasso", "Freehand lasso", this.selectionTools);
    if (options.includeSpace) {
      this.createToolButton("space", "between-horizontal-start", "Add or shrink vertical space", this.selectionTools);
      this.createToolButton("space-horizontal", "between-vertical-start", "Add or shrink horizontal space", this.selectionTools);
    }

    const tools = this.createGroup();
    this.createToolButton("pen", "pencil", "Pen", tools);
    this.createToolButton("highlighter", "highlighter", "Highlighter", tools);
    this.createToolButton("eraser", "eraser", "Stroke eraser", tools);

    this.stylePresets = this.createGroup();
    this.stylePresets.classList.add("modern-draw-style-presets");
    this.stylePresets.setAttribute("role", "group");
    this.stylePresets.setAttribute("aria-label", "Saved ink presets");

    this.popover = document.createElement("div");
    this.popover.className = "modern-draw-style-popover is-hidden";
    this.popover.setAttribute("aria-label", "Ink style");
    this.popover.setAttribute("role", "dialog");
    this.popover.addEventListener("pointerdown", stopEvent);
    this.popover.addEventListener("click", stopEvent);
    this.styleTitle = document.createElement("div");
    this.styleTitle.className = "modern-draw-style-title";
    this.popover.appendChild(this.styleTitle);
    const palette = document.createElement("div");
    palette.className = "modern-draw-palette";
    for (const [name, color] of INK_PALETTE) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.style.setProperty("--ink-color", color);
      swatch.setAttribute("aria-label", name);
      swatch.title = name;
      swatch.addEventListener("click", () => this.setPopoverColor(color));
      this.swatches.set(color, swatch);
      palette.appendChild(swatch);
    }
    this.popover.appendChild(palette);

    const colorRow = document.createElement("div");
    colorRow.className = "modern-draw-style-row";
    this.customColorInput = document.createElement("input");
    this.customColorInput.type = "color";
    this.customColorInput.className = "modern-draw-custom-color";
    this.customColorInput.setAttribute("aria-label", "Choose working color");
    this.customColorInput.addEventListener("input", () => this.setPopoverColor(this.customColorInput.value));
    colorRow.appendChild(this.customColorInput);
    this.pinButton = document.createElement("button");
    this.pinButton.type = "button";
    this.pinButton.className = "modern-draw-pin-style";
    this.pinButton.addEventListener("click", () => {
      const edit = this.editingPreset;
      if (edit) {
        const active = this.currentTool === edit.tool
          && sameInkStyle(edit.original, { color: this.currentColor, width: this.currentSize });
        this.hidePopover();
        actions.updatePinnedStyle(edit.tool, edit.original, edit.draft);
        if (active) actions.setStyle(edit.tool, edit.draft);
        return;
      }
      if (!isInkTool(this.currentTool)) return;
      actions.togglePinnedStyle(this.currentTool, { color: this.currentColor, width: this.currentSize });
    });
    colorRow.appendChild(this.pinButton);
    this.popover.appendChild(colorRow);

    const sizeRow = document.createElement("div");
    sizeRow.className = "modern-draw-style-row modern-draw-size-row";
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "Size";
    sizeRow.appendChild(sizeLabel);
    this.sizeInput = document.createElement("input");
    this.sizeInput.type = "range";
    this.sizeInput.setAttribute("aria-label", "Stroke size");
    this.sizeInput.addEventListener("input", () => this.setPopoverSize(Number(this.sizeInput.value)));
    sizeRow.appendChild(this.sizeInput);
    this.sizeValue = document.createElement("span");
    this.sizeValue.className = "modern-draw-size-value";
    sizeRow.appendChild(this.sizeValue);
    this.popover.appendChild(sizeRow);
    this.deleteButton = document.createElement("button");
    this.deleteButton.type = "button";
    this.deleteButton.className = "modern-draw-delete-style mod-destructive";
    this.deleteButton.textContent = "Delete preset";
    this.deleteButton.hidden = true;
    this.deleteButton.addEventListener("click", () => {
      const edit = this.editingPreset;
      if (!edit) return;
      this.hidePopover();
      actions.updatePinnedStyle(edit.tool, edit.original, null);
    });
    this.popover.appendChild(this.deleteButton);
    this.popover.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      const anchor = this.popoverAnchor;
      this.hidePopover();
      anchor?.focus();
    });
    document.body.appendChild(this.popover);
    document.addEventListener("pointerdown", this.closePopover, true);

    const hasZoom = actions.zoomIn && actions.zoomOut && actions.resetZoom;
    const view = actions.toggleLayout || hasZoom || actions.fitView || actions.openViewMenu
      ? this.createGroup() : null;
    this.layoutButton = view && actions.toggleLayout
      ? this.createButton("align-left", "Toggle centered/left canvas origin", actions.toggleLayout, view)
      : null;
    if (view && hasZoom) {
      this.createButton("plus", "Zoom in", () => actions.zoomIn?.(), view);
      this.zoomLabel = document.createElement("button");
      this.zoomLabel.type = "button";
      this.zoomLabel.className = "modern-draw-control modern-draw-zoom-label";
      this.zoomLabel.setAttribute("aria-label", "Reset zoom");
      this.zoomLabel.setAttribute("data-tooltip-position", "bottom");
      this.zoomLabel.addEventListener("click", () => actions.resetZoom?.());
      view.appendChild(this.zoomLabel);
      this.createButton("minus", "Zoom out", () => actions.zoomOut?.(), view);
    } else {
      this.zoomLabel = null;
    }
    if (view && actions.fitView) this.createButton("maximize", "Zoom to fit", actions.fitView, view);
    if (view && actions.openViewMenu) this.createButton("settings-2", "Canvas options", actions.openViewMenu, view);

    if (options.includeHistory) {
      const history = this.createGroup();
      this.undoButton = this.createButton("undo-2", "Undo ink", actions.undo, history);
      this.redoButton = this.createButton("redo-2", "Redo ink", actions.redo, history);
    } else {
      this.undoButton = null;
      this.redoButton = null;
    }

    const importTools = actions.importPdf || actions.scaleNote ? this.createGroup() : null;
    if (importTools && actions.scaleNote) this.createButton("scaling", "Scale note", actions.scaleNote, importTools);
    this.importButton = importTools && actions.importPdf
      ? this.createButton("file-plus", "Import PDF pages or slides", actions.importPdf, importTools) : null;
  }

  update(state: InkControlState): void {
    const previousTool = this.currentTool;
    this.currentTool = state.tool;
    const { toolbarAlignment, writingHand } = state.settings;
    this.root.dataset.alignment = toolbarAlignment === "writing-hand" ? writingHand : toolbarAlignment;
    this.currentColor = state.color;
    this.currentSize = state.strokeSize;
    this.currentPresets = state.tool === "pen"
      ? state.settings.penPresets
      : state.tool === "highlighter" ? state.settings.highlighterPresets : [];

    for (const [tool, button] of this.toolButtons) {
      const active = tool === state.tool;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (previousTool !== state.tool) this.hidePopover();
    const edit = this.editingPreset;
    if (edit) {
      const presets = edit.tool === "pen" ? state.settings.penPresets : state.settings.highlighterPresets;
      if (!presets.some((preset) => sameInkStyle(preset, edit.original))) this.hidePopover();
    }
    this.updateHistory(state.canUndo, state.canRedo);

    this.updatePopover();
    this.renderStylePresets(state, { color: state.color, width: state.strokeSize });

    if (this.layoutButton) {
      const isLeft = state.canvasLayout === "left";
      this.layoutButton.classList.remove("is-active");
      setIcon(this.layoutButton, isLeft ? "align-left" : "align-center");
      this.layoutButton.setAttribute(
        "aria-label",
        isLeft ? "Left-origin text canvas; switch to centered" : "Centered text canvas; switch to left origin"
      );
    }
    this.updateZoom(state.zoom);
  }

  updateZoom(zoom: number): void {
    if (!this.zoomLabel) return;
    const label = `${Math.round(zoom * 100)}%`;
    if (this.zoomLabel.textContent !== label) this.zoomLabel.textContent = label;
  }

  updateHistory(canUndo: boolean, canRedo: boolean): void {
    setControlEnabled(this.undoButton, canUndo);
    setControlEnabled(this.redoButton, canRedo);
  }

  updateImportAvailability(available: boolean): void {
    setControlEnabled(this.importButton, available);
  }

  destroy(): void {
    this.clearPresetPress();
    this.owner.removeEventListener("pointerdown", this.closePopover, true);
    this.popover.remove();
    this.root.remove();
  }

  private togglePopover(anchor: HTMLElement): void {
    if (!isInkTool(this.currentTool)) return;
    if (!this.popover.classList.contains("is-hidden") && !this.editingPreset) {
      this.hidePopover();
      return;
    }
    this.editingPreset = undefined;
    this.showPopover(anchor);
  }

  private hidePopover(): void {
    this.editingPreset = undefined;
    this.popoverAnchor = undefined;
    this.popover.classList.add("is-hidden");
  }

  private showPopover(anchor: HTMLElement): void {
    this.popoverAnchor = anchor;
    this.updatePopover();
    this.popover.classList.remove("is-hidden");
    const anchorRect = anchor.getBoundingClientRect();
    const ownerWindow = this.owner.defaultView ?? window;
    this.popover.style.left = `${Math.max(8, Math.min(ownerWindow.innerWidth - this.popover.offsetWidth - 8, anchorRect.left))}px`;
    this.popover.style.top = `${Math.max(8, Math.min(ownerWindow.innerHeight - this.popover.offsetHeight - 8, anchorRect.bottom + 8))}px`;
  }

  private editPreset(anchor: HTMLButtonElement, tool: InkTool, preset: InkStylePreset): void {
    this.editingPreset = { tool, original: preset, draft: { ...preset } };
    this.showPopover(anchor);
    this.customColorInput.focus();
  }

  private setPopoverColor(color: string): void {
    if (!this.editingPreset) this.actions.setColor(color);
    else {
      this.editingPreset.draft.color = color;
      this.updatePopover();
    }
  }

  private setPopoverSize(width: number): void {
    if (!this.editingPreset) this.actions.setStrokeSize(width);
    else {
      this.editingPreset.draft.width = width;
      this.updatePopover();
    }
  }

  private updatePopover(): void {
    const edit = this.editingPreset;
    const highlighter = (edit?.tool ?? this.currentTool) === "highlighter";
    const style = edit?.draft ?? { color: this.currentColor, width: this.currentSize };
    const name = highlighter ? "highlighter" : "pen";
    const title = edit ? `Edit ${name} preset` : highlighter ? "Highlighter style" : "Pen style";
    this.styleTitle.textContent = title;
    this.popover.setAttribute("aria-label", title);
    this.customColorInput.value = style.color;
    for (const [color, swatch] of this.swatches) swatch.setAttribute("aria-pressed", String(color === style.color));
    this.sizeInput.min = highlighter ? "4" : "1";
    this.sizeInput.max = highlighter ? "60" : "24";
    this.sizeInput.step = highlighter ? "1" : "0.5";
    this.sizeInput.value = String(style.width);
    this.sizeValue.textContent = `${style.width.toFixed(highlighter ? 0 : 1)} px`;
    this.pinButton.textContent = edit ? "Save changes"
      : this.currentPresets.some((preset) => sameInkStyle(preset, style)) ? "Remove preset" : "Save preset";
    this.pinButton.classList.toggle("mod-cta", Boolean(edit));
    this.deleteButton.hidden = !edit;
  }

  private renderStylePresets(state: InkControlState, currentStyle: InkStylePreset): void {
    const presets = orderedInkPresets(state.settings);
    // Keep the same button through selection changes so the second click can open its editor.
    const key = JSON.stringify(presets);
    if (key !== this.presetRenderKey) {
      this.presetRenderKey = key;
      this.clearPresetPress();
      this.lastPresetClick = this.presetEditClick = undefined;
      this.presetButtons.clear();
      this.stylePresets.replaceChildren();
      for (const { tool, preset } of presets) this.createPresetButton(tool, preset);
    }
    for (const [button, { tool, preset }] of this.presetButtons) {
      const active = tool === state.tool && sameInkStyle(preset, currentStyle);
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  private createPresetButton(tool: InkTool, preset: InkStylePreset): void {
    const button = this.owner.createElement("button");
    button.type = "button";
    button.className = "modern-draw-control modern-draw-style-preset";
    button.dataset.inkTool = tool;
    button.setAttribute("aria-label", `Use ${tool} preset ${preset.color}, ${preset.width}px`);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-keyshortcuts", "Shift+F10 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight");
    button.setAttribute("data-tooltip-position", "bottom");
    button.style.setProperty("--ink-color", preset.color);
    const thickness = tool === "pen" ? Math.min(4, 1 + preset.width / 6) : Math.min(6, 3 + preset.width / 20);
    button.style.setProperty("--ink-sample-size", `${thickness}px`);
    setIcon(button, tool === "pen" ? "pen" : "highlighter");
    const sample = this.owner.createElement("span");
    sample.className = "modern-draw-preset-sample";
    sample.setAttribute("aria-hidden", "true");
    button.appendChild(sample);
    button.addEventListener("pointerdown", (event) => this.startPresetPress(event, button));
    button.addEventListener("click", (event) => {
      const pointerClick = event.detail !== 0 || ("pointerType" in event && Boolean(event.pointerType));
      if (this.suppressPresetClick && pointerClick) {
        event.preventDefault();
        return;
      }
      const touchTap = pointerClick && this.lastPresetPointerType === "touch";
      const doubleTap = touchTap && this.lastPresetClick === button && event.timeStamp - this.lastTapTime < 350;
      this.presetEditClick = !touchTap && event.detail === 2 && this.lastPresetClick === button ? button : undefined;
      this.lastPresetClick = pointerClick && !doubleTap ? button : undefined;
      this.lastTapTime = touchTap ? event.timeStamp : -Infinity;
      this.hidePopover();
      this.actions.setStyle(tool, preset);
      if (doubleTap) this.editPreset(button, tool, preset);
    });
    const edit = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.editPreset(button, tool, preset);
    };
    button.addEventListener("dblclick", (event) => {
      if (this.presetEditClick === button) edit(event);
    });
    button.addEventListener("contextmenu", (event) => {
      // A touch long press belongs to reordering. A mouse context click still opens the editor.
      if (("pointerType" in event && event.pointerType === "touch")
        || (this.presetPress?.button === button && event.button !== 2)) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        edit(event);
      }
    });
    button.addEventListener("keydown", (event) => {
      if (event.shiftKey && event.key === "F10") edit(event);
      if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        const direction = (event.key === "ArrowLeft" ? -1 : 1) * this.presetInlineDirection();
        this.movePresetByKey(button, direction);
      }
    });
    this.presetButtons.set(button, { tool, preset });
    this.stylePresets.appendChild(button);
  }

  private startPresetPress(event: PointerEvent, button: HTMLButtonElement): void {
    if (event.button !== 0 || !event.isPrimary || this.presetPress) return;
    this.suppressPresetClick = false;
    this.lastPresetPointerType = event.pointerType;
    if (this.presetButtons.size < 2 && this.stylePresets.scrollWidth <= this.stylePresets.clientWidth) return;
    const view = this.owner.defaultView ?? window;
    const press: PresetPress = {
      button,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: this.stylePresets.scrollLeft,
      phase: "pressed"
    };
    this.presetPress = press;
    press.timer = view.setTimeout(() => this.activatePresetDrag(press), PRESET_HOLD_MS);
    this.owner.addEventListener("pointermove", this.onPresetPointerMove, true);
    this.owner.addEventListener("pointerup", this.onPresetPointerEnd, true);
    this.owner.addEventListener("pointercancel", this.onPresetPointerEnd, true);
    this.owner.addEventListener("keydown", this.onPresetEscape, true);
    view.addEventListener("blur", this.onPresetBlur);
  }

  private activatePresetDrag(press: PresetPress): void {
    if (this.presetPress !== press || this.presetButtons.size < 2) return;
    press.phase = "drag";
    this.suppressPresetClick = true;
    this.lastPresetClick = this.presetEditClick = undefined;
    this.hidePopover();
    press.button.classList.add("is-preset-dragging");
    this.stylePresets.classList.add("is-reordering");
    try {
      press.button.setPointerCapture(press.pointerId);
    } catch {
      // The document listeners also handle pointers that cannot be captured.
    }
    this.updatePresetDrop(press);
  }

  private readonly onPresetPointerMove = (event: PointerEvent): void => {
    const press = this.presetPress;
    if (!press || event.pointerId !== press.pointerId) return;
    press.x = event.clientX;
    press.y = event.clientY;
    if (press.phase === "pressed") {
      if (Math.hypot(press.x - press.startX, press.y - press.startY) <= PRESET_MOVE_THRESHOLD) return;
      const view = this.owner.defaultView ?? window;
      view.clearTimeout(press.timer);
      this.suppressPresetClick = true;
      this.lastPresetClick = this.presetEditClick = undefined;
      if (event.pointerType === "touch") press.phase = "scroll";
      else this.activatePresetDrag(press);
    }
    event.preventDefault();
    if (press.phase === "scroll") {
      this.stylePresets.scrollLeft = press.scrollLeft + press.startX - press.x;
    } else {
      this.updatePresetDrop(press);
    }
  };

  private readonly onPresetPointerEnd = (event: PointerEvent): void => {
    const press = this.presetPress;
    if (!press || event.pointerId !== press.pointerId) return;
    press.x = event.clientX;
    press.y = event.clientY;
    const drop = press.phase === "drag" && event.type === "pointerup" ? this.presetDrop(press) : undefined;
    this.clearPresetPress();
    if (drop) {
      const source = this.presetButtons.get(press.button);
      const before = drop.before ? this.presetButtons.get(drop.before) : null;
      if (source && before !== undefined) this.actions.movePinnedStyle(source, before);
    }
  };

  private readonly onPresetEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.presetPress?.phase !== "drag") return;
    event.preventDefault();
    event.stopPropagation();
    this.clearPresetPress();
  };

  private readonly onPresetBlur = (): void => this.clearPresetPress();

  private clearPresetPress(): void {
    const press = this.presetPress;
    if (!press) return;
    const view = this.owner.defaultView ?? window;
    this.presetPress = undefined;
    view.clearTimeout(press.timer);
    if (press.frame !== undefined) view.cancelAnimationFrame(press.frame);
    press.button.classList.remove("is-preset-dragging");
    press.indicator?.classList.remove("is-drop-before", "is-drop-after");
    this.stylePresets.classList.remove("is-reordering");
    if (press.button.hasPointerCapture(press.pointerId)) press.button.releasePointerCapture(press.pointerId);
    this.owner.removeEventListener("pointermove", this.onPresetPointerMove, true);
    this.owner.removeEventListener("pointerup", this.onPresetPointerEnd, true);
    this.owner.removeEventListener("pointercancel", this.onPresetPointerEnd, true);
    this.owner.removeEventListener("keydown", this.onPresetEscape, true);
    view.removeEventListener("blur", this.onPresetBlur);
  }

  private presetDrop(press: PresetPress): { before: HTMLButtonElement | null; last: HTMLButtonElement } | undefined {
    const bounds = this.stylePresets.getBoundingClientRect();
    if (press.x < bounds.left - 12 || press.x > bounds.right + 12
      || press.y < bounds.top - 22 || press.y > bounds.bottom + 22) return;
    const buttons = [...this.presetButtons.keys()].filter((button) => button !== press.button);
    if (buttons.length === 0) return;
    const direction = this.presetInlineDirection();
    const before = buttons.find((button) => {
      const rect = button.getBoundingClientRect();
      return (press.x - (rect.left + rect.right) / 2) * direction < 0;
    }) ?? null;
    return { before, last: buttons[buttons.length - 1] };
  }

  private updatePresetDrop(press: PresetPress): void {
    const drop = this.presetDrop(press);
    press.indicator?.classList.remove("is-drop-before", "is-drop-after");
    press.indicator = drop ? drop.before ?? drop.last : undefined;
    press.indicator?.classList.add(drop?.before ? "is-drop-before" : "is-drop-after");
    if (!drop || press.frame !== undefined || this.stylePresets.scrollWidth <= this.stylePresets.clientWidth) return;
    const { left, right } = this.stylePresets.getBoundingClientRect();
    const edge = Math.min(24, (right - left) / 4);
    const speed = press.x < left + edge ? -6 : press.x > right - edge ? 6 : 0;
    if (speed === 0) return;
    const view = this.owner.defaultView ?? window;
    press.frame = view.requestAnimationFrame(() => {
      press.frame = undefined;
      const position = this.stylePresets.scrollLeft;
      this.stylePresets.scrollLeft += speed;
      if (this.stylePresets.scrollLeft !== position) this.updatePresetDrop(press);
    });
  }

  private presetInlineDirection(): number {
    return this.owner.defaultView?.getComputedStyle(this.stylePresets).direction === "rtl" ? -1 : 1;
  }

  private movePresetByKey(button: HTMLButtonElement, direction: number): void {
    const buttons = [...this.presetButtons.keys()];
    const from = buttons.indexOf(button);
    const to = from + direction;
    if (to < 0 || to >= buttons.length) return;
    const source = this.presetButtons.get(button)!;
    const before = this.presetButtons.get(buttons[direction > 0 ? to + 1 : to]) ?? null;
    this.actions.movePinnedStyle(source, before);
    for (const [updated, entry] of this.presetButtons) {
      if (entry.tool === source.tool && sameInkStyle(entry.preset, source.preset)) {
        updated.focus();
        break;
      }
    }
  }

  private createGroup(): HTMLDivElement {
    const group = this.owner.createElement("div");
    group.className = "modern-draw-control-group";
    this.root.appendChild(group);
    return group;
  }

  private createToolButton(tool: DrawingTool, icon: string, label: string, parent: HTMLElement): void {
    let button: HTMLDivElement;
    button = this.createButton(icon, label, () => {
      if (isInkTool(tool) && this.currentTool === tool) this.togglePopover(button);
      else {
        this.hidePopover();
        this.actions.setTool(tool);
      }
    }, parent);
    button.dataset.tool = tool;
    this.toolButtons.set(tool, button);
  }

  private createButton(icon: string, label: string, action: (button: HTMLElement) => void, parent: HTMLElement): HTMLDivElement {
    const button = this.owner.createElement("div");
    button.className = "modern-draw-control modern-draw-button";
    button.tabIndex = 0;
    button.setAttribute("role", "button");
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip-position", "bottom");
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.classList.contains("is-disabled")) action(button);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      if (!button.classList.contains("is-disabled")) action(button);
    });
    parent.appendChild(button);
    return button;
  }
}

function setControlEnabled(button: HTMLElement | null, enabled: boolean): void {
  if (!button) return;
  button.classList.toggle("is-disabled", !enabled);
  button.setAttribute("aria-disabled", String(!enabled));
}

function isInkTool(tool: DrawingTool): tool is InkTool {
  return tool === "pen" || tool === "highlighter";
}

const INK_PALETTE = [
  ["Ink black", "#182333"], ["Graphite", "#566273"], ["White", "#ffffff"],
  ["Ocean blue", "#07599c"], ["Sky blue", "#35a7e6"], ["Violet", "#7047c7"],
  ["Crimson", "#c32637"], ["Coral", "#f06d5e"], ["Amber", "#ed861c"],
  ["Forest green", "#187446"], ["Mint", "#62d399"], ["Sunflower", "#ffd84d"]
] as const;

function stopEvent(event: Event): void {
  event.stopPropagation();
}
