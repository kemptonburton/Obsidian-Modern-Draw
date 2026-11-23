import type { DrawingTool, InkTool } from "./model";

const TAP_INTERVAL_MS = 320;
const TAP_DURATION_MS = 235;
const TAP_MOVEMENT_PX = 8;
const TAP_SEPARATION_PX = 28;

type TapEvent = Pick<PointerEvent, "pointerId" | "pointerType" | "isPrimary" | "button" | "buttons"
  | "clientX" | "clientY" | "timeStamp" | "type">;
type TapResult = "none" | "single" | "double";

interface PendingTap {
  point: TapEvent;
  timer: number;
  commit?: () => void;
}

/** A first tap may be a dot or eraser stroke. Commit it once a second tap cannot claim it. */
export class InkDoubleTap {
  private press: TapEvent | null = null;
  private pending: PendingTap | null = null;
  private lastInkTool: InkTool = "pen";

  constructor(private readonly timers: Pick<Window, "setTimeout" | "clearTimeout">) {}

  get tracking(): boolean {
    return this.press !== null;
  }

  remember(tool: DrawingTool): void {
    if (tool === "pen" || tool === "highlighter") this.lastInkTool = tool;
  }

  switchFrom(tool: DrawingTool): DrawingTool {
    return tool === "eraser" ? this.lastInkTool : "eraser";
  }

  begin(event: TapEvent): void {
    if (!event.isPrimary || (event.pointerType !== "touch" && event.pointerType !== "pen")
      || event.button !== 0 || (event.buttons & 32) !== 0 || this.press) {
      this.reset();
      return;
    }
    if (this.pending && !matchesTap(this.pending.point, event)) this.flush();
    this.press = event;
  }

  move(event: TapEvent): boolean {
    if (!this.press || event.pointerId !== this.press.pointerId || distance(this.press, event) <= TAP_MOVEMENT_PX) {
      return false;
    }
    this.reset();
    return true;
  }

  finish(event: TapEvent): TapResult {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return "none";
    this.press = null;
    if (event.type !== "pointerup" || event.timeStamp - press.timeStamp > TAP_DURATION_MS
      || distance(press, event) > TAP_MOVEMENT_PX) {
      this.flush();
      return "none";
    }
    if (this.pending && matchesTap(this.pending.point, event)) {
      this.timers.clearTimeout(this.pending.timer);
      this.pending = null;
      return "double";
    }
    this.flush();
    this.pending = { point: event, timer: this.timers.setTimeout(() => this.flush(), TAP_INTERVAL_MS) };
    return "single";
  }

  commit(result: TapResult, action: () => void): void {
    if (result === "none") action();
    else if (result === "single" && this.pending) this.pending.commit = action;
  }

  reset(): void {
    this.press = null;
    this.flush();
  }

  private flush(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.timers.clearTimeout(pending.timer);
    pending.commit?.();
  }
}

function matchesTap(first: TapEvent, second: TapEvent): boolean {
  return first.pointerType === second.pointerType && second.timeStamp - first.timeStamp <= TAP_INTERVAL_MS
    && distance(first, second) <= TAP_SEPARATION_PX;
}

function distance(first: TapEvent, second: TapEvent): number {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}
