import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@codemirror/state";
import {
  blankLineRemovalRange,
  markdownSpaceBoundary,
  removableBlankLinesBefore,
  spaceAnchorLineDelta,
  trailingInkSpace
} from "../src/markdown-space";

function text(value: string): Text {
  return Text.of(value.split("\n"));
}

test("space boundary follows a run of editable blank Markdown lines", () => {
  const doc = text("one\n\n\ntwo");
  assert.equal(markdownSpaceBoundary(doc, 4), 6);
  assert.equal(removableBlankLinesBefore(doc, 6), 2);
});

test("space removal deletes only the requested blank Markdown lines", () => {
  const source = "one\n\n\ntwo";
  const doc = text(source);
  const range = blankLineRemovalRange(doc, 6, 1);
  assert.deepEqual(range, { from: 5, to: 6 });
  assert.equal(source.slice(0, range!.from) + source.slice(range!.to), "one\n\ntwo");
});

test("space removal cannot cross a nonblank Markdown line", () => {
  const doc = text("one\n\ntwo");
  assert.deepEqual(blankLineRemovalRange(doc, 5, 100), { from: 4, to: 5 });
  assert.equal(blankLineRemovalRange(doc, 0, 1), null);
});

test("space insertion stays outside leading frontmatter", () => {
  const source = "---\ntitle: Demo\n---\nBody";
  const doc = text(source);
  assert.equal(markdownSpaceBoundary(doc, 0), source.indexOf("Body"));
  assert.equal(markdownSpaceBoundary(text("Body"), 0), 4);
});

test("ink before an existing trailing blank line or within the last paragraph needs no room", () => {
  assert.equal(trailingInkSpace(-15, 24, 24, true), undefined);
  assert.equal(trailingInkSpace(0, 24, 24, true), undefined);
  assert.equal(trailingInkSpace(40, 48, 24, false), undefined);
});

test("end-of-note ink only reserves the shortfall and calculates the first clear writing line", () => {
  assert.deepEqual(trailingInkSpace(8, 24, 24, true), { bottom: 8, padding: 0, lines: 1 });
  assert.deepEqual(trailingInkSpace(40, 24, 24, true), { bottom: 40, padding: 24, lines: 2 });
  assert.deepEqual(trailingInkSpace(40, 24, 24, false), { bottom: 40, padding: 24, lines: 2 });
  assert.deepEqual(trailingInkSpace(70, 48, 24, false), { bottom: 70, padding: 30, lines: 3 });
});

test("a space retraction maps an ink anchor inside the deleted blank lines to the surviving line", () => {
  const doc = text("Above\n\n\n\nBelow");
  const boundary = doc.line(5).from;
  const removal = blankLineRemovalRange(doc, boundary, 2);
  assert.equal(spaceAnchorLineDelta(doc, doc.line(2).from, boundary, -2, removal), 0);
  assert.equal(spaceAnchorLineDelta(doc, doc.line(3).from, boundary, -2, removal), 0);
  assert.equal(spaceAnchorLineDelta(doc, doc.line(4).from, boundary, -2, removal), -1);
  assert.equal(spaceAnchorLineDelta(doc, boundary, boundary, -2, removal), -2);
});
