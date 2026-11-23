import { rectangleFromPoints, type Rectangle } from "./geometry";

export type PdfRectangle = [number, number, number, number];

export interface PdfRegion {
  page: number;
  rectangle: PdfRectangle;
  width?: number;
}

export interface PdfViewport {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportRectangle(rectangle: number[]): number[];
}

export function parsePdfRegion(subpath: string): PdfRegion | null {
  const params = new URLSearchParams(subpath.replace(/^#/, ""));
  const page = Number(params.get("page"));
  const values = params.get("rect")?.split(",");
  if (!Number.isSafeInteger(page) || page < 1 || values?.length !== 4
    || values.some((value) => !value.trim() || !Number.isFinite(Number(value)))) return null;
  const [x1, y1, x2, y2] = values.map(Number);
  if (x1 === x2 || y1 === y2) return null;
  const width = Number(params.get("width"));
  return {
    page,
    rectangle: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
    width: Number.isFinite(width) && width > 0 ? width : undefined
  };
}

export function pdfRegionSubpath(region: PdfRegion): string {
  return `#page=${region.page}&rect=${region.rectangle.join(",")}`;
}

export function pdfRectangleFromDrag(viewport: PdfViewport, bounds: Rectangle): PdfRectangle {
  const [x1, y1] = viewport.convertToPdfPoint(bounds.left, bounds.top);
  const [x2, y2] = viewport.convertToPdfPoint(bounds.right, bounds.bottom);
  const round = (value: number) => Math.round(value * 100) / 100;
  return [
    round(Math.min(x1, x2)), round(Math.min(y1, y2)),
    round(Math.max(x1, x2)), round(Math.max(y1, y2))
  ];
}

export function pdfRegionBounds(viewport: PdfViewport, region: PdfRegion): Rectangle {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(region.rectangle);
  return rectangleFromPoints({ x: x1, y: y1 }, { x: x2, y: y2 });
}
