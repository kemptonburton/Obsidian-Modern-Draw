import assert from "node:assert/strict";
import test from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { lassoTextDrop } from "../src/lasso-text";

test("dropping selected text moves it and selects the moved text", () => {
  const state = EditorState.create({ doc: "alpha beta", selection: { anchor: 0, head: 5 } });
  const drop = lassoTextDrop(state, 10);
  assert.ok(drop);
  const moved = state.update(drop).state;
  assert.equal(moved.doc.toString(), " betaalpha");
  assert.equal(moved.sliceDoc(moved.selection.main.from, moved.selection.main.to), "alpha");
});

test("a drop into any selected range leaves the document alone", () => {
  const state = EditorState.create({ doc: "alpha beta", selection: { anchor: 0, head: 5 } });
  assert.equal(lassoTextDrop(state, 3), undefined);
});

test("disjoint ranges are moved together and keep their order", () => {
  const state = EditorState.create({
    doc: "alpha beta gamma",
    selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(11, 16)]),
    extensions: EditorState.allowMultipleSelections.of(true)
  });
  const drop = lassoTextDrop(state, 8);
  assert.ok(drop);
  const moved = state.update(drop).state;
  assert.equal(moved.sliceDoc(moved.selection.main.from, moved.selection.main.to), "alpha\ngamma");
  assert.equal(moved.doc.toString(), " bealpha\ngammata ");
});
