import assert from "node:assert/strict";
import test from "node:test";
import { hashPath, lineAt, resolveAnchor } from "../src/anchors";

test("lineAt finds the containing Markdown line", () => {
  const text = "alpha\nbeta words\ngamma";
  assert.deepEqual(lineAt(text, 9), { from: 6, to: 16, text: "beta words" });
  assert.deepEqual(lineAt(text, 0), { from: 0, to: 5, text: "alpha" });
  assert.deepEqual(lineAt(text, 999), { from: 17, to: 22, text: "gamma" });
});

test("resolveAnchor follows a line moved by external edits", () => {
  const original = "first\nimportant paragraph\nlast";
  const anchor = { pos: original.indexOf("important"), lineText: "important paragraph" };
  const changed = "new heading\nfirst\nimportant paragraph\nlast";
  assert.deepEqual(resolveAnchor(changed, anchor), {
    pos: changed.indexOf("important"),
    lineText: "important paragraph"
  });
});

test("an embed fingerprint recovers when a whole-note replacement maps its offset into properties", () => {
  const line = "![[diagram.jpg|480]]";
  const text = "---\ncreated: today\nupdated: now\n---\n\n" + line + "\n";
  assert.deepEqual(resolveAnchor(text, { pos: 6, lineText: line }), { pos: text.indexOf(line), lineText: line });
});

test("resolveAnchor chooses the closest duplicate fingerprint", () => {
  const text = "repeat\nspace\nspace\nrepeat";
  assert.equal(resolveAnchor(text, { pos: text.length, lineText: "repeat" }).pos, text.lastIndexOf("repeat"));
});

test("hashPath is deterministic, distinct, and filename-safe", () => {
  assert.equal(hashPath("Notes/Demo.md"), hashPath("Notes/Demo.md"));
  assert.notEqual(hashPath("Notes/Demo.md"), hashPath("Notes/Other.md"));
  assert.match(hashPath("folder/odd:name?.md"), /^[a-f0-9]{16}$/);
});

test("the first blank line anchors at the start of the note", () => {
  assert.deepEqual(lineAt("\nNext", 0), { from: 0, to: 0, text: "" });
  assert.deepEqual(resolveAnchor("\nNext", { pos: 0, lineText: "" }), { pos: 0, lineText: "" });
});
