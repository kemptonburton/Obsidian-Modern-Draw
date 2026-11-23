import { EditorView } from "@codemirror/view";
import {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TFile,
  type App
} from "obsidian";
import { DrawingController } from "./controller";
import { CanvasInkManager } from "./canvas-extension";
import { createInkEditorExtension, inkEditorAction, type InkEditorAction } from "./editor-extension";
import { InkStore } from "./ink-store";
import {
  DEFAULT_SETTINGS,
  parseRegionDisplay,
  type DrawingTool,
  type InkStylePreset,
  type ModernDrawSettings
} from "./model";
import { renderPrintInk } from "./ink-print";
import { notePdfImportDestination, PdfImportModal } from "./pdf-import";
import { ModernDrawSettingTab } from "./settings";
import { NoteImportModal } from "./import-modal";
import { registerRegionFeatures } from "./pdf-viewer";
import { moveNoteZoom } from "./note-zoom";

export default class ModernDrawPlugin extends Plugin {
  settings: ModernDrawSettings = { ...DEFAULT_SETTINGS };
  controller!: DrawingController;
  store!: InkStore;
  canvasInkManager!: CanvasInkManager;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addCommand({ id: "import-notes", name: "Import Excalidraw, OneNote, or Notability notes", callback: () => new NoteImportModal(this.app, this).open() });
    this.controller = new DrawingController(this.settings);
    this.store = new InkStore(this.app, () => this.settings, (message, error) => {
      console.error(`Modern Draw: ${message}`, error);
      new Notice(message);
    });
    this.registerMarkdownPostProcessor(
      (element, context) => renderPrintInk(this.app, this.store, element, context.sourcePath, this.settings),
      100
    );
    const regions = registerRegionFeatures(this, this.controller, this.store);
    this.canvasInkManager = new CanvasInkManager(this.app, {
      controller: this.controller,
      store: this.store,
      regions,
      saveSettings: (settings) => this.saveSettings(settings)
    });
    this.app.workspace.onLayoutReady(() => this.canvasInkManager.start());
    this.register(() => this.canvasInkManager.destroy());

    this.registerEditorExtension(
      createInkEditorExtension({
        app: this.app,
        controller: this.controller,
        store: this.store,
        regions,
        importPdf: (info) => {
          const target = notePdfImportDestination(this.app, info);
          if (target) new PdfImportModal(this.app, target).open();
        },
        saveSettings: async (settings) => this.saveSettings(settings)
      })
    );

