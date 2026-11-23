import { resolveSubpath, setIcon, type App, type FileView, type Pos, type TFile } from "obsidian";
import type { LinkedSelection } from "./snapshot-region";

export type RegionLocation = { file: TFile; position: Pos } | { file: TFile; nodeId: string };
export type LinkOccurrence = RegionLocation & { key?: string };
export type RegionUsage = RegionLocation & { key: string };
export type LinkDestination = { file: TFile; subpath: string; region?: LinkedSelection };
export type LinkEndpoint = LinkOccurrence | LinkDestination;
export interface LinkReference {
  from: LinkOccurrence;
  to: LinkDestination;
}

interface BacklinkMatch {
  el: HTMLElement;
  matches?: [number, number][];
  mutateEState?(state: { match: { nodeId?: string } }): void;
}

interface BacklinkResult {
  el: HTMLElement;
  vChildren?: { children: BacklinkMatch[] };
}

type BacklinksView = FileView & {
  backlink?: {
    file: TFile | null;
    backlinkCountEl?: HTMLElement;
    backlinkDom?: {
      el: HTMLElement;
      getResult(file: TFile): BacklinkResult | undefined;
      getMatchCount?(): number;
    };
  };
};

type OutgoingView = FileView & {
  isLeafBoundToFile?: boolean;
  outgoingLink?: {
    outgoingLinkDom?: { el: HTMLElement; vChildren?: { children: { el: HTMLElement; pos: number; sourcePath?: string }[] } };
    linksCountEl?: HTMLElement;
  };
};

interface SidebarActions {
  incoming(file: TFile): LinkReference[];
  outgoing(file: TFile): LinkReference[];
  openEndpoint(endpoint: LinkEndpoint, newTab: boolean): void;
  openUsage(usages: LinkOccurrence[], newTab: boolean): void;
  previewEndpoint(endpoint: LinkEndpoint): () => void;
}

interface LinkRow {
  badge: HTMLButtonElement;
  source: LinkEndpoint;
  linked: LinkEndpoint;
  usages?: LinkOccurrence[];
}

interface CanvasRows {
  rows: HTMLElement;
  count?: HTMLElement;
  signature?: string;
}

const BACKLINK_ROW = ".search-result-file-match, .search-result-file-title";
const OUTGOING_ROW = ".outgoing-link-item";
const BADGE = ".modern-draw-sidebar-source";
const ROW_CLASS = "modern-draw-sidebar-link";

/** Adds source navigation to native rows and fills in Canvas rows the core panels omit. */
export class RegionSidebar {
  private readonly canvasRows = new Map<HTMLElement, CanvasRows>();
  private readonly rows = new Map<HTMLElement, LinkRow>();
  private readonly panels = new Map<HTMLElement, () => void>();
  private hovered?: Element;
  private stopHover?: () => void;

  constructor(private readonly app: App, private readonly actions: SidebarActions) {}

