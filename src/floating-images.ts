import type { EditorView } from "@codemirror/view";
import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import type { Rectangle, ScreenPoint } from "./geometry";
import type { InkDocument } from "./ink-store";
import { findImageSyntaxRanges, selectImageSyntaxRange } from "./image-syntax";
import { createStrokeId, type FloatingImagePlacement, type StrokeAnchor } from "./model";
import { noteLineOffset } from "./note-zoom";

interface ImageIdentity {
  source: string;
  occurrence: number;
  anchor: StrokeAnchor;
  line: HTMLElement | null;
  block: boolean;
}

export interface FloatingImageSelectionItem {
  id: string;
  bounds: Rectangle;
}

/** Adds persistent, line-anchored floating behavior to Live Preview image widgets. */
export class FloatingImageManager {
  private readonly observer: MutationObserver;
  private readonly boundEmbeds = new WeakSet<HTMLElement>();
  private readonly suppressZoomUntil = new WeakMap<HTMLElement, number>();
  private refreshFrame: number | null = null;
  private destroyed = false;
  private readonly persistentLayer: HTMLDivElement;
  private readonly persistentEmbeds = new Map<string, { host: HTMLDivElement; component: Component; source: string }>();
  private spaceShift?: { factors: ReadonlyMap<string, number>; delta: ScreenPoint };
  private readonly onScroll = (): void => this.refresh();

  constructor(
    private readonly view: EditorView,
    private readonly app: App,
    private readonly getDocument: () => InkDocument | null,
    private readonly getScale: () => number,
    private readonly onLayoutChanged: () => void,
    private readonly getAnchorOffset: (position: number) => number = () => 0,
    private readonly onExtentPreview: (right: number | null) => void = () => undefined,
    private readonly allowTouchDrag: () => boolean = () => true
  ) {
    this.persistentLayer = view.dom.ownerDocument.createElement("div");
    this.persistentLayer.className = "modern-draw-floating-layer";
    view.scrollDOM.appendChild(this.persistentLayer);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(view.contentDOM, { childList: true, subtree: true });
    this.observer.observe(this.persistentLayer, { childList: true, subtree: true });
    this.refresh();
  }

