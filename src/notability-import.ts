import { unzipSync } from "fflate";
import { readBinaryPlist, unarchivePlist } from "./binary-plist";
import type { ImportDrawing, ImportedImage } from "./note-import";
import type { InkStroke } from "./model";

export async function importNotability(bytes: Uint8Array, filename: string): Promise<ImportDrawing> {
  const files = unzipSync(bytes);
  const sessionPath = Object.keys(files).find((name) => /(?:^|\/)Session\.plist$/.test(name));
  if (!sessionPath) throw new Error("This file does not contain a Notability Session.plist.");
  const prefix = sessionPath.slice(0, -"Session.plist".length);
  const session = unarchivePlist(readBinaryPlist(files[sessionPath]));
  if (![7, 8, 9].includes(session.sessionFormatVersion)) throw new Error(`Unsupported Notability session version ${session.sessionFormatVersion}.`);
  const richText = session.richText;
  const spatial = richText?.["Handwriting Overlay"]?.SpatialHash;
  const strokes = spatial ? notabilityStrokes(spatial) : [];
  const images: ImportedImage[] = [];
  const warnings: string[] = [];
  if (strokes.length) warnings.push("Pen-pressure variation is approximated with each stroke’s saved width.");
  if (spatial?.dashStyles instanceof Uint8Array && Object.keys(readBinaryPlist(spatial.dashStyles).objectPatterns ?? {}).length) warnings.push("Dashed strokes are imported as solid lines.");
  let width = Number(richText?.reflowState?.pageWidthInDocumentCoordsKey) || 574, height = 400;
  for (const stroke of strokes) for (const point of stroke.points) {
    width = Math.max(width, point.x + stroke.width + 20);
    height = Math.max(height, point.y + stroke.width + 20);
  }
  for (const media of Array.isArray(richText?.mediaObjects) ? richText.mediaObjects : []) {
    const image = notabilityImage(media, files, prefix);
    images.push(image);
    width = Math.max(width, image.x + image.width); height = Math.max(height, image.y + image.height);
  }
  const layouts = session.NBNoteTakingSessionDocumentPaperLayoutModelKey?.pageLayoutArray ?? richText?.pageLayoutArray ?? [];
  const pdfPages = (Array.isArray(layouts) ? layouts : []).filter((layout: any) => layout.kPageLayoutPDFFileNameKey || layout.kPageLayoutPDFFileKey);
  if (pdfPages.length) throw new Error("This Notability note contains PDF backgrounds. PDF background import is not supported yet.");
  const backing = richText?.NBAttributedBackingString?.NBAttributedBackingStringCodingKey;
  const encodedText = backing?.stringKey?.["NS.bytes"];
  const markdown = typeof backing?.stringKey === "string" ? backing.stringKey : encodedText instanceof Uint8Array ? new TextDecoder().decode(encodedText) : "";
  if (Object.keys(files).some((name) => /\/Recordings\/.+\.(m4a|caf|wav)$/i.test(name))) warnings.push("Audio recordings were omitted.");
  return { sourceFormat: "notability", title: typeof session.name === "string" ? session.name : filename.replace(/\.note$/i, ""), width, height, strokes, images, background: "", markdown, warnings };
}

export function notabilityImage(media: any, files: Record<string, Uint8Array>, prefix: string): ImportedImage {
  const relative = media.relativePath ?? media.contentSnapshot?.relativePath
    ?? media.figure?.FigureBackgroundObjectKey?.kImageObjectSnapshotKey?.relativePath;
  const data = files[prefix + relative];
  const origin = numbers(media.documentContentOrigin ?? media.documentOrigin), size = numbers(media.unscaledContentSize);
  if (!relative || !data || origin.length !== 2 || size.length !== 2 || size.some((value) => value <= 0)) throw new Error("A Notability media object has an unsupported placement.");
  if (media.rotationDegrees) throw new Error("Rotated Notability images require an additional conversion step.");
  const extension = String(relative).split(".").pop()?.toLowerCase();
  let url = dataUrl(data, extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`);
  const crop = numbers(media.figure?.FigureCropRectKey);
  if (crop.length === 4) {
    const [naturalWidth, naturalHeight] = imageDimensions(data);
    const [x, y, width, height] = crop;
    if (width <= 0 || height <= 0) throw new Error("Notability contains an invalid image crop.");
    if (x !== 0 || y !== 0 || Math.abs(width - naturalWidth) > 0.01 || Math.abs(height - naturalHeight) > 0.01) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}"><image width="${naturalWidth}" height="${naturalHeight}" href="${url}"/></svg>`;
      url = dataUrl(new TextEncoder().encode(svg), "image/svg+xml");
    }
  }
  return { dataURL: url, x: origin[0], y: origin[1], width: size[0], height: size[1] };
}

function imageDimensions(data: Uint8Array): [number, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && view.getUint32(0) === 0x89504e47) return [view.getUint32(16), view.getUint32(20)];
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1], length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
      if (length < 2) break;
      offset += length + 2;
    }
  }
  throw new Error("Could not read the dimensions of a cropped Notability image.");
}

