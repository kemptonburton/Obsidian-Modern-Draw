import { lineAt, resolveAnchor } from "./anchors";
import { findImageSyntaxRanges } from "./image-syntax";
import type { StrokeAnchor } from "./model";

export type NotePdfPlacement = "cursor" | "end";

export interface PdfCursor {
  anchor: StrokeAnchor;
  column: number;
}

export function capturePdfCursor(text: string, position: number): PdfCursor {
  const line = lineAt(text, position);
  return { anchor: { pos: line.from, lineText: line.text }, column: position - line.from };
}

export function notePdfInsertion(text: string, links: readonly string[], cursor?: PdfCursor): { from: number; insert: string } {
  let from = text.length;
  if (cursor) {
    const anchor = resolveAnchor(text, cursor.anchor);
    const line = lineAt(text, anchor.pos);
    from = safeBlockPosition(text, Math.min(line.to, line.from + cursor.column));
  }
  const before = text.slice(0, from);
  const after = text.slice(from);
  const prefix = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return { from, insert: prefix + links.join("\n\n") + suffix };
}

function safeBlockPosition(text: string, position: number): number {
  // PDF pages are Markdown blocks. Keep frontmatter, fenced code, and existing image embeds intact.
  const frontmatter = /^---[ \t]*\n[\s\S]*?^---[ \t]*$/m.exec(text);
  const frontmatterEnd = frontmatter?.index === 0 ? frontmatter[0].length : 0;
  if (position < frontmatterEnd) return frontmatterEnd;

  let fence: { start: number; marker: string } | undefined;
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm)) {
    const start = match.index;
    if (start < frontmatterEnd) continue;
    const marker = match[1];
    if (!fence) {
      if (position <= start) break;
      fence = { start, marker };
    } else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !match[2].trim()) {
      const end = start + match[0].length;
      if (position < end) return end;
      fence = undefined;
    }
  }
  if (fence) return fence.start;

  const line = lineAt(text, position);
  const embed = findImageSyntaxRanges(line.text)
    .find(({ from, to }) => position > line.from + from && position < line.from + to);
  return embed ? line.to : position;
}
