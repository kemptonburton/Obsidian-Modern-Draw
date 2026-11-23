export type FloatingImagePointerMode = "direct" | "group" | "toggle";

export interface FloatingImagePointerState {
  isSelected: boolean;
  selectedImageCount: number;
  selectedStrokeCount: number;
  shiftKey: boolean;
}

/**
 * A single floating image must use its compositor-only drag handler. The
 * editor selection surface is reserved for explicit toggles and real groups.
 */
export function floatingImagePointerMode(state: FloatingImagePointerState): FloatingImagePointerMode {
  if (state.shiftKey) return "toggle";
  if (state.isSelected && (state.selectedImageCount > 1 || state.selectedStrokeCount > 0)) return "group";
  return "direct";
}
