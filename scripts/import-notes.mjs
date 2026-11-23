import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { DOMParser } from "@xmldom/xmldom";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const vault = path.resolve(option("--vault") ?? "");
const folder = option("--folder") ?? "04 - Fleeting/plugin tests";
const kind = option("--kind") ?? "md";
const source = args.includes("--source") ? option("--source") : undefined;
const pageId = args.includes("--onenote-id") ? option("--onenote-id") : undefined;
const exportedPage = option("--onenote-export");
const notability = option("--notability");
const referenceNote = option("--reference");
if (!args.includes("--vault") || (!source && !pageId && !exportedPage && !notability) || !["md", "canvas"].includes(kind)) {
  throw new Error('Use --vault <vault> --source <Excalidraw file> or --onenote-id <page ID>, with optional --reference <vault note path>, --title, --folder, --kind md|canvas, and --replace.');
}
const absolute = (relative) => {
  const target = path.resolve(vault, relative);
  if (target !== vault && !target.startsWith(vault + path.sep)) throw new Error("Import path escapes the vault.");
  return target;
};
globalThis.DOMParser = DOMParser;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "modern-draw-import-"));
try {
  await build({
    stdin: { contents: 'export {importExcalidraw,saveImportedDrawing} from "./src/note-import"; export {decodeOneNotePage} from "./src/onenote-import"; export {importNotability} from "./src/notability-import"; export {decodeInk,encodeInk} from "./src/ink-storage"; export {measureDrawingScale} from "./src/drawing-scale";', resolveDir: root },
    bundle: true, platform: "node", format: "esm", outfile: path.join(temporary, "engine.mjs"), loader: { ".ps1": "text" },
    plugins: [{ name: "headless-obsidian", setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "headless" }));
      builder.onLoad({ filter: /.*/, namespace: "headless" }, () => ({ contents: 'import Turndown from "turndown"; export const Platform={isDesktopApp:false}; export const htmlToMarkdown=(html)=>new Turndown().turndown(html);', resolveDir: root }));
    } }]
  });
  const engine = await import(pathToFileURL(path.join(temporary, "engine.mjs")).href);
  const files = (await fs.readdir(vault, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.parentPath.includes(path.sep + ".obsidian"))
    .map((entry) => fileInfo(path.relative(vault, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")));
  let reference;
  if (referenceNote) {
    const relative = path.relative(vault, absolute(referenceNote)).replaceAll("\\", "/");
    if (!files.some((file) => file.path === relative && file.extension === "md")) {
      throw new Error(`Scale reference note could not be found: ${relative}`);
    }
    const suffix = path.posix.basename(relative) + ".ink.json";
    for (const file of files.filter(({ name }) => name === suffix || name.endsWith("-" + suffix))) {
      const candidate = engine.decodeInk(await fs.readFile(absolute(file.path), "utf8"));
      if (candidate.sourcePath !== relative) continue;
      reference = engine.measureDrawingScale(candidate.strokes, candidate.floatingImages ?? []);
      break;
    }
    if (!reference?.handwriting && !reference?.imageWidth) {
      throw new Error("The reference note has no measurable handwriting or saved image widths.");
    }
  }
  const pending = new Map();
  let output;
  const app = {
    vault: {
      read: async (file) => fs.readFile(absolute(file.path), "utf8"),
      getFileByPath: (name) => files.find((file) => file.path === name),
      getFolderByPath: (name) => ({ path: name }),
      getAbstractFileByPath: (name) => pending.has(name) || files.some((f) => f.path === name),
      create: async (name, data) => { pending.set(name, data); output = fileInfo(name); return output; },
      process: async (file, transform) => { pending.set(file.path, transform(await fs.readFile(absolute(file.path), "utf8"))); output = fileInfo(file.path); },
      createBinary: async (name, data) => { pending.set(name, Buffer.from(data)); return fileInfo(name); }
    },
    metadataCache: { getFirstLinkpathDest: (link, from) => {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), link));
      return files.find((f) => f.path === relative) ?? files.find((f) => f.path === link) ?? files.find((f) => f.name === link);
    } }
  };
  let drawing;
  if (source) {
    const relative = path.relative(vault, path.resolve(source)).replaceAll("\\", "/");
    absolute(relative);
    drawing = await engine.importExcalidraw(app, fileInfo(relative));
  } else if (notability) {
    drawing = await engine.importNotability(new Uint8Array(await fs.readFile(notability)), path.basename(notability));
  } else {
    const stdout = exportedPage ? await fs.readFile(exportedPage, "utf8") : (await promisify(execFile)(`${process.env.WINDIR}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoProfile", "-NonInteractive", "-STA", "-File", path.join(root, "src/onenote-bridge.ps1"), "-PageId", pageId],
      { windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 180000 })).stdout;
    drawing = engine.decodeOneNotePage(stdout.replace(/^\uFEFF/, ""), args.includes("--title") ? option("--title") : "OneNote page");
  }
  const target = `${folder}/${drawing.title.replace(/[\\/:*?"<>|]/g, "-")}.${kind}`;
  let replacement;
  if (args.includes("--replace")) {
    const existing = files.find((f) => f.path === target);
    if (existing) {
      const previous = await fs.readFile(absolute(target), "utf8");
      if (kind === "md" && !previous.includes("cssclasses: modern-draw-import") && !/-mdpage-[a-z0-9-]+-1\.png/.test(previous)) throw new Error("Replace requires a previous Modern Draw import.");
      replacement = { file: existing, original: previous };
    }
  }
  let ink;
  const store = {
    getDocument: async (name) => {
      ink = { version: 1, sourcePath: name, updatedAt: new Date().toISOString(), strokes: [] };
      return { setCanvasLayout: (layout) => { ink.canvasLayout = layout; }, commitState: (strokes, images) => { ink.strokes = strokes; ink.floatingImages = images; } };
    },
    flushDocument: async () => {
      const inkPath = `${path.posix.dirname(ink.sourcePath)}/_ink/${path.posix.basename(ink.sourcePath)}.ink.json`;
      pending.set(inkPath, engine.encodeInk(ink));
    }
  };
  await engine.saveImportedDrawing(app, store, drawing, folder, kind, replacement, {
    factor: Number(option("--scale") ?? 100) / 100,
    matchNotability: !args.includes("--native-size"),
    reference
  });
  // Publish text before its ink so external-change handlers resolve new anchors against the new note.
  const priority = (name) => name.endsWith(".ink.json") ? 2 : name === output.path ? 1 : 0;
  const writes = [...pending].sort(([a], [b]) => priority(a) - priority(b));
  for (const [name, data] of writes) {
    const destination = absolute(name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const staged = destination + ".import-tmp";
    await fs.writeFile(staged, data);
    await fs.rename(staged, destination);
  }
  console.log(JSON.stringify({ file: output.path, strokes: ink.strokes.length, images: drawing.images.length,
    pdfRectangles: drawing.images.filter((i) => i.source?.includes("&rect=")).length,
    scale: reference ? engine.measureDrawingScale(ink.strokes, ink.floatingImages) : undefined,
    warnings: drawing.warnings }, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

function fileInfo(name) {
  const filename = path.posix.basename(name);
  return { path: name, name: filename, basename: filename.replace(/\.[^.]+$/, ""), extension: filename.split(".").pop() };
}
