import { EditorSelection, findClusterBreak, type SelectionRange, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { lassoIntersectsRectangle, pointInRectangle, type ScreenPoint } from "./geometry";

export function lassoTextRanges(view: EditorView, path: readonly ScreenPoint[], viewport: DOMRect): SelectionRange[] {
  if (path.length < 3) return [];
  const polygon = path.map(({ x, y }) => ({ x: x + viewport.left, y: y + viewport.top }));
  const left = Math.min(...polygon.map(({ x }) => x));
  const right = Math.max(...polygon.map(({ x }) => x));
  const top = Math.min(...polygon.map(({ y }) => y));
  const bottom = Math.max(...polygon.map(({ y }) => y));
  if (right - left < 2 || bottom - top < 2) return [];
  const from = view.lineBlockAtHeight(top - view.documentTop).from;
  const to = view.lineBlockAtHeight(bottom - view.documentTop).to;
  const ranges: SelectionRange[] = [];
  const doc = view.state.doc;
  for (const visible of view.visibleRanges) {
    const end = Math.min(to, visible.to);
    for (let position = Math.max(from, visible.from); position < end;) {
      const line = doc.lineAt(position);
      const lineEnd = Math.min(line.to, end);
      let selectedStart: number | undefined;
      while (position < lineEnd) {
        const next = Math.min(lineEnd, line.from + findClusterBreak(line.text, position - line.from));
        const rect = view.coordsForChar(position);
        const selected = rect && rect.right > rect.left && rect.bottom > rect.top
          && rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom
          && lassoIntersectsRectangle(polygon, rect);
        if (selected) selectedStart ??= position;
        else if (selectedStart !== undefined) {
          ranges.push(EditorSelection.range(selectedStart, position));
          selectedStart = undefined;
        }
        position = next;
      }
      if (selectedStart !== undefined) ranges.push(EditorSelection.range(selectedStart, position));
      position = line.to + 1;
    }
  }
  return ranges;
}

export function pointerHitsSelectedText(view: EditorView, point: ScreenPoint): boolean {
  const position = view.posAtCoords(point);
  if (position === null) return false;
  // The nearest caret can be on either side of the character under the pointer.
  return [position - 1, position].some((character) => {
    if (!view.state.selection.ranges.some((range) => character >= range.from && character < range.to)) return false;
    const bounds = view.coordsForChar(character);
    return bounds && pointInRectangle(point, bounds);
  });
}

export function lassoTextDrop(state: EditorState, position: number): TransactionSpec | undefined {
  if (state.readOnly) return;
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  if (ranges.length === 0 || ranges.some(({ from, to }) => position >= from && position <= to)) return;
  const text = ranges.map(({ from, to }) => state.sliceDoc(from, to)).join(state.lineBreak);
  const changes = state.changes([...ranges.map(({ from, to }) => ({ from, to })), { from: position, insert: text }]);
  return {
    changes,
    selection: { anchor: changes.mapPos(position, -1), head: changes.mapPos(position, 1) },
    userEvent: "move.drop"
  };
}