    const refreshInk = (file: unknown): void => {
      if (file instanceof TFile) void this.store.refreshFile(file);
    };
    this.registerEvent(this.app.vault.on("create", refreshInk));
    this.registerEvent(this.app.vault.on("modify", refreshInk));
    this.registerDomEvent(window, "pagehide", () => void this.store.flushAll());
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.store.flushAll();
    });

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === "md" || file.extension === "canvas") {
          if (file.extension === "md") moveNoteZoom(this.app, oldPath, file.path);
          if (this.settings.importScaleReference === oldPath) void this.updateSetting("importScaleReference", file.path);
          void this.store.renameDocument(oldPath, file.path);
        } else {
          refreshInk(file);
        }
      })
    );

    const ribbon = this.addRibbonIcon("pencil-ruler", "Toggle Modern Draw pen", () => {
      this.controller.setTool(this.controller.activeTool === "pen" ? "select" : "pen");
    });
    ribbon.addClass("modern-draw-ribbon");

    this.addToolCommand("select", "Switch to text/select mode");
    this.addToolCommand("lasso", "Switch to freehand lasso");
    this.addToolCommand("pen", "Switch to pen");
    this.addToolCommand("highlighter", "Switch to highlighter");
    this.addToolCommand("eraser", "Switch to stroke eraser");
    this.addToolCommand("space", "Insert vertical space");
    this.addCommand({
      id: "tool-space-horizontal",
      name: "Insert horizontal space",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() === "preview") return false;
        if (!checking) this.controller.setTool("space-horizontal");
        return true;
      }
    });

    this.addCommand({
      id: "import-pdf-pages",
      name: "Import PDF pages or slides",
      checkCallback: (checking) => {
        const view = this.app.workspace.getMostRecentLeaf()?.view;
        const note = view instanceof MarkdownView && view.getMode() !== "preview" ? view : null;
        if (checking && note) return Boolean(note.file && note.editor);
        const target = note
          ? notePdfImportDestination(this.app, note)
          : this.canvasInkManager.activePdfImportDestination();
        if (!target) return false;
        if (!checking) new PdfImportModal(this.app, target).open();
        return true;
      }
    });
    this.addCommand({
      id: "toggle-drawing-mode",
      name: "Toggle pen mode",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "D" }],
      callback: () => this.controller.setTool(this.controller.activeTool === "pen" ? "select" : "pen")
    });
    this.addCommand({
      id: "undo-ink",
      name: "Undo ink",
      editorCheckCallback: (checking) => checking || this.dispatchToActiveEditor("undo")
    });
    this.addCommand({
      id: "redo-ink",
      name: "Redo ink",
      editorCheckCallback: (checking) => checking || this.dispatchToActiveEditor("redo")
    });
    this.addCommand({
      id: "zoom-in",
      name: "Zoom canvas in",
      editorCheckCallback: (checking) => checking || this.dispatchToActiveEditor("zoom-in")
    });
    this.addCommand({
      id: "zoom-out",
      name: "Zoom canvas out",
      editorCheckCallback: (checking) => checking || this.dispatchToActiveEditor("zoom-out")
    });
    this.addCommand({
      id: "zoom-reset",
      name: "Reset canvas zoom",
      editorCheckCallback: (checking) => checking || this.dispatchToActiveEditor("zoom-reset")
    });
    this.addCommand({
      id: "toggle-canvas-origin",
      name: "Toggle centered/left canvas origin",
      editorCheckCallback: (checking) => checking || this.dispatchToActiveEditor("toggle-layout")
    });
    this.addCommand({
      id: "clear-note-ink",
      name: "Clear all ink from current note",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        const document = this.store.getLoadedDocument(view.file.path);
        if (!document || document.strokes.length === 0) return false;
        if (!checking) new ClearInkModal(this.app, () => this.dispatchToActiveEditor("clear")).open();
        return true;
      }
    });

    this.addSettingTab(new ModernDrawSettingTab(this.app, this));
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    this.controller.updateSettings(this.settings);
  }

  async onunload(): Promise<void> {
    await this.store?.flushAll();
  }

  async updateSetting<Key extends keyof ModernDrawSettings>(key: Key, value: ModernDrawSettings[Key]): Promise<void> {
    const settings = { ...this.settings, [key]: value };
    await this.saveSettings(settings);
  }

  private addToolCommand(tool: DrawingTool, name: string): void {
    this.addCommand({
      id: `tool-${tool}`,
      name,
      callback: () => this.controller.setTool(tool)
    });
  }

  private dispatchToActiveEditor(action: InkEditorAction): boolean {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) return false;
    // Obsidian documents this bridge, but its public Editor type does not expose `cm`.
    // @ts-expect-error The CodeMirror EditorView exists on Obsidian's editor at runtime.
    const editorView = markdownView.editor.cm as EditorView | undefined;
    if (!editorView) return false;
    editorView.dispatch({ effects: inkEditorAction.of(action) });
    return true;
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as (Partial<ModernDrawSettings> & {
      pinnedColors?: unknown; regionDisplay?: unknown; zoom?: unknown; canvasLayout?: unknown;
    }) | null;
    const { regionDisplay: legacyDisplay, zoom: _syncedZoom, canvasLayout: _defaultLayout, ...saved } = loaded ?? {};
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    const legacyColors = normalizeLegacyColors(loaded?.pinnedColors);
    const previousOverride = legacyDisplay === "icon" ? undefined : parseRegionDisplay(legacyDisplay);
    this.settings = {
      ...merged,
      importScale: Number.isFinite(merged.importScale) && merged.importScale > 0 ? merged.importScale : 1,
      importScaleReference: typeof merged.importScaleReference === "string" ? merged.importScaleReference : "",
      matchNotabilityImportSize: merged.matchNotabilityImportSize !== false,
      stylusPressure: merged.stylusPressure !== false,
      inkLocation: ["root", "same", "subfolder", "fixed"].includes(merged.inkLocation)
        ? merged.inkLocation : DEFAULT_SETTINGS.inkLocation,
      inkFolder: checkedFolder(merged.inkFolder) ?? DEFAULT_SETTINGS.inkFolder,
      inkSubfolder: checkedFolder(merged.inkSubfolder) ?? DEFAULT_SETTINGS.inkSubfolder,
      toolbarAlignment: merged.toolbarAlignment === "center" || merged.toolbarAlignment === "left"
        || merged.toolbarAlignment === "right" ? merged.toolbarAlignment : DEFAULT_SETTINGS.toolbarAlignment,
      doubleTapToErase: merged.doubleTapToErase !== false,
      writingHand: merged.writingHand === "left" || merged.writingHand === "right" ? merged.writingHand : "off",
      palmRestHeight: Number.isFinite(merged.palmRestHeight)
        ? Math.max(5, Math.min(45, merged.palmRestHeight)) : DEFAULT_SETTINGS.palmRestHeight,
      noteRegionDisplay: parseRegionDisplay(saved.noteRegionDisplay) ?? previousOverride ?? DEFAULT_SETTINGS.noteRegionDisplay,
      canvasRegionDisplay: parseRegionDisplay(saved.canvasRegionDisplay) ?? previousOverride ?? DEFAULT_SETTINGS.canvasRegionDisplay,
      pdfRegionDisplay: parseRegionDisplay(saved.pdfRegionDisplay) ?? previousOverride ?? DEFAULT_SETTINGS.pdfRegionDisplay,
      regionOutlineColor: isHexColor(saved.regionOutlineColor) ? saved.regionOutlineColor : DEFAULT_SETTINGS.regionOutlineColor,
      regionHighlightColor: isHexColor(saved.regionHighlightColor) ? saved.regionHighlightColor : DEFAULT_SETTINGS.regionHighlightColor,
      penPresets: normalizeInkPresets(
        loaded?.penPresets ?? (legacyColors.length
          ? legacyColors.map((color) => ({ color, width: merged.penWidth }))
          : DEFAULT_SETTINGS.penPresets),
        "pen"
      ),
      highlighterPresets: normalizeInkPresets(
        loaded?.highlighterPresets ?? (legacyColors.length
          ? legacyColors.map((color) => ({ color, width: merged.highlighterWidth }))
          : DEFAULT_SETTINGS.highlighterPresets),
        "highlighter"
      )
    };
    delete (this.settings as ModernDrawSettings & { pinnedColors?: unknown }).pinnedColors;
    delete (this.settings as ModernDrawSettings & { workspaceWidth?: unknown }).workspaceWidth;
  }

  private async saveSettings(settings: ModernDrawSettings): Promise<void> {
    const normalized = {
      ...settings,
      penPresets: normalizeInkPresets(settings.penPresets, "pen"),
      highlighterPresets: normalizeInkPresets(settings.highlighterPresets, "highlighter")
    };
    this.settings = normalized;
    this.controller.updateSettings(normalized);
    await this.saveData(normalized);
  }
}

