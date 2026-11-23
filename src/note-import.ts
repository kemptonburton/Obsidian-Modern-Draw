import { type App, type TFile } from "obsidian";
import LZString from "lz-string";
import type { FloatingImagePlacement, InkStroke } from "./model";
import type { InkStore } from "./ink-store";
import { hashPath } from "./anchors";
import { scaleImportedDrawing, type ImportScaleOptions } from "./drawing-scale";


export interface ImportedImage {
  source?: string;
  dataURL?: string;
  x: number; y: number; width: number; height: number;
}

export interface ImportDrawing {
  sourceFormat?: "excalidraw" | "onenote" | "notability";
  images: ImportedImage[];
  title: string;
  width: number;
  height: number;
  strokes: InkStroke[];
  background: string;
  markdown: string;
  warnings: string[];
}

// Source elements vary between Excalidraw versions and installed plugins.
interface ExElement {
  id: string; type: string; x: number; y: number; width: number; height: number;
  angle?: number; isDeleted?: boolean; strokeColor?: string; backgroundColor?: string;
  strokeWidth?: number; opacity?: number; points?: number[][]; pressures?: number[];
  text?: string; fontSize?: number; fileId?: string; link?: string; scale?: number[];
  simulatePressure?: boolean;
  crop?: { x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number };
}

export function readExcalidraw(raw: string): { elements: ExElement[]; files?: Record<string, { dataURL: string }> } {
  const compressed = raw.match(/```compressed-json\s+([\s\S]*?)```/);
  const plain = raw.match(/```json\s+([\s\S]*?)```/);
  const json = compressed ? LZString.decompressFromBase64(compressed[1].replace(/\s/g, "")) : plain?.[1] ?? raw;
  if (!json) throw new Error("Could not decompress the Excalidraw drawing.");
  const scene = JSON.parse(json);
  if (!Array.isArray(scene.elements)) throw new Error("This file does not contain an Excalidraw scene.");
  return scene;
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export async function importExcalidraw(app: App, source: TFile): Promise<ImportDrawing> {
  const raw = await app.vault.read(source);
  const scene = readExcalidraw(raw);
  const elements = scene.elements.filter((e) => !e.isDeleted);
  if (!elements.length) throw new Error("The drawing is empty.");
  const minX = Math.min(...elements.map((e) => e.x)) - 20;
  const minY = Math.min(...elements.map((e) => e.y)) - 20;
  const width = Math.max(...elements.map((e) => e.x + e.width)) - minX + 20;
  const height = Math.max(...elements.map((e) => e.y + e.height)) - minY + 20;
  const strokes: InkStroke[] = [];
  const background: string[] = [];
  const images: ImportedImage[] = [];
  const warnings: string[] = [];
  const texts: string[] = [];
  for (const e of elements) {
    const x = e.x - minX, y = e.y - minY;
    if (e.type === "freedraw") {
      const angle = e.angle ?? 0;
      strokes.push({ id: e.id, tool: "pen", rendering: "excalidraw", simulatePressure: e.simulatePressure, color: e.strokeColor ?? "#000000", width: (e.strokeWidth ?? 1) * 4.25,
        opacity: (e.opacity ?? 100) / 100, horizontalOrigin: 0, anchor: { pos: 0, lineText: "" },
        points: (e.points ?? []).map(([px, py], i) => ({
          x: x + e.width / 2 + (px - e.width / 2) * Math.cos(angle) - (py - e.height / 2) * Math.sin(angle),
          y: y + e.height / 2 + (px - e.width / 2) * Math.sin(angle) + (py - e.height / 2) * Math.cos(angle),
          pressure: e.pressures?.[i] ?? 0.5
        })) });
      continue;
    }
    let body = "";
    if (e.type === "image") {
      const embedded = raw.match(new RegExp(`${e.fileId}: \\[\\[([^\\n]+?)\\]\\]`))?.[1];
      const link = e.link?.replace(/^\[\[|\]\]$/g, "") ?? embedded;
      const dataURL = scene.files?.[e.fileId ?? ""]?.dataURL;
      let imageSource: string | undefined;
      if (link) {
        const [path, subpath] = link.split("#");
        const linkedFile = app.metadataCache.getFirstLinkpathDest(path, source.path);
        if (!linkedFile) throw new Error(`Could not find attachment ${path}.`);
        imageSource = linkedFile.path + (subpath ? "#" + subpath : "");
      }
      if (!imageSource && !dataURL) throw new Error(`Missing image ${e.fileId}.`);
      images.push({ source: imageSource, dataURL: imageSource ? undefined : dataURL, x, y, width: e.width, height: e.height });
      if (e.angle || e.scale?.some((scale) => scale < 0)) warnings.push(`Image ${e.id} has rotation or mirroring that needs review.`);
      continue;
    } else if (e.type === "text") {
      texts.push(e.text ?? "");
      body = (e.text ?? "").split("\n").map((line, i) => `<text x="0" y="${(i + 1) * (e.fontSize ?? 20)}" font-size="${e.fontSize ?? 20}">${escapeXml(line)}</text>`).join("");
    } else if (e.type === "rectangle") body = `<rect width="${e.width}" height="${e.height}"/>`;
    else if (e.type === "ellipse") body = `<ellipse cx="${e.width / 2}" cy="${e.height / 2}" rx="${e.width / 2}" ry="${e.height / 2}"/>`;
    else if (e.type === "diamond") body = `<polygon points="${e.width / 2},0 ${e.width},${e.height / 2} ${e.width / 2},${e.height} 0,${e.height / 2}"/>`;
    else if (e.points) body = `<polyline fill="none" points="${e.points.map((p) => p.join(",")).join(" ")}"/>`;
    else warnings.push(`Unsupported Excalidraw element ${e.type} (${e.id}).`);
    background.push(`<g transform="translate(${x} ${y}) rotate(${(e.angle ?? 0) * 180 / Math.PI} ${e.width / 2} ${e.height / 2})" opacity="${(e.opacity ?? 100) / 100}" stroke="${escapeXml(e.strokeColor ?? "#000000")}" stroke-width="${e.strokeWidth ?? 1}" fill="${escapeXml(e.type === "text" ? e.strokeColor ?? "#000000" : e.backgroundColor ?? "none")}">${body}</g>`);
  }
  return { sourceFormat: "excalidraw", images, title: source.basename.replace(/\.excalidraw$/, ""), width, height, strokes, background: background.join(""), markdown: texts.join("\n\n"), warnings };
}

export async function ensureImportFolder(app: App, folder: string): Promise<void> {
  let path = "";
  for (const segment of folder.split("/").filter(Boolean)) {
    path = path ? `${path}/${segment}` : segment;
    if (!app.vault.getFolderByPath(path)) await app.vault.createFolder(path);
  }
}

export function safeImportName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+|[. ]+$/g, "").trim() || "Untitled";
}

