import assert from "node:assert/strict";
import test from "node:test";
import { LocalInkStyle, moveInkPreset, orderedInkPresets, updateInkPreset } from "../src/ink-style";
import { DEFAULT_SETTINGS } from "../src/model";

test("working ink styles remain isolated between open surfaces", () => {
  const note = new LocalInkStyle({ ...DEFAULT_SETTINGS });
  const canvas = new LocalInkStyle({ ...DEFAULT_SETTINGS });

  note.setColor("pen", "#123456");
  note.setWidth("pen", 7.5);
  note.setColor("highlighter", "#abcdef");
  note.setWidth("highlighter", 32);

  assert.equal(note.colorFor("pen"), "#123456");
  assert.equal(note.widthFor("pen"), 7.5);
  assert.equal(note.colorFor("highlighter"), "#abcdef");
  assert.equal(note.widthFor("highlighter"), 32);
  assert.equal(canvas.colorFor("pen"), DEFAULT_SETTINGS.penColor);
  assert.equal(canvas.widthFor("pen"), DEFAULT_SETTINGS.penWidth);
  assert.equal(canvas.colorFor("highlighter"), DEFAULT_SETTINGS.highlighterColor);
  assert.equal(canvas.widthFor("highlighter"), DEFAULT_SETTINGS.highlighterWidth);
});

test("saved presets can move between pen and highlighter positions", () => {
  const initial = orderedInkPresets(DEFAULT_SETTINGS);
  const [firstPen, secondPen, lastPen, firstHighlighter, lastHighlighter] = initial;
  const moved = moveInkPreset(DEFAULT_SETTINGS, firstHighlighter, secondPen);
  assert.deepEqual(orderedInkPresets(moved).map(({ preset }) => preset.color),
    [firstPen, firstHighlighter, secondPen, lastPen, lastHighlighter].map(({ preset }) => preset.color));

  const toEnd = moveInkPreset(moved, firstPen, null);
  assert.deepEqual(orderedInkPresets(toEnd).map(({ preset }) => preset.color),
    [firstHighlighter, secondPen, lastPen, lastHighlighter, firstPen].map(({ preset }) => preset.color));
});

test("reordering skips unchanged placements and editing preserves a preset's position", () => {
  const [first, second, third] = orderedInkPresets(DEFAULT_SETTINGS);
  assert.equal(moveInkPreset(DEFAULT_SETTINGS, first, second), DEFAULT_SETTINGS);
  const moved = moveInkPreset(DEFAULT_SETTINGS, first, third);
  const edited = updateInkPreset(moved, first.tool, first.preset, { color: "#123456", width: first.preset.width });
  assert.equal(orderedInkPresets(edited)[1].preset.color, "#123456");
});
