import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { decodeInk, encodeInk } from "../src/ink-storage";
import { DEFAULT_SETTINGS, type InkFileData, type InkStroke } from "../src/model";

const bundledStore = build({
  entryPoints: ["src/ink-store.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "obsidian-stub", setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
      contents: "export const normalizePath = path => path;"
    }));
  } }]
}).then(({ outputFiles }): Promise<typeof import("../src/ink-store")> =>
  import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`));

function stroke(id: string): InkStroke {
  return {
    id, tool: "pen", color: "#07599c", width: 2.5, opacity: 1, anchor: { pos: 0, lineText: "Note" },
    points: [{ x: 10, y: 15, pressure: 0.5 }]
  };
}

async function fixture() {
  const { InkStore } = await bundledStore;
  const data: InkFileData = {
    version: 1, sourcePath: "Note.md", updatedAt: "2026-11-23T18:00:00.000Z", strokes: [stroke("original")]
  };
  const file = { path: "Note.md.ink.json", name: "Note.md.ink.json" };
  let raw = encodeInk(data);
  let pauseWrite: (() => Promise<void>) | undefined;
  const errors: unknown[] = [];
  const vault = {
    getFileByPath: (path: string) => path === file.path ? file : null,
    getFiles: () => [file],
    read: async () => raw,
    async process(_file: typeof file, transform: (value: string) => string) {
      const next = transform(raw);
      await pauseWrite?.();
      raw = next;
    }
  };
  const store = new InkStore({ vault } as never, () => ({ ...DEFAULT_SETTINGS, inkLocation: "same" }),
    (_message, error) => errors.push(error));
  const drawing = await store.getDocument(data.sourcePath);
  return {
    store, drawing, data, errors,
    onDisk: () => decodeInk(raw),
    replace: (contents: InkFileData) => { raw = encodeInk(contents); },
    refresh: () => store.refreshFile(file as never),
    flush: () => store.flushDocument(data.sourcePath),
    pauseWrite: (run: () => Promise<void>) => { pauseWrite = run; }
  };
}

test("a download after an iPad save preserves recent ink and rewrites the combined sidecar", async () => {
  const note = await fixture();
  note.drawing.append(stroke("ipad"));
  await note.flush();
  const local = note.onDisk();
  note.replace({ ...note.data, updatedAt: "2099-01-01T00:00:00.000Z", strokes: [...note.data.strokes, stroke("pc")] });
  await note.refresh();
  await note.flush();
  assert.deepEqual(note.drawing.strokes.map(({ id }) => id), ["original", "pc", "ipad"]);
  assert.deepEqual(note.onDisk().strokes.map(({ id }) => id), ["original", "pc", "ipad"]);
  assert.deepEqual(note.onDisk().revisions?.strokes?.ipad, local.revisions?.strokes?.ipad);
  assert.deepEqual(note.errors, []);
});

test("an edit during the first save survives a stale download and later syncs its erase", async () => {
  const note = await fixture();
  let reached!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const release = new Promise<void>((resolve) => { resume = resolve; });
  note.pauseWrite(async () => {
    note.pauseWrite(async () => {});
    reached();
    await release;
  });
  note.drawing.append(stroke("first"));
  await ready;
  note.drawing.append(stroke("second"));
  resume();
  await note.flush();
  note.replace(note.data);
  await note.refresh();
  await note.flush();
  assert.deepEqual(note.onDisk().strokes.map(({ id }) => id), ["original", "first", "second"]);
  const beforeErase = note.onDisk();
  note.drawing.eraseStrokes(new Set(["second"]));
  await note.flush();
  note.replace(beforeErase);
  await note.refresh();
  await note.flush();
  assert.deepEqual(note.drawing.strokes.map(({ id }) => id), ["original", "first"]);
  assert.deepEqual(note.onDisk().strokes.map(({ id }) => id), ["original", "first"]);
  assert.equal(note.onDisk().revisions?.strokes?.second[2], true);
  assert.deepEqual(note.errors, []);
});
