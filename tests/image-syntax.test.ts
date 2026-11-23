import assert from "node:assert/strict";
import test from "node:test";
import { findImageSyntaxRanges, imageDeletionRanges, selectImageSyntaxRange } from "../src/image-syntax";
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import type { FloatingImagePlacement } from "../src/model";

test("image syntax discovery handles wiki embeds and Markdown images", () => {
  const line = "before ![[Pasted image.png|420]] and ![diagram](assets/diagram.png) after";
  assert.deepEqual(findImageSyntaxRanges(line).map((range) => range.text), [
    "![[Pasted image.png|420]]",
    "![diagram](assets/diagram.png)"
  ]);
});

test("image deletion removes selected occurrences while preserving text, spacing, and other images", () => {
  const line = "before ![[same.png]] ![[same.png|200]] ![[other-same.png]] after";
  const text = "---\ncreated: today\n---\n\n" + line + "\n\n";
  const image: FloatingImagePlacement = { id: "selected", source: "same.png", occurrence: 1, anchor: { pos: 0, lineText: line }, x: 0, y: 3000 };
  const changes = imageDeletionRanges(text, [image, image]).map((range) => ({ ...range, insert: "" }));
  assert.equal(changes.length, 1);
  let state = EditorState.create({ doc: text, extensions: [history()] });
  state = state.update({ changes }).state;
  assert.equal(state.doc.toString(), text.replace("![[same.png|200]]", ""));
  const target = { get state() { return state; }, dispatch: (transaction: { state: EditorState }) => { state = transaction.state; } };
  assert.ok(undo(target));
  assert.equal(state.doc.toString(), text);
  assert.ok(redo(target));
  assert.equal(state.doc.toString(), text.replace("![[same.png|200]]", ""));
});

test("image deletion recovers a unique embed from a stale anchor and matches encoded Markdown paths", () => {
  const text = "created: today\n\n![diagram](assets/my%20diagram.png) ![[other.png]]\n";
  const image: FloatingImagePlacement = { id: "selected", source: "assets/my diagram.png", occurrence: 0, anchor: { pos: 0, lineText: "created: today" }, x: 0, y: 0 };
  const ranges = imageDeletionRanges(text, [image]);
  assert.equal(ranges.length, 1);
  assert.equal(text.slice(ranges[0].from, ranges[0].to), "![diagram](assets/my%20diagram.png)");
});

test("image syntax selection distinguishes repeated source images", () => {
  const line = "![[same.png]] ![[same.png|200]]";
  assert.equal(selectImageSyntaxRange(line, "same.png", 1, 0)?.text, "![[same.png|200]]");
});
