import { App, type TFile, normalizePath } from "obsidian";
import { decodeInk, encodeInk, mergeInk, recordInkChanges } from "./ink-storage";
import type { SnapshotRegion } from "./snapshot-region";
import { hashPath, lineAt, resolveAnchor } from "./anchors";
import {
  cloneFloatingImages,
  cloneStrokes,
  cloneVerticalSpaces,
  createStrokeId,
  normalizeCanvasLayout,
  type CanvasLayout,
  type FloatingImagePlacement,
  type InkFileData,
  type InkStroke,
  type ModernDrawSettings,
  type VerticalSpace
} from "./model";

const LEGACY_INK_FOLDER = ".modern-draw";
const HISTORY_LIMIT = 80;

type Subscriber = (persist: boolean) => void;

interface InkDocumentSnapshot {
  strokes: InkStroke[];
  floatingImages: FloatingImagePlacement[];
  verticalSpaces: VerticalSpace[];
  snapshotRegions: SnapshotRegion[];
}

export interface IndexedInkStroke {
  index: number;
  stroke: InkStroke;
}

export class InkDocument {
  strokes: InkStroke[];
  floatingImages: FloatingImagePlacement[];
  verticalSpaces: VerticalSpace[];
  sourcePath: string;
  snapshotRegions: SnapshotRegion[] = [];
  private knownDocumentText: string | null = null;
  private noteLayout?: InkFileData["canvasLayout"];

  private readonly subscribers = new Set<Subscriber>();
  private readonly textDeletedStrokeIds = new Set<string>();
  private undoStack: InkDocumentSnapshot[] = [];
  private redoStack: InkDocumentSnapshot[] = [];

  constructor(
    sourcePath: string,
    strokes: InkStroke[],
    floatingImages: FloatingImagePlacement[] = [],
    verticalSpaces: VerticalSpace[] = [],
    layout?: CanvasLayout
  ) {
    this.sourcePath = sourcePath;
    this.strokes = strokes;
    this.floatingImages = floatingImages;
    this.verticalSpaces = verticalSpaces;
    this.noteLayout = layout;
  }

  /** Import default or legacy layout, used only to initialize a device's view of this note. */
  get canvasLayout(): CanvasLayout | undefined {
    return normalizeCanvasLayout(this.noteLayout);
  }

  setCanvasLayout(layout: CanvasLayout): void {
    if (this.noteLayout === layout) return;
    this.noteLayout = layout;
    this.emit();
  }

