import assert from "node:assert/strict";
import test from "node:test";
import {
  distanceToSegment,
  lassoIntersects,
  lassoIntersectsRectangle,
  pointInRectangle,
  rectangleFromPoints,
  rectanglesIntersect,
  screenToWorldX,
  simplifyPoints,
  worldToScreenX
} from "../src/geometry";

test("distanceToSegment measures against the closest point", () => {
  assert.equal(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distanceToSegment({ x: 12, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 2);
});

test("simplifyPoints removes redundant near-identical samples", () => {
  const simplified = simplifyPoints([
    { x: 0, y: 0, pressure: 0.5 },
    { x: 0.1, y: 0.1, pressure: 0.5 },
    { x: 0.2, y: 0.2, pressure: 0.5 },
    { x: 4, y: 4, pressure: 0.7 }
  ]);
  assert.deepEqual(simplified, [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 4, y: 4, pressure: 0.7 }
  ]);
});

test("selection rectangles normalize drag direction and intersect strokes", () => {
  const lasso = rectangleFromPoints({ x: 20, y: 30 }, { x: 5, y: 10 });
  assert.deepEqual(lasso, { left: 5, top: 10, right: 20, bottom: 30 });
  assert.equal(pointInRectangle({ x: 8, y: 12 }, lasso), true);
  assert.equal(rectanglesIntersect(lasso, { left: 18, top: 25, right: 40, bottom: 50 }), true);
  assert.equal(rectanglesIntersect(lasso, { left: 30, top: 31, right: 40, bottom: 50 }), false);
});

test("a concave lasso selects crossed strokes and enclosed images without selecting its entire bounding box", () => {
  const path = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 },
    { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }
  ];
  assert.equal(lassoIntersects(path, [{ x: -2, y: 2 }, { x: 12, y: 2 }]), true);
  assert.equal(lassoIntersects(path, [{ x: 6, y: 6 }, { x: 8, y: 8 }]), false);
  assert.equal(lassoIntersectsRectangle(path, { left: 1, top: 5, right: 3, bottom: 7 }), true);
  assert.equal(lassoIntersectsRectangle(path, { left: 5, top: 5, right: 8, bottom: 8 }), false);
});

test("ink zoom scales around the Markdown origin and round-trips pointer coordinates", () => {
  const origin = 120;
  const worldX = 460;
  const zoom = 1.7;
  const scrollLeft = 95;
  const screenX = worldToScreenX(worldX, origin, zoom, scrollLeft);
  assert.equal(screenX, 603);
  assert.equal(screenToWorldX(screenX, origin, zoom, scrollLeft), worldX);
  assert.equal(worldToScreenX(origin, origin, 2.5, scrollLeft), origin - scrollLeft);
});