  sync(): void {
    const panels = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType("backlink")) {
      const view = leaf.view as BacklinksView;
      const host = view.backlink?.backlinkDom?.el;
      if (!host) continue;
      panels.add(host);
      this.watch(host, BACKLINK_ROW, () => this.formatBacklinks(view), view.backlink?.backlinkCountEl, () => {
        const count = view.backlink?.backlinkCountEl;
        const native = view.backlink?.backlinkDom?.getMatchCount?.();
        if (count && native !== undefined) this.setText(count, String(native));
      });
    }
    for (const leaf of this.app.workspace.getLeavesOfType("outgoing-link")) {
      const view = leaf.view as OutgoingView;
      const host = view.outgoingLink?.outgoingLinkDom?.el;
      if (!host) continue;
      panels.add(host);
      this.watch(host, OUTGOING_ROW, () => this.formatOutgoing(view), view.outgoingLink?.linksCountEl);
    }
    for (const [host, remove] of this.panels) {
      if (panels.has(host)) continue;
      remove();
      this.panels.delete(host);
    }
    this.removeDetachedRows();
  }

  destroy(): void {
    this.cancelHover();
    for (const remove of this.panels.values()) remove();
    this.panels.clear();
    for (const row of this.rows.keys()) this.removeBadges(row);
    for (const host of this.canvasRows.keys()) this.removeCanvasRows(host);
  }

  private watch(host: HTMLElement, selector: string, format: () => void, count?: HTMLElement, restore?: () => void): void {
    format();
    if (this.panels.has(host)) return;
    const owner = host.ownerDocument.defaultView ?? window;
    const events = new AbortController();
    const options = { signal: events.signal, capture: true };
    const observer = new MutationObserver(() => {
      if (this.hovered && !this.hovered.isConnected) this.cancelHover();
      format();
      this.removeDetachedRows();
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    if (count) observer.observe(count, { childList: true, subtree: true, characterData: true });
    const start = (target: Element | null, badgeOnly: boolean) => {
      if (!target || target.closest(".collapse-icon, .search-result-hover-button")) return;
      const badge = target.closest(BADGE);
      const row = target.closest<HTMLElement>(selector);
      const hit = badge ?? (badgeOnly ? null : row);
      if (!hit || !row || !host.contains(row) || this.hovered === hit || !this.rows.has(row)) return;
      this.cancelHover();
      this.hovered = hit;
      const timer = owner.setTimeout(() => {
        if (this.hovered !== hit || !hit.isConnected || hit.getClientRects().length === 0) return;
        const entry = this.rows.get(row);
        const endpoint = badge ? entry?.source : entry?.linked;
        if (endpoint) this.stopHover = this.actions.previewEndpoint(endpoint);
      }, 250);
      this.stopHover = () => owner.clearTimeout(timer);
    };
    const end = (event: PointerEvent | FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (this.hovered?.contains(event.target as Node) && (!next || !this.hovered.contains(next))) this.cancelHover();
    };
    host.addEventListener("pointerover", (event) => {
      if (event.pointerType !== "touch") start(event.target as Element | null, false);
    }, options);
    host.addEventListener("mouseover", (event) => {
      const target = event.target as Element | null;
      const row = target?.closest<HTMLElement>(selector);
      if (row && this.rows.has(row) && !target?.closest(".collapse-icon, .search-result-hover-button")) {
        event.preventDefault();
      }
    }, options);
    host.addEventListener("pointerout", end, options);
    host.addEventListener("focusin", (event) => start(event.target as Element | null, true), options);
    host.addEventListener("focusout", end, options);
    host.addEventListener("pointercancel", () => this.cancelHover(), options);
    host.addEventListener("click", (event) => {
      this.cancelHover();
      const target = event.target as Element | null;
      if (event.button !== 0 || target?.closest(".collapse-icon, .search-result-hover-button")) return;
      const badge = target?.closest(BADGE);
      const row = target?.closest<HTMLElement>(selector);
      const entry = row && this.rows.get(row);
      const newTab = event.ctrlKey || event.metaKey;
      if (entry && badge) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.actions.openEndpoint(entry.source, newTab);
      } else if (entry?.usages) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.actions.openUsage(entry.usages, newTab);
      }
    }, options);
    owner.addEventListener("blur", (event) => {
      if (event.target === owner) this.cancelHover();
    }, options);
    owner.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.cancelHover();
    }, options);
    this.panels.set(host, () => {
      if (this.hovered && (!this.hovered.isConnected || host.contains(this.hovered))) this.cancelHover();
      observer.disconnect();
      events.abort();
      restore?.();
      this.removeCanvasRows(host);
      for (const row of this.rows.keys()) {
        if (host.contains(row)) this.removeBadges(row);
      }
    });
  }

  private cancelHover(): void {
    this.hovered = undefined;
    this.stopHover?.();
    this.stopHover = undefined;
  }

  private formatOutgoing(view: OutgoingView): void {
    const file = view.isLeafBoundToFile ? view.file : this.app.workspace.getActiveFile();
    const native = view.outgoingLink?.outgoingLinkDom;
    if (!native) return;
    const host = native.el;
    const links = file ? this.actions.outgoing(file) : [];
    if (file?.extension === "canvas" && !host.querySelector(".outgoing-link-item:not(.modern-draw-canvas-outgoing)")) {
      this.syncCanvasRows(host, view.outgoingLink?.linksCountEl, links);
      return;
    }
    this.removeCanvasRows(host);
    const byOffset = new Map<number, LinkReference>();
    for (const link of links) {
      if ("position" in link.from) byOffset.set(link.from.position.start.offset, link);
    }
    const active = new Set<HTMLElement>();
    for (const { el, pos, sourcePath } of native.vChildren?.children ?? []) {
      if (!host.contains(el) || (sourcePath && sourcePath !== file?.path)) continue;
      const link = byOffset.get(pos);
      if (!link) continue;
      const title = el.querySelector<HTMLElement>(".tree-item-inner-text");
      if (title) this.formatTitle(title, link.to.file);
      this.setLinkRow(el, link.from, link.to);
      active.add(el);
    }
    this.removeStaleRows(host, active);
  }

  private formatBacklinks(view: BacklinksView): void {
    const backlink = view.backlink;
    const dom = backlink?.backlinkDom;
    if (!dom || !backlink.file) return;
    const byFile = new Map<TFile, LinkReference[]>();
    for (const link of this.actions.incoming(backlink.file)) {
      if (link.from.file === backlink.file) continue;
      const related = byFile.get(link.from.file) ?? [];
      related.push(link);
      byFile.set(link.from.file, related);
    }
    const active = new Set<HTMLElement>();
    let extraCount = 0;
    for (const [file, links] of byFile) {
      const result = dom.getResult(file);
      if (!result) continue;
      const children = result.vChildren?.children ?? [];
      const title = result.el.querySelector<HTMLElement>(".search-result-file-title");
      if (title && dom.el.contains(title)) {
        const label = title.querySelector<HTMLElement>(".tree-item-inner");
        if (label) this.formatTitle(label, file);
        this.setBacklinkRow(title, links);
        active.add(title);
      }
      const unmatched = new Set(links);
      for (const match of children) {
        const related = links.filter(({ from }) => matchIncludesUsage(match, from));
        if (related.length === 0) continue;
        for (const link of related) unmatched.delete(link);
        if (!dom.el.contains(match.el)) continue;
        this.setBacklinkRow(match.el, related);
        if (related.some(({ from }) => from.key)) {
          for (const span of match.el.querySelectorAll<HTMLElement>(".search-result-file-matched-text")) {
            if (!span.hasAttribute("data-modern-draw-original-label") && /(?:md-region=|[&#]rect=)/i.test(span.textContent ?? "")) {
              this.formatLabel(span, "Linked image");
            }
          }
        }
        active.add(match.el);
      }
      if (file.extension === "canvas") extraCount += unmatched.size;
    }
    const count = backlink.backlinkCountEl;
    if (count && dom.getMatchCount) this.setText(count, String(dom.getMatchCount() + extraCount));
    this.removeStaleRows(dom.el, active);
  }

  private formatTitle(title: HTMLElement, file: TFile): void {
    this.formatLabel(title, file.extension === "md" || file.extension === "canvas" || file.extension === "pdf" ? file.basename : file.name);
  }

  private formatLabel(title: HTMLElement, label: string): void {
    if (!title.hasAttribute("data-modern-draw-original-label")) {
      title.setAttribute("data-modern-draw-original-label", title.textContent ?? "");
    }
    this.setText(title, label);
  }

  private setBacklinkRow(row: HTMLElement, links: LinkReference[]): void {
    const { from, to } = links[0];
    this.setLinkRow(row, to, from, links.map((link) => link.from));
  }

  private setLinkRow(row: HTMLElement, source: LinkEndpoint, linked: LinkEndpoint, usages?: LinkOccurrence[]): void {
    let badge = this.rows.get(row)?.badge;
    if (!badge || !row.contains(badge)) {
      badge = row.createEl("button", { cls: "modern-draw-sidebar-source", text: "Source", attr: { type: "button" } });
    }
    this.rows.set(row, { badge, source, linked, usages });
    row.classList.add(ROW_CLASS);
    const label = `Source: ${source.file.name}, ${endpointLabel(this.app, source)}`;
    if (badge.getAttribute("aria-label") !== label) {
      badge.setAttribute("aria-label", label);
      badge.title = label;
    }
  }

  private setText(element: HTMLElement, value: string): void {
    if (element.textContent !== value) element.textContent = value;
  }

  private removeStaleRows(host: HTMLElement, active: Set<HTMLElement>): void {
    for (const row of this.rows.keys()) {
      if (host.contains(row) && !active.has(row)) this.removeBadges(row);
    }
  }

  private removeDetachedRows(): void {
    for (const row of this.rows.keys()) {
      if (!row.isConnected) this.removeBadges(row);
    }
  }

  private removeBadges(row: HTMLElement): void {
    this.rows.get(row)?.badge.remove();
    row.classList.remove(ROW_CLASS);
    for (const title of row.querySelectorAll<HTMLElement>("[data-modern-draw-original-label]")) {
      this.setText(title, title.dataset.modernDrawOriginalLabel ?? "");
      delete title.dataset.modernDrawOriginalLabel;
    }
    this.rows.delete(row);
  }

  private syncCanvasRows(host: HTMLElement, count: HTMLElement | undefined, links: LinkReference[]): void {
    const unique = new Map<string, LinkReference>();
    for (const link of links) {
      const key = link.to.file.path + link.to.subpath;
      if (!unique.has(key)) unique.set(key, link);
    }
    if (unique.size === 0) {
      this.removeCanvasRows(host);
      return;
    }
    let entry = this.canvasRows.get(host);
    if (!entry) {
      entry = { rows: host.createDiv({ cls: "modern-draw-canvas-outgoing-rows" }), count };
      this.canvasRows.set(host, entry);
    }
    if (entry.rows.parentElement !== host) host.append(entry.rows);
    if (count) this.setText(count, String(unique.size));
    const signature = JSON.stringify([...unique.values()].map(({ from, to }) =>
      [from.file.path, "nodeId" in from && from.nodeId, to.file.path, to.subpath]));
    if (entry.signature === signature && entry.rows.childElementCount === unique.size) return;
    entry.signature = signature;
    entry.rows.replaceChildren();
    for (const link of unique.values()) {
      const row = entry.rows.createDiv({ cls: "tree-item-self is-clickable outgoing-link-item modern-draw-canvas-outgoing" });
      const icon = row.createSpan({ cls: "tree-item-icon" });
      setIcon(icon, "link");
      const name = row.createDiv({ cls: "tree-item-inner" }).createDiv({
        cls: "tree-item-inner-text", attr: { tabIndex: 0, role: "link", title: link.to.file.path }
      });
      this.formatTitle(name, link.to.file);
      this.setLinkRow(row, link.from, link.to);
      row.addEventListener("click", (event) => this.actions.openEndpoint(link.to, event.ctrlKey || event.metaKey));
      name.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.actions.openEndpoint(link.to, event.ctrlKey || event.metaKey);
      });
    }
  }

  private removeCanvasRows(host: HTMLElement): void {
    const entry = this.canvasRows.get(host);
    entry?.rows.remove();
    if (entry?.count && !host.querySelector(OUTGOING_ROW)) this.setText(entry.count, "0");
    this.canvasRows.delete(host);
  }
}

