import type { App } from "obsidian";
import { resolveAnchor } from "./anchors";
import type { Rectangle, ScreenPoint } from "./geometry";
import { createStrokeOutline, outlineToSvgPath } from "./ink-renderer";
import type { InkStore } from "./ink-store";
import { importedPageImages } from "./imported-page";
import type { InkStroke, ModernDrawSettings } from "./model";

const SVG = "http://www.w3.org/2000/svg";

export function inkExportColor(stroke: InkStroke, monochrome: boolean): string {
  return monochrome ? (stroke.tool === "highlighter" ? "#666666" : "#000000") : stroke.color;
}

export async function renderPrintInk(
  app: App, store: InkStore, root: HTMLElement, sourcePath: string, settings: ModernDrawSettings
): Promise<void> {
  if (!root.matches(".print > .markdown-preview-view") || !sourcePath.endsWith(".md")) return;
  const file = app.vault.getFileByPath(sourcePath);
  if (!file) return;
  const ink = await store.getDocument(sourcePath);
  if (ink.strokes.length === 0 && !settings.monochromeExport) return;
  const text = (await app.vault.cachedRead(file)).replace(/\r\n/g, "\n");
  // Obsidian initializes image embeds immediately after invoking post-processors.
  const images = importedPageImages(root);
  await Promise.allSettled(Array.from(images.values(), (image) => image.decode()));
  if (settings.monochromeExport) root.classList.add("modern-draw-monochrome-print");

  const lineHeight = Number.parseFloat(root.ownerDocument.defaultView?.getComputedStyle(root).lineHeight ?? "") || 24;
  const layout = mapPrintBlocks(root, app.metadataCache.getFileCache(file)?.sections ?? [], text);
  const anchorLines = new Map<InkStroke, number>();
  const sourceLines = text.split("\n");
  const lineByOffset = new Map<number, number>();
  let offset = 0;
  for (let line = 0; line < sourceLines.length; line += 1) {
    lineByOffset.set(offset, line);
    offset += sourceLines[line].length + 1;
  }
  for (const stroke of ink.strokes) {
    if (!stroke.points.length) continue;
    const anchor = resolveAnchor(text, stroke.anchor);
    anchorLines.set(stroke, lineByOffset.get(anchor.pos) ?? 0);
  }
  insertDrawingSpace(root, layout, sourceLines, anchorLines, lineHeight);
  const rootBounds = root.getBoundingClientRect();
  const byBlock = new Map<HTMLElement, { stroke: InkStroke; points: ScreenPoint[]; scale: number }[]>();
  for (const [stroke, line] of anchorLines) {
    const page = stroke.page;
    const image = page && images.get(page.name);
    const pageBounds = image?.getBoundingClientRect();
    if (page && pageBounds?.width) {
      const target = layout.find(({ block }) => image && block.contains(image))?.block ?? root;
      const blockBounds = target.getBoundingClientRect();
      const scale = pageBounds.width / page.width;
      add(target, stroke, stroke.points.map((point) => ({
        x: pageBounds.left - blockBounds.left + (point.x - (stroke.horizontalOrigin ?? 0) - page.x) * scale,
        y: pageBounds.top - blockBounds.top + (point.y - page.y) * scale
      })), scale);
      continue;
    }
    const match = layout.find(({ end }) => line <= end) ?? layout.at(-1);
    const target = match?.block ?? root;
    const targetBounds = target.getBoundingClientRect();
    const inline = match && hasMultipleLines(match.block)
      ? Math.max(0, Math.min(line, match.end) - match.start) : 0;
    const after = match ? Math.max(0, line - match.end) : line;
    const before = match && line < match.start ? (line - match.start) * lineHeight : 0;
    const y = inline * lineHeight + before + (after ? targetBounds.height + (after - 1) * lineHeight : 0);
    const x = target === root ? 0 : Math.max(0, rootBounds.left - targetBounds.left);
    add(target, stroke, stroke.points.map((point) => ({
      x: x + point.x - (stroke.horizontalOrigin ?? 0), y: y + point.y
    })), 1);
  }

  let horizontalExtent = root.clientWidth;
  for (const [target, strokes] of byBlock) {
    const bounds = appendOverlay(target, strokes, settings);
    if (!bounds) continue;
    const rect = target.getBoundingClientRect();
    horizontalExtent = Math.max(horizontalExtent, rect.left - rootBounds.left + bounds.right);
    const overflow = Math.ceil(bounds.bottom - rect.height);
    if (overflow > 0 && (target === root || target === layout.at(-1)?.block)) {
      target.style.paddingBottom = `${overflow}px`;
    }
  }
  if (horizontalExtent > root.clientWidth + 1 && root.clientWidth > 0) {
    const fit = root.clientWidth / horizontalExtent;
    root.style.width = `${horizontalExtent + 1}px`;
    root.style.zoom = String(fit);
  }

  function add(block: HTMLElement, stroke: InkStroke, points: ScreenPoint[], scale: number): void {
    const entries = byBlock.get(block) ?? [];
    entries.push({ stroke, points, scale });
    byBlock.set(block, entries);
  }
}

