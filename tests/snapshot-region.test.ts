import assert from "node:assert/strict";
import test from "node:test";
import { embedLinkText, lineFingerprint, parseSnapshotRegion, resolveSnapshotLine, snapshotSubpath } from "../src/snapshot-region";

test("a note capture link preserves negative coordinates and its text anchor", () => {
  const region = {
    id: "7ebb4e48-95cc-4015-9dad-d49e4cedc8bd",
    bounds: { left: -32, top: -15.5, right: 95, bottom: 100 },
    anchor: { line: 42, fingerprint: lineFingerprint("Annotated paragraph") }
  };
  assert.deepEqual(parseSnapshotRegion(snapshotSubpath(region)), region);
  assert.equal(parseSnapshotRegion("#md-region=../../example&rect=0,0,5,5"), null);
});

test("note captures follow the anchored text after a line is inserted", () => {
  const lines = ["Intro", "An inserted line", "Annotated paragraph", "Ending"];
  const anchor = { line: 1, fingerprint: lineFingerprint("Annotated paragraph") };
  assert.equal(resolveSnapshotLine(anchor, lines.length, (index) => lines[index]), 2);
});

test("Canvas paste accepts a single region embed in either Obsidian link format", () => {
  assert.equal(embedLinkText("![[A note#md-region=example|320]]"), "A note#md-region=example");
  assert.equal(embedLinkText("![](A%20note.md#md-region=example)"), "A note.md#md-region=example");
  assert.equal(embedLinkText("Read this: ![[A note#md-region=example]]"), null);
});
