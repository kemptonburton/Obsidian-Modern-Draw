import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { importNotability, notabilityImage, notabilityPath, notabilityStrokes } from "../src/notability-import";
import { readBinaryPlist } from "../src/binary-plist";
import { inkDisplayColor } from "../src/ink-renderer";

// A synthetic keyed archive with one two-point stroke, encoded as an Apple binary plist.
const session = Uint8Array.from(Buffer.from("YnBsaXN0MDDSAQIDHlgkb2JqZWN0c1QkdG9wpAQFDBFVJG51bGzTBgcICQoLVG5hbWVYcmljaFRleHRfEBRzZXNzaW9uRm9ybWF0VmVyc2lvblZTYW1wbGWAAhAJ0Q0OXxATSGFuZHdyaXRpbmcgT3ZlcmxhedEPEFtTcGF0aWFsSGFzaIAD1hITFBUWFxgZGhscHVxjdXJ2ZXNjb2xvcnNfEA9jdXJ2ZXNudW1wb2ludHNcY3VydmVzcG9pbnRzXGN1cnZlc3N0eWxlc1tjdXJ2ZXN3aWR0aFludW1jdXJ2ZXNEAAAA/0QCAAAATxAQAAAgQQAAoEEAAPBBAAAgQkEDRAAAQEAQAdEfIFIkMIABAAgADQAWABsAIAAmAC0AMgA7AFIAWQBbAF0AYAB2AHkAhQCHAJQAoQCzAMAAzQDZAOMA6ADtAQABAgEHAQkBDAEPAAAAAAAAAgEAAAAAAAAAIQAAAAAAAAAAAAAAAAAAARE=", "base64"));

test("Notability nested image references preserve the document origin, size, and crop", () => {
  const data = new Uint8Array(24), view = new DataView(data.buffer);
  view.setUint32(0, 0x89504e47); view.setUint32(16, 400); view.setUint32(20, 600);
  const figure = { FigureBackgroundObjectKey: { kImageObjectSnapshotKey: { relativePath: "Images/photo.png" } }, FigureCropRectKey: "{{0, 100}, {400, 200}}" };
  const image = notabilityImage({ figure, documentContentOrigin: "{35, 3047}", unscaledContentSize: "{200, 100}" }, { "Sample/Images/photo.png": data }, "Sample/");
  assert.deepEqual([image.x, image.y, image.width, image.height], [35, 3047, 200, 100]);
  assert.ok(image.dataURL?.startsWith("data:image/svg+xml;base64,"));
  assert.match(Buffer.from(image.dataURL!.split(",")[1], "base64").toString(), /viewBox="0 100 400 200"/);
  const original = notabilityImage({ figure: { ...figure, FigureCropRectKey: "{{0, 0}, {400, 600}}" }, documentOrigin: "{1, 2}", unscaledContentSize: "{200, 300}" }, { "Images/photo.png": data }, "");
  assert.ok(original.dataURL?.startsWith("data:image/png;base64,"));
});

test("Notability zip and keyed plist produce editable, theme-aware ink", async () => {
  const archive = zipSync({ "Sample/Session.plist": session });
  const drawing = await importNotability(archive, "backup.note");
  assert.equal(drawing.title, "Sample");
  assert.equal(drawing.strokes.length, 1);
  const stroke = drawing.strokes[0];
  assert.equal(stroke.rendering, "notability");
  assert.equal(stroke.width, 3);
  assert.deepEqual(stroke.points.map(({ x, y }) => [x, y]), [[10, 20], [30, 40]]);
  assert.equal(inkDisplayColor(stroke, true), "#ffffff");
  assert.equal(drawing.images.length, 0);
});

test("Notability vector paths preserve line endpoints and sample cubic shapes", () => {
  const bytes = new Uint8Array(8 + 3 + 5 * 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x48e5b325, true); view.setUint32(4, 3, true);
  bytes.set([0, 1, 3], 8);
  [0, 0, 10, 0, 10, 10, 20, 10, 20, 0].forEach((value, index) => view.setFloat64(11 + index * 8, value, true));
  const points = notabilityPath(bytes);
  assert.deepEqual(points[0], { x: 0, y: 0, pressure: 0.5 });
  assert.deepEqual(points[points.length - 1], { x: 20, y: 0, pressure: 0.5 });
  assert.ok(points.some((point) => point.y > 7));
});

test("invalid archives and truncated handwriting fail before a note is saved", async () => {
  assert.throws(() => readBinaryPlist(new Uint8Array(40)), /Unsupported/);
  await assert.rejects(importNotability(zipSync({ "other.txt": new Uint8Array() }), "other.note"), /Session.plist/);
  assert.throws(() => notabilityStrokes({ numcurves: 1, curvesnumpoints: new Uint8Array(4), curvespoints: new Uint8Array(8), curveswidth: new Uint8Array(4), curvescolors: new Uint8Array(4), curvesstyles: new Uint8Array([3]) }), /width/);
});
