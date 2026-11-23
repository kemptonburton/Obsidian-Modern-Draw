import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneFloatingImages,
  cloneStrokes,
  cloneVerticalSpaces,
  type FloatingImagePlacement,
  type InkStroke,
  type VerticalSpace
} from "../src/model";

test("floating image placement clones keep anchors isolated", () => {
  const placement: FloatingImagePlacement = {
    id: "image-1",
    source: "attachment.png",
    occurrence: 0,
    anchor: { pos: 12, lineText: "![[attachment.png]]" },
    x: 320,
    y: 48,
    width: 900
  };
  const cloned = cloneFloatingImages([placement]);
  cloned[0].anchor.pos = 24;
  assert.equal(placement.anchor.pos, 12);
  assert.equal(cloned[0].width, 900);
});

test("stroke clones retain vector point data", () => {
  const stroke: InkStroke = {
    id: "stroke-1",
    tool: "pen",
    color: "#ffffff",
    width: 3,
    opacity: 1,
    anchor: { pos: 0, lineText: "" },
    points: [{ x: 1, y: 2, pressure: 0.5 }]
  };
  const cloned = cloneStrokes([stroke]);
  cloned[0].points[0].x = 99;
  assert.equal(stroke.points[0].x, 1);
});

test("vertical space clones keep persistent pixel heights and isolated anchors", () => {
  const space: VerticalSpace = {
    id: "space-1",
    anchor: { pos: 8, lineText: "Below the gap" },
    height: 137.5
  };
  const cloned = cloneVerticalSpaces([space]);
  cloned[0].anchor.pos = 20;
  cloned[0].height = 50;
  assert.equal(space.anchor.pos, 8);
  assert.equal(space.height, 137.5);
});
