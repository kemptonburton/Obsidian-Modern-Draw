import assert from "node:assert/strict";
import test from "node:test";
import { createStrokeOutline, inkDisplayColor, outlineToSvgPath } from "../src/ink-renderer";
import { simplifyPoints, STYLUS_SAMPLE_DISTANCE } from "../src/geometry";
import { decodeInk, encodeInk } from "../src/ink-storage";
import type { InkStroke } from "../src/model";

test("imported dark neutral ink adapts to dark mode and preserves source colors", () => {
  const stroke: InkStroke = { id: "import", tool: "pen", rendering: "onenote", color: "#000000", width: 3, opacity: 1, anchor: { pos: 0, lineText: "" }, points: [] };
  assert.equal(inkDisplayColor(stroke, true), "#ffffff");
  assert.equal(inkDisplayColor(stroke, false), "#000000");
  assert.equal(stroke.color, "#000000");
  assert.equal(inkDisplayColor({ ...stroke, rendering: "excalidraw", color: "#1e1e1e" }, true), "#ffffff");
  for (const color of ["#E71225", "#33CCFF", "#66CC00", "#004F8B", "#FFFFFF", "#e03131", "#1971c2", "#6741d9"]) {
    assert.equal(inkDisplayColor({ ...stroke, color }, true), color);
  }
  assert.equal(inkDisplayColor({ ...stroke, rendering: undefined }, true), "#000000");
  assert.equal(inkDisplayColor({ ...stroke, tool: "highlighter" }, true), "#000000");
});

test("shared renderer produces the same reusable vector outline for every surface", () => {
  const stroke: InkStroke = {
    id: "shared-renderer",
    tool: "pen",
    color: "#ff0000",
    width: 3,
    opacity: 1,
    anchor: { pos: 0, lineText: "" },
    points: [
      { x: 10, y: 10, pressure: 0.3 },
      { x: 20, y: 16, pressure: 0.7 },
      { x: 34, y: 12, pressure: 0.5 }
    ]
  };
  const outline = createStrokeOutline(stroke, stroke.points, 1, 0.72, true);
  assert.ok(outline.length > stroke.points.length);
  const path = outlineToSvgPath(outline);
  assert.match(path, /^M /);
  assert.match(path, / Q /);
  assert.match(path, / Z$/);
});

test("constant-width stylus ink keeps its outline across pressure changes and save reloads", () => {
  const stroke: InkStroke = {
    id: "constant-width", tool: "pen", color: "#07599c", width: 3, opacity: 1,
    anchor: { pos: 0, lineText: "" }, pressureSensitive: false, stylus: true,
    points: [0.1, 0.3, 0.9, 1].map((pressure, index) => ({ x: index * 10, y: index * 4, pressure }))
  };
  const flat = { ...stroke, points: stroke.points.map((point) => ({ ...point, pressure: 0.5 })) };
  const outline = (ink: InkStroke) => createStrokeOutline(ink, ink.points, 1, 0.72, true);
  assert.deepEqual(outline(stroke), outline(flat));
  assert.notDeepEqual(outline({ ...stroke, pressureSensitive: undefined }), outline(flat));
  const saved = decodeInk(encodeInk({ version: 1, sourcePath: "page.md", updatedAt: "test", strokes: [stroke] }));
  assert.equal(saved.strokes[0].pressureSensitive, false);
  assert.deepEqual(outline(saved.strokes[0]), outline(stroke));
});

test("stylus rendering reduces the effect of stair-stepped input on a narrow stroke edge", () => {
  const stroke: InkStroke = {
    id: "quantized", tool: "pen", color: "#07599c", width: 2, opacity: 1, pressureSensitive: false,
    anchor: { pos: 0, lineText: "" },
    points: Array.from({ length: 32 }, (_, index) => ({ x: index * 1.5, y: index % 2 * 0.84 - 0.42, pressure: 0.5 }))
  };
  const edgeError = (stylus?: boolean): number => {
    const outline = createStrokeOutline({ ...stroke, stylus }, stroke.points, 1, 0.72, true);
    const interior = outline.filter(([x, y]) => x > 7 && x < 35 && y > 0);
    return Math.hypot(...interior.map(([, y]) => y - 1)) / Math.sqrt(interior.length);
  };
  assert.ok(edgeError(true) < edgeError(false) / 2);
  assert.equal(edgeError(), edgeError(true));
});

test("live Pencil ink uses the same contour as the saved stroke", () => {
  const live: InkStroke = {
    id: "live", tool: "pen", color: "#07599c", width: 3, opacity: 1,
    anchor: { pos: 0, lineText: "" }, stylus: true,
    points: [[0, 0], [0, 0], [0.17, 0.12], [2, 1], [2, 1], [4, 3], [4.03, 3], [8, 7]]
      .map(([x, y], index) => ({ x, y, pressure: 0.3 + index * 0.08 }))
  };
  const saved = { ...live, points: simplifyPoints(live.points, STYLUS_SAMPLE_DISTANCE) };
  for (const pressureSensitive of [true, false]) {
    const preview = createStrokeOutline({ ...live, pressureSensitive }, live.points, 1, 0.72, false);
    const finished = createStrokeOutline({ ...saved, pressureSensitive }, saved.points, 1, 0.72, true);
    assert.deepEqual(preview, finished);
  }
});
