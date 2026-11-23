import type { StrokeAnchor } from "./model";

export interface TextLine {
  from: number;
  to: number;
  text: string;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function lineAt(documentText: string, position: number): TextLine {
  const safePosition = clamp(position, 0, documentText.length);
  const previousBreak = safePosition === 0 ? -1 : documentText.lastIndexOf("\n", safePosition - 1);
  const nextBreak = documentText.indexOf("\n", safePosition);
  const from = previousBreak < 0 ? 0 : previousBreak + 1;
  const to = nextBreak < 0 ? documentText.length : nextBreak;
  return { from, to, text: documentText.slice(from, to) };
}

/**
 * Resolve a persisted anchor against the current note. Numeric positions handle
 * normal CodeMirror edits; the line fingerprint repairs anchors after changes
 * made while the note was closed or by an external editor.
 */
export function resolveAnchor(documentText: string, anchor: StrokeAnchor): StrokeAnchor {
  const currentLine = lineAt(documentText, anchor.pos);
  if (normalizeLine(currentLine.text) === normalizeLine(anchor.lineText)) {
    return { pos: currentLine.from, lineText: currentLine.text };
  }

  const fingerprint = normalizeLine(anchor.lineText);
  if (fingerprint.length > 0) {
    let bestMatch: TextLine | null = null;
    let cursor = 0;
    for (const text of documentText.split("\n")) {
      const candidate = { from: cursor, to: cursor + text.length, text };
      if (
        normalizeLine(text) === fingerprint &&
        (bestMatch === null || Math.abs(candidate.from - anchor.pos) < Math.abs(bestMatch.from - anchor.pos))
      ) {
        bestMatch = candidate;
      }
      cursor += text.length + 1;
    }
    if (bestMatch !== null) {
      return { pos: bestMatch.from, lineText: bestMatch.text };
    }
  }

  return { pos: currentLine.from, lineText: currentLine.text || anchor.lineText };
}

export function normalizeLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

/** Stable, filesystem-safe 64-bit-style hash made from two 32-bit accumulators. */
export function hashPath(path: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
