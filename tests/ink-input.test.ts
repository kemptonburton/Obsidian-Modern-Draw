import assert from "node:assert/strict";
import test from "node:test";
import { guardDrawingTouches, isPalmPointer, type PinchGesture } from "../src/ink-input";
import { DEFAULT_SETTINGS } from "../src/model";

const viewport = {
  getBoundingClientRect: () => ({ left: 20, top: 100, right: 320, bottom: 500, height: 400 })
} as HTMLElement;
const settings = { ...DEFAULT_SETTINGS, writingHand: "left" } as const;

test("the palm rest rejects finger input and permits the stylus at the same point", () => {
  const atBottom = { clientX: 100, clientY: 480 };
  for (const pointerType of ["touch", "pen", "mouse"]) {
    assert.equal(isPalmPointer({ ...atBottom, pointerType } as PointerEvent, viewport, settings), pointerType === "touch");
  }
});

test("palm contacts stay blocked after leaving the rest while fingers above it can scroll", () => {
  const host = new EventTarget() as HTMLElement;
  const detach = guardDrawingTouches(host, viewport, () => settings, () => false, () => false);
  assert.equal(touch(host, "touchstart", 1, 480), false);
  assert.equal(touch(host, "touchmove", 1, 300), false);
  assert.equal(touch(host, "touchstart", 2, 300), true);
  assert.equal(touch(host, "touchmove", 2, 480), true);
  touch(host, "touchcancel", 1, 300);
  assert.equal(touch(host, "touchstart", 1, 300), true);
  detach();
  assert.equal(touch(host, "touchstart", 3, 480), true);
});

test("an active ink gesture prevents native scrolling and leaves controls available", () => {
  const host = new EventTarget() as HTMLElement;
  let drawing = false;
  let control = false;
  const detach = guardDrawingTouches(host, viewport, () => DEFAULT_SETTINGS, () => drawing, () => control);
  assert.equal(touch(host, "touchstart", 1, 480), true);
  drawing = true;
  assert.equal(touch(host, "touchmove", 1, 300), false);
  control = true;
  assert.equal(touch(host, "touchstart", 2, 480), true);
  detach();
});

test("pinch uses two contacts above the palm rest and suppresses pan until they lift", () => {
  const host = new EventTarget() as HTMLElement;
  const gestures: PinchGesture[] = [];
  const detach = guardDrawingTouches(host, viewport, () => settings, () => false, () => false,
    (gesture) => gestures.push(gesture));
  const first = { identifier: 1, clientX: 80, clientY: 200 };
  const second = { identifier: 2, clientX: 120, clientY: 200 };
  const palm = { identifier: 3, clientX: 90, clientY: 480 };
  assert.equal(dispatchTouch(host, "touchstart", [first]), true);
  assert.equal(dispatchTouch(host, "touchstart", [palm], [first, palm]), false);
  assert.deepEqual(gestures, []);
  assert.equal(dispatchTouch(host, "touchstart", [second], [first, second, palm]), false);
  const spread = { ...second, clientX: 160 };
  assert.equal(dispatchTouch(host, "touchmove", [spread], [first, spread, palm]), false);
  assert.deepEqual(gestures, [{ clientX: 120, clientY: 200, deltaX: 20, deltaY: 0, scale: 2 }]);
  dispatchTouch(host, "touchend", [spread], [first, palm]);
  assert.equal(dispatchTouch(host, "touchmove", [first], [first, palm]), false);
  dispatchTouch(host, "touchend", [first], [palm]);
  assert.equal(dispatchTouch(host, "touchstart", [first], [first, palm]), true);
  detach();
});

function touch(host: HTMLElement, type: string, identifier: number, clientY: number): boolean {
  return dispatchTouch(host, type, [{ identifier, clientX: 100, clientY }]);
}

type Contact = Pick<Touch, "identifier" | "clientX" | "clientY">;

function dispatchTouch(host: HTMLElement, type: string, changedTouches: Contact[], touches = changedTouches): boolean {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { changedTouches, touches });
  return host.dispatchEvent(event);
}
