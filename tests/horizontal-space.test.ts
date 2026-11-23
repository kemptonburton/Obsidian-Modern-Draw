import assert from "node:assert/strict";
import test from "node:test";
import { planHorizontalSpace } from "../src/horizontal-space";
import { clampNoteZoom, stepNoteZoom } from "../src/model";

test("horizontal space moves whole items on the right even when other ink extends past the divider", () => {
  const items = [
    { id: "left", kind: "stroke", left: 10, right: 40 },
    { id: "crossing", kind: "stroke", left: 48, right: 140 },
    { id: "right", kind: "stroke", left: 80, right: 100 },
    { id: "image", kind: "image", left: 115, right: 155 }
  ] as const;
  const plan = planHorizontalSpace(items, 60, 0);
  assert.deepEqual(plan.moving.map(({ id }) => id), ["right", "image"]);
  assert.equal(plan.minDelta, -80);
});

test("horizontal space uses the scroll origin as the left limit", () => {
  const stroke = { id: "stroke", kind: "stroke", left: -8, right: 18 } as const;
  const region = { id: "region", kind: "region", left: 15, right: 30 } as const;
  assert.equal(planHorizontalSpace([stroke, region], 10, -10).minDelta, -25);
  assert.equal(planHorizontalSpace([region], 10, -10).minDelta, -25);
  assert.deepEqual(planHorizontalSpace([region], 40, -10), { moving: [], minDelta: 0 });
});

test("note zoom takes finer steps below half scale and stops at ten percent", () => {
  assert.equal(stepNoteZoom(0.6, -1), 0.5);
  assert.equal(stepNoteZoom(0.5, -1), 0.45);
  assert.equal(stepNoteZoom(0.45, 1), 0.5);
  assert.equal(stepNoteZoom(0.15, -1), 0.1);
  assert.equal(stepNoteZoom(0.1, -1), 0.1);
  assert.equal(stepNoteZoom(2.5, 1), 2.5);
  assert.equal(clampNoteZoom(NaN), 1);
});
