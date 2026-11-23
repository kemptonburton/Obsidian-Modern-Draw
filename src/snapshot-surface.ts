import type { EditorView } from "@codemirror/view";
import { Notice, type App, type TFile } from "obsidian";
import { pointInRectangle, rectangleFromPoints, type Rectangle, type ScreenPoint } from "./geometry";
import type { InkDocument } from "./ink-store";
import { regionControl, regionLinkIcon, type RegionAppearance } from "./region-controls";
import { lineFingerprint, REGION_FLASH_MS, resolveSnapshotLine, SNAPSHOT_FOLDER, snapshotSubpath, type SnapshotRegion } from "./snapshot-region";

export interface SnapshotLink {
  region: SnapshotRegion;
  openUsage?: () => void;
}

interface SnapshotGeometry {
  save(bounds: Rectangle): Omit<SnapshotRegion, "id">;
  screen(region: SnapshotRegion): Rectangle | null;
  bind(region: SnapshotRegion): SnapshotRegion;
  world?(region: SnapshotRegion): Rectangle | null;
  resetTargets?(): void;
}

type CaptureWindow = Window & {
  electron?: { remote?: { getCurrentWebContents(): {
    getZoomFactor(): number;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<{ toPNG(): Uint8Array }>;
  } } };
};

export function noteSnapshotGeometry(view: EditorView, zoom: () => number): SnapshotGeometry {
  const lineTop = (from: number) => view.documentTop + view.lineBlockAt(from).top;
  const horizontalOrigin = () => view.contentDOM.getBoundingClientRect().left;
  let document = view.state.doc;
  const resolved = new Map<string, number>();
  const boundLine = (region: SnapshotRegion) => {
    const doc = view.state.doc;
    if (region.noteAnchor) return doc.lineAt(Math.max(0, Math.min(doc.length, region.noteAnchor.pos)));
    if (doc !== document) {
      document = doc;
      resolved.clear();
    }
    const anchor = region.anchor;
    if (!anchor) return doc.line(1);
    const key = `${anchor.line}:${anchor.fingerprint}`;
    const index = resolved.get(key) ?? resolveSnapshotLine(anchor, doc.lines, (line) => doc.line(line + 1).text);
    resolved.set(key, index);
    return doc.line(index + 1);
  };
  const floatingImages = () => view.contentDOM.querySelectorAll<HTMLElement>(
    ".modern-draw-floating-image[data-modern-draw-placement-id]"
  );
  const floatingAnchor = (bounds: Rectangle): SnapshotRegion["noteImageAnchor"] => {
    const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
    for (const image of floatingImages()) {
      const rect = image.getBoundingClientRect();
      const width = Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left);
      const height = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
      if (width > 0 && height > 0 && width * height >= area / 2 && image.dataset.modernDrawPlacementId) {
        return {
          id: image.dataset.modernDrawPlacementId,
          x: (bounds.left - rect.left) / (zoom() * view.scaleX),
          y: (bounds.top - rect.top) / (zoom() * view.scaleY)
        };
      }
    }
    return null;
  };
  return {
    save: (bounds) => {
      const block = view.lineBlockAtHeight(bounds.top - view.documentTop);
      const doc = view.state.doc;
      let line = doc.lineAt(block.from);
      if (!line.text.trim()) {
        for (let index = line.number + 1; index <= doc.lines; index++) {
          const candidate = doc.line(index);
          if (lineTop(candidate.from) >= bounds.bottom) break;
          if (candidate.text.trim()) {
            line = candidate;
            break;
          }
        }
      }
      const top = lineTop(line.from);
      const left = horizontalOrigin();
      const scaleX = zoom() * view.scaleX;
      const scaleY = zoom() * view.scaleY;
      return {
        bounds: {
          left: (bounds.left - left) / scaleX,
          right: (bounds.right - left) / scaleX,
          top: (bounds.top - top) / scaleY,
          bottom: (bounds.bottom - top) / scaleY
        },
        anchor: { line: line.number - 1, fingerprint: lineFingerprint(line.text) },
        noteAnchor: { pos: line.from, lineText: line.text },
        noteImageAnchor: floatingAnchor(bounds)
      };
    },
    bind: (region) => {
      if (region.noteAnchor) return region;
      const line = boundLine(region);
      return { ...region, noteAnchor: { pos: line.from, lineText: line.text } };
    },
    screen: (region) => {
      const { bounds } = region;
      const top = lineTop(boundLine(region).from);
      const left = horizontalOrigin();
      const scaleX = zoom() * view.scaleX;
      const scaleY = zoom() * view.scaleY;
      const attached = region.noteImageAnchor;
      if (attached) {
        const image = Array.from(floatingImages()).find(({ dataset }) => dataset.modernDrawPlacementId === attached.id);
        if (image) {
          const rect = image.getBoundingClientRect();
          const x = rect.left + attached.x * scaleX;
          const y = rect.top + attached.y * scaleY;
          return { left: x, top: y, right: x + (bounds.right - bounds.left) * scaleX, bottom: y + (bounds.bottom - bounds.top) * scaleY };
        }
      }
      return {
        left: left + bounds.left * scaleX,
        right: left + bounds.right * scaleX,
        top: top + bounds.top * scaleY,
        bottom: top + bounds.bottom * scaleY
      };
    }
  };
}

