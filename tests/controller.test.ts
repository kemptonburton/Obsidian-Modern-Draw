import assert from "node:assert/strict";
import test from "node:test";
import { DrawingController, type ControllerChange } from "../src/controller";
import { DEFAULT_SETTINGS } from "../src/model";

test("tool changes identify their originating surface", () => {
  const controller = new DrawingController({ ...DEFAULT_SETTINGS });
  const source = {};
  const changes: ControllerChange[] = [];
  controller.subscribe((change) => changes.push(change));
  controller.setTool("pen", source);
  assert.deepEqual(changes, [{ kind: "tool", source }]);
});

test("command tool changes still emit when another pane already reported that tool", () => {
  const controller = new DrawingController({ ...DEFAULT_SETTINGS });
  const changes: ControllerChange[] = [];
  controller.setTool("pen", {});
  controller.subscribe((change) => changes.push(change));
  controller.setTool("pen");
  assert.deepEqual(changes, [{ kind: "tool", source: undefined }]);
});
