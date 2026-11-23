import type { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, parseLinktext, resolveSubpath, setIcon, SuggestModal, TFile, type App, type CachedMetadata, type FileView, type PaneType, type Plugin } from "obsidian";
import { rectangleFromPoints, type Rectangle, type ScreenPoint } from "./geometry";
import type { ModernDrawController } from "./controller";
import { findImageSyntaxRanges } from "./image-syntax";
import { RegionEmbeds, PDF_THEME_KEY } from "./pdf-embeds";
import { parsePdfRegion, pdfRectangleFromDrag, pdfRegionBounds, pdfRegionSubpath, type PdfRegion, type PdfViewport } from "./pdf-region";
import { regionControl, regionLinkIcon, RegionAppearance } from "./region-controls";
import { linkedImage, markdownLinkedImage, markdownLinkLine, RegionArrival } from "./region-arrival";
import { RegionHover } from "./region-hover";
import { RegionSidebar, type LinkEndpoint, type LinkOccurrence, type LinkReference, type RegionLocation, type RegionUsage } from "./region-sidebar";
import { embedLinkText, parseSnapshotRegion, REGION_FLASH_MS, resolveSnapshotLine, type LinkedSelection, type SnapshotRegion } from "./snapshot-region";
import { canvasSnapshotGeometry, noteSnapshotGeometry, SnapshotSurface, type CanvasRegionTarget, type SnapshotLink } from "./snapshot-surface";

import type { InkStore } from "./ink-store";

interface PageView {
  div: HTMLElement;
  viewport: PdfViewport;
}

interface ViewerChild {
  toolbar: { toolbarRightEl: HTMLElement };
  pdfViewer: {
    dom: { viewerEl: HTMLElement; pdfContainerEl: HTMLElement };
    pdfViewer: { pagesCount: number; getPageView(index: number): PageView | undefined };
    eventBus: {
      on(event: string, handler: () => void): void;
      off(event: string, handler: () => void): void;
    };
  };
}

type PdfView = FileView & {
  viewer?: { then(callback: (viewer: ViewerChild) => void): void };
};

interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RegionCanvas {
  readonly?: boolean;
  canvasRect?: { width: number; height: number };
  nodes?: Map<string, { getBBox(): CanvasBounds; contentEl?: HTMLElement; nodeEl?: HTMLElement }>;
  zoomToBbox?(bounds: CanvasBounds): void;
  posCenter?(): ScreenPoint;
  createFileNode?(options: {
    pos: ScreenPoint; position: "center"; size: { width: number; height: number }; file: TFile; subpath: string;
  }): unknown;
}

interface LinkedRegion<Region extends LinkedSelection = LinkedSelection> {
  region: Region;
  usages: RegionUsage[];
}

function selectionKey(region: LinkedSelection): string {
  return "page" in region ? pdfRegionSubpath(region) : region.id;
}

function parseLinkedRegion(file: TFile, subpath: string): LinkedSelection | null {
  if (file.extension === "pdf") return parsePdfRegion(subpath);
  if (file.extension === "md" || file.extension === "canvas") return parseSnapshotRegion(subpath);
  return null;
}

