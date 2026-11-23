import assert from "node:assert/strict";
import test from "node:test";
import { parsePdfRegion, pdfRectangleFromDrag, pdfRegionBounds, pdfRegionSubpath } from "../src/pdf-region";

test("PDF embed fragments normalize coordinates and handle malformed links", () => {
  const region = parsePdfRegion("#page=2&rect=42%2C54%2C10%2C-2&width=300");
  assert.deepEqual(region, { page: 2, rectangle: [10, -2, 42, 54], width: 300 });
  assert.equal(pdfRegionSubpath(region!), "#page=2&rect=10,-2,42,54");
  for (const bad of ["#page=1", "#page=0&rect=1,2,3,4", "#page=1&rect=1,,3,4", "#page=1&rect=1,2,1,4"]) {
    assert.equal(parsePdfRegion(bad), null);
  }
});

test("a rectangle dragged on a rotated PDF round-trips through PDF coordinates", () => {
  const viewport = {
    width: 200,
    height: 420,
    convertToPdfPoint: (x: number, y: number) => [y / 2, x / 2],
    convertToViewportRectangle: ([x1, y1, x2, y2]: number[]) => [y1 * 2, x1 * 2, y2 * 2, x2 * 2]
  };
  const bounds = { left: 30, top: 45, right: 150, bottom: 180 };
  const rectangle = pdfRectangleFromDrag(viewport, bounds);
  assert.deepEqual(rectangle, [22.5, 15, 90, 75]);
  assert.deepEqual(pdfRegionBounds(viewport, { page: 1, rectangle }), bounds);
});