interface PrintBlock { block: HTMLElement; start: number; end: number }

function mapPrintBlocks(
  root: HTMLElement, sections: readonly { type: string; position: { start: { line: number }; end: { line: number } } }[], text: string
): PrintBlock[] {
  const candidates = Array.from(root.children).filter((child): child is HTMLElement =>
    Boolean(child.firstElementChild || child.tagName === "HR")
  );
  const lines = text.split("\n");
  let cursor = 0;
  const result: PrintBlock[] = [];
  const hidden = new Set(["yaml", "footnoteDefinition", "comment", "linkReference"]);
  for (const section of sections) {
    if (hidden.has(section.type)) continue;
    const start = section.position.start.line;
    const end = section.position.end.line;
    if (!lines[start]?.trim() || /^\s*\[[^\]]+\]:/.test(lines[start])) continue;
    const block = candidates[cursor++];
    if (!block) break;
    result.push({ block, start, end });
  }
  return result;
}

function insertDrawingSpace(
  root: HTMLElement, layout: PrintBlock[], lines: string[], anchorLines: Map<InkStroke, number>, lineHeight: number
): void {
  const blankInk = new Set<number>();
  for (const [stroke, line] of anchorLines) {
    if (!stroke.page && !lines[line]?.trim()) blankInk.add(line);
  }
  if (blankInk.size === 0) return;
  const blocks: PrintBlock[] = [];
  const existing = [...layout];
  for (let start = 0; start < lines.length;) {
    if (lines[start].trim()) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < lines.length && !lines[end + 1].trim()) end += 1;
    const anchored = Array.from(blankInk).some((line) => line >= start && line <= end);
    const insideRenderedBlock = existing.some((block) => start >= block.start && end <= block.end);
    if (anchored && !insideRenderedBlock) {
      const before = existing.find((block) => block.start > end)?.block ?? null;
      // Keep individual groups small so long handwritten notes can paginate.
      const groupSize = 12;
      for (let line = start; line <= end; line += groupSize) {
        const groupEnd = Math.min(end, line + groupSize - 1);
        const block = root.ownerDocument.createElement("div");
        block.dataset.inkBlank = "true";
        block.style.minHeight = `${(groupEnd - line + 1) * lineHeight}px`;
        block.style.breakInside = "avoid";
        root.insertBefore(block, before);
        blocks.push({ block, start: line, end: groupEnd });
      }
    }
    start = end + 1;
  }
  layout.push(...blocks);
  layout.sort((first, second) => first.start - second.start);
}

function hasMultipleLines(block: HTMLElement): boolean {
  return block.dataset.inkBlank === "true" || Boolean(block.querySelector("pre, ul, ol, table, br"));
}

function appendOverlay(
  target: HTMLElement, entries: { stroke: InkStroke; points: ScreenPoint[]; scale: number }[], settings: ModernDrawSettings
): Rectangle | null {
  const owner = target.ownerDocument;
  const svg = owner.createElementNS(SVG, "svg");
  const bounds: Rectangle = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const { stroke, points, scale } of entries) {
    const outline = createStrokeOutline(stroke, points, scale, settings.strokeSmoothing, true);
    if (outline.length === 0) continue;
    for (const [x, y] of outline) {
      bounds.left = Math.min(bounds.left, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
    const path = owner.createElementNS(SVG, "path");
    path.setAttribute("d", outlineToSvgPath(outline));
    path.setAttribute("fill", inkExportColor(stroke, settings.monochromeExport));
    path.setAttribute("fill-opacity", String(stroke.opacity));
    svg.appendChild(path);
  }
  if (!svg.childElementCount) return null;
  const left = Math.floor(bounds.left) - 1;
  const top = Math.floor(bounds.top) - 1;
  const width = Math.ceil(bounds.right - left) + 1;
  const height = Math.ceil(bounds.bottom - top) + 1;
  svg.setAttribute("viewBox", `${left} ${top} ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = `position:absolute;left:${left}px;top:${top}px;overflow:visible;pointer-events:none;z-index:5;print-color-adjust:exact`;
  if (target.tagName === "HR") {
    const wrapper = owner.createElement("div");
    target.replaceWith(wrapper);
    wrapper.append(target);
    target = wrapper;
  }
  target.style.position = "relative";
  target.append(svg);
  return bounds;
}
