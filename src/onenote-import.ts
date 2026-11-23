import { Platform, htmlToMarkdown } from "obsidian";
import bridge from "./onenote-bridge.ps1";
import { safeImportName, type ImportedImage, type ImportDrawing } from "./note-import";
import type { InkStroke } from "./model";

export interface OneNoteEntry { id: string; name: string; path: string; kind: string; }

export async function readOneNote(pageId = ""): Promise<string> {
  if (!Platform.isDesktopApp || process.platform !== "win32") throw new Error("Live OneNote import requires OneNote desktop on Windows.");
  const { execFile } = require("child_process") as typeof import("child_process");
  const script = bridge.replace("param([string]$PageId = '')", `$PageId = '${pageId.replace(/'/g, "''")}'`);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(`${process.env.WINDIR ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
      { windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 180000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message)); else resolve(stdout.replace(/^\uFEFF/, ""));
      });
  });
}

export function oneNoteEntries(xml: string): OneNoteEntry[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("OneNote returned invalid notebook data.");
  const entries: OneNoteEntry[] = [];
  const walk = (element: Element, parents: string[]): void => {
    const name = element.getAttribute("name");
    const path = name ? [...parents, safeImportName(name)] : parents;
    if (name && element.getAttribute("ID")) entries.push({ id: element.getAttribute("ID")!, name, path: path.join("/"), kind: element.localName });
    for (const child of element.children) walk(child, path);
  };
  walk(doc.documentElement, []);
  return entries;
}

export function decodeOneNotePage(raw: string, title: string): ImportDrawing {
  const { xml, strokes: originalStrokes } = JSON.parse(raw) as { xml: string; strokes: InkStroke[] };
  const strokes: InkStroke[] = originalStrokes.map((stroke) => ({ ...stroke, rendering: "onenote" }));
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const images: ImportedImage[] = [];
  const markdown: string[] = [];
  const warnings: string[] = [];
  let width = 760, height = 400;
  for (const stroke of strokes) for (const point of stroke.points) {
    width = Math.max(width, point.x + stroke.width + 20);
    height = Math.max(height, point.y + stroke.width + 20);
  }
  const nodes = Array.from(doc.getElementsByTagNameNS("*", "Image"));
  for (const node of nodes) {
    const position = node.getElementsByTagNameNS("*", "Position")[0];
    const size = node.getElementsByTagNameNS("*", "Size")[0];
    const data = node.getElementsByTagNameNS("*", "Data")[0]?.textContent;
    if (!size || !data) { warnings.push("An image has no exported data."); continue; }
    let parent = node.parentElement;
    while (parent && parent.localName !== "Outline") parent = parent.parentElement;
    const parentPosition = parent?.getElementsByTagNameNS("*", "Position")[0];
    const x = Number((position ?? parentPosition)?.getAttribute("x") ?? 0) * 4 / 3;
    const y = Number((position ?? parentPosition)?.getAttribute("y") ?? 0) * 4 / 3;
    const w = Number(size.getAttribute("width")) * 4 / 3, h = Number(size.getAttribute("height")) * 4 / 3;
    const format = data.trim().startsWith("/9j/") ? "jpeg" : node.getAttribute("format") || "png";
    images.push({ dataURL: `data:image/${format};base64,${data.trim()}`, x, y, width: w, height: h });
    width = Math.max(width, x + w + 20); height = Math.max(height, y + h + 20);
  }
  for (const outline of Array.from(doc.getElementsByTagNameNS("*", "Outline"))) {
    const text = Array.from(outline.getElementsByTagNameNS("*", "T")).map((t) => htmlToMarkdown(t.textContent ?? "")).join("\n\n");
    if (text.trim()) markdown.push(text);
  }
  if (doc.getElementsByTagNameNS("*", "InsertedFile").length) warnings.push("File attachments require a separate export from OneNote.");
  return { sourceFormat: "onenote", title, images, strokes, width, height, background: "", markdown: markdown.join("\n\n"), warnings };
}
