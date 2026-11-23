import { getStroke } from "perfect-freehand";
import { simplifyPoints, STYLUS_SAMPLE_DISTANCE, type ScreenPoint } from "./geometry";
import type { InkStroke } from "./model";

/** Imported neutral ink follows the viewing theme while keeping its source color. */
export function inkDisplayColor(stroke: InkStroke, darkMode: boolean): string {
  if (!darkMode || !stroke.rendering || stroke.tool !== "pen") return stroke.color;
  const hex = stroke.color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return stroke.color;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const brightest = Math.max(...channels);
  return brightest <= 64 && brightest - Math.min(...channels) <= 16 ? "#ffffff" : stroke.color;
}

export function createStrokeOutline(
  stroke: InkStroke,
  points: readonly ScreenPoint[],
  zoom: number,
  smoothing: number,
  isComplete: boolean
): number[][] {
  // Older builds only stored pressureSensitive:false for Pencil or stylus input.
  const stylus = stroke.stylus ?? (stroke.pressureSensitive === false && !stroke.rendering);
  const samples = points.map((point, index) => ({
    x: point.x, y: point.y, pressure: stroke.points[index]?.pressure ?? 0.5
  }));
  return getStroke(
    stylus
      ? smoothStylusSamples(simplifyPoints(samples, STYLUS_SAMPLE_DISTANCE * zoom), zoom, stroke.width, smoothing)
      : samples,
    {
      size: stroke.width * zoom,
      thinning: stroke.tool === "highlighter" || stroke.pressureSensitive === false ? 0 : stroke.rendering === "excalidraw" ? 0.6 : 0.68,
      smoothing: stroke.rendering === "excalidraw" ? 0.5 : smoothing,
      streamline: stroke.rendering === "excalidraw" ? 0.5 : 0.62,
      easing: stroke.rendering === "excalidraw" ? (pressure) => Math.sin(pressure * Math.PI / 2) : undefined,
      simulatePressure: stroke.simulatePressure ?? false,
      start: { cap: true },
      end: { cap: true },
      last: stylus || isComplete
    }
  );
}

function smoothStylusSamples(samples: InkStroke["points"], zoom: number, width: number, smoothing: number): InkStroke["points"] {
  const maximumShift = Math.min(0.7, width * 0.3) * zoom;
  return samples.map((point, index) => {
    if (!index || index === samples.length - 1) return point;
    const { x, y, pressure } = point;
    const { x: ax, y: ay, pressure: ap } = samples[index - 1];
    const { x: bx, y: by, pressure: bp } = samples[index + 1];
    const before = Math.hypot(x - ax, y - ay);
    const after = Math.hypot(bx - x, by - y);
    if (before + after <= 0) return point;
    const progress = before / (before + after);
    const dx = ax + (bx - ax) * progress - x;
    const dy = ay + (by - ay) * progress - y;
    const blend = Math.min(smoothing, maximumShift / (Math.hypot(dx, dy) || 1));
    const adjustedPressure = pressure + (ap + (bp - ap) * progress - pressure) * smoothing / 2;
    return { x: x + dx * blend, y: y + dy * blend, pressure: adjustedPressure };
  });
}
export function outlineToSvgPath(outline: readonly number[][]): string {
  if (outline.length === 0) return "";
  if (outline.length === 1) {
    const [x, y] = outline[0];
    return `M ${x} ${y} Z`;
  }
  let path = `M ${outline[0][0]} ${outline[0][1]}`;
  for (let index = 1; index < outline.length - 1; index += 1) {
    const point = outline[index];
    const next = outline[index + 1];
    path += ` Q ${point[0]} ${point[1]} ${(point[0] + next[0]) / 2} ${(point[1] + next[1]) / 2}`;
  }
  return `${path} Z`;
}