  initializeHorizontalOrigins(origin: number): void {
    if (this.strokes.every((stroke) => Number.isFinite(stroke.horizontalOrigin))) return;
    this.strokes = this.strokes.map((stroke) => Number.isFinite(stroke.horizontalOrigin)
      ? stroke : { ...stroke, horizontalOrigin: origin });
    this.emit();
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  append(stroke: InkStroke): void {
    this.recordHistory();
    this.strokes = [...this.strokes, stroke];
    this.emit();
  }

  commit(strokes: InkStroke[], recordHistory = true): void {
    if (recordHistory) this.recordHistory();
    this.strokes = this.cloneVisibleStrokes(strokes);
    this.emit();
  }

  eraseStrokes(ids: ReadonlySet<string>): boolean {
    const next = this.strokes.filter((stroke) => !ids.has(stroke.id));
    if (next.length === this.strokes.length) return false;
    this.commit(next);
    return true;
  }

  recolorStrokes(ids: ReadonlySet<string>, color: string): boolean {
    if (!this.strokes.some((stroke) => ids.has(stroke.id) && stroke.color !== color)) return false;
    this.commit(this.strokes.map((stroke) => ids.has(stroke.id) ? { ...stroke, color } : stroke));
    return true;
  }

  applyTextInkEdit(entries: readonly IndexedInkStroke[], restore: boolean, text: string): void {
    const next = [...this.strokes];
    const visibleIds = new Set(next.map(({ id }) => id));
    let changed = false;
    for (const { index, stroke } of entries) {
      if (restore) {
        this.textDeletedStrokeIds.delete(stroke.id);
        if (visibleIds.has(stroke.id)) continue;
        next.splice(index, 0, { ...stroke, anchor: resolveAnchor(text, stroke.anchor) });
        visibleIds.add(stroke.id);
        changed = true;
      } else {
        this.textDeletedStrokeIds.add(stroke.id);
        changed = visibleIds.has(stroke.id) || changed;
      }
    }
    if (changed) this.commit(next, false);
  }

  commitState(
    strokes: InkStroke[],
    floatingImages: FloatingImagePlacement[],
    verticalSpaces: VerticalSpace[] = this.verticalSpaces,
    recordHistory = true,
    snapshotRegions = this.snapshotRegions
  ): void {
    if (recordHistory) this.recordHistory();
    this.strokes = this.cloneVisibleStrokes(strokes);
    this.floatingImages = cloneFloatingImages(floatingImages);
    this.verticalSpaces = cloneVerticalSpaces(verticalSpaces);
    this.snapshotRegions = snapshotRegions;
    this.emit();
  }

  updateRegions(regions: readonly SnapshotRegion[], recordHistory = true): void {
    if (!regions.length) return;
    if (recordHistory) this.recordHistory();
    this.snapshotRegions = mergeSnapshotRegions(this.snapshotRegions, regions);
    this.emit();
  }

  commitFloatingImages(images: FloatingImagePlacement[]): void {
    this.floatingImages = cloneFloatingImages(images);
    this.emit();
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    this.redoStack.push(this.snapshot());
    if (previous) {
      this.restore(previous);
    } else if (this.strokes.length > 0) {
      // A freshly loaded document has no in-memory history. Treat its stored
      // strokes as the initial undo chain so toolbar undo works immediately
      // after opening or reloading a note.
      this.strokes = cloneStrokes(this.strokes.slice(0, -1));
    } else {
      this.redoStack.pop();
      return false;
    }
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.emit();
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.strokes.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Keep anchors aligned with Markdown edits. The text guard prevents two panes
   * showing the same note from applying the same CodeMirror change twice.
   */
  syncDocumentText(oldText: string, newText: string, mapPosition: (position: number) => number): void {
    if (this.knownDocumentText === newText) return;
    let changed = false;
    const strokes = cloneStrokes(this.strokes);
    const floatingImages = cloneFloatingImages(this.floatingImages);
    const verticalSpaces = cloneVerticalSpaces(this.verticalSpaces);
    if (this.knownDocumentText === null || this.knownDocumentText !== oldText) {
      for (const stroke of strokes) {
        const resolved = resolveAnchor(newText, stroke.anchor);
        if (resolved.pos !== stroke.anchor.pos || resolved.lineText !== stroke.anchor.lineText) changed = true;
        stroke.anchor = resolved;
      }
      for (const image of floatingImages) {
        const resolved = resolveAnchor(newText, image.anchor);
        if (resolved.pos !== image.anchor.pos || resolved.lineText !== image.anchor.lineText) changed = true;
        image.anchor = resolved;
      }
      for (const space of verticalSpaces) {
        const resolved = resolveAnchor(newText, space.anchor);
        if (resolved.pos !== space.anchor.pos || resolved.lineText !== space.anchor.lineText) changed = true;
        space.anchor = resolved;
      }
    } else {
      for (const stroke of strokes) {
        const resolved = resolveAnchor(newText, { ...stroke.anchor, pos: mapPosition(stroke.anchor.pos) });
        if (resolved.pos !== stroke.anchor.pos || resolved.lineText !== stroke.anchor.lineText) changed = true;
        stroke.anchor = resolved;
      }
      for (const image of floatingImages) {
        const mappedPosition = mapPosition(image.anchor.pos);
        const resolved = resolveAnchor(newText, { ...image.anchor, pos: mappedPosition });
        if (resolved.pos !== image.anchor.pos || resolved.lineText !== image.anchor.lineText) changed = true;
        image.anchor = resolved;
      }
      for (const space of verticalSpaces) {
        const mappedPosition = mapPosition(space.anchor.pos);
        const safePosition = Math.max(0, Math.min(newText.length, mappedPosition));
        const lineStart = safePosition === 0 ? 0 : newText.lastIndexOf("\n", safePosition - 1) + 1;
        const lineEndIndex = newText.indexOf("\n", lineStart);
        const lineEnd = lineEndIndex < 0 ? newText.length : lineEndIndex;
        const lineText = newText.slice(lineStart, lineEnd);
        if (lineStart !== space.anchor.pos || lineText !== space.anchor.lineText) changed = true;
        space.anchor = { pos: lineStart, lineText };
      }
    }
    const snapshotRegions = this.snapshotRegions.map((region) => {
      if (!region.noteAnchor || region.deleted) return region;
      const { noteAnchor } = region;
      const resolved = this.knownDocumentText === oldText
        ? lineAt(newText, mapPosition(noteAnchor.pos))
        : lineAt(newText, resolveAnchor(newText, noteAnchor).pos);
      if (resolved.from === noteAnchor.pos && resolved.text === noteAnchor.lineText) return region;
      changed = true;
      return { ...region, noteAnchor: { pos: resolved.from, lineText: resolved.text } };
    });
    this.knownDocumentText = newText;
    if (changed) {
      this.strokes = strokes;
      this.floatingImages = floatingImages;
      this.verticalSpaces = verticalSpaces;
      this.snapshotRegions = snapshotRegions;
      this.emit();
    }
  }

  data(): InkFileData {
    return {
      version: 1,
      sourcePath: this.sourcePath,
      updatedAt: new Date().toISOString(),
      strokes: this.strokes,
      floatingImages: this.floatingImages,
      verticalSpaces: this.verticalSpaces,
      snapshotRegions: this.snapshotRegions.length ? this.snapshotRegions : undefined,
      canvasLayout: this.noteLayout
    };
  }

  applySynced(data: InkFileData, clearHistory: boolean): void {
    this.strokes = data.strokes;
    this.floatingImages = data.floatingImages ?? [];
    this.verticalSpaces = data.verticalSpaces ?? [];
    this.noteLayout = data.canvasLayout;
    this.snapshotRegions = data.snapshotRegions ?? [];
    this.knownDocumentText = null;
    if (clearHistory) {
      this.textDeletedStrokeIds.clear();
      this.undoStack = [];
      this.redoStack = [];
    }
    this.emit(false);
  }

  private recordHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private snapshot(): InkDocumentSnapshot {
    return {
      strokes: this.strokes,
      floatingImages: this.floatingImages,
      verticalSpaces: this.verticalSpaces,
      snapshotRegions: this.snapshotRegions
    };
  }

  private restore(snapshot: InkDocumentSnapshot): void {
    this.strokes = this.cloneVisibleStrokes(snapshot.strokes);
    this.floatingImages = cloneFloatingImages(snapshot.floatingImages);
    this.verticalSpaces = cloneVerticalSpaces(snapshot.verticalSpaces);
    this.snapshotRegions = snapshot.snapshotRegions;
  }

  private cloneVisibleStrokes(strokes: InkStroke[]): InkStroke[] {
    return cloneStrokes(this.textDeletedStrokeIds.size
      ? strokes.filter(({ id }) => !this.textDeletedStrokeIds.has(id))
      : strokes);
  }

  private emit(persist = true): void {
    for (const subscriber of this.subscribers) subscriber(persist);
  }
}

interface StoredDrawing {
  document: InkDocument;
  path: string | null;
  file?: TFile;
  raw?: string;
  savedSourcePath?: string;
  local: InkFileData;
  dirty: boolean;
  saveQueued: boolean;
  chain: Promise<void>;
}

export class InkStore {
  private readonly documents = new Map<string, StoredDrawing>();
  private readonly loading = new Map<string, Promise<StoredDrawing>>();
  private readonly writer = createStrokeId();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => ModernDrawSettings,
    private readonly onError: (message: string, error: unknown) => void
  ) {}

  async getDocument(sourcePath: string): Promise<InkDocument> {
    const current = this.documents.get(sourcePath);
    if (current) return current.document;
    let loading = this.loading.get(sourcePath);
    if (!loading) {
      loading = this.load(sourcePath).finally(() => this.loading.delete(sourcePath));
      this.loading.set(sourcePath, loading);
    }
    return (await loading).document;
  }

  getLoadedDocument(sourcePath: string): InkDocument | null {
    return this.documents.get(sourcePath)?.document ?? null;
  }

  async renameDocument(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.getDocument(oldPath);
      const entry = this.documents.get(oldPath);
      if (!entry) return;
      this.documents.delete(oldPath);
      this.documents.set(newPath, entry);
      this.enqueue(entry, async () => {
        entry.document.sourcePath = newPath;
        entry.local = { ...entry.local, sourcePath: newPath };
        if (!entry.path && !entry.dirty) return;
        const previousPath = entry.path;
        if (previousPath) {
          // The vault may already have moved the ink file as part of a folder rename.
          const file = entry.file ?? this.app.vault.getFileByPath(previousPath);
          const existingPath = file?.path ?? previousPath;
          const desired = renamedInkPath(previousPath, existingPath, oldPath, newPath);
          const target = await this.claimPath(desired, newPath, existingPath);
          if (file && file.path !== target && !this.app.vault.getAbstractFileByPath(target)) {
            await this.ensureFolder(target);
            await this.app.vault.rename(file, target);
          }
          entry.path = target;
          entry.file = this.app.vault.getFileByPath(target) ?? undefined;
          if (entry.file !== file) entry.raw = undefined;
        }
        entry.dirty = true;
        await this.save(entry);
      });
      await entry.chain;
    } catch (error) {
      this.onError("Could not move Modern Draw ink after rename.", error);
    }
  }

