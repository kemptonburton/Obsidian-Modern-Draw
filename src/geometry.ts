export interface ScreenPoint {
  x: number;
  y: number;
}

export interface Rectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function distanceToSegment(point: ScreenPoint, start: ScreenPoint, end: ScreenPoint): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (deltaX === 0 && deltaY === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / (deltaX ** 2 + deltaY ** 2))
  );
  return Math.hypot(point.x - (start.x + projection * deltaX), point.y - (start.y + projection * deltaY));
}

export const STYLUS_SAMPLE_DISTANCE = 0.25;

export function simplifyPoints<Point extends ScreenPoint>(points: readonly Point[], minimumDistance = 0.6): Point[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const simplified: Point[] = [{ ...points[0] }];
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const previous = simplified[simplified.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumDistance) {
      simplified.push({ ...point });
    }
  }
  simplified.push({ ...points[points.length - 1] });
  return simplified;
}

export function rectangleFromPoints(start: ScreenPoint, end: ScreenPoint): Rectangle {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y)
  };
}

export function pointInRectangle(point: ScreenPoint, rectangle: Rectangle, padding = 0): boolean {
  return (
    point.x >= rectangle.left - padding &&
    point.x <= rectangle.right + padding &&
    point.y >= rectangle.top - padding &&
    point.y <= rectangle.bottom + padding
  );
}

export function rectanglesIntersect(first: Rectangle, second: Rectangle): boolean {
  return !(
    first.right < second.left ||
    first.left > second.right ||
    first.bottom < second.top ||
    first.top > second.bottom
  );
}

export function lassoIntersects(path: readonly ScreenPoint[], points: readonly ScreenPoint[]): boolean {
  if (path.length < 3 || points.length === 0) return false;
  if (points.some((point) => pointInPolygon(point, path))) return true;
  for (let index = 1; index < points.length; index += 1) {
    for (let edge = 0; edge < path.length; edge += 1) {
      if (segmentsCross(points[index - 1], points[index], path[edge], path[(edge + 1) % path.length])) {
        return true;
      }
    }
  }
  return false;
}

export function lassoIntersectsRectangle(path: readonly ScreenPoint[], rect: Rectangle): boolean {
  if (path.length < 3) return false;
  const topLeft = { x: rect.left, y: rect.top };
  return path.some((point) => pointInRectangle(point, rect)) || lassoIntersects(path, [
    topLeft,
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
    topLeft
  ]);
}

function pointInPolygon(point: ScreenPoint, path: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = path.length - 1; index < path.length; previous = index++) {
    const start = path[previous];
    const end = path[index];
    if ((start.y > point.y) !== (end.y > point.y)
      && point.x < start.x + (end.x - start.x) * (point.y - start.y) / (end.y - start.y)) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsCross(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint, d: ScreenPoint): boolean {
  const cross = (start: ScreenPoint, end: ScreenPoint, point: ScreenPoint) =>
    (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

/**
 * Convert the horizontal coordinate stored in an ink file into viewport space.
 * Scaling around the Markdown content origin (instead of the scroller's left
 * edge) keeps glyphs and ink registered when the editor zoom changes.
 */
export function worldToScreenX(worldX: number, originX: number, zoom: number, scrollLeft: number): number {
  return originX + (worldX - originX) * zoom - scrollLeft;
}

/** Inverse of worldToScreenX, used for pointer input at any zoom level. */
export function screenToWorldX(screenX: number, originX: number, zoom: number, scrollLeft: number): number {
  return originX + (screenX + scrollLeft - originX) / zoom;
}