export interface CanvasRegionTarget {
  kind: "card" | "ink";
  id: string;
  bounds: Rectangle;
}

export function canvasSnapshotGeometry(
  canvas: HTMLElement, targets: () => readonly CanvasRegionTarget[]
): SnapshotGeometry {
  const matrix = () => {
    const css = getComputedStyle(canvas).transform;
    return css === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(css);
  };
  const transform = (bounds: Rectangle, inverse: boolean): Rectangle => {
    const viewport = canvas.parentElement!.getBoundingClientRect();
    const conversion = inverse ? matrix().inverse() : matrix();
    const point = (x: number, y: number): ScreenPoint => {
      const transformed = new DOMPoint(
        x - (inverse ? viewport.left : 0), y - (inverse ? viewport.top : 0)
      ).matrixTransform(conversion);
      return {
        x: transformed.x + (inverse ? 0 : viewport.left),
        y: transformed.y + (inverse ? 0 : viewport.top)
      };
    };
    return rectangleFromPoints(point(bounds.left, bounds.top), point(bounds.right, bounds.bottom));
  };
  let frameTargets: readonly CanvasRegionTarget[] | undefined;
  const currentTargets = () => frameTargets ??= targets();
  const attach = (bounds: Rectangle): SnapshotRegion["canvasAnchor"] => {
    let best: CanvasRegionTarget | undefined;
    let bestArea = 0;
    for (const target of currentTargets()) {
      const rect = target.bounds;
      const width = Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left);
      const height = Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top);
      if (width <= 0 || height <= 0) continue;
      const area = width * height;
      if ((!best || best.kind === target.kind || target.kind === "card") && (area > bestArea || best?.kind === "ink" && target.kind === "card")) {
        best = target;
        bestArea = area;
      }
    }
    return best ? { id: best.id, kind: best.kind, x: best.bounds.left, y: best.bounds.top } : null;
  };
  const world = (region: SnapshotRegion): Rectangle | null => {
    const anchor = region.canvasAnchor;
    if (!anchor) return region.bounds;
    const target = currentTargets().find(({ kind, id }) => kind === anchor.kind && id === anchor.id);
    return target ? translated(region.bounds, target.bounds.left - anchor.x, target.bounds.top - anchor.y) : null;
  };
  return {
    resetTargets: () => { frameTargets = undefined; },
    save: (screenBounds) => {
      const bounds = transform(screenBounds, true);
      return { bounds, canvasAnchor: attach(bounds) };
    },
    bind: (region) => {
      if (region.canvasAnchor !== undefined) return region;
      return { ...region, canvasAnchor: attach(region.bounds) };
    },
    screen: (region) => {
      const bounds = world(region);
      return bounds ? transform(bounds, false) : null;
    },
    world
  };
}

function translated(bounds: Rectangle, x: number, y: number): Rectangle {
  return { left: bounds.left + x, right: bounds.right + x, top: bounds.top + y, bottom: bounds.bottom + y };
}

export interface ScreenSnapshot {
  region: SnapshotRegion;
  bounds: Rectangle;
}