class ClearInkModal extends Modal {
  constructor(app: App, private readonly clear: () => void) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Clear this note's ink?");
    this.contentEl.createEl("p", {
      text: "This removes every Modern Draw stroke from the current note. You can undo immediately afterward."
    });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-warning", text: "Clear ink" });
    confirm.addEventListener("click", () => {
      this.clear();
      this.close();
    });
  }
}


function isHexColor(color: unknown): color is string {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color);
}

function normalizeLegacyColors(colors: unknown): string[] {
  if (!Array.isArray(colors)) return [];
  return Array.from(new Set(
    colors
      .filter(isHexColor)
      .map((color) => color.toLowerCase())
  ));
}

function normalizeInkPresets(presets: unknown, tool: "pen" | "highlighter"): InkStylePreset[] {
  if (!Array.isArray(presets)) return [];
  const min = tool === "pen" ? 1 : 4;
  const max = tool === "pen" ? 24 : 60;
  const normalized: InkStylePreset[] = [];
  const seen = new Set<string>();
  for (const candidate of presets) {
    if (!candidate || typeof candidate !== "object") continue;
    const { color, width, order } = candidate as Partial<InkStylePreset>;
    if (
      !isHexColor(color)
      || typeof width !== "number"
      || !Number.isFinite(width)
    ) continue;
    const preset = {
      color: color.toLowerCase(),
      width: Math.round(Math.max(min, Math.min(max, width)) * 10) / 10,
      order: Number.isSafeInteger(order) ? order : undefined
    };
    const key = `${preset.color}:${preset.width}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(preset);
    if (normalized.length >= 12) break;
  }
  return normalized;
}

function checkedFolder(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || /[:*?"<>|]/.test(normalized)
    || normalized.split("/").some((part) => !part.trim() || part.startsWith("."))) return;
  return normalized;
}
