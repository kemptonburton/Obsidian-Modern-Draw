import type { Line, SelectionRange, Text } from "@codemirror/state";

type TextRange = Pick<SelectionRange, "from" | "to">;

/** A line belongs to a text selection only when its text or blank line break is covered. */
export function textRangeCoversInkLine(doc: Text, position: number, range: TextRange): boolean {
  if (range.from === range.to) return false;
  const line = doc.lineAt(Math.min(doc.length, Math.max(0, position)));
  if (range.from > line.from || range.to < line.to) return false;
  return Boolean(line.text.length || range.to > line.from || line.from === doc.length);
}

/** The inclusive span of whole logical lines in a non-empty selection. */
export function fullySelectedLines(doc: Text, range: TextRange): { first: Line; last: Line } | undefined {
  if (range.from === range.to) return undefined;
  const start = doc.lineAt(range.from);
  const end = doc.lineAt(range.to);
  const first = start.number + (textRangeCoversInkLine(doc, start.from, range) ? 0 : 1);
  const last = end.number - (textRangeCoversInkLine(doc, end.from, range) ? 0 : 1);
  return first <= last ? { first: doc.line(first), last: doc.line(last) } : undefined;
}
