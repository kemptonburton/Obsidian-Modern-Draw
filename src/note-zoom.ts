import type { EditorView } from "@codemirror/view";

/** Keep line anchors in note units while CodeMirror's measurements catch up with the new scale. */
export function noteLineOffset(view: EditorView, position: number): number {
  return (view.documentPadding.top + view.lineBlockAt(position).top) / view.scaleY;
}