  async refreshFile(file: TFile): Promise<void> {
    if (!file.path.endsWith(".ink.json")) return;
    const path = file.path;
    try {
      const entry = [...this.documents.values()].find((loaded) => loaded.file === file || loaded.path === path)
        ?? this.documents.get(decodeInk(await this.app.vault.read(file)).sourcePath);
      if (!entry) return;
      await this.enqueue(entry, async () => {
        if (file.path !== path || (entry.path && entry.path !== path && this.app.vault.getFileByPath(entry.path))) return;
        const raw = await this.app.vault.read(file);
        if (entry.raw === raw) return;
        const incoming = decodeInk(raw);
        if (incoming.sourcePath !== entry.document.sourcePath) return;
        entry.path = path;
        entry.file = file;
        entry.raw = raw;
        entry.savedSourcePath = incoming.sourcePath;
        const merged = mergeInk(entry.local, incoming);
        entry.dirty = drawingContents(merged, true) !== drawingContents(incoming, true);
        this.applyMerged(entry, merged);
        if (entry.dirty) this.queueSave(entry);
      }, `Could not read drawing data at ${path}.`);
    } catch (error) {
      this.onError(`Could not read drawing data at ${path}.`, error);
    }
  }

  async flushAll(): Promise<void> {
    for (const entry of this.documents.values()) {
      if (entry.dirty) this.queueSave(entry);
    }
    await Promise.allSettled(Array.from(this.documents.values(), (entry) => entry.chain));
  }