export class SnapshotSurface {
  private readonly controls: ReturnType<typeof regionControl>;
  private readonly layer: HTMLDivElement;
  private readonly resize: ResizeObserver;
  private readonly events = new AbortController();
  private readonly unsubscribe: () => void;
  private readonly owner: CaptureWindow;
  private readonly markers = new Map<HTMLElement, () => void>();
  private selected = new Set<string>();
  private offsets = new Map<string, ScreenPoint>();
  private frame = 0;
  private armed = false;
  private hint?: Notice;
  private active?: { start: ScreenPoint; pointer: number; preview: HTMLElement; file: TFile };
  private focused?: { file: TFile; region: SnapshotRegion };
  private focusTimer?: number;

  constructor(
    private readonly app: App,
    private readonly file: () => TFile | null,
    private readonly root: HTMLElement,
    private readonly viewport: HTMLElement,
    toolbar: HTMLElement,
    private readonly geometry: SnapshotGeometry,
    private readonly appearance: RegionAppearance,
    private readonly links: (file: TFile) => SnapshotLink[],
    private readonly document: (file: TFile) => InkDocument | null
  ) {
    this.owner = (root.ownerDocument.defaultView ?? window) as CaptureWindow;
    this.layer = root.ownerDocument.createElement("div");
    this.layer.className = "modern-draw-snapshot-layer";
    root.append(this.layer);
    this.controls = regionControl(toolbar, () => this.setArmed(!this.armed));
    const { signal } = this.events;
    root.addEventListener("pointerdown", this.pointerDown, { signal, capture: true });
    root.addEventListener("pointermove", this.pointerMove, { signal, capture: true });
    root.addEventListener("pointerup", this.pointerUp, { signal, capture: true });
    root.addEventListener("pointercancel", this.pointerUp, { signal, capture: true });
    root.addEventListener("dblclick", this.doubleClick, { signal, capture: true });
    root.ownerDocument.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.armed) this.setArmed(false);
    }, { signal, capture: true });
    viewport.addEventListener("scroll", this.refresh, { signal, passive: true });
    this.resize = new ResizeObserver(this.refresh);
    this.resize.observe(viewport);
    this.unsubscribe = appearance.subscribe(this.refresh);
    this.setArmed(false);
    this.refresh();
  }

  refresh = (): void => {
    if (this.frame || this.events.signal.aborted) return;
    this.frame = this.owner.requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  };

  private placements(file: TFile): SnapshotLink[] {
    const links = new Map(this.links(file).map((link) => [link.region.id, link]));
    const document = this.document(file);
    for (const region of document?.snapshotRegions ?? []) {
      links.set(region.id, { region, openUsage: links.get(region.id)?.openUsage });
    }
    return [...links.values()].filter(({ region }) => !region.deleted);
  }

  screenRegions(includeHidden = false): ScreenSnapshot[] {
    const file = this.file();
    if (!file || !includeHidden && this.appearance.display === "hidden") return [];
    this.geometry.resetTargets?.();
    return this.placements(file).flatMap(({ region }) => {
      const bound = this.geometry.bind(region);
      const bounds = this.geometry.screen(bound);
      return bounds ? [{ region: bound, bounds }] : [];
    });
  }

  hitSelection(point: ScreenPoint, selected: ReadonlySet<string>): ScreenSnapshot | undefined {
    return this.screenRegions().find(({ region, bounds }) =>
      pointInRectangle(point, bounds, 4) && (selected.has(region.id) || !pointInRectangle(point, bounds, -4)));
  }

  setSelection(ids: ReadonlySet<string>, offsets: ReadonlyMap<string, ScreenPoint> = new Map()): void {
    if (!this.selected.size && !ids.size && !this.offsets.size) return;
    this.selected = new Set(ids);
    this.offsets = new Map(offsets);
    this.refresh();
  }

  moveFrom(snapshot: ScreenSnapshot, dx: number, dy: number): SnapshotRegion {
    this.geometry.resetTargets?.();
    return { id: snapshot.region.id, ...this.geometry.save(translated(snapshot.bounds, dx, dy)) };
  }

  revealCanvas(region: SnapshotRegion, zoom: (bounds: Rectangle) => void, persistent = false): void {
    this.geometry.resetTargets?.();
    const bounds = this.geometry.world?.(this.geometry.bind(region));
    if (!bounds) return;
    zoom(bounds);
    this.focus(region, persistent);
  }

  focus(region: SnapshotRegion, persistent = false): void {
    const file = this.file();
    if (!file) return;
    this.focused = { file, region };
    this.owner.clearTimeout(this.focusTimer);
    this.focusTimer = persistent ? undefined : this.owner.setTimeout(() => {
      this.focused = undefined;
      this.refresh();
    }, REGION_FLASH_MS);
    this.refresh();
  }

  belongsTo(container: HTMLElement): boolean {
    return container.contains(this.root);
  }

  revealNote(region: SnapshotRegion, persistent = false): void {
    const target = this.geometry.screen(this.geometry.bind(region));
    if (!target) return;
    const viewport = this.viewport.getBoundingClientRect();
    if (target.left >= viewport.right || target.right <= viewport.left) {
      this.viewport.scrollLeft += target.left - viewport.left - 30;
    }
    if (target.top >= viewport.bottom || target.bottom <= viewport.top) {
      this.viewport.scrollTop += target.top - viewport.top - 30;
    }
    this.focus(region, persistent);
  }

  destroy(): void {
    this.setArmed(false);
    this.events.abort();
    this.owner.cancelAnimationFrame(this.frame);
    this.owner.clearTimeout(this.focusTimer);
    this.resize.disconnect();
    this.unsubscribe();
    this.controls.destroy();
    this.layer.remove();
    this.markers.clear();
  }

  private setArmed(armed: boolean): void {
    if (armed && !this.owner.electron?.remote) {
      new Notice("Capturing a note or Canvas is available in Obsidian desktop.");
      return;
    }
    this.armed = armed;
    this.controls.setArmed(armed);
    this.root.classList.toggle("modern-draw-snapshot-armed", armed);
    this.hint?.hide();
    this.hint = armed ? new Notice("Drag a rectangle to copy its embed link.") : undefined;
    if (!armed && this.active) {
      const drag = this.active;
      this.active = undefined;
      drag.preview.remove();
      if (this.root.hasPointerCapture(drag.pointer)) this.root.releasePointerCapture(drag.pointer);
    }
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!this.armed || this.active || event.button !== 0) return;
    const file = this.file();
    if (!file || (event.target as Element | null)?.closest(".modern-draw-toolbar, .canvas-controls")) return;
    const { left, top, right, bottom } = this.viewport.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.root.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    const preview = this.root.ownerDocument.createElement("div");
    preview.className = "modern-draw-pdf-rectangle is-preview";
    this.layer.append(preview);
    this.active = { start, preview, pointer: event.pointerId, file };
  };

  private pointerMove = (event: PointerEvent): void => {
    const drag = this.active;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.position(drag.preview, this.selectionBounds(drag.start, event));
  };

  private pointerUp = (event: PointerEvent): void => {
    const drag = this.active;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const bounds = this.selectionBounds(drag.start, event);
    this.setArmed(false);
    if (event.type !== "pointerup" || drag.file !== this.file()
      || bounds.right - bounds.left < 5 || bounds.bottom - bounds.top < 5) return;
    this.geometry.resetTargets?.();
    const region = { id: crypto.randomUUID(), ...this.geometry.save(bounds) };
    void this.capture(drag.file, region, bounds).catch((error) => {
      console.error("Modern Draw: Could not capture this region.", error);
      new Notice("Could not capture this region.");
    });
  };

  private selectionBounds(start: ScreenPoint, event: PointerEvent): Rectangle {
    const viewport = this.viewport.getBoundingClientRect();
    return rectangleFromPoints(start, {
      x: Math.max(viewport.left, Math.min(viewport.right, event.clientX)),
      y: Math.max(viewport.top, Math.min(viewport.bottom, event.clientY))
    });
  }

  private async capture(file: TFile, region: SnapshotRegion, bounds: Rectangle): Promise<void> {
    const contents = this.owner.electron?.remote?.getCurrentWebContents();
    if (!contents) throw new Error("Desktop capture is unavailable.");
    this.root.classList.add("modern-draw-capture-clean");
    let png: Uint8Array;
    try {
      await new Promise<void>((resolve) => this.owner.requestAnimationFrame(() => this.owner.requestAnimationFrame(() => resolve())));
      if (file !== this.file() || !this.root.isConnected || this.root.getBoundingClientRect().width === 0) return;
      const zoom = contents.getZoomFactor();
      const x = Math.round(bounds.left * zoom);
      const y = Math.round(bounds.top * zoom);
      const image = await contents.capturePage({
        x, y,
        width: Math.round(bounds.right * zoom) - x,
        height: Math.round(bounds.bottom * zoom) - y
      });
      png = image.toPNG();
    } finally {
      this.root.classList.remove("modern-draw-capture-clean");
    }
    if (!png.byteLength) throw new Error("The capture was empty.");
    if (!this.app.vault.getFolderByPath(SNAPSHOT_FOLDER)) {
      await this.app.vault.createFolder(SNAPSHOT_FOLDER).catch((error: unknown) => {
        if (!this.app.vault.getFolderByPath(SNAPSHOT_FOLDER)) throw error;
      });
    }
    await this.app.vault.createBinary(`${SNAPSHOT_FOLDER}/${region.id}.png`, Uint8Array.from(png).buffer);
    this.document(file)?.updateRegions([region], false);
    this.refresh();
    const link = this.app.fileManager.generateMarkdownLink(file, "", snapshotSubpath(region));
    await this.owner.navigator.clipboard.writeText("!" + link);
    new Notice("Region copied. Paste it into a note or Canvas.");
  }

  private doubleClick = (event: MouseEvent): void => {
    if (this.armed || (event.target as Element | null)?.closest(
      ".modern-draw-region-image, .modern-draw-region-link-icon, .modern-draw-toolbar, .canvas-controls"
    )) return;
    let best: (() => void) | undefined;
    let smallest = Infinity;
    for (const [element, open] of this.markers) {
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > 0 && area < smallest && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        best = open;
        smallest = area;
      }
    }
    if (!best) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    best();
  };

  private render(): void {
    for (const marker of this.layer.querySelectorAll(".modern-draw-snapshot-mark")) marker.remove();
    this.markers.clear();
    const file = this.file();
    if (!file) return;
    const focused = this.focused?.file === file ? this.focused.region : undefined;
    const { display } = this.appearance;
    if (display === "hidden" && !focused) return;
    this.geometry.resetTargets?.();
    const placements = this.placements(file);
    const document = this.document(file);
    const upgraded: SnapshotRegion[] = [];
    for (const link of placements) {
      const bound = this.geometry.bind(link.region);
      if (bound !== link.region && document) upgraded.push(bound);
      link.region = bound;
    }
    if (upgraded.length) document?.updateRegions(upgraded, false);
    const links = placements.filter(({ region }) => display !== "hidden" || region.id === focused?.id);
    if (focused && !document?.snapshotRegions.some(({ id, deleted }) => id === focused.id && deleted)
      && !links.some(({ region }) => region.id === focused.id)) {
      links.push({ region: focused });
    }
    const viewport = this.viewport.getBoundingClientRect();
    for (const { region, openUsage } of links) {
      const original = this.geometry.screen(region);
      if (!original) continue;
      const offset = this.offsets.get(region.id);
      const bounds = offset ? translated(original, offset.x, offset.y) : original;
      const clipped = {
        left: Math.max(bounds.left, viewport.left), top: Math.max(bounds.top, viewport.top),
        right: Math.min(bounds.right, viewport.right), bottom: Math.min(bounds.bottom, viewport.bottom)
      };
      if (clipped.right <= clipped.left || clipped.bottom <= clipped.top) continue;
      const marker = this.root.ownerDocument.createElement("div");
      marker.className = "modern-draw-pdf-rectangle modern-draw-snapshot-mark";
      marker.dataset.regionDisplay = display;
      marker.dataset.regionId = region.id;
      marker.classList.toggle("is-focused", region.id === focused?.id || this.selected.has(region.id));
      this.position(marker, clipped);
      this.layer.append(marker);
      if (openUsage) {
        regionLinkIcon(marker, "Open a location that uses this region", openUsage);
        this.markers.set(marker, openUsage);
      } else marker.setAttribute("aria-hidden", "true");
    }
  }

  private position(element: HTMLElement, bounds: Rectangle): void {
    const origin = this.layer.getBoundingClientRect();
    element.style.left = `${bounds.left - origin.left}px`;
    element.style.top = `${bounds.top - origin.top}px`;
    element.style.width = `${bounds.right - bounds.left}px`;
    element.style.height = `${bounds.bottom - bounds.top}px`;
  }
}
