import assert from "node:assert/strict";
import test from "node:test";
import { InkDoubleTap } from "../src/ink-double-tap";

function gesture() {
  let id = 0;
  const timers = new Map<number, () => void>();
  const tap = new InkDoubleTap({
    setTimeout: (callback: () => void) => {
      timers.set(++id, callback);
      return id;
    },
    clearTimeout: (timer) => { if (timer !== undefined) timers.delete(timer); }
  });
  return { tap, expire: () => { for (const callback of timers.values()) callback(); } };
}

function pointer(type: string, timeStamp: number, clientX = 50, pointerId = 1, pointerType = "pen") {
  return { type, pointerId, pointerType, timeStamp, clientX, clientY: 100, isPrimary: true, button: 0, buttons: 0 };
}

test("single dots commit after the tap interval and a double tap discards both actions", () => {
  const { tap, expire } = gesture();
  let dots = 0;
  const dot = () => { dots++; };
  tap.begin(pointer("pointerdown", 0));
  tap.commit(tap.finish(pointer("pointerup", 35)), dot);
  assert.equal(dots, 0);
  expire();
  assert.equal(dots, 1);

  tap.begin(pointer("pointerdown", 600));
  tap.commit(tap.finish(pointer("pointerup", 635)), dot);
  tap.begin(pointer("pointerdown", 720, 53, 2));
  const second = tap.finish(pointer("pointerup", 755, 54, 2));
  assert.equal(second, "double");
  tap.commit(second, dot);
  expire();
  assert.equal(dots, 1);
});

test("a real stroke settles a previous tap and commits without delay", () => {
  const { tap } = gesture();
  const operations: string[] = [];
  tap.begin(pointer("pointerdown", 0));
  tap.commit(tap.finish(pointer("pointerup", 45)), () => operations.push("dot"));
  tap.begin(pointer("pointerdown", 90));
  assert.equal(tap.move(pointer("pointermove", 120, 70)), true);
  assert.deepEqual(operations, ["dot"]);
  tap.commit(tap.finish(pointer("pointerup", 150, 94)), () => operations.push("stroke"));
  assert.deepEqual(operations, ["dot", "stroke"]);
});

test("distant taps, mouse clicks and overlapping touches do not switch tools", () => {
  const { tap } = gesture();
  tap.begin(pointer("pointerdown", 0));
  assert.equal(tap.finish(pointer("pointerup", 35)), "single");
  tap.begin(pointer("pointerdown", 110, 110));
  assert.equal(tap.finish(pointer("pointerup", 150, 112)), "single");
  tap.begin(pointer("pointerdown", 175, 112, 1, "mouse"));
  assert.equal(tap.finish(pointer("pointerup", 195, 113, 1, "mouse")), "none");
  tap.begin(pointer("pointerdown", 220, 112, 1, "touch"));
  tap.begin({ ...pointer("pointerdown", 250, 112, 2, "touch"), isPrimary: false });
  assert.equal(tap.finish(pointer("pointerup", 270, 112, 1, "touch")), "none");
});

test("the eraser returns to the last pen or highlighter", () => {
  const { tap } = gesture();
  assert.equal(tap.switchFrom("eraser"), "pen");
  tap.remember("highlighter");
  assert.equal(tap.switchFrom("highlighter"), "eraser");
  tap.remember("select");
  assert.equal(tap.switchFrom("eraser"), "highlighter");
});