  async flushDocument(sourcePath: string): Promise<void> {
    const entry = this.documents.get(sourcePath);
    if (!entry) return;
    if (entry.dirty) this.queueSave(entry);
    await entry.chain;
    if (entry.dirty) throw new Error(`Drawing data for ${sourcePath} could not be saved. The note remains available for recovery.`);
  }

  private async load(sourcePath: string): Promise<StoredDrawing> {
    const document = new InkDocument(sourcePath, []);
    let path: string | null = null;
    let legacy = false;
    let raw: string | undefined;
    let saved: InkFileData | undefined;
    let file: TFile | null = null;
    try {
      file = await this.findFile(sourcePath);
      if (file) {
        path = file.path;
        const contents = await this.app.vault.read(file);
        const data = decodeInk(contents);
        if (data.sourcePath !== sourcePath) throw new Error("Ink file belongs to a different source.");
        raw = contents;
        saved = data;
        document.applySynced(data, false);
      } else {
        const legacyPath = `${LEGACY_INK_FOLDER}/${hashPath(sourcePath)}.json`;
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(legacyPath)) {
          saved = { ...decodeInk(await adapter.read(legacyPath)), sourcePath };
          document.applySynced(saved, false);
          legacy = true;
        }
      }
    } catch (error) {
      this.onError(`Could not read drawing data for ${sourcePath}.`, error);
    }
    const local = document.data();
    const entry: StoredDrawing = {
      document, path, file: file ?? undefined, raw, savedSourcePath: saved?.sourcePath,
      local: saved ? { ...local, updatedAt: saved.updatedAt, revisions: saved.revisions } : local,
      dirty: false, saveQueued: false, chain: Promise.resolve()
    };
    this.documents.set(sourcePath, entry);
    document.subscribe((persist) => {
      if (persist) this.schedule(entry);
    });
    if (legacy) this.schedule(entry);
    return entry;
  }

  private schedule(entry: StoredDrawing): void {
    entry.local = recordInkChanges(entry.local, entry.document.data(), this.writer);
    entry.dirty = true;
    this.queueSave(entry);
  }

  private queueSave(entry: StoredDrawing): void {
    if (entry.saveQueued) return;
    entry.saveQueued = true;
    this.enqueue(entry, async () => {
      entry.saveQueued = false;
      await this.save(entry);
    });
  }

  private enqueue(entry: StoredDrawing, action: () => Promise<void>, errorMessage?: string): Promise<void> {
    return entry.chain = entry.chain.then(async () => {
      try {
        await action();
      } catch (error) {
        this.onError(errorMessage ?? `Could not save drawing data for ${entry.document.sourcePath}.`, error);
      }
    });
  }

  private async save(entry: StoredDrawing): Promise<void> {
    if (!entry.dirty) return;
    const snapshot = { ...entry.local, sourcePath: entry.document.sourcePath };
    let data = snapshot;
    let written: string;
    entry.dirty = false;
    try {
      const path = entry.file?.path ?? entry.path ?? await this.claimPath(this.defaultPath(snapshot.sourcePath), snapshot.sourcePath);
      const existing = this.app.vault.getFileByPath(path);
      if (existing) {
        await this.app.vault.process(existing, (raw) => {
          if (raw !== entry.raw) {
            const incoming = decodeInk(raw);
            if (incoming.sourcePath !== snapshot.sourcePath && incoming.sourcePath !== entry.savedSourcePath) {
              throw new Error("An ink file for a different source is already at the save location.");
            }
            data = { ...mergeInk(snapshot, incoming), sourcePath: snapshot.sourcePath };
          }
          written = encodeInk(data);
          return written;
        });
      } else {
        await this.ensureFolder(path);
        written = encodeInk(data);
        await this.app.vault.create(path, written);
      }
      entry.path = path;
      entry.file = this.app.vault.getFileByPath(path) ?? undefined;
      entry.raw = written!;
      entry.savedSourcePath = data.sourcePath;
      if (snapshot !== data) this.applyMerged(entry, mergeInk(entry.local, data));
    } catch (error) {
      entry.dirty = true;
      throw error;
    }
  }

  private applyMerged(entry: StoredDrawing, merged: InkFileData): void {
    const changed = drawingContents(entry.local) !== drawingContents(merged);
    entry.local = changed ? merged : { ...entry.local, updatedAt: merged.updatedAt, revisions: merged.revisions };
    if (changed) entry.document.applySynced(merged, true);
  }

  private async findFile(sourcePath: string): Promise<TFile | null> {
    const expected = this.app.vault.getFileByPath(this.defaultPath(sourcePath));
    if (expected && await this.belongsTo(expected, sourcePath)) return expected;
    const suffix = inkFilename(sourcePath);
    for (const file of this.app.vault.getFiles()) {
      if (file === expected || (file.name !== suffix && file.name !== hashedInkFilename(sourcePath))) continue;
      if (await this.belongsTo(file, sourcePath)) return file;
    }
    return null;
  }

  private async belongsTo(file: TFile, sourcePath: string): Promise<boolean> {
    try {
      return decodeInk(await this.app.vault.read(file)).sourcePath === sourcePath;
    } catch {
      return false;
    }
  }

  private async claimPath(path: string, sourcePath: string, previousPath?: string): Promise<string> {
    const existing = this.app.vault.getFileByPath(path);
    if (!this.app.vault.getAbstractFileByPath(path) || path === previousPath
      || (existing && await this.belongsTo(existing, sourcePath))) return path;
    return [...path.split("/").slice(0, -1), hashedInkFilename(sourcePath)].join("/");
  }

  private async ensureFolder(path: string): Promise<void> {
    const folder = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of folder) {
      current = current ? `${current}/${segment}` : segment;
      if (this.app.vault.getFolderByPath(current)) continue;
      await this.app.vault.createFolder(current).catch((error: unknown) => {
        if (!this.app.vault.getFolderByPath(current)) throw error;
      });
    }
  }

  private defaultPath(sourcePath: string): string {
    const { inkLocation, inkSubfolder, inkFolder } = this.getSettings();
    const parent = sourcePath.split("/").slice(0, -1).join("/");
    const name = inkFilename(sourcePath);
    if (inkLocation === "same") return normalizePath([parent, name].filter(Boolean).join("/"));
    if (inkLocation === "subfolder") return normalizePath([parent, inkSubfolder, name].filter(Boolean).join("/"));
    const uniqueName = hashedInkFilename(sourcePath);
    return inkLocation === "fixed" ? normalizePath(`${inkFolder}/${uniqueName}`) : uniqueName;
  }
}

