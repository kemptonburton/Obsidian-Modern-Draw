import type { FloatingImagePlacement, InkStroke, StrokeAnchor } from "./model";
import type { SnapshotRegion } from "./snapshot-region";
import type { ImportDrawing } from "./note-import";

export const NOMINAL_IMPORT_WIDTH = 574;

export interface DrawingScale {
  handwriting?: number;
  imageWidth?: number;
}

export interface ImportScaleOptions {
  factor: number;
  matchNotability: boolean;
  reference?: DrawingScale;
}

export function measureDrawingScale(strokes: readonly InkStroke[], images: readonly { width?: number }[]): DrawingScale {
  const heights: number[] = [];
  for (const stroke of strokes) {
    if (stroke.tool !== "pen" || stroke.points.length < 3 || !Number.isFinite(stroke.width) || stroke.width <= 0) continue;
    let top = Infinity;
    let bottom = -Infinity;
    for (const { y } of stroke.points) {
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    const height = bottom - top;
    if (Number.isFinite(height) && height >= stroke.width) heights.push(height);
  }
  const widths = images.flatMap(({ width }) => width !== undefined && Number.isFinite(width) && width > 0 ? [width] : []);
  return { handwriting: median(heights), imageWidth: median(widths) };
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  values.sort((first, second) => first - second);
  return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
}

export function matchDrawingScale(target: DrawingScale, reference: DrawingScale): { factor: number; measure: string } {
  if (reference.handwriting && target.handwriting) {
    return { factor: reference.handwriting / target.handwriting, measure: "pen-stroke height" };
  }
  if (reference.imageWidth && target.imageWidth) {
    return { factor: reference.imageWidth / target.imageWidth, measure: "image width" };
  }
  throw new Error("Both notes need measurable handwriting or both need images with saved widths.");
}

export function validateScale(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("Enter a scale greater than zero.");
}

export function scaleDrawingContent(
  strokes: readonly InkStroke[], images: readonly FloatingImagePlacement[], regions: readonly SnapshotRegion[],
  factor: number, anchorY: (anchor: StrokeAnchor) => number = () => 0
): { strokes: InkStroke[]; images: FloatingImagePlacement[]; regions: SnapshotRegion[] } {
  validateScale(factor);
  const scaledY = (value: number, anchor?: StrokeAnchor) => {
    const top = anchor ? anchorY(anchor) : 0;
    return (top + value) * factor - top;
  };
  return {
    strokes: strokes.map((stroke) => {
      const origin = stroke.horizontalOrigin ?? 0;
      return { ...stroke, width: stroke.width * factor,
        points: stroke.points.map((point) => ({ ...point, x: origin + (point.x - origin) * factor, y: scaledY(point.y, stroke.anchor) })),
        page: stroke.page ? { ...stroke.page, x: stroke.page.x * factor, y: scaledY(stroke.page.y, stroke.anchor), width: stroke.page.width * factor } : undefined };
    }),
    images: images.map((image) => ({ ...image, x: image.x * factor, y: scaledY(image.y, image.anchor), width: image.width === undefined ? undefined : image.width * factor })),
    regions: regions.map((region) => ({ ...region,
      bounds: { left: region.bounds.left * factor, right: region.bounds.right * factor,
        top: scaledY(region.bounds.top, region.noteAnchor), bottom: scaledY(region.bounds.bottom, region.noteAnchor) },
      noteImageAnchor: region.noteImageAnchor ? { ...region.noteImageAnchor, x: region.noteImageAnchor.x * factor, y: region.noteImageAnchor.y * factor } : region.noteImageAnchor
    }))
  };
}

export function scaleImportedDrawing(drawing: ImportDrawing, options: ImportScaleOptions): ImportDrawing {
  validateScale(options.factor);
  const normalized = options.matchNotability && (drawing.sourceFormat === "excalidraw" || drawing.sourceFormat === "onenote");
  const images = drawing.images.length || !drawing.background ? drawing.images : [{ width: drawing.width }];
  const base = options.reference
    ? matchDrawingScale(measureDrawingScale(drawing.strokes, images), options.reference).factor
    : normalized ? NOMINAL_IMPORT_WIDTH / drawing.width : 1;
  const factor = options.factor * base;
  const content = scaleDrawingContent(drawing.strokes, [], [], factor);
  return { ...drawing, width: drawing.width * factor, height: drawing.height * factor, strokes: content.strokes,
    images: drawing.images.map((image) => ({ ...image, x: image.x * factor, y: image.y * factor, width: image.width * factor, height: image.height * factor })),
    background: drawing.background && factor !== 1 ? `<g transform="scale(${factor})">${drawing.background}</g>` : drawing.background };
}