export function registerRegionFeatures(plugin: Plugin, controller: ModernDrawController, store: InkStore) {
  const { app } = plugin;
  const noteAppearance = new RegionAppearance(controller.settings.noteRegionDisplay);
  const canvasAppearance = new RegionAppearance(controller.settings.canvasRegionDisplay);
  const pdfAppearance = new RegionAppearance(controller.settings.pdfRegionDisplay);
  const colorHosts = new Set<HTMLElement>();
  plugin.register(controller.subscribe((change) => {
    if (change.kind !== "settings") return;
    noteAppearance.update(controller.settings.noteRegionDisplay);
    canvasAppearance.update(controller.settings.canvasRegionDisplay);
    pdfAppearance.update(controller.settings.pdfRegionDisplay);
    for (const host of colorHosts) updateColors(host);
  }));
  const viewers = new Map<PdfView, PdfSurface>();
  const references = new Map<TFile, Map<TFile, LinkReference[]>>();
  const incoming = new Map<TFile, Map<TFile, LinkReference[]>>();
  const snapshotSurfaces = new Set<SnapshotSurface>();
  const canvasRevisions = new WeakMap<TFile, number>();
  const arrival = new RegionArrival();
  const hover = new RegionHover(app);
  let unloaded = false;

  function updateColors(host: HTMLElement): void {
    host.style.setProperty("--modern-draw-region-outline", controller.settings.regionOutlineColor);
    host.style.setProperty("--modern-draw-region-highlight", controller.settings.regionHighlightColor);
  }

  function syncColors(): void {
    const hosts = new Set([app.workspace.containerEl.ownerDocument.body]);
    app.workspace.iterateAllLeaves((leaf) => {
      hosts.add(leaf.view.containerEl.ownerDocument.body);
    });
    for (const host of hosts) {
      if (!colorHosts.has(host)) updateColors(host);
    }
    for (const host of colorHosts) {
      if (!hosts.has(host)) clearColors(host);
    }
    for (const host of hosts) colorHosts.add(host);
  }

  function clearColors(host: HTMLElement): void {
    host.style.removeProperty("--modern-draw-region-outline");
    host.style.removeProperty("--modern-draw-region-highlight");
    colorHosts.delete(host);
  }

  const regionsFor = (file: TFile): LinkedRegion[] => {
    const unique = new Map<string, LinkedRegion>();
    for (const links of incoming.get(file)?.values() ?? []) {
      for (const { from, to: { region } } of links) {
        if (!region || !from.key) continue;
        const key = selectionKey(region);
        const usage = { ...from, key };
        const linked = unique.get(key);
        if (linked) linked.usages.push(usage);
        else unique.set(key, { region, usages: [usage] });
      }
    }
    return [...unique.values()];
  };

  function followRegion(file: TFile, region: LinkedSelection, newLeaf?: PaneType | boolean): Promise<void> {
    return ("page" in region ? openRegion(file, region, newLeaf) : openSnapshot(file, region, newLeaf)).catch((error) => {
      console.error("Modern Draw: Could not open the source region.", error);
      new Notice("Could not open the source region.");
    });
  }

  const embeds = new RegionEmbeds(app, followRegion);
  plugin.register(embeds.install());

  const sidebars = new RegionSidebar(app, {
    incoming: (file) => [...incoming.get(file)?.values() ?? []].flat(),
    outgoing: (file) => [...references.get(file)?.values() ?? []].flat(),
    openEndpoint,
    openUsage: chooseUsage,
    previewEndpoint
  });

  function previewEndpoint(endpoint: LinkEndpoint): () => void {
    return hover.show(endpoint.file, endpointState(endpoint, false), (view, signal) => {
      if (!("subpath" in endpoint)) {
        revealUsage(view, endpoint, signal);
      } else if (endpoint.region && "page" in endpoint.region) {
        const surface = createPdfSurface(view as PdfView);
        signal.addEventListener("abort", () => surface.destroy(), { once: true });
        surface.focus(endpoint.region, true);
      } else if (endpoint.region) {
        void revealSnapshot(view, endpoint.file, endpoint.region, signal).catch((error) => {
          if (!signal.aborted) console.error("Modern Draw: Could not reveal the preview region.", error);
        });
      } else {
        revealDestination(view, endpoint, signal);
      }
    });
  }

  function openEndpoint(endpoint: LinkEndpoint, newTab: boolean): void {
    if (!("subpath" in endpoint)) openUsage(endpoint, newTab);
    else if (endpoint.region) void followRegion(endpoint.file, endpoint.region, newTab);
    else void openFile(endpoint.file, endpointState(endpoint, true), newTab)
      .then((view) => revealDestination(view, endpoint))
      .catch((error) => console.error("Modern Draw: Could not open the linked file.", error));
  }

  function endpointState(endpoint: LinkEndpoint, focus: boolean): Record<string, unknown> | undefined {
    if (!("subpath" in endpoint)) return "position" in endpoint ? { scroll: endpoint.position.start.line, focus } : undefined;
    if (endpoint.region && "page" in endpoint.region) return pdfState(endpoint.region, focus);
    return !endpoint.region && endpoint.subpath ? { subpath: endpoint.subpath, focus } : undefined;
  }

  function revealDestination(view: FileView, endpoint: LinkEndpoint & { subpath: string }, signal?: AbortSignal): void {
    if (!(view instanceof MarkdownView) || !endpoint.subpath) return;
    const cache = app.metadataCache.getFileCache(endpoint.file);
    const match = cache && resolveSubpath(cache, endpoint.subpath);
    if (match?.type === "heading") revealUsage(view, { file: endpoint.file, position: match.current.position }, signal);
    if (match?.type === "block") revealUsage(view, { file: endpoint.file, position: match.block.position }, signal);
  }

  // The native Outgoing links panel passes the complete fragment here.
  const nativeOpenLink = app.workspace.openLinkText;
  const openLink: typeof nativeOpenLink = (link, source, newLeaf, state) => {
    const { path, subpath } = parseLinktext(link);
    if (subpath) {
      const target = app.metadataCache.getFirstLinkpathDest(path, source);
      const region = target && parseLinkedRegion(target, subpath);
      if (target && region) return followRegion(target, region, newLeaf);
    }
    return nativeOpenLink.call(app.workspace, link, source, newLeaf, state);
  };
  app.workspace.openLinkText = openLink;
  plugin.register(() => {
    if (app.workspace.openLinkText === openLink) app.workspace.openLinkText = nativeOpenLink;
  });

  function openUsage(usage: LinkOccurrence, newTab = false): void {
    void jumpToUsage(usage, newTab).catch((error) => {
      console.error("Modern Draw: Could not open the location using this region.", error);
      new Notice("Could not open the location using this region.");
    });
  }

  async function jumpToUsage(usage: LinkOccurrence, newTab: boolean): Promise<void> {
    const view = await openFile(usage.file, endpointState(usage, true), newTab);
    if (view instanceof MarkdownView && view.getMode() !== "source" && !usage.key) {
      await showLivePreview(view);
      view.leaf.setEphemeralState(endpointState(usage, true));
    }
    revealUsage(view, usage);
  }

  function revealUsage(view: FileView, usage: LinkOccurrence, signal?: AbortSignal): void {
    const { file } = usage;
    if ("nodeId" in usage) {
      whenVisible(view, file, () => {
        const canvas = visibleCanvas(view);
        const node = canvas?.nodes?.get(usage.nodeId);
        if (!canvas || !node) return false;
        canvas.zoomToBbox?.(node.getBBox());
        arrival.highlight(view.contentEl, () =>
          (usage.key && node.contentEl ? linkedImage(node.contentEl, usage.key) : undefined)
          ?? (node.nodeEl?.getBoundingClientRect().width ? node.nodeEl : undefined), false, signal);
        return true;
      });
      return;
    }
    const { position } = usage;
    if (view instanceof MarkdownView) {
      const { key } = usage;
      arrival.highlight(view.contentEl, () => key ? markdownLinkedImage(view, key, position) : markdownLinkLine(view, position),
        true, signal);
    }
  }

  function chooseUsage(usages: LinkOccurrence[], newTab = false): void {
    if (usages.length === 1) openUsage(usages[0], newTab);
    else if (usages.length > 1) new RegionUsageModal(app, usages, (usage) => openUsage(usage, newTab)).open();
  }

  async function openFile(file: TFile, eState?: Record<string, unknown>, newLeaf?: PaneType | boolean): Promise<FileView> {
    const viewType = file.extension === "md" ? "markdown" : file.extension;
    const leaf = newLeaf ? app.workspace.getLeaf(newLeaf)
      : app.workspace.getLeavesOfType(viewType).find((item) =>
        (item.view as FileView).file === file || item.getViewState().state?.file === file.path)
        ?? app.workspace.getLeaf("tab");
    if (leaf.isDeferred) await app.workspace.revealLeaf(leaf);
    const alreadyOpen = (leaf.view as FileView).file === file;
    if (!alreadyOpen) await leaf.openFile(file, { active: true, eState });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    if (alreadyOpen && eState) leaf.setEphemeralState(eState);
    return leaf.view as FileView;
  }

  async function openSnapshot(file: TFile, region: SnapshotRegion, newLeaf?: PaneType | boolean): Promise<void> {
    const view = await openFile(file, undefined, newLeaf);
    await revealSnapshot(view, file, region);
  }

  async function revealSnapshot(view: FileView, file: TFile, region: SnapshotRegion, signal?: AbortSignal): Promise<void> {
    const document = await store.getDocument(file.path);
    const current = document.snapshotRegions.find(({ id }) => id === region.id) ?? region;
    if (signal?.aborted) return;
    if (current.deleted) {
      if (!signal) new Notice("This capture’s source rectangle was deleted.");
      return;
    }
    region = current;
    if (view instanceof MarkdownView) {
      await showLivePreview(view);
      if (signal?.aborted) return;
      const editor = view.editor;
      const line = region.noteAnchor ? editor.offsetToPos(region.noteAnchor.pos).line
        : region.anchor ? resolveSnapshotLine(region.anchor, editor.lineCount(), (index) => editor.getLine(index)) : 0;
      editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
    }
    whenVisible(view, file, () => {
      const surface = [...snapshotSurfaces].find((item) => item.belongsTo(view.containerEl));
      if (!surface) return false;
      if (view instanceof MarkdownView) surface.revealNote(region, !!signal);
      else {
        const canvas = visibleCanvas(view);
        if (!canvas) return false;
        surface.revealCanvas(region, (bounds) =>
          canvas.zoomToBbox?.({ minX: bounds.left, minY: bounds.top, maxX: bounds.right, maxY: bounds.bottom }), !!signal);
      }
      return true;
    });
  }

  async function showLivePreview(view: MarkdownView): Promise<void> {
    if (view.getMode() === "source") return;
    const state = view.leaf.getViewState();
    await view.leaf.setViewState({ ...state, state: { ...state.state, mode: "source", source: false } });
  }

  function visibleCanvas(view: FileView): RegionCanvas | undefined {
    const canvas = (view as FileView & { canvas?: RegionCanvas }).canvas;
    const rect = canvas?.canvasRect;
    return rect && rect.width > 0 && rect.height > 0 ? canvas : undefined;
  }

  function whenVisible(view: FileView, file: TFile, action: () => boolean): void {
    const owner = view.contentEl.ownerDocument.defaultView ?? window;
    const deadline = owner.performance.now() + 2000;
    const check = () => {
      if (unloaded || view.file !== file || !view.contentEl.isConnected) return;
      if (view.contentEl.clientWidth > 0 && action()) return;
      if (owner.performance.now() < deadline) owner.requestAnimationFrame(check);
    };
    owner.requestAnimationFrame(check);
  }

  async function openRegion(file: TFile, region: PdfRegion, newLeaf?: PaneType | boolean): Promise<void> {
    const view = await openFile(file, pdfState(region, true), newLeaf);
    syncViewers();
    viewers.get(view as PdfView)?.focus(region);
  }

  function pdfState(region: PdfRegion, focus: boolean): Record<string, unknown> {
    const [left, , , top] = region.rectangle;
    return { subpath: `#page=${region.page}&offset=${left},${top},0`, focus };
  }

  function addReference(
    found: Map<TFile, LinkReference[]>, source: TFile, link: string, location: RegionLocation, embed: boolean
  ): void {
    const { path, subpath } = parseLinktext(link);
    const target = app.metadataCache.getFirstLinkpathDest(path, source.path);
    if (!target) return;
    const region = parseLinkedRegion(target, subpath) ?? undefined;
    const entries = found.get(target) ?? [];
    entries.push({ from: { ...location, key: embed && region ? selectionKey(region) : undefined }, to: { file: target, subpath, region } });
    found.set(target, entries);
  }

  function commitIndex(file: TFile, found: Map<TFile, LinkReference[]>): boolean {
    const previous = references.get(file);
    if (!previous && found.size === 0) return false;
    for (const target of previous?.keys() ?? []) {
      if (found.has(target)) continue;
      const sources = incoming.get(target);
      sources?.delete(file);
      if (sources?.size === 0) incoming.delete(target);
    }
    for (const [target, links] of found) {
      let sources = incoming.get(target);
      if (!sources) incoming.set(target, sources = new Map());
      sources.set(file, links);
    }
    if (found.size > 0) references.set(file, found);
    else references.delete(file);
    return true;
  }

  function indexFile(file: TFile): boolean {
    if (file.extension !== "md") return false;
    const found = new Map<TFile, LinkReference[]>();
    const cache = app.metadataCache.getFileCache(file);
    for (const link of cache?.links ?? []) addReference(found, file, link.link, { file, position: link.position }, false);
    for (const embed of cache?.embeds ?? []) addReference(found, file, embed.link, { file, position: embed.position }, true);
    return commitIndex(file, found);
  }

  async function indexCanvas(file: TFile): Promise<void> {
    const revision = (canvasRevisions.get(file) ?? 0) + 1;
    canvasRevisions.set(file, revision);
    try {
      const data = JSON.parse(await app.vault.cachedRead(file)) as {
        nodes?: { id: string; type: string; file?: string; subpath?: string; text?: string; background?: string }[];
      };
      if (unloaded || canvasRevisions.get(file) !== revision) return;
      const found = new Map<TFile, LinkReference[]>();
      const native = (app as App & { internalPlugins?: {
        getEnabledPluginById(id: string): { index?: { get(file: TFile): { caches?: Record<string, CachedMetadata> } | null } } | null;
      } }).internalPlugins?.getEnabledPluginById("canvas")?.index?.get(file)?.caches;
      for (const node of Array.isArray(data.nodes) ? data.nodes : []) {
        if (!node || typeof node.id !== "string") continue;
        const usage = { file, nodeId: node.id };
        if (node.type === "file" && typeof node.file === "string") {
          addReference(found, file, node.file + (node.subpath ?? ""), usage, true);
        } else if (node.type === "group" && node.background) {
          addReference(found, file, node.background, usage, false);
        } else if (node.type === "text" && typeof node.text === "string") {
          const links = new Map<string, boolean>();
          for (const reference of native?.[node.id]?.links ?? []) {
            const { start, end } = reference.position;
            if (node.text.slice(start.offset, end.offset) === reference.original) links.set(reference.link, false);
          }
          for (const embed of findImageSyntaxRanges(node.text)) {
            const link = embedLinkText(embed.text);
            if (link) links.set(link, true);
          }
          for (const [link, embed] of links) addReference(found, file, link, usage, embed);
        }
      }
      if (commitIndex(file, found)) refreshMarks();
    } catch (error) {
      console.debug("Modern Draw: Could not read Canvas links.", error);
    }
  }

  function syncViewers(): void {
    hover.sync();
    syncColors();
    const open = new Set<PdfView>();
    for (const leaf of app.workspace.getLeavesOfType("pdf")) {
      const view = leaf.view as PdfView;
      if (!view.viewer) continue;
      open.add(view);
      if (!viewers.has(view)) {
        viewers.set(view, createPdfSurface(view));
      }
      viewers.get(view)?.refresh();
    }
    for (const [view, surface] of viewers) {
      if (open.has(view)) continue;
      surface.destroy();
      viewers.delete(view);
    }
    sidebars.sync();
  }

  function createPdfSurface(view: PdfView): PdfSurface {
    return new PdfSurface(app, view, (file) =>
      regionsFor(file).flatMap(({ region, usages }) => "page" in region ? [{ region, usages }] : []),
    chooseUsage, () => embeds.updateTheme(), pdfAppearance);
  }

  function refreshMarks(): void {
    for (const surface of viewers.values()) surface.refresh();
    for (const surface of snapshotSurfaces) surface.refresh();
    sidebars.sync();
  }

  function onNoteUpdate(file: TFile): void {
    if (indexFile(file)) refreshMarks();
  }

  plugin.registerEvent(app.metadataCache.on("changed", onNoteUpdate));
  plugin.registerEvent(app.metadataCache.on("resolve", (file) => {
    if (file.extension === "canvas") void indexCanvas(file);
    else onNoteUpdate(file);
  }));
  plugin.registerEvent(app.metadataCache.on("deleted", (file) => {
    if (commitIndex(file, new Map())) refreshMarks();
  }));
  plugin.registerEvent(app.vault.on("modify", (file) => {
    if (file instanceof TFile && file.extension === "canvas") void indexCanvas(file);
  }));
  plugin.registerEvent(app.vault.on("create", (file) => {
    if (file instanceof TFile && file.extension === "canvas") void indexCanvas(file);
  }));
  plugin.registerEvent(app.vault.on("delete", (file) => {
    if (file instanceof TFile && file.extension === "canvas") {
      canvasRevisions.delete(file);
      if (commitIndex(file, new Map())) refreshMarks();
    }
  }));
  plugin.registerEvent(app.workspace.on("layout-change", syncViewers));
  plugin.registerEvent(app.workspace.on("file-open", syncViewers));
  plugin.registerEvent(app.workspace.on("active-leaf-change", syncViewers));
  plugin.registerEvent(app.workspace.on("css-change", () => embeds.updateTheme()));
  app.workspace.onLayoutReady(() => {
    if (unloaded) return;
    for (const file of app.vault.getMarkdownFiles()) indexFile(file);
    for (const file of app.vault.getFiles()) {
      if (file.extension === "canvas") void indexCanvas(file);
    }
    syncViewers();
  });
  plugin.register(() => {
    unloaded = true;
    for (const surface of viewers.values()) surface.destroy();
    viewers.clear();
    sidebars.destroy();
    hover.clear();
    arrival.destroy();
    for (const host of colorHosts) clearColors(host);
  });

  function snapshotsFor(file: TFile): SnapshotLink[] {
    return regionsFor(file).flatMap(({ region, usages }) =>
      "id" in region ? [{ region, openUsage: () => chooseUsage(usages) }] : []
    );
  }

  function track(surface: SnapshotSurface) {
    snapshotSurfaces.add(surface);
    return { surface, refresh: surface.refresh, destroy: () => { snapshotSurfaces.delete(surface); surface.destroy(); } };
  }

  function attachNote(view: EditorView, file: () => TFile | null, toolbar: HTMLElement, zoom: () => number) {
    const surface = track(new SnapshotSurface(app, file, view.dom, view.scrollDOM, toolbar,
      noteSnapshotGeometry(view, zoom), noteAppearance, snapshotsFor, (source) => store.getLoadedDocument(source.path)));
    const observer = new MutationObserver((changes) => {
      if (changes.some(({ target }) => (target as Element).classList?.contains("modern-draw-floating-image"))) surface.refresh();
    });
    observer.observe(view.contentDOM, { attributes: true, subtree: true, attributeFilter: ["style", "class"] });
    return { ...surface, destroy: () => { observer.disconnect(); surface.destroy(); } };
  }

  function attachCanvas(
    file: TFile, wrapper: HTMLElement, canvas: HTMLElement, toolbar: HTMLElement, native: RegionCanvas | undefined,
    targets: () => readonly CanvasRegionTarget[]
  ) {
    const surface = track(new SnapshotSurface(app, () => file, wrapper, wrapper, toolbar,
      canvasSnapshotGeometry(canvas, targets), canvasAppearance, snapshotsFor, (source) => store.getLoadedDocument(source.path)));
    const observer = new MutationObserver(surface.refresh);
    observer.observe(canvas, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
    const paste = (event: ClipboardEvent): void => {
      if (!native?.createFileNode || !native.posCenter || native.readonly || event.defaultPrevented
        || wrapper.ownerDocument.activeElement !== wrapper) return;
      const text = event.clipboardData?.getData("text/plain");
      const link = text && embedLinkText(text);
      if (!link) return;
      const { path, subpath } = parseLinktext(link);
      const source = app.metadataCache.getFirstLinkpathDest(path, file.path);
      if (!source) return;
      const region = parseLinkedRegion(source, subpath);
      if (!region) return;
      const width = "page" in region ? region.rectangle[2] - region.rectangle[0] : region.bounds.right - region.bounds.left;
      const height = "page" in region ? region.rectangle[3] - region.rectangle[1] : region.bounds.bottom - region.bounds.top;
      const scale = Math.min(1, 480 / Math.max(width, height));
      event.preventDefault();
      event.stopImmediatePropagation();
      native.createFileNode({
        file: source, subpath, pos: native.posCenter(), position: "center",
        size: { width: Math.max(30, Math.round(width * scale)), height: Math.max(30, Math.round(height * scale)) }
      });
    };
    wrapper.addEventListener("paste", paste, true);
    return { ...surface, destroy: () => {
      wrapper.removeEventListener("paste", paste, true);
      observer.disconnect();
      surface.destroy();
    } };
  }

  return { attachNote, attachCanvas, canvasPreviewView: () => hover.canvasView() };
}

class RegionUsageModal extends SuggestModal<LinkOccurrence> {
  constructor(app: App, private readonly usages: LinkOccurrence[], private readonly choose: (usage: LinkOccurrence) => void) {
    super(app);
    this.setPlaceholder("Open a note or Canvas that uses this region");
  }

  getSuggestions(query: string): LinkOccurrence[] {
    const search = query.toLowerCase().trim();
    return this.usages.filter((usage) => this.description(usage).toLowerCase().includes(search));
  }

  private description(usage: LinkOccurrence): string {
    return `${usage.file.path} Â· ${"position" in usage ? `Line ${usage.position.start.line + 1}` : "Canvas card"}`;
  }

  renderSuggestion(usage: LinkOccurrence, el: HTMLElement): void {
    el.createDiv({ text: usage.file.basename });
    el.createDiv({ cls: "suggestion-note", text: this.description(usage) });
  }

  onChooseSuggestion(usage: LinkOccurrence): void {
    this.choose(usage);
  }
}

interface Drag {
  file: TFile;
  page: number;
  view: PageView;
  viewport: PdfViewport;
  start: ScreenPoint;
  preview: HTMLElement;
  pointer: number;
}

class PdfSurface {
  private viewer?: ViewerChild;
  private file: TFile | null = null;
  private controls?: HTMLElement;
  private regionButton?: ReturnType<typeof regionControl>;
  private themeButton?: HTMLButtonElement;
  private themeObserver?: MutationObserver;
  private unsubscribeViewer?: () => void;
  private armed = false;
  private drag?: Drag;
  private focused?: PdfRegion;
  private focusTimer?: number;
  private frame = 0;
  private destroyed = false;
  private readonly unsubscribeAppearance: () => void;
  private readonly marks = new Map<HTMLElement, RegionUsage[]>();
  private readonly events = new AbortController();
  private readonly owner: Window;

  constructor(
    private readonly app: App,
    private readonly view: PdfView,
    private readonly regionsFor: (file: TFile) => LinkedRegion<PdfRegion>[],
    private readonly openUsage: (usages: RegionUsage[]) => void,
    private readonly refreshEmbedTheme: () => void,
    private readonly appearance: RegionAppearance
  ) {
    this.unsubscribeAppearance = appearance.subscribe(this.scheduleMarks);
    this.owner = view.contentEl.ownerDocument.defaultView ?? window;
    view.viewer?.then((viewer) => {
      if (this.destroyed || !viewer?.toolbar?.toolbarRightEl
        || !viewer.pdfViewer?.pdfViewer || !viewer.pdfViewer.eventBus?.on) return;
      this.viewer = viewer;
      this.installControls(viewer);
      const options = { capture: true, signal: this.events.signal };
      view.contentEl.addEventListener("pointerdown", this.pointerDown, options);
      view.contentEl.addEventListener("pointermove", this.pointerMove, options);
      view.contentEl.addEventListener("pointerup", this.pointerUp, options);
      view.contentEl.addEventListener("pointercancel", this.pointerUp, options);
      view.contentEl.addEventListener("dblclick", this.doubleClickMark, options);
      view.contentEl.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.armed) this.setArmed(false);
      }, options);
      const { eventBus } = viewer.pdfViewer;
      const events = ["pagesinit", "pagerendered", "rotationchanging"];
      for (const event of events) eventBus.on(event, this.scheduleMarks);
      this.unsubscribeViewer = () => {
        for (const event of events) eventBus.off(event, this.scheduleMarks);
      };
      this.refresh();
    });
  }

  refresh(): void {
    if (this.file !== this.view.file) {
      this.file = this.view.file;
      this.focused = undefined;
      this.owner.clearTimeout(this.focusTimer);
      this.setArmed(false);
    }
    this.updateTheme();
    this.scheduleMarks();
  }

  focus(region: PdfRegion, persistent = false): void {
    this.file = this.view.file;
    this.focused = region;
    this.owner.clearTimeout(this.focusTimer);
    this.focusTimer = persistent ? undefined : this.owner.setTimeout(() => {
      this.focused = undefined;
      this.focusTimer = undefined;
      if (this.appearance.display === "hidden") this.clearMarks();
      else for (const mark of this.marks.keys()) mark.classList.remove("is-focused");
      this.scheduleMarks();
    }, REGION_FLASH_MS);
    this.scheduleMarks();
  }

  destroy(): void {
    this.destroyed = true;
    this.events.abort();
    this.setArmed(false);
    this.themeObserver?.disconnect();
    this.unsubscribeAppearance();
    this.regionButton?.destroy();
    this.controls?.remove();
    this.owner.cancelAnimationFrame(this.frame);
    this.owner.clearTimeout(this.focusTimer);
    this.unsubscribeViewer?.();
    this.clearMarks();
  }

  private installControls(viewer: ViewerChild): void {
    const owner = this.view.contentEl.ownerDocument;
    this.controls = owner.createElement("div");
    this.controls.className = "modern-draw-pdf-controls";
    viewer.toolbar.toolbarRightEl.prepend(this.controls);
    const button = (icon: string, label: string, action: () => void): HTMLButtonElement => {
      const element = owner.createElement("button");
      element.type = "button";
      element.className = "clickable-icon";
      element.setAttribute("aria-label", label);
      setIcon(element, icon);
      element.addEventListener("click", action);
      this.controls?.appendChild(element);
      return element;
    };
    this.regionButton = regionControl(this.controls, () => {
      this.setArmed(!this.armed);
      if (this.armed) new Notice("Drag a rectangle on a PDF page to copy its embed.");
    });
    this.themeButton = button("contrast", "Adapt PDF to theme", () => {
      const adapt = Boolean(this.app.loadLocalStorage(PDF_THEME_KEY));
      this.app.saveLocalStorage(PDF_THEME_KEY, adapt ? null : "true");
      this.app.workspace.trigger("css-change");
      this.updateTheme();
    });
    this.themeObserver = new MutationObserver(() => {
      this.updateTheme();
      this.refreshEmbedTheme();
    });
    this.themeObserver.observe(viewer.pdfViewer.dom.pdfContainerEl, { attributes: true, attributeFilter: ["class"] });
    this.setArmed(false);
    this.updateTheme();
  }

  private updateTheme(): void {
    this.themeButton?.setAttribute("aria-pressed", String(Boolean(this.app.loadLocalStorage(PDF_THEME_KEY))));
  }

  private setArmed(armed: boolean): void {
    this.armed = armed;
    this.regionButton?.setArmed(armed);
    this.view.contentEl.classList.toggle("modern-draw-pdf-selecting", armed);
    if (!armed && this.drag) {
      const { preview, pointer } = this.drag;
      this.drag = undefined;
      preview.remove();
      if (this.view.contentEl.hasPointerCapture(pointer)) this.view.contentEl.releasePointerCapture(pointer);
    }
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!this.armed || this.drag || event.button !== 0 || !this.file || !this.viewer) return;
    const element = (event.target as Element | null)?.closest<HTMLElement>(".page[data-page-number]");
    if (!element || !this.viewer.pdfViewer.dom.viewerEl.contains(element)) return;
    const page = Number(element.dataset.pageNumber);
    const view = this.viewer.pdfViewer.pdfViewer.getPageView(page - 1);
    if (!view?.viewport) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.view.contentEl.setPointerCapture(event.pointerId);
    const preview = element.ownerDocument.createElement("div");
    preview.className = "modern-draw-pdf-rectangle is-preview";
    element.appendChild(preview);
    const viewport = view.viewport;
    const start = this.pagePoint(event, view, viewport);
    this.drag = { page, view, viewport, start, preview, pointer: event.pointerId, file: this.file };
    this.positionMark(preview, viewport, rectangleFromPoints(start, start));
  };

  private pointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const bounds = rectangleFromPoints(drag.start, this.pagePoint(event, drag.view, drag.viewport));
    this.positionMark(drag.preview, drag.viewport, bounds);
  };

  private pointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const bounds = rectangleFromPoints(drag.start, this.pagePoint(event, drag.view, drag.viewport));
    this.setArmed(false);
    if (event.type !== "pointerup" || bounds.right - bounds.left < 4 || bounds.bottom - bounds.top < 4) return;
    const region = { page: drag.page, rectangle: pdfRectangleFromDrag(drag.viewport, bounds) };
    const link = this.app.fileManager.generateMarkdownLink(drag.file, "", pdfRegionSubpath(region));
    void this.owner.navigator.clipboard.writeText("!" + link).then(
      () => new Notice("Region copied. Paste it into a note or Canvas."),
      () => new Notice("Could not copy the PDF selection to the clipboard.")
    );
  };

  private pagePoint(event: PointerEvent, view: PageView, viewport: PdfViewport): ScreenPoint {
    const area = view.div.getBoundingClientRect();
    const x = (event.clientX - area.left - view.div.clientLeft) / view.div.clientWidth;
    const y = (event.clientY - area.top - view.div.clientTop) / view.div.clientHeight;
    return {
      x: Math.max(0, Math.min(1, x)) * viewport.width,
      y: Math.max(0, Math.min(1, y)) * viewport.height
    };
  }

  private doubleClickMark = (event: MouseEvent): void => {
    if (this.armed || (event.target as Element | null)?.closest(".modern-draw-region-link-icon")) return;
    const targetPage = (event.target as Element | null)?.closest(".page[data-page-number]");
    if (!targetPage || !this.viewer?.pdfViewer.dom.viewerEl.contains(targetPage)) return;
    let closest: RegionUsage[] | undefined;
    let smallest = Infinity;
    for (const [mark, usages] of this.marks) {
      if (usages.length === 0 || mark.parentElement !== targetPage) continue;
      const rect = mark.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) continue;
      const area = rect.width * rect.height;
      if (area > 0 && area < smallest) {
        smallest = area;
        closest = usages;
      }
    }
    if (!closest) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.openUsage(closest);
  };

  private scheduleMarks = (): void => {
    if (this.frame || this.destroyed) return;
    this.frame = this.owner.requestAnimationFrame(() => {
      this.frame = 0;
      this.renderMarks();
    });
  };

  private renderMarks(): void {
    this.clearMarks();
    const { display } = this.appearance;
    if (!this.file || !this.viewer || (display === "hidden" && !this.focused)) return;
    const focusedKey = this.focused && pdfRegionSubpath(this.focused);
    const regions = this.regionsFor(this.file)
      .filter(({ region }) => display !== "hidden" || pdfRegionSubpath(region) === focusedKey);
    if (this.focused && !regions.some(({ region }) => pdfRegionSubpath(region) === focusedKey)) {
      regions.push({ region: this.focused, usages: [] });
    }
    const pdf = this.viewer.pdfViewer.pdfViewer;
    for (const { region, usages } of regions) {
      if (region.page > pdf.pagesCount) continue;
      const page = pdf.getPageView(region.page - 1);
      if (!page?.div || !page.viewport) continue;
      const mark = page.div.ownerDocument.createElement("div");
      mark.className = "modern-draw-pdf-rectangle";
      mark.dataset.regionDisplay = display;
      mark.classList.toggle("is-focused", pdfRegionSubpath(region) === focusedKey);
      if (usages.length > 0) {
        regionLinkIcon(mark, usages.length === 1
          ? `Open PDF selection in ${usages[0].file.basename}`
          : `Choose from ${usages.length} uses of this PDF selection`, () => this.openUsage(usages));
      } else mark.setAttribute("aria-hidden", "true");
      this.positionMark(mark, page.viewport, pdfRegionBounds(page.viewport, region));
      page.div.appendChild(mark);
      this.marks.set(mark, usages);
    }
  }

  private clearMarks(): void {
    for (const mark of this.marks.keys()) mark.remove();
    this.marks.clear();
  }

  private positionMark(element: HTMLElement, viewport: PdfViewport, bounds: Rectangle): void {
    const left = Math.max(0, bounds.left);
    const top = Math.max(0, bounds.top);
    const right = Math.min(viewport.width, bounds.right);
    const bottom = Math.min(viewport.height, bounds.bottom);
    element.style.left = `${100 * left / viewport.width}%`;
    element.style.top = `${100 * top / viewport.height}%`;
    element.style.width = `${100 * Math.max(0, right - left) / viewport.width}%`;
    element.style.height = `${100 * Math.max(0, bottom - top) / viewport.height}%`;
  }
}
