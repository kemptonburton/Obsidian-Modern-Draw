import html2canvas from "html2canvas-pro";
import type { Rectangle } from "./geometry";

/** The Canvas ink SVG normally paints outside its one-pixel viewport. Give the clone a real viewport for rasterizing. */
function fitCanvasInk(root: HTMLElement, bounds: Rectangle): ((copy: HTMLElement) => void) | undefined {
  const svg = root.querySelector<SVGSVGElement>("svg.modern-draw-canvas-overlay");
  const matrix = svg?.getScreenCTM();
  if (!matrix) return;
  const inverse = matrix.inverse();
  const { x, y } = new DOMPoint(bounds.left, bounds.top).matrixTransform(inverse);
  const bottom = new DOMPoint(bounds.right, bounds.bottom).matrixTransform(inverse);
  const width = bottom.x - x;
  const height = bottom.y - y;
  return (copy) => {
    const ink = copy.querySelector<SVGSVGElement>("svg.modern-draw-canvas-overlay");
    if (!ink) return;
    ink.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
    ink.setAttribute("width", String(width));
    ink.setAttribute("height", String(height));
    ink.style.left = `${x}px`;
    ink.style.top = `${y}px`;
    ink.style.width = `${width}px`;
    ink.style.height = `${height}px`;
    ink.style.overflow = "hidden";
  };
}

export async function renderSnapshotImage(root: HTMLElement, bounds: Rectangle): Promise<Uint8Array> {
  const viewport = root.getBoundingClientRect();
  const width = Math.ceil(bounds.right - bounds.left);
  const height = Math.ceil(bounds.bottom - bounds.top);
  const view = root.ownerDocument.defaultView ?? window;
  const scale = Math.min(view.devicePixelRatio || 1, 2, 4096 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
  const backgroundColor = view.getComputedStyle(root).getPropertyValue("--background-primary").trim() || "#ffffff";
  const fitInk = fitCanvasInk(root, bounds);
  const canvas = await html2canvas(root, {
    x: bounds.left - viewport.left, y: bounds.top - viewport.top, width, height, scale,
    backgroundColor, logging: false, useCORS: true,
    customIsSameOrigin: (source, sameOrigin) => source.startsWith("app://local/") || sameOrigin(source),
    onclone: (_document, copy) => fitInk?.(copy)
  });
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("The capture was empty.")), "image/png"
  ));
  return new Uint8Array(await png.arrayBuffer());
}