function inkFilename(sourcePath: string): string {
  return `${sourcePath.split("/").pop()}.ink.json`;
}

function hashedInkFilename(sourcePath: string): string {
  return `${hashPath(sourcePath)}-${inkFilename(sourcePath)}`;
}

function renamedInkPath(previousPath: string, currentPath: string, oldSource: string, newSource: string): string {
  const oldSourceFolder = oldSource.split("/").slice(0, -1);
  const newSourceFolder = newSource.split("/").slice(0, -1);
  const oldInkFolder = previousPath.split("/").slice(0, -1);
  const currentInkFolder = currentPath.split("/").slice(0, -1);
  const centralized = previousPath.endsWith(hashedInkFilename(oldSource));
  const relative = !centralized && oldSourceFolder.every((part, index) => oldInkFolder[index] === part);
  const folder = relative ? [...newSourceFolder, ...oldInkFolder.slice(oldSourceFolder.length)] : currentInkFolder;
  return [...folder, centralized ? hashedInkFilename(newSource) : inkFilename(newSource)].join("/");
}

function drawingContents(data: InkFileData, includeRevisions = false): string {
  return encodeInk({
    version: 1, sourcePath: data.sourcePath, updatedAt: "",
    strokes: data.strokes, floatingImages: data.floatingImages ?? [], verticalSpaces: data.verticalSpaces ?? [],
    snapshotRegions: data.snapshotRegions ?? [], canvasLayout: data.canvasLayout,
    revisions: includeRevisions ? data.revisions : undefined
  });
}


export function mergeSnapshotRegions(current: readonly SnapshotRegion[], updates: readonly SnapshotRegion[]): SnapshotRegion[] {
  const regions = new Map(current.map((region) => [region.id, region]));
  for (const region of updates) regions.set(region.id, region);
  return [...regions.values()];
}
