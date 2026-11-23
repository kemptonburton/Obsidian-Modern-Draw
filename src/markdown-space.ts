import type { Text } from "@codemirror/state";

export interface MarkdownRemovalRange {
  from: number;
  to: number;
}

export interface TrailingInkSpace {
  bottom: number;
  padding: number;
  lines: number;
}

/** Reserve space past the last line only when there is no usable line below the ink. */
export function trailingInkSpace(bottom: number, lastLineHeight: number, lineHeight: number, lastLineBlank: boolean): TrailingInkSpace | undefined {
  if (!Number.isFinite(bottom) || bottom <= (lastLineBlank ? 0 : lastLineHeight)) return;
  const extra = Math.max(0, bottom + lineHeight / 3 - lastLineHeight);
  return { bottom, padding: Math.ceil(extra), lines: 1 + Math.ceil(extra / lineHeight) };
}

/** Lines that an existing anchor moves when a space gesture is committed. */
export function spaceAnchorLineDelta(
  doc: Text, anchor: number, boundary: number, lineDelta: number, removal: MarkdownRemovalRange | null
): number {
  if (anchor >= boundary) return lineDelta;
  if (!removal || anchor < removal.from) return 0;
  return doc.lineAt(removal.from).number - doc.lineAt(anchor).number;
}

/** Resolve a space gesture to the Markdown boundary immediately before content. */
export function markdownSpaceBoundary(doc: Text, position: number): number {
  let line = doc.lineAt(Math.max(0, Math.min(doc.length, position)));
  while (line.text.trim().length === 0 && line.number < doc.lines) {
    line = doc.line(line.number + 1);
  }
  if (line.text.trim().length === 0 && line.number === doc.lines) return doc.length;

  // Never create blank lines before the first line. If the note begins with
  // frontmatter, keep the inserted lines outside of that block.
  if (line.from === 0) {
    if (line.text.trim() === "---") {
      for (let lineNumber = 2; lineNumber <= doc.lines; lineNumber += 1) {
        const candidate = doc.line(lineNumber);
        if (candidate.text.trim() === "---") {
          return candidate.to < doc.length ? candidate.to + 1 : doc.length;
        }
      }
    }
    return line.to < doc.length ? line.to + 1 : doc.length;
  }
  return line.from;
}

/** Count the contiguous editable blank Markdown lines immediately above a boundary. */
export function removableBlankLinesBefore(doc: Text, boundary: number): number {
  if (boundary <= 0) return 0;
  const line = doc.lineAt(Math.min(boundary, doc.length));
  let lineNumber = line.from === boundary ? line.number - 1 : line.number;
  let count = 0;
  while (lineNumber >= 1 && doc.line(lineNumber).text.trim().length === 0) {
    count += 1;
    lineNumber -= 1;
  }
  return count;
}

/** Return the exact text range for removing blank lines without touching content. */
export function blankLineRemovalRange(
  doc: Text,
  boundary: number,
  requestedCount: number
): MarkdownRemovalRange | null {
  if (boundary <= 0 || requestedCount <= 0) return null;
  const line = doc.lineAt(Math.min(boundary, doc.length));
  let lineNumber = line.from === boundary ? line.number - 1 : line.number;
  let from = boundary;
  let removed = 0;
  while (lineNumber >= 1 && removed < requestedCount) {
    const candidate = doc.line(lineNumber);
    if (candidate.text.trim().length > 0) break;
    from = candidate.from;
    removed += 1;
    lineNumber -= 1;
  }
  return removed > 0 ? { from, to: boundary } : null;
}