  refresh(): void {
    if (this.destroyed || this.refreshFrame !== null) return;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = null;
      this.refreshNow();
    });
  }

  refreshLayout(): void {
    if (this.destroyed) return;
    if (this.refreshFrame !== null) cancelAnimationFrame(this.refreshFrame);
    this.refreshFrame = null;
    this.refreshNow();
  }

  destroy(): void {
    this.destroyed = true;
    this.observer.disconnect();
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    for (const entry of this.persistentEmbeds.values()) entry.component.unload();
    this.persistentEmbeds.clear();
    this.persistentLayer.remove();
    if (this.refreshFrame !== null) cancelAnimationFrame(this.refreshFrame);
    this.showSelection(new Set());
    this.showSpaceShift(new Map());
    for (const button of this.view.contentDOM.querySelectorAll<HTMLElement>(".modern-draw-float-image-button")) {
      button.remove();
    }
    for (const group of this.view.contentDOM.querySelectorAll<HTMLElement>(".modern-draw-image-action-group")) {
      const embed = group.parentElement;
      const nativeGroup = embed?.querySelector<HTMLElement>(":scope > .embed-actions");
      if (nativeGroup) {
        for (const nativeAction of group.querySelectorAll<HTMLElement>(":scope > .embed-action")) {
          nativeGroup.appendChild(nativeAction);
        }
      }
      group.remove();
    }
  }

  placementIdForTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>(".modern-draw-floating-image")?.dataset.modernDrawPlacementId ?? null;
  }

  /**
   * Start the lightweight, compositor-only drag from the editor's capture
   * handler. Starting here prevents Obsidian's image handlers from seeing the
   * pointerdown and avoids falling back to the much heavier group-selection
   * drag path.
   */
  beginDirectDrag(event: PointerEvent): boolean {
    if (!(event.target instanceof Element)) return false;
    const embed = event.target.closest<HTMLElement>(".modern-draw-floating-image");
    if (!embed || !this.view.dom.contains(embed)) return false;
    this.beginDrag(event, embed);
    return event.defaultPrevented;
  }

  selectionItems(relativeTo: DOMRect): FloatingImageSelectionItem[] {
    const items: FloatingImageSelectionItem[] = [];
    for (const embed of this.view.dom.querySelectorAll<HTMLElement>(".modern-draw-floating-image")) {
      if (embed.closest("[hidden]")) continue;
      const id = embed.dataset.modernDrawPlacementId;
      if (!id) continue;
      const rect = embed.getBoundingClientRect();
      items.push({
        id,
        bounds: {
          left: rect.left - relativeTo.left,
          top: rect.top - relativeTo.top,
          right: rect.right - relativeTo.left,
          bottom: rect.bottom - relativeTo.top
        }
      });
    }
    return items;
  }

  showSelection(selectedIds: ReadonlySet<string>, dragDelta: ScreenPoint | null = null): void {
    for (const embed of this.view.dom.querySelectorAll<HTMLElement>(".modern-draw-floating-image")) {
      const selected = selectedIds.has(embed.dataset.modernDrawPlacementId ?? "");
      embed.classList.toggle("modern-draw-image-selected", selected);
      if (selected && dragDelta) {
        embed.style.setProperty("--modern-draw-selection-drag-x", `${dragDelta.x}px`);
        embed.style.setProperty("--modern-draw-selection-drag-y", `${dragDelta.y}px`);
      } else {
        embed.style.removeProperty("--modern-draw-selection-drag-x");
        embed.style.removeProperty("--modern-draw-selection-drag-y");
      }
    }
  }

  showSpaceShift(factors: ReadonlyMap<string, number>, delta?: ScreenPoint): void {
    this.spaceShift = delta ? { factors, delta } : undefined;
    for (const embed of this.view.dom.querySelectorAll<HTMLElement>(".modern-draw-floating-image")) {
      this.applySpaceShift(embed);
    }
  }

  private applySpaceShift(embed: HTMLElement): void {
    const shift = this.spaceShift;
    const factor = shift?.factors.get(embed.dataset.modernDrawPlacementId ?? "") ?? 0;
    if (shift && factor !== 0) {
      embed.style.setProperty("--modern-draw-space-drag-x", `${shift.delta.x * factor}px`);
      embed.style.setProperty("--modern-draw-space-drag-y", `${shift.delta.y * factor}px`);
    } else {
      embed.style.removeProperty("--modern-draw-space-drag-x");
      embed.style.removeProperty("--modern-draw-space-drag-y");
    }
  }

  private refreshNow(): void {
    const occurrenceCounts = new Map<string, number>();
    const document = this.getDocument();
    let migratedImages: FloatingImagePlacement[] | null = null;
    const visibleSources = new Set<string>();
    for (const embed of this.view.contentDOM.querySelectorAll<HTMLElement>(".image-embed")) {
      const identity = this.identityFor(embed, occurrenceCounts);
      if (!identity) continue;
      embed.dataset.modernDrawOccurrence = String(identity.occurrence);
      if (!this.boundEmbeds.has(embed)) this.bindEmbed(embed);
      this.ensureActionGroup(embed);
      let placement = this.findPlacement(identity);
      if (placement && (placement.anchor.pos !== identity.anchor.pos || placement.anchor.lineText !== identity.anchor.lineText)) {
        placement = { ...placement, anchor: identity.anchor };
        migratedImages = (migratedImages ?? document?.floatingImages ?? []).map((image) => image.id === placement?.id ? placement : image);
      }
      if (placement && placement.width === undefined) {
        const width = this.measureUnscaledWidth(embed);
        if (width > 0) {
          placement = { ...placement, width };
          migratedImages = (migratedImages ?? document?.floatingImages ?? []).map((image) =>
            image.id === placement?.id ? placement : image
          );
        }
      }
      this.applyPlacement(embed, placement, identity);
      this.updateButton(embed, Boolean(placement));
      if (placement) visibleSources.add(placement.id);
    }
    if (document && migratedImages) document.commitFloatingImages(migratedImages);
    this.refreshPersistentEmbeds(visibleSources);
  }

  private refreshPersistentEmbeds(visibleSources: ReadonlySet<string>): void {
    const ink = this.getDocument();
    const placements = ink?.floatingImages ?? [];
    const byId = new Map(placements.map((image) => [image.id, image]));
    for (const [id, entry] of this.persistentEmbeds) {
      if (byId.get(id)?.source === entry.source) continue;
      entry.component.unload();
      entry.host.remove();
      this.persistentEmbeds.delete(id);
    }
    const content = this.view.contentDOM.getBoundingClientRect();
    const scroll = this.view.scrollDOM.getBoundingClientRect();
    const scale = this.getScale();
    this.persistentLayer.style.left = `${(content.left - scroll.left) / scale + this.view.scrollDOM.scrollLeft}px`;
    this.persistentLayer.style.top = `${(content.top - scroll.top) / scale + this.view.scrollDOM.scrollTop}px`;
    for (const placement of placements) {
      let entry = this.persistentEmbeds.get(placement.id);
      if (!entry && ink) {
        const host = this.view.dom.ownerDocument.createElement("div");
        host.dataset.modernDrawPersistentId = placement.id;
        const component = new Component();
        component.load();
        entry = { host, component, source: placement.source };
        this.persistentEmbeds.set(placement.id, entry);
        this.persistentLayer.appendChild(host);
        void MarkdownRenderer.render(this.app, `![[${placement.source}]]`, host, ink.sourcePath, component)
          .then(() => this.refresh()).catch((error: unknown) => console.error("Modern Draw could not render a floating image", error));
      }
      if (!entry) continue;
      entry.host.hidden = visibleSources.has(placement.id);
      for (const embed of entry.host.querySelectorAll<HTMLElement>(".image-embed")) {
        const identity = this.identityFor(embed);
        if (!identity) continue;
        if (!this.boundEmbeds.has(embed)) this.bindEmbed(embed);
        this.ensureActionGroup(embed);
        this.applyPlacement(embed, placement, identity);
        this.updateButton(embed, true);
      }
    }
  }

  private bindEmbed(embed: HTMLElement): void {
    this.boundEmbeds.add(embed);
    this.ensureActionGroup(embed);
    embed.querySelector("img")?.addEventListener("load", () => this.refresh());
    embed.addEventListener("pointerdown", (event) => this.beginDrag(event, embed), true);
    embed.addEventListener("click", (event) => {
      const suppressUntil = this.suppressZoomUntil.get(embed) ?? 0;
      if (performance.now() > suppressUntil) return;
      this.suppressZoomUntil.delete(embed);
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  private ensureActionGroup(embed: HTMLElement): void {
    const nativeGroup = embed.querySelector<HTMLElement>(":scope > .embed-actions");
    if (!nativeGroup) return;

    // Clean up the separate group used by older Modern Draw builds and put
    // every native action back where Obsidian created it.
    const legacyGroup = embed.querySelector<HTMLElement>(":scope > .modern-draw-image-action-group");
    if (legacyGroup) {
      for (const nativeAction of legacyGroup.querySelectorAll<HTMLElement>(":scope > .embed-action")) {
        nativeGroup.appendChild(nativeAction);
      }
    }

    let button = legacyGroup?.querySelector<HTMLElement>(":scope > .modern-draw-float-image-button")
      ?? nativeGroup.querySelector<HTMLElement>(":scope > .modern-draw-float-image-button");
    if (!button) {
      button = document.createElement("div");
      button.className = "embed-action modern-draw-float-image-button";
      button.tabIndex = 0;
      button.setAttribute("role", "button");
      button.setAttribute("data-tooltip-position", "top");
      button.addEventListener("pointerdown", stopEvent);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.toggleFloating(embed);
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        this.toggleFloating(embed);
      });
      nativeGroup.appendChild(button);
    } else {
      button.className = "embed-action modern-draw-float-image-button";
      if (button.parentElement !== nativeGroup) nativeGroup.appendChild(button);
    }
    legacyGroup?.remove();
  }

  private updateButton(embed: HTMLElement, floating: boolean): void {
    const button = embed.querySelector<HTMLElement>(
      ":scope > .embed-actions > .modern-draw-float-image-button"
    );
    if (!button) return;
    const label = floating ? "Return image to text flow" : "Float image over note";
    button.setAttribute("aria-label", label);
    if (button.dataset.floating === String(floating)) return;
    button.dataset.floating = String(floating);
    setIcon(button, floating ? "pin-off" : "move");
  }

  private toggleFloating(embed: HTMLElement): void {
    const document = this.getDocument();
    const identity = this.identityFor(embed);
    if (!document || !identity) return;
    const existing = this.findPlacement(identity);
    if (existing) {
      this.moveImageSyntaxToVisualPosition(embed, identity);
      document.commitFloatingImages(document.floatingImages.filter((image) => image.id !== existing.id));
    } else {
      const embedRect = embed.getBoundingClientRect();
      const anchorRect = this.anchorRect(identity);
      const scale = this.getScale();
      document.commitFloatingImages([
        ...document.floatingImages,
        {
          id: createStrokeId(),
          source: identity.source,
          occurrence: identity.occurrence,
          anchor: identity.anchor,
          x: (embedRect.left - anchorRect.left) / scale,
          y: (embedRect.top - anchorRect.top) / scale,
          width: embedRect.width / scale
        }
      ]);
    }
    this.refresh();
    this.onLayoutChanged();
  }

  private moveImageSyntaxToVisualPosition(embed: HTMLElement, identity: ImageIdentity): void {
    const editorDocument = this.view.state.doc;
    const sourceLine = editorDocument.lineAt(Math.max(0, Math.min(editorDocument.length, identity.anchor.pos)));
    let widgetPosition = sourceLine.from;
    try {
      widgetPosition = this.view.posAtDOM(embed, 0);
    } catch {
      // The stored anchor still gives us a safe source-line fallback.
    }
    const localRange = selectImageSyntaxRange(
      sourceLine.text,
      identity.source,
      identity.occurrence,
      Math.max(0, widgetPosition - sourceLine.from)
    );
    if (!localRange) return;

    const embedRect = embed.getBoundingClientRect();
    const documentHeight = Math.max(0, embedRect.top - this.view.documentTop);
    const targetBlock = this.view.lineBlockAtHeight(documentHeight);
    const targetLine = editorDocument.lineAt(targetBlock.from);
    if (targetLine.from === sourceLine.from) return;

    const syntaxFrom = sourceLine.from + localRange.from;
    const syntaxTo = sourceLine.from + localRange.to;
    const occupiesWholeLine = sourceLine.text.trim() === localRange.text;
    const removeTo = occupiesWholeLine && sourceLine.to < editorDocument.length ? sourceLine.to + 1 : syntaxTo;
    const targetIsBlank = targetLine.text.trim().length === 0;
    const insertion = targetIsBlank
      ? { from: targetLine.from, to: targetLine.to, insert: localRange.text }
      : { from: targetLine.from, to: targetLine.from, insert: `${localRange.text}\n` };
    const changes = [
        { from: syntaxFrom, to: removeTo, insert: "" },
        insertion
      ].sort((first, second) => first.from - second.from || first.to - second.to);
    this.view.dispatch({
      changes,
      scrollIntoView: false
    });
  }

  private beginDrag(event: PointerEvent, embed: HTMLElement): void {
    if (event.button !== 0 || event.pointerType === "mouse" && !event.isPrimary) return;
    const identity = this.identityFor(embed);
    const placement = identity ? this.findPlacement(identity) : null;
    if ((event.target as Element | null)?.closest(".image-resize-corner")) {
      if (identity && placement) this.beginResize(event, embed, identity, placement);
      return;
    }
    if (event.pointerType === "touch" && !this.allowTouchDrag()) return;
    if ((event.target as Element | null)?.closest(
      "button, a, [role=button], .clickable-icon, .embed-action, .embed-actions, .modern-draw-image-action-group"
    )) return;
    if (!placement) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startX = placement.x;
    const startY = placement.y;
    const extentWidth = placement.width
      ?? embed.getBoundingClientRect().width / this.getScale();
    let nextX = startX;
    let nextY = startY;
    let dragFrame: number | null = null;
    embed.classList.add("is-dragging");

    const paintDrag = (): void => {
      dragFrame = null;
      embed.style.translate = `${nextX - startX}px ${nextY - startY}px`;
      // Keep the hot drag path to a compositor transform plus a lightweight
      // scroll-extent update. A full editor/canvas render here causes severe
      // pointer lag on notes with a lot of ink.
      this.onExtentPreview(nextX + extentWidth);
    };

    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      moveEvent.stopImmediatePropagation();
      const scale = this.getScale();
      nextX = startX + (moveEvent.clientX - startClientX) / scale;
      nextY = startY + (moveEvent.clientY - startClientY) / scale;
      if (dragFrame === null) dragFrame = requestAnimationFrame(paintDrag);
    };
    const end = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== pointerId) return;
      endEvent.preventDefault();
      endEvent.stopImmediatePropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (dragFrame !== null) cancelAnimationFrame(dragFrame);
      this.onExtentPreview(null);
      if (identity) this.applyCoordinates(embed, nextX, nextY, identity);
      embed.style.removeProperty("translate");
      // Clean up values left by builds that used transform custom properties.
      embed.style.removeProperty("--modern-draw-drag-x");
      embed.style.removeProperty("--modern-draw-drag-y");
      embed.classList.remove("is-dragging");
      const moved = Math.hypot(nextX - startX, nextY - startY) > 3;
      if (moved) this.suppressNextZoom(embed);
      const document = this.getDocument();
      if (!document) return;
      document.commitFloatingImages(document.floatingImages.map((image) =>
        image.id === placement.id ? { ...image, x: nextX, y: nextY } : image
      ));
      this.refresh();
      this.onLayoutChanged();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  private beginResize(
    event: PointerEvent,
    embed: HTMLElement,
    identity: ImageIdentity,
    placement: FloatingImagePlacement
  ): void {
    const image = embed.querySelector<HTMLImageElement>("img");
    if (!image) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const scale = this.getScale();
    const startWidth = image.getBoundingClientRect().width / scale;
    const rtl = getComputedStyle(embed).direction === "rtl";
    let nextWidth = startWidth;
    let resizeFrame: number | null = null;
    embed.classList.add("is-resizing");

    const paintResize = (): void => {
      resizeFrame = null;
      this.applyWidth(embed, nextWidth);
      this.onExtentPreview(placement.x + nextWidth);
    };

    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      moveEvent.stopImmediatePropagation();
      const delta = (moveEvent.clientX - startClientX) * (rtl ? -1 : 1) / scale;
      nextWidth = Math.max(20, Math.min(20_000, startWidth + delta));
      if (resizeFrame === null) resizeFrame = requestAnimationFrame(paintResize);
    };
    const end = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== pointerId) return;
      endEvent.preventDefault();
      endEvent.stopImmediatePropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      this.onExtentPreview(null);
      this.applyWidth(embed, nextWidth);
      embed.classList.remove("is-resizing");
      const document = this.getDocument();
      if (!document) return;
      document.commitFloatingImages(document.floatingImages.map((item) =>
        item.id === placement.id ? { ...item, width: Math.round(nextWidth * 10) / 10 } : item
      ));
      this.refresh();
      this.onLayoutChanged();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  private identityFor(embed: HTMLElement, counts = new Map<string, number>()): ImageIdentity | null {
    const persistentId = embed.closest<HTMLElement>("[data-modern-draw-persistent-id]")?.dataset.modernDrawPersistentId;
    if (persistentId) {
      const placement = this.getDocument()?.floatingImages.find((image) => image.id === persistentId);
      return placement ? { source: placement.source, occurrence: placement.occurrence, anchor: placement.anchor, line: null, block: true } : null;
    }
    const image = embed.querySelector<HTMLImageElement>("img");
    const line = embed.closest<HTMLElement>(".cm-line");
    const source = embed.getAttribute("src") ?? image?.getAttribute("src") ?? "";
    if (!image || !source) return null;
    let position: number;
    try {
      position = this.view.posAtDOM(embed, 0);
    } catch {
      return null;
    }
    const documentLine = this.view.state.doc.lineAt(Math.max(0, Math.min(this.view.state.doc.length, position)));
    const countKey = `${documentLine.from}\u0000${source}`;
    const storedOccurrence = Number(embed.dataset.modernDrawOccurrence);
    const occurrence = counts.get(countKey)
      ?? (Number.isInteger(storedOccurrence) && storedOccurrence >= 0 ? storedOccurrence : this.occurrenceWithinLine(embed, source));
    counts.set(countKey, occurrence + 1);
    return {
      source,
      occurrence,
      anchor: { pos: documentLine.from, lineText: documentLine.text },
      line,
      block: !line
    };
  }

  private occurrenceWithinLine(embed: HTMLElement, source: string): number {
    const line = embed.closest<HTMLElement>(".cm-line");
    if (!line) return 0;
    let occurrence = 0;
    for (const candidate of line.querySelectorAll<HTMLElement>(".image-embed")) {
      if (candidate === embed) break;
      const candidateSource = candidate.getAttribute("src") ?? candidate.querySelector("img")?.getAttribute("src") ?? "";
      if (candidateSource === source) occurrence += 1;
    }
    return occurrence;
  }

  private findPlacement(identity: ImageIdentity): FloatingImagePlacement | null {
    const candidates = (this.getDocument()?.floatingImages ?? []).filter((image) =>
      image.source === identity.source && image.occurrence === identity.occurrence
    );
    return candidates.find((image) => image.anchor.pos === identity.anchor.pos)
      ?? candidates.find((image) => image.anchor.lineText === identity.anchor.lineText)
      ?? (candidates.length === 1 && findImageSyntaxRanges(this.view.state.doc.toString())
        .filter((range) => range.text.includes(identity.source)).length === 1 ? candidates[0] : undefined)
      ?? null;
  }

  private applyPlacement(embed: HTMLElement, placement: FloatingImagePlacement | null, identity: ImageIdentity): void {
    embed.classList.toggle("modern-draw-floating-image", Boolean(placement));
    embed.classList.toggle("is-block-image", identity.block);
    if (placement) {
      embed.dataset.modernDrawPlacementId = placement.id;
      this.applyCoordinates(embed, placement.x, placement.y, identity);
      this.applyWidth(embed, placement.width);
      this.applySpaceShift(embed);
    }
    else {
      delete embed.dataset.modernDrawPlacementId;
      embed.classList.remove("modern-draw-image-selected");
      embed.style.removeProperty("--modern-draw-selection-drag-x");
      embed.style.removeProperty("--modern-draw-selection-drag-y");
      embed.style.removeProperty("--modern-draw-space-drag-x");
      embed.style.removeProperty("--modern-draw-space-drag-y");
      embed.style.removeProperty("--modern-draw-float-x");
      embed.style.removeProperty("--modern-draw-float-y");
      this.applyWidth(embed, undefined);
    }
  }

  private applyCoordinates(embed: HTMLElement, x: number, y: number, identity: ImageIdentity): void {
    const lineOffset = identity.block ? noteLineOffset(this.view, identity.anchor.pos) : 0;
    embed.style.setProperty("--modern-draw-float-x", `${x}px`);
    embed.style.setProperty("--modern-draw-float-y", `${lineOffset + this.getAnchorOffset(identity.anchor.pos) + y}px`);
  }

  private applyWidth(embed: HTMLElement, width: number | undefined): void {
    embed.classList.toggle("has-custom-size", width !== undefined);
    if (width !== undefined) embed.style.setProperty("--modern-draw-image-width", `${width}px`);
    else embed.style.removeProperty("--modern-draw-image-width");
  }

  private measureUnscaledWidth(embed: HTMLElement): number {
    const image = embed.querySelector<HTMLImageElement>("img");
    if (!image) return 0;
    return image.getBoundingClientRect().width / this.getScale();
  }

  private suppressNextZoom(embed: HTMLElement): void {
    this.suppressZoomUntil.set(embed, performance.now() + 400);
  }

  private anchorRect(identity: ImageIdentity): { left: number; top: number } {
    const rect = (identity.line ?? this.view.contentDOM).getBoundingClientRect();
    const lineOffset = identity.line ? 0 : noteLineOffset(this.view, identity.anchor.pos);
    return {
      left: rect.left,
      top: rect.top + (lineOffset + this.getAnchorOffset(identity.anchor.pos)) * this.getScale()
    };
  }
}

function stopEvent(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}
