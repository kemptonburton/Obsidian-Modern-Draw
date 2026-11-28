import type { SnapshotRegion } from "./snapshot-region";

export type DrawingTool = "select" | "lasso" | "pen" | "highlighter" | "eraser" | "space" | "space-horizontal";
export type WritingHand = "off" | "left" | "right";
export type ToolbarAlignment = "writing-hand" | "center" | "left" | "right";
export type InkLocation = "root" | "same" | "subfolder" | "fixed";
export type InkTool = "pen" | "highlighter";
export type CanvasLayout = "center" | "left";
export type RegionDisplay = "hidden" | "icon" | "border" | "full";

export const NOTE_ZOOM_MIN = 0.1;
export const NOTE_ZOOM_MAX = 2.5;
export const NOTE_ZOOM_FINE_STEP = 0.05;

export function normalizeCanvasLayout(layout: unknown): CanvasLayout | undefined {
  if (layout === "left-scroll") return "left";
  if (layout === "left" || layout === "center") return layout;
  return undefined;
}

export function clampNoteZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(NOTE_ZOOM_MIN, Math.min(NOTE_ZOOM_MAX, zoom)) : 1;
}

export function stepNoteZoom(zoom: number, direction: -1 | 1): number {
  const current = clampNoteZoom(zoom);
  const step = current < 0.5 || (current === 0.5 && direction < 0) ? NOTE_ZOOM_FINE_STEP : 0.1;
  return clampNoteZoom(Math.round((current + direction * step) * 100) / 100);
}

export interface InkStylePreset {
  color: string;
  width: number;
  /** Position in the shared pen and highlighter strip. */
  order?: number;
}

export interface InkPoint {
  /** Horizontal position in the editor's scroll coordinate space. */
  x: number;
  /** Vertical position relative to the anchored Markdown line. */
  y: number;
  /** Normalized Pointer Events pressure, from 0 to 1. */
  pressure: number;
}

export interface StrokeAnchor {
  /** CodeMirror document offset at the start of the anchored line. */
  pos: number;
  /** A text fingerprint used to recover the anchor after external edits. */
  lineText: string;
}

export interface InkStroke {
  rendering?: "excalidraw" | "onenote" | "notability";
  simulatePressure?: boolean;
  pressureSensitive?: boolean;
  stylus?: boolean;
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  opacity: number;
  /** The note's text origin when the stroke's horizontal coordinates were stored. */
  horizontalOrigin?: number;
  anchor: StrokeAnchor;
  points: InkPoint[];
  /** Original position and width of an imported page, relative to the stroke anchor. */
  page?: { name: string; x: number; y: number; width: number };
}

export interface FloatingImagePlacement {
  id: string;
  source: string;
  occurrence: number;
  anchor: StrokeAnchor;
  x: number;
  y: number;
  width?: number;
}

export interface VerticalSpace {
  id: string;
  anchor: StrokeAnchor;
  /** Signed unzoomed visual offset in CSS pixels. Positive adds space; negative removes it. */
  height: number;
}

export interface InkFileData {
  version: 1;
  sourcePath: string;
  updatedAt: string;
  strokes: InkStroke[];
  floatingImages?: FloatingImagePlacement[];
  verticalSpaces?: VerticalSpace[];
  snapshotRegions?: SnapshotRegion[];
  canvasLayout?: CanvasLayout | "left-scroll";
  revisions?: InkFileRevisions;
}

export type InkRevision = [clock: number, writer: string, deleted?: true];

export interface InkFileRevisions {
  clock: number;
  strokes?: Record<string, InkRevision>;
  floatingImages?: Record<string, InkRevision>;
  verticalSpaces?: Record<string, InkRevision>;
  snapshotRegions?: Record<string, InkRevision>;
  canvasLayout?: InkRevision;
}

export interface ModernDrawSettings {
  importScale: number;
  importScaleReference: string;
  matchNotabilityImportSize: boolean;
  autoDrawWithPen: boolean;
  stylusPressure: boolean;
  writingHand: WritingHand;
  toolbarAlignment: ToolbarAlignment;
  doubleTapToErase: boolean;
  palmRestHeight: number;
  penOnly: boolean;
  monochromeExport: boolean;
  inkLocation: InkLocation;
  inkSubfolder: string;
  inkFolder: string;
  showToolbar: boolean;
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
  penPresets: InkStylePreset[];
  highlighterPresets: InkStylePreset[];
  eraserRadius: number;
  noteRegionDisplay: RegionDisplay;
  canvasRegionDisplay: RegionDisplay;
  pdfRegionDisplay: RegionDisplay;
  regionOutlineColor: string;
  regionHighlightColor: string;
  strokeSmoothing: number;
  pinHeaderDuringHorizontalScroll: boolean;
}

export const DEFAULT_SETTINGS: ModernDrawSettings = {
  importScale: 1,
  importScaleReference: "",
  matchNotabilityImportSize: true,
  autoDrawWithPen: true,
  stylusPressure: true,
  writingHand: "off",
  toolbarAlignment: "writing-hand",
  doubleTapToErase: true,
  palmRestHeight: 22,
  penOnly: false,
  monochromeExport: false,
  inkLocation: "subfolder",
  inkSubfolder: "_ink",
  inkFolder: "_ink",
  showToolbar: true,
  penColor: "#182333",
  penWidth: 2.5,
  highlighterColor: "#ffd84d",
  highlighterWidth: 18,
  penPresets: [{ color: "#182333", width: 2.5 }, { color: "#07599c", width: 2.5 }, { color: "#c32637", width: 2.5 }],
  highlighterPresets: [{ color: "#ffd84d", width: 18 }, { color: "#62d399", width: 18 }],
  eraserRadius: 12,
  noteRegionDisplay: "icon",
  canvasRegionDisplay: "icon",
  pdfRegionDisplay: "border",
  regionOutlineColor: "#9a9a9a",
  regionHighlightColor: "#ffe04d",
  strokeSmoothing: 0.72,
  pinHeaderDuringHorizontalScroll: true
};

export function parseRegionDisplay(value: unknown): RegionDisplay | undefined {
  return value === "hidden" || value === "icon" || value === "border" || value === "full" ? value : undefined;
}

export function cloneStrokes(strokes: readonly InkStroke[]): InkStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    anchor: { ...stroke.anchor },
    points: stroke.points.map((point) => ({ ...point }))
  }));
}

export function cloneFloatingImages(images: readonly FloatingImagePlacement[]): FloatingImagePlacement[] {
  return images.map((image) => ({
    ...image,
    anchor: { ...image.anchor }
  }));
}

export function cloneVerticalSpaces(spaces: readonly VerticalSpace[]): VerticalSpace[] {
  return spaces.map((space) => ({
    ...space,
    anchor: { ...space.anchor }
  }));
}

export function sameInkStyle(first: InkStylePreset, second: InkStylePreset): boolean {
  return first.color.toLowerCase() === second.color.toLowerCase()
    && Math.abs(first.width - second.width) < 0.01;
}

export function createStrokeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
