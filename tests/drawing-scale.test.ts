import assert from "node:assert/strict";
import test from "node:test";
import { matchDrawingScale, measureDrawingScale, scaleDrawingContent, scaleImportedDrawing, validateScale } from "../src/drawing-scale";
import type { InkStroke, FloatingImagePlacement } from "../src/model";
import type { ImportDrawing } from "../src/note-import";
import { decodeInk, encodeInk } from "../src/ink-storage";

const stroke: InkStroke = { id: "ink", tool: "pen", width: 4, color: "#123456", opacity: 1, horizontalOrigin: 120,
  anchor: { pos: 100, lineText: "lower line" }, points: [{ x: 160, y: 20, pressure: 0.7 }],
  page: { name: "page.png", x: 20, y: 0, width: 400 } };
const image: FloatingImagePlacement = { id: "image", source: "page.png", occurrence: 0, anchor: stroke.anchor, x: 20, y: 0, width: 400 };

test("saved drawing scaling keeps line-anchored ink, images, widths, and linked regions aligned", () => {
  const regions = [{ id: "region", bounds: { left: 20, top: 0, right: 420, bottom: 300 }, noteAnchor: stroke.anchor, noteImageAnchor: { id: image.id, x: 5, y: 10 } }];
  const original = JSON.stringify({ stroke, image, regions });
  const scaled = scaleDrawingContent([stroke], [image], regions, 0.5, () => 500);
  assert.deepEqual(scaled.strokes[0].points[0], { x: 140, y: -240, pressure: 0.7 });
  assert.equal(scaled.strokes[0].width, 2);
  assert.deepEqual(scaled.images[0], { ...image, x: 10, y: -250, width: 200 });
  assert.deepEqual(scaled.strokes[0].page, { ...stroke.page, x: 10, y: -250, width: 200 });
  assert.deepEqual(scaled.regions[0].bounds, { left: 10, top: -250, right: 210, bottom: -100 });
  assert.deepEqual(scaled.regions[0].noteImageAnchor, { id: image.id, x: 2.5, y: 5 });
  const restored = scaleDrawingContent(scaled.strokes, scaled.images, scaled.regions, 2, () => 500);
  assert.deepEqual(restored.strokes, [stroke]);
  assert.deepEqual(restored.images, [image]);
  assert.deepEqual(restored.regions, regions);
  assert.equal(JSON.stringify({ stroke, image, regions }), original);
  const saved = decodeInk(encodeInk({ version: 1, sourcePath: "note.md", updatedAt: "now", strokes: scaled.strokes, floatingImages: scaled.images }));
  assert.equal(saved.strokes[0].width, 2);
  assert.equal(saved.floatingImages![0].width, 200);
});

test("OneNote and Excalidraw share a nominal import width and all formats accept a percentage", () => {
  const drawing: ImportDrawing = { sourceFormat: "onenote", title: "test", width: 1148, height: 2000,
    strokes: [{ ...stroke, horizontalOrigin: 0, points: [{ x: 100, y: 200, pressure: 0.5 }] }],
    images: [{ source: "image.png", x: 100, y: 200, width: 400, height: 300 }], markdown: "", background: "<rect/>", warnings: [] };
  const nominal = scaleImportedDrawing(drawing, { factor: 1, matchNotability: true });
  assert.equal(nominal.width, 574);
  assert.equal(nominal.strokes[0].width, 2);
  assert.deepEqual(nominal.images[0], { source: "image.png", x: 50, y: 100, width: 200, height: 150 });
  assert.match(nominal.background, /scale\(0.5\)/);
  assert.equal(scaleImportedDrawing({ ...drawing, sourceFormat: "excalidraw" }, { factor: 1, matchNotability: true }).width, 574);
  assert.equal(scaleImportedDrawing({ ...drawing, sourceFormat: "notability" }, { factor: 1, matchNotability: true }).width, 1148);
  assert.equal(scaleImportedDrawing(drawing, { factor: 2, matchNotability: true }).width, 1148);
  assert.equal(scaleImportedDrawing(drawing, { factor: 1, matchNotability: false }).width, 1148);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => validateScale(value));
});

test("a note reference scales imported ink and images by the same handwriting factor", () => {
  const pen = { ...stroke, points: [{ x: 0, y: 100, pressure: .5 }, { x: 2, y: 104, pressure: .5 }, { x: 4, y: 108, pressure: .5 }] };
  const reference = measureDrawingScale([
    pen, { ...pen, tool: "highlighter", points: pen.points.map((point) => ({ ...point, y: point.y * 40 })) }
  ], [{ width: 400 }, { width: 440 }]);
  assert.deepEqual(reference, { handwriting: 8, imageWidth: 420 });
  const drawing: ImportDrawing = {
    title: "Reference test", sourceFormat: "excalidraw", width: 1200, height: 1400,
    strokes: [{ ...pen, page: undefined, horizontalOrigin: 0, points: pen.points.map((point) => ({ ...point, y: point.y * 2 })) }],
    images: [{ source: "photo.png", x: 40, y: 200, width: 700, height: 500 }], background: "", markdown: "", warnings: []
  };
  const scaled = scaleImportedDrawing(drawing, { factor: 1, matchNotability: true, reference });
  assert.equal(scaled.width, 600);
  assert.equal(scaled.strokes[0].width, 2);
  assert.equal(measureDrawingScale(scaled.strokes, scaled.images).handwriting, reference.handwriting);
  assert.deepEqual(scaled.images[0], { source: "photo.png", x: 20, y: 100, width: 350, height: 250 });
  assert.equal(scaleImportedDrawing(drawing, { factor: 1.5, matchNotability: true, reference }).width, 900);
});

test("images are a scale reference when handwriting cannot be compared", () => {
  const reference = measureDrawingScale([], [{ width: 200 }, { width: 400 }, {}]);
  assert.deepEqual(matchDrawingScale({ handwriting: 8, imageWidth: 150 }, reference), { factor: 2, measure: "image width" });
  assert.throws(() => matchDrawingScale({ handwriting: 8 }, reference), /Both notes need/);
});
