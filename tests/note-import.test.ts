import assert from "node:assert/strict";
import test from "node:test";
import LZString from "lz-string";
import type { App, TFile } from "obsidian";
import { convertExcalidrawNote, importExcalidraw, saveImportedDrawing } from "../src/note-import";
import type { InkStore } from "../src/ink-store";
import type { FloatingImagePlacement, InkStroke } from "../src/model";

test("compressed Excalidraw imports preserve native PDF rectangles and separate images", async () => {
  const scene = { elements: [
    { id: "ink", type: "freedraw", x: 10, y: 20, width: 30, height: 20, strokeWidth: 2, points: [[0, 0], [30, 20]], pressures: [0.2, 0.8] },
    { id: "crop", type: "image", x: 20, y: 50, width: 300, height: 100, link: "[[page.pdf#page=2&rect=10,20,110,220]]" },
    { id: "image", type: "image", x: 20, y: 200, width: 400, height: 300, link: "[[photo.png]]" },
    { id: "deleted", type: "freedraw", isDeleted: true }
  ] };
  const raw = "```compressed-json\n" + LZString.compressToBase64(JSON.stringify(scene)) + "\n```";
  let savedText = "";
  let strokes: InkStroke[] = [];
  let images: FloatingImagePlacement[] = [];
  const app = {
    vault: {
      read: async () => raw,
      getFolderByPath: () => true,
      getAbstractFileByPath: () => false,
      create: async (path: string, text: string) => { savedText = text; return { path }; }
    },
    metadataCache: { getFirstLinkpathDest: (path: string) => ({ path: `Attachments/${path}` }) }
  } as unknown as App;
  const drawing = await importExcalidraw(app, { path: "drawing.md", basename: "drawing" } as TFile);
  assert.equal(drawing.strokes.length, 1);
  assert.equal(drawing.strokes[0].width, 8.5);
  assert.equal(drawing.strokes[0].points[1].pressure, 0.8);
  assert.equal(drawing.background, "");
  assert.equal(drawing.images.length, 2);
  const store = {
    getDocument: async () => ({ setCanvasLayout: () => undefined, commitState: (s: InkStroke[], i: FloatingImagePlacement[]) => { strokes = s; images = i; } }),
    flushDocument: async () => undefined
  } as unknown as InkStore;
  await saveImportedDrawing(app, store, drawing, "Imports", "md", undefined, { factor: 1, matchNotability: false });
  assert.match(savedText, /!\[\[Attachments\/page.pdf#page=2&rect=10,20,110,220\|300\]\]/);
  assert.match(savedText, /!\[\[Attachments\/photo.png\|400\]\]/);
  assert.equal(images.length, 2);
  assert.equal(images[1].y - images[0].y, 150);
  assert.ok(savedText.slice(strokes[0].anchor.pos).startsWith(strokes[0].anchor.lineText));
  assert.equal(strokes[0].page, undefined);
  await saveImportedDrawing(app, store, drawing, "Imports", "canvas", undefined, { factor: 1, matchNotability: false });
  const canvas = JSON.parse(savedText);
  assert.equal(canvas.nodes.length, 2);
  assert.equal(canvas.nodes[0].subpath, "#page=2&rect=10,20,110,220");
  assert.equal(images.length, 0);
});

test("converting a Markdown Excalidraw note keeps its path and backs up the source", async () => {
  const original = JSON.stringify({ elements: [{ id: "ink", type: "freedraw", x: 0, y: 0, width: 20, height: 20, points: [[0, 0], [20, 20]] }] });
  const source = { path: "Notes/Drawing.md", name: "Drawing.md", basename: "Drawing", extension: "md" } as TFile;
  const files = new Map([[source.path, original]]);
  let inkSource = "";
  const app = { vault: {
    read: async (file: TFile) => files.get(file.path),
    getFolderByPath: () => true,
    getAbstractFileByPath: (path: string) => files.has(path),
    create: async (path: string, text: string) => { files.set(path, text); return { path }; },
    process: async (file: TFile, transform: (text: string) => string) => { files.set(file.path, transform(files.get(file.path)!)); }
  } } as unknown as App;
  const store = {
    getDocument: async (path: string) => { inkSource = path; return { setCanvasLayout: () => undefined, commitState: () => undefined }; },
    flushDocument: async () => undefined
  } as unknown as InkStore;
  const result = await convertExcalidrawNote(app, store, source);
  assert.equal(result.path, source.path);
  assert.equal(inkSource, source.path);
  assert.match(files.get(source.path)!, /modern-draw-import: true/);
  const backup = [...files].find(([path]) => path.endsWith(".excalidraw-backup"));
  assert.equal(backup?.[1], original);
});