function matchIncludesUsage(match: BacklinkMatch, usage: LinkOccurrence): boolean {
  if ("nodeId" in usage) {
    const state: { match: { nodeId?: string } } = { match: {} };
    match.mutateEState?.(state);
    return state.match.nodeId === usage.nodeId;
  }
  return match.matches?.some(([start, end]) =>
    start === usage.position.start.offset && end === usage.position.end.offset) ?? false;
}

function endpointLabel(app: App, endpoint: LinkEndpoint): string {
  if ("position" in endpoint) return `Line ${endpoint.position.start.line + 1}`;
  if ("nodeId" in endpoint) return "Card";
  const { file, subpath, region } = endpoint;
  if (region && "page" in region) return `Page ${region.page}`;
  if (region?.anchor) return `Line ${region.anchor.line + 1}`;
  if (region) return "Region";
  if (file.extension === "pdf") {
    const page = /(?:^#|&)page=(\d+)/.exec(subpath)?.[1];
    if (page) return `Page ${page}`;
  }
  if (subpath && file.extension === "md") {
    const cache = app.metadataCache.getFileCache(file);
    const target = cache && resolveSubpath(cache, subpath);
    if (target?.type === "heading") return `Line ${target.current.position.start.line + 1}`;
    if (target?.type === "block") return `Line ${target.block.position.start.line + 1}`;
  }
  return "File";
}