export function notabilityStrokes(spatial: any): InkStroke[] {
  const dataView = (name: string): DataView => {
    const data = spatial[name];
    if (!(data instanceof Uint8Array)) throw new Error(`Notability handwriting is missing ${name}.`);
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  };
  const counts = dataView("curvesnumpoints"), points = dataView("curvespoints"), widths = dataView("curveswidth");
  const colors = spatial.curvescolors as Uint8Array, styles = spatial.curvesstyles as Uint8Array;
  const count = Number(spatial.numcurves);
  if (!Number.isSafeInteger(count) || count < 0 || counts.byteLength !== count * 4 || widths.byteLength !== count * 4 || colors?.length !== count * 4 || styles?.length !== count) throw new Error("Unsupported Notability handwriting arrays.");
  const strokes: InkStroke[] = [];
  let pointIndex = 0;
  for (let index = 0; index < count; index++) {
    const length = counts.getUint32(index * 4, true);
    if ((pointIndex + length) * 8 > points.byteLength) throw new Error("Notability stroke coordinates are truncated.");
    const strokePoints = [];
    for (let offset = 0; offset < length; offset++) {
      const x = points.getFloat32((pointIndex + offset) * 8, true), y = points.getFloat32((pointIndex + offset) * 8 + 4, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Notability contains invalid ink coordinates.");
      strokePoints.push({ x, y, pressure: 0.5 });
    }
    pointIndex += length;
    const style = styles[index];
    if (style !== 3 && style !== 4) throw new Error(`Unsupported Notability stroke style ${style}.`);
    const width = widths.getFloat32(index * 4, true);
    if (!Number.isFinite(width) || width <= 0) throw new Error("Notability contains an invalid stroke width.");
    const color = "#" + Array.from(colors.subarray(index * 4, index * 4 + 3)).map((channel) => channel.toString(16).padStart(2, "0")).join("");
    strokes.push({ id: `notability-${index}`, rendering: "notability", tool: style === 4 ? "highlighter" : "pen", color, width,
      opacity: colors[index * 4 + 3] / 255, horizontalOrigin: 0, anchor: { pos: 0, lineText: "" }, points: strokePoints });
  }
  if (pointIndex * 8 !== points.byteLength) throw new Error("Notability point counts do not match its ink data.");
  if (spatial.shapes instanceof Uint8Array) {
    const shapes = readBinaryPlist(spatial.shapes);
    for (let index = 0; index < shapes.shapes.length; index++) {
      const shape = shapes.shapes[index], stroke = strokes[shapes.indices[index]];
      if (!stroke) throw new Error("Notability shape references a missing stroke.");
      if (shapes.kinds[index] === "line") stroke.points = [shape.startPt, shape.endPt].map(([x, y]: number[]) => ({ x, y, pressure: 0.5 }));
      else if (shape.strokePath instanceof Uint8Array) stroke.points = notabilityPath(shape.strokePath);
      else throw new Error(`Unsupported Notability shape ${shapes.kinds[index]}.`);
      const appearance = shape.appearance;
      if (appearance) {
        stroke.width = appearance.strokeWidth ?? stroke.width;
        const rgba = appearance.strokeColor?.rgba;
        if (rgba) {
          stroke.color = "#" + rgba.slice(0, 3).map((channel: number) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("");
          stroke.opacity = rgba[3];
        }
      }
    }
  }
  return strokes;
}

/** Notability's path stream stores operation bytes followed by little-endian double coordinates. */
export function notabilityPath(bytes: Uint8Array): InkStroke["points"] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint32(0, true) !== 0x48e5b325) throw new Error("Unsupported Notability vector path.");
  const count = view.getUint32(4, true);
  let offset = 8 + count;
  const points: InkStroke["points"] = [];
  const point = () => {
    const x = view.getFloat64(offset, true), y = view.getFloat64(offset + 8, true); offset += 16;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Notability vector path has invalid coordinates.");
    return { x, y, pressure: 0.5 };
  };
  for (let index = 0; index < count; index++) {
    const operation = bytes[8 + index];
    if (operation === 0 || operation === 1) points.push(point());
    else if ((operation === 2 || operation === 3) && points.length) {
      const start = points[points.length - 1], first = point();
      const second = operation === 3 ? point() : first, end = point();
      for (let step = 1; step <= 24; step++) {
        const t = step / 24, u = 1 - t;
        const coordinate = (axis: "x" | "y") => operation === 3
          ? u ** 3 * start[axis] + 3 * u ** 2 * t * first[axis] + 3 * u * t ** 2 * second[axis] + t ** 3 * end[axis]
          : u ** 2 * start[axis] + 2 * u * t * first[axis] + t ** 2 * end[axis];
        points.push({ x: coordinate("x"), y: coordinate("y"), pressure: 0.5 });
      }
    } else if (operation === 4 && points.length) points.push({ ...points[0] });
    else throw new Error(`Unsupported Notability vector operation ${operation}.`);
  }
  if (offset !== bytes.length) throw new Error("Notability vector coordinates do not match its operations.");
  return points;
}

function numbers(value: unknown): number[] {
  return typeof value === "string" ? (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number) : [];
}

function dataUrl(bytes: Uint8Array, type: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}
