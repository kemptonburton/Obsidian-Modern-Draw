export interface HorizontalSpaceItem {
  id: string;
  kind: "stroke" | "image" | "region";
  left: number;
  right: number;
}

/** Move whole items on the right and keep them inside the scrollable note. */
export function planHorizontalSpace(items: readonly HorizontalSpaceItem[], divider: number, leftLimit: number) {
  const moving: HorizontalSpaceItem[] = [];
  let firstLeft = Infinity;
  for (const item of items) {
    if (item.left >= divider) {
      moving.push(item);
      firstLeft = Math.min(firstLeft, item.left);
    }
  }
  return { moving, minDelta: moving.length ? Math.min(0, leftLimit - firstLeft) : 0 };
}
