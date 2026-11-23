import assert from "node:assert/strict";
import test from "node:test";
import { decodeInk, encodeInk, mergeInk, recordInkChanges } from "../src/ink-storage";
import type { InkFileData } from "../src/model";

test("region placements and deletion flags survive sidecar updates", () => {
  const note: InkFileData = { version: 1, sourcePath: "Note.md", updatedAt: "", strokes: [] };
  const region = {
    id: "9ab0caf0-0000-0000-0000-000000000000",
    bounds: { left: 0, top: 1, right: 50, bottom: 80 },
    noteAnchor: { pos: 10, lineText: "Captured content" }
  };
  const initial = { ...note, snapshotRegions: [region] };
  const removed = { ...note, snapshotRegions: [{ ...region, deleted: true }] };
  assert.deepEqual(decodeInk(encodeInk(initial)).snapshotRegions, [region]);
  const edited = recordInkChanges(initial, removed, "device");
  assert.deepEqual(mergeInk(edited, initial).snapshotRegions, removed.snapshotRegions);
  assert.deepEqual(mergeInk(initial, edited).snapshotRegions, removed.snapshotRegions);
});
