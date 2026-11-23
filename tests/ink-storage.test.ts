import test from "node:test";
import assert from "node:assert/strict";
import { decodeInk, encodeInk, mergeInk, recordInkChanges } from "../src/ink-storage";
import type { InkFileData, InkStroke } from "../src/model";

function stroke(id: string): InkStroke {
  return {
    id, tool: "pen", color: "#07599c", width: 2.5, opacity: 1,
    anchor: { pos: 0, lineText: "A slide" },
    points: [{ x: 15.1254, y: 3.3754, pressure: 0.7234 }]
  };
}

function drawing(strokes: InkStroke[]): InkFileData {
  return { version: 1, sourcePath: "Lecture.md", updatedAt: "2026-01-01", strokes };
}

test("compact saves retain page-relative ink and read older vector files", () => {
  const original = drawing([{
    ...stroke("page"),
    horizontalOrigin: 16,
    page: { name: "Test-mdpage-a-1.png", x: 12, y: 4, width: 640 }
  }]);
  assert.deepEqual(decodeInk(JSON.stringify(original)), original);
  const raw = encodeInk(original);
  assert.deepEqual(JSON.parse(raw).strokes[0].points, [15.13, 3.38, 0.723]);
  const decoded = decodeInk(raw).strokes[0];
  assert.deepEqual(decoded.page, original.strokes[0].page);
  assert.deepEqual(decoded.points, [{ x: 15.13, y: 3.38, pressure: 0.723 }]);
});

test("merging incoming ink preserves other-device additions and a local erase", () => {
  const erased = stroke("erased");
  const existing = stroke("existing");
  const local = stroke("local");
  const remote = stroke("remote");
  const base = drawing([erased, existing]);
  const changed = { ...existing, color: "#c32637" };
  const merged = mergeInk(
    recordInkChanges(base, drawing([existing, local]), "ipad"),
    recordInkChanges(base, drawing([erased, changed, remote]), "desktop")
  );
  assert.deepEqual(merged.strokes, [changed, remote, local]);
});

test("a remote erase survives a local edit to a different stroke", () => {
  const erased = stroke("erased");
  const existing = stroke("existing");
  const local = { ...existing, width: 4 };
  const base = drawing([erased, existing]);
  const merged = mergeInk(
    recordInkChanges(base, drawing([erased, local]), "ipad"),
    recordInkChanges(base, drawing([existing]), "desktop")
  );
  assert.deepEqual(merged.strokes, [local]);
});

test("a stale snapshot cannot undo ink already saved on another device", () => {
  const base = drawing([stroke("original")]);
  const local = recordInkChanges(base, drawing([...base.strokes, stroke("new ink")]), "ipad");
  const remote = recordInkChanges(base, drawing([...base.strokes, stroke("other ink")]), "desktop");
  const merged = mergeInk(decodeInk(encodeInk(local)), decodeInk(encodeInk(remote)));
  assert.deepEqual(merged.strokes.map(({ id }) => id), ["original", "other ink", "new ink"]);
});

test("an explicit erase survives stale snapshots and an undo can restore it", () => {
  const base = drawing([stroke("original")]);
  const erased = decodeInk(encodeInk(recordInkChanges(base, drawing([]), "ipad")));
  assert.deepEqual(mergeInk(erased, base).strokes, []);
  assert.deepEqual(mergeInk(base, erased).strokes, []);
  const restored = recordInkChanges(erased, base, "desktop");
  assert.deepEqual(mergeInk(erased, restored).strokes, base.strokes);
});