export async function saveImportedDrawing(app: App, store: InkStore, drawing: ImportDrawing, folder: string, kind: "md" | "canvas", replace?: { file: TFile; original: string }, scaling: ImportScaleOptions = { factor: 1, matchNotability: true }): Promise<TFile> {
  drawing = scaleImportedDrawing(drawing, scaling);
  folder = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (folder.split("/").some((s) => s === "." || s === ".." || /[:*?"<>|]/.test(s))) throw new Error("Choose a vault-relative destination folder.");
  await ensureImportFolder(app, folder);
  const base = `${folder ? folder + "/" : ""}${safeImportName(drawing.title)}`;
  let path = replace?.file.path ?? `${base}.${kind}`, number = 2;
  while (!replace && app.vault.getAbstractFileByPath(path)) path = `${base} (${number++}).${kind}`;
  const images = [...drawing.images];
  if (drawing.background) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.width}" height="${drawing.height}">${drawing.background}</svg>`;
    images.push({ dataURL: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg))), x: 0, y: 0, width: drawing.width, height: drawing.height });
  }
  const links: string[] = [];
  const placements: FloatingImagePlacement[] = [];
  const nodes: object[] = [];
  for (const image of images) {
    let source = image.source;
    if (!source && image.dataURL) {
      const match = image.dataURL.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!match) throw new Error("Unsupported embedded image encoding.");
      const extension = match[1] === "svg+xml" ? "svg" : match[1].replace("jpeg", "jpg");
      const data = Uint8Array.from(atob(match[2].replace(/\s/g, "")), (c) => c.charCodeAt(0));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map((value) => value.toString(16).padStart(2, "0")).join("");
      const assetPath = `${folder ? folder + "/" : ""}_attachments/${safeImportName(drawing.title)}-${digest}.${extension}`;
      await ensureImportFolder(app, `${folder ? folder + "/" : ""}_attachments`);
      source = app.vault.getFileByPath(assetPath)?.path ?? (await app.vault.createBinary(assetPath, data.buffer)).path;
    }
    if (!source) continue;
    const occurrence = placements.filter((p) => p.source === source).length;
    links.push(`![[${source}|${Math.round(image.width)}]]`);
    placements.push({ id: `import-image-${hashPath(source)}-${occurrence}`, source, occurrence, anchor: { pos: 0, lineText: "" }, x: image.x, y: image.y, width: image.width });
    const [file, subpath] = source.split("#");
    nodes.push({ id: crypto.randomUUID(), type: "file", file, subpath: subpath ? "#" + subpath : undefined, x: image.x, y: image.y, width: image.width, height: image.height });
  }
  const originalProperties = replace?.original.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const properties = originalProperties === undefined ? "cssclasses: modern-draw-import" : originalProperties
    .replace(/^excalidraw-plugin:.*(?:\r?\n|$)/gm, "")
    .replace(/^modern-draw-import:.*(?:\r?\n|$)/gm, "").trim();
  const header = `---\n${properties ? properties + "\n" : ""}modern-draw-import: true\n---\n\n`;
  const line = links.join("") || "%% Modern Draw drawing %%";
  const anchor = { pos: header.length, lineText: line };
  const content = kind === "md" ? `${header}${line}\n${"\n".repeat(Math.ceil(drawing.height / 24))}${drawing.markdown}\n` : JSON.stringify({ nodes: [...nodes, ...(drawing.markdown.trim() ? [{ id: crypto.randomUUID(), type: "text", text: drawing.markdown, x: 0, y: drawing.height + 40, width: drawing.width, height: 400 }] : [])], edges: [] });
  const file = replace?.file ?? await app.vault.create(path, content);
  if (replace) await app.vault.process(file, (current) => {
    if (current !== replace.original) throw new Error("The Excalidraw note changed during conversion. Run conversion again.");
    return content;
  });
  const ink = await store.getDocument(file.path);
  ink.setCanvasLayout("left");
  ink.commitState(drawing.strokes.map((s) => ({ ...s, anchor: kind === "md" ? anchor : { pos: 0, lineText: "" }, page: undefined })), kind === "md" ? placements.map((p) => ({ ...p, anchor })) : []);
  await store.flushDocument(file.path);
  return file;
}

export async function convertExcalidrawNote(app: App, store: InkStore, source: TFile, scaling?: ImportScaleOptions): Promise<TFile> {
  const original = await app.vault.read(source);
  const drawing = await importExcalidraw(app, source);
  if (await app.vault.read(source) !== original) throw new Error("The Excalidraw note changed during conversion. Run conversion again.");
  if (drawing.warnings.length) throw new Error(`Conversion needs review. ${drawing.warnings.join(" ")}`);
  const folder = source.parent?.path === "/" ? "" : source.path.split("/").slice(0, -1).join("/");
  const backups = `${folder ? folder + "/" : ""}_attachments`;
  await ensureImportFolder(app, backups);
  const backup = `${backups}/${source.name}-${crypto.randomUUID()}.excalidraw-backup`;
  await app.vault.create(backup, original);
  try {
    const result = await saveImportedDrawing(app, store, drawing, folder, "md", source.extension === "md" ? { file: source, original } : undefined, scaling);
    if (source.extension !== "md") await app.vault.trash(source, true);
    return result;
  } catch (error) {
    throw new Error(`Conversion could not finish. The original drawing is backed up at ${backup}. ${String(error)}`);
  }
}
