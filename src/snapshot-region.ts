import { hashPath, normalizeLine } from "./anchors";
import type { Rectangle } from "./geometry";
import type { StrokeAnchor } from "./model";
import type { PdfRegion } from "./pdf-region";

export const SNAPSHOT_FOLDER = "Modern Draw Captures";
export const REGION_ICON = "scan";
export const REGION_LABEL = "Copy embed link to rectangle";
export const REGION_FLASH_MS = 2200;

export interface SnapshotRegion {
  id: string;
  bounds: Rectangle;
  anchor?: { line: number; fingerprint: string };
  noteAnchor?: StrokeAnchor;
  noteImageAnchor?: { id: string; x: number; y: number } | null;
  canvasAnchor?: { kind: "card" | "ink"; id: string; x: number; y: number } | null;
  deleted?: boolean;
}

export type LinkedSelection = PdfRegion | SnapshotRegion;

export function embedLinkText(markdown: string): string | null {
  const text = markdown.trim();
  const wiki = /^!\[\[([^|\]\n]+)(?:\|[^\]\n]*)?\]\]$/.exec(text);
  if (wiki) return wiki[1];
  const link = /^!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\n]+))\)$/.exec(text);
  if (!link) return null;
  try {
    return decodeURI(link[1] ?? link[2]);
  } catch {
    return null;
  }
}

export function parseSnapshotRegion(subpath: string): SnapshotRegion | null {
  const params = new URLSearchParams(subpath.replace(/^#/, ""));
  const id = params.get("md-region");
  const values = params.get("rect")?.split(",");
  if (!id || !/^[a-f0-9-]{36}$/i.test(id) || values?.length !== 4
    || values.some((value) => !value.trim() || !Number.isFinite(Number(value)))) return null;
  const [left, top, right, bottom] = values.map(Number);
  if (right <= left || bottom <= top) return null;
  const line = Number(params.get("line"));
  const fingerprint = params.get("anchor");
  const anchor = fingerprint && /^[a-f0-9]{16}$/.test(fingerprint) && Number.isSafeInteger(line) && line >= 0
    ? { line, fingerprint } : undefined;
  return { id, bounds: { left, top, right, bottom }, anchor };
}

export function snapshotSubpath(region: SnapshotRegion): string {
  const { left, top, right, bottom } = region.bounds;
  const rect = [left, top, right, bottom].map((value) => Math.round(value * 100) / 100).join(",");
  const anchor = region.anchor ? `&line=${region.anchor.line}&anchor=${region.anchor.fingerprint}` : "";
  return `#md-region=${region.id}&rect=${rect}${anchor}`;
}

export function lineFingerprint(text: string): string {
  return hashPath(normalizeLine(text));
}

export function resolveSnapshotLine(
  anchor: NonNullable<SnapshotRegion["anchor"]>,
  count: number,
  textAt: (index: number) => string
): number {
  const expected = Math.max(0, Math.min(count - 1, anchor.line));
  if (lineFingerprint(textAt(expected)) === anchor.fingerprint || anchor.fingerprint === lineFingerprint("")) return expected;
  for (let distance = 1; distance < count; distance++) {
    const before = expected - distance;
    if (before >= 0 && lineFingerprint(textAt(before)) === anchor.fingerprint) return before;
    const after = expected + distance;
    if (after < count && lineFingerprint(textAt(after)) === anchor.fingerprint) return after;
  }
  return expected;
}
