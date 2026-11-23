import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@codemirror/state";
import { fullySelectedLines, textRangeCoversInkLine } from "../src/text-ink-selection";

test("a selection can cover blank lines and a trailing ink line", () => {
  const doc = Text.of(["written", "", "", "last", ""]);
  assert.equal(textRangeCoversInkLine(doc, doc.line(2).from, { from: doc.line(2).from, to: doc.line(3).from }), true);
  assert.equal(textRangeCoversInkLine(doc, doc.line(3).from, { from: doc.line(2).from, to: doc.line(3).from }), false);
  assert.equal(textRangeCoversInkLine(doc, doc.length, { from: 0, to: doc.length }), true);
});

test("a caret or partial text range does not cover an entire line of ink", () => {
  const doc = Text.of(["first", "second"]);
  assert.equal(textRangeCoversInkLine(doc, 0, { from: 0, to: 3 }), false);
  assert.equal(textRangeCoversInkLine(doc, 0, { from: 0, to: 0 }), false);
  assert.equal(textRangeCoversInkLine(doc, 0, { from: 0, to: 5 }), true);
});

test("the whole-line span includes covered blank lines and excludes partial end lines", () => {
  const doc = Text.of(["first", "", "third", "fourth"]);
  const span = fullySelectedLines(doc, { from: 2, to: doc.line(4).from + 2 });
  assert.equal(span?.first.number, 2);
  assert.equal(span?.last.number, 3);
  assert.equal(fullySelectedLines(doc, { from: 1, to: 4 }), undefined);
  assert.equal(fullySelectedLines(doc, { from: 0, to: doc.line(2).from })?.last.number, 1);
});
