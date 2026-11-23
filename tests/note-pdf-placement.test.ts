import assert from "node:assert/strict";
import test from "node:test";
import { capturePdfCursor, notePdfInsertion } from "../src/note-pdf-placement";

const pages = ["![[Page 1.png]]", "![[Page 2.png]]"];

function importAt(text: string, offset?: number): string {
  const cursor = offset === undefined ? undefined : capturePdfCursor(text, offset);
  const { from, insert } = notePdfInsertion(text, pages, cursor);
  return text.slice(0, from) + insert + text.slice(from);
}

test("a cursor import inserts between the text on either side without replacing it", () => {
  assert.equal(importAt("BeforeAfter", 6), "Before\n\n![[Page 1.png]]\n\n![[Page 2.png]]\n\nAfter");
  assert.equal(importAt("Before\n\nAfter", 7), "Before\n\n![[Page 1.png]]\n\n![[Page 2.png]]\n\nAfter");
});

test("end imports append to a note, including an empty note", () => {
  assert.equal(importAt("Before\n"), "Before\n\n![[Page 1.png]]\n\n![[Page 2.png]]\n");
  assert.equal(importAt(""), "![[Page 1.png]]\n\n![[Page 2.png]]\n");
});

test("a cursor on an existing image, in frontmatter, or in fenced code keeps that block intact", () => {
  const source = "---\ntitle: A note\n---\n\n~~~md\nOriginal content\n~~~\n\n![[Existing slide.png]]\nAfter";
  const afterMetadata = importAt(source, source.indexOf("A note"));
  assert.match(afterMetadata, /^---\ntitle: A note\n---\n\n!\[\[Page 1\.png\]\]/);
  const afterCode = importAt(source, source.indexOf("Original"));
  assert.match(afterCode, /~~~md\nOriginal content\n~~~\n\n!\[\[Page 1\.png\]\]/);
  const afterImage = importAt(source, source.indexOf("slide"));
  assert.match(afterImage, /!\[\[Existing slide\.png\]\]\n\n!\[\[Page 1\.png\]\]/);
});

test("the cursor can follow its captured line when text is inserted above it", () => {
  const cursor = capturePdfCursor("First\nBeforeAfter", 12);
  const { from } = notePdfInsertion("Heading\nFirst\nBeforeAfter", pages, cursor);
  assert.equal(from, "Heading\nFirst\nBefore".length);
});
