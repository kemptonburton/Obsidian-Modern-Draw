import assert from "node:assert/strict";
import test from "node:test";
import { floatingImagePointerMode } from "../src/selection-gesture";

test("a single floating image uses the compositor-only direct drag path", () => {
  assert.equal(floatingImagePointerMode({
    isSelected: false,
    selectedImageCount: 0,
    selectedStrokeCount: 0,
    shiftKey: false
  }), "direct");
  assert.equal(floatingImagePointerMode({
    isSelected: true,
    selectedImageCount: 1,
    selectedStrokeCount: 0,
    shiftKey: false
  }), "direct");
});

test("only an existing multi-selection uses the group drag path", () => {
  assert.equal(floatingImagePointerMode({
    isSelected: true,
    selectedImageCount: 2,
    selectedStrokeCount: 0,
    shiftKey: false
  }), "group");
  assert.equal(floatingImagePointerMode({
    isSelected: true,
    selectedImageCount: 1,
    selectedStrokeCount: 1,
    shiftKey: false
  }), "group");
});

test("shift-click remains a selection toggle rather than starting a drag", () => {
  assert.equal(floatingImagePointerMode({
    isSelected: true,
    selectedImageCount: 1,
    selectedStrokeCount: 0,
    shiftKey: true
  }), "toggle");
});
