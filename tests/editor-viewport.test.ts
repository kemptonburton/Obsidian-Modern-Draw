import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { chromium, webkit } from "playwright-core";

const useWebKit = process.env.MODERN_DRAW_TEST_WEBKIT === "1";
const browserPath = (useWebKit ? [webkit.executablePath()] : [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome"
]).find((candidate) => candidate && existsSync(candidate));

test("note ink moves with the scroller and stays registered through mobile pinch zoom", { skip: !browserPath }, async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {EditorState} from "@codemirror/state";
      import {Decoration, EditorView, WidgetType} from "@codemirror/view";
      import {editorInfoField, imageEmbed, MarkdownView} from "obsidian";
      import {DrawingController} from "./src/controller";
      import {createInkEditorExtension} from "./src/editor-extension";
      import {InkDocument} from "./src/ink-store";
      import {decodeInk, encodeInk} from "./src/ink-storage";
      import {DEFAULT_SETTINGS} from "./src/model";

      const controller = new DrawingController({...DEFAULT_SETTINGS, penOnly: true, writingHand: "left", canvasLayout: "left"});
      const owner = Object.assign(new MarkdownView(), {file: {path: "Test.md", extension: "md"}});
      const notes = new Map();
      const saves = new Map();
      const getInk = (path) => {
        if (notes.has(path)) return notes.get(path);
        const drawing = new InkDocument(path, []);
        if (saves.has(path)) drawing.applySynced(decodeInk(saves.get(path)), false);
        drawing.subscribe(persist => { if (persist) saves.set(path, encodeInk(drawing.data())); });
        notes.set(path, drawing);
        return drawing;
      };
      const ink = getInk(owner.file.path);
      const zooms = new Map();
      const extension = createInkEditorExtension({
        app: {
          workspace: {getActiveViewOfType: () => null},
          loadLocalStorage: key => zooms.get(key) ?? null,
          saveLocalStorage: (key, value) => value === null ? zooms.delete(key) : zooms.set(key, value)
        }, controller,
        store: {getDocument: async path => getInk(path)},
        regions: {attachNote: () => ({
          surface: {screenRegions: () => [], setSelection() {}}, refresh() {}, destroy() {}
        })}, importPdf() {}, async saveSettings() {}
      });
      class ImageWidget extends WidgetType {
        toDOM() { return imageEmbed(); }
      }
      const imageRow = 8;
      const state = EditorState.create({
        doc: "test line\\n".repeat(imageRow - 1) + "![[crop.png]]\\n" + "test line\\n".repeat(400 - imageRow),
        extensions: [editorInfoField.init(() => owner), extension, EditorView.decorations.compute(["doc"], ({doc}) =>
          Decoration.set([Decoration.widget({widget: new ImageWidget()}).range(doc.line(imageRow).from)]))]
      });
      const anchor = state.doc.line(imageRow);
      ink.commitFloatingImages([{id: "registration-image", source: "crop.png", occurrence: 0,
        anchor: {pos: anchor.from, lineText: anchor.text}, x: 250, y: 220, width: 95}]);
      const view = new EditorView({state, parent: document.querySelector("#editor")});
      const sizer = document.createElement("div");
      sizer.className = "cm-sizer";
      const title = document.createElement("div");
      title.className = "inline-title";
      title.contentEditable = "true";
      title.textContent = "Lecture Notes";
      const properties = document.createElement("div");
      properties.className = "metadata-container";
      properties.textContent = "Properties";
      view.scrollDOM.insertBefore(sizer, view.contentDOM);
      sizer.append(title, properties, view.contentDOM);
      const canvas = document.querySelector(".modern-draw-overlay");
      const context = canvas.getContext("2d");
      const row = 17;
      const position = state.doc.line(row).from;
      const zoom = () => Number(view.scrollDOM.style.getPropertyValue("--modern-draw-note-zoom") || 1);
      const textY = () => view.documentTop + view.lineBlockAt(position).top + 4 * zoom();
      let inkOffset = 0;
      let registration;
      const painted = new Map();
      let strokeIndex = 0;
      const clearRect = context.clearRect.bind(context);
      context.clearRect = function (...args) {
        painted.clear();
        registration = undefined;
        strokeIndex = 0;
        clearRect(...args);
      };
      const fill = context.fill.bind(context);
      context.fill = function (...args) {
        const {a, d, e, f} = this.getTransform();
        const rect = canvas.getBoundingClientRect();
        const stroke = args[0] instanceof Path2D ? ink.strokes[strokeIndex++] : undefined;
        if (stroke) {
          const y = rect.top + (f + d * stroke.points[0].y) * rect.height / canvas.height;
          painted.set(stroke.id, y);
          if (stroke.id === "registration") {
            registration = {x: (e + a * stroke.points[0].x) / canvas.width,
              y: (f + d * stroke.points[0].y) / canvas.height, scale: d / canvas.height};
          }
        }
        fill(...args);
      };
      window.fixture = {
        view, canvas, controller, ink, zoom, zooms, painted, notes,
        layout() {
          const bounds = (element) => {
            const {left, top, width, height} = element.getBoundingClientRect();
            return {left, top, width, height};
          };
          return {viewport: bounds(view.scrollDOM), toolbar: bounds(view.dom.querySelector(".modern-draw-toolbar")),
            title: bounds(title), properties: bounds(properties), text: bounds(view.contentDOM)};
        },
        imageRegistration() {
          const image = view.dom.querySelector(".modern-draw-floating-image img:not([hidden] *)");
          if (!image || !registration) return null;
          const crop = image.getBoundingClientRect();
          const buffer = canvas.getBoundingClientRect();
          return {x: buffer.left + registration.x * buffer.width - crop.left,
            y: buffer.top + registration.y * buffer.height - crop.top,
            width: crop.width, scale: registration.scale * buffer.height, cropTop: crop.top};
        },
        moveCropDown() {
          const target = view.state.doc.line(180);
          const shift = (target.number - row) * 24;
          ink.commitState(ink.strokes.slice(0, 1).map(stroke => ({...stroke, points:
            stroke.points.map(point => ({...point, y: point.y + shift}))})),
            ink.floatingImages.map(image => ({...image, y: image.y + shift})));
          view.scrollDOM.scrollTop += shift;
        },
        savedLayout: path => saves.has(path) ? decodeInk(saves.get(path)).canvasLayout : undefined,
        drawAcrossLineBoundary() {
          const target = view.scrollDOM;
          const viewport = target.getBoundingClientRect();
          const boundary = view.documentTop + view.lineBlockAt(position).bottom;
          for (const [id, y] of [[51, boundary - 4], [52, boundary + 4]]) {
            for (const [type, x] of [["pointerdown", 315], ["pointermove", 345], ["pointerup", 365]]) {
              target.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
                pointerId: id, pointerType: "pen", clientX: viewport.left + x, clientY: y, pressure: .5
              }));
            }
          }
          return ink.strokes.slice(-2).map(({id, anchor}) => ({id, anchor: anchor.pos}));
        },
        openNote(path) {
          owner.file = { path, extension: "md" };
          view.dispatch({selection: {anchor: 0}});
        },
        seedInk() {
          const line = view.contentDOM.querySelector(".cm-line");
          inkOffset = textY() - (view.documentTop + view.lineBlockAt(anchor.from).top);
          ink.append({
            id: "registration", anchor: {pos: anchor.from, lineText: anchor.text},
            tool: "pen", color: "#181818", width: 3, opacity: 1,
            points: [{x: 250, y: inkOffset, pressure: .5}, {x: 280, y: inkOffset, pressure: .5}]
          });
          const previousInk = canvas.getBoundingClientRect().top;
          const previousText = line.getBoundingClientRect().top;
          view.scrollDOM.scrollTop = 100;
          const deltas = [canvas.getBoundingClientRect().top - previousInk, line.getBoundingClientRect().top - previousText];
          view.scrollDOM.scrollTop = 240;
          return deltas;
        },
        location: () => {
          const buffer = canvas.getBoundingClientRect();
          return {textY: textY(), inkY: registration ? buffer.top + registration.y * buffer.height : NaN,
            scrollHeight: view.scrollDOM.scrollHeight};
        }
      };
    ` },
    bundle: true, write: false, format: "iife", platform: "browser",
    plugins: [{ name: "obsidian-editor", setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        resolveDir: process.cwd(),
        contents: `
          import {StateField} from "@codemirror/state";
          export const editorInfoField = StateField.define({create: () => null, update: value => value});
          export const Platform = {isMobile: true};
          export class MarkdownView {}
          export class Component {load() {} unload() {}}
          export class Modal {}
          export class FuzzySuggestModal {}
          export class Notice {}
          export class Menu {}
          export class Setting {}
          export function imageEmbed() {
            const host = document.createElement("span");
            host.className = "image-embed modern-draw-region-embed";
            host.setAttribute("src", "crop.png");
            const image = host.appendChild(document.createElement("img"));
            image.className = "modern-draw-region-image";
            image.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='80'%3E%3Crect width='100' height='80' fill='red'/%3E%3C/svg%3E";
            return host;
          }
          export const MarkdownRenderer = {async render(_app, _text, host) { host.appendChild(imageEmbed()); }};
          export const normalizePath = path => path;
          export function setIcon() {}
        `
      }));
    } }]
  });

  const browser = await (useWebKit ? webkit : chromium).launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 640 }, hasTouch: true, isMobile: true });
    page.setDefaultTimeout(4000);
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><div class="workspace-leaf mod-active"><div id="editor" class="markdown-source-view mod-cm6"></div></div>');
    await page.addStyleTag({
      content: readFileSync("styles.css", "utf8") + `
        .cm-editor { height: 550px; }
        .cm-scroller { overflow: auto; padding: 8px 16px; }
        .cm-sizer { display: flex; flex-direction: column; max-width: 700px; margin-inline: auto; }
        .cm-line { line-height: 24px; }
        .inline-title { line-height: 32px; font-size: 26px; }
        .metadata-container { height: 48px; }
      `
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction("fixture.canvas.height > 200");
    await page.waitForSelector(".cm-line .modern-draw-floating-image img");
    assert.deepEqual(await page.evaluate("fixture.seedInk()"), [-100, -100]);
    await page.waitForFunction("Math.abs(fixture.location().inkY - fixture.location().textY) < 3");
    const imageBaseline = await page.waitForFunction("fixture.imageRegistration()").then((handle) =>
      handle.jsonValue() as Promise<{ x: number; y: number; width: number; scale: number; cropTop: number }>
    );
    const checkRegistration = async (zoom: number) => {
      const actual = await page.evaluate<typeof imageBaseline>("fixture.imageRegistration()");
      assert.ok(actual, "the floating crop should remain mounted");
      assert.ok(Math.abs(actual.scale - zoom) < 0.01, JSON.stringify(actual));
      assert.ok(Math.abs(actual.width - imageBaseline.width * zoom) < 0.5, JSON.stringify(actual));
      assert.ok(Math.abs(actual.x - imageBaseline.x * zoom) < 1.5, JSON.stringify({ actual, imageBaseline, zoom }));
      assert.ok(Math.abs(actual.y - imageBaseline.y * zoom) < 1.5, JSON.stringify({ actual, imageBaseline, zoom }));
      return actual;
    };

    await page.evaluate("fixture.view.focus(); fixture.controller.setTool('pen')");
    await page.waitForFunction("!fixture.view.contentDOM.isContentEditable && document.activeElement !== fixture.view.contentDOM");
    const initial = await page.evaluate<{ textY: number; scrollHeight: number }>("fixture.location()");
    await page.touchscreen.tap(330, initial.textY);
    assert.equal(await page.evaluate("fixture.view.contentDOM.isContentEditable"), false);

    const session = useWebKit ? null : await page.context().newCDPSession(page);
    const points = (spread: number) => [
      { x: 330 - spread, y: Math.round(initial.textY), id: 1 },
      { x: 330 + spread, y: Math.round(initial.textY), id: 2 }
    ];
    const touch = async (type: "touchStart" | "touchMove" | "touchEnd", touchPoints: ReturnType<typeof points>) => {
      if (session) {
        await session.send("Input.dispatchTouchEvent", { type, touchPoints });
      } else {
        await page.locator(".cm-scroller").evaluate((target, gesture) => {
          const event = new Event(gesture.type.toLowerCase(), { bubbles: true, cancelable: true });
          const changed = gesture.touchPoints.map(({ x, y, id }) => ({ clientX: x, clientY: y, identifier: id }));
          Object.defineProperties(event, { changedTouches: { value: changed }, touches: {
            value: gesture.type === "touchEnd" ? [] : changed
          } });
          target.dispatchEvent(event);
        }, { type, touchPoints: type === "touchEnd" ? points(35) : touchPoints });
      }
    };
    let written: { id: string; anchor: number }[] = [];
    let initialGap = 0;
    for (const [start, end, zoom] of [[35, 70, 2], [70, 35, 1]]) {
      await touch("touchStart", points(start));
      await touch("touchMove", points((start + end) / 2));
      await page.waitForFunction("Math.abs(fixture.zoom() - 1.5) < 0.001");
      await checkRegistration(1.5);
      await touch("touchMove", points(end));
      await touch("touchEnd", []);
      await page.waitForFunction(`fixture.view.scaleY > ${zoom - 0.01} && fixture.view.scaleY < ${zoom + 0.01}`);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await checkRegistration(zoom);
      const settled = await page.evaluate<typeof initial & { inkY: number }>("fixture.location()");
      assert.ok(Math.abs(settled.textY - initial.textY) < 3, JSON.stringify({ initial, settled }));
      assert.ok(Math.abs(settled.inkY - settled.textY) < 3, JSON.stringify(settled));
      assert.equal(await page.evaluate("fixture.zooms.get('modern-draw-note-zoom:Test.md') ?? 1"), zoom);
      if (zoom === 2) {
        written = await page.evaluate("fixture.drawAcrossLineBoundary()");
        assert.notEqual(written[0].anchor, written[1].anchor);
      }
      const [first, second] = written.map(({ id }) => JSON.stringify(id));
      await page.waitForFunction(`fixture.painted.has(${first}) && fixture.painted.has(${second})`);
      const gap: number = await page.evaluate(`fixture.painted.get(${second}) - fixture.painted.get(${first})`);
      if (zoom === 2) {
        assert.ok(Math.abs(gap - 8) < 1);
        initialGap = gap;
      } else {
        assert.ok(Math.abs(gap - initialGap / 2) < 1);
      }
    }
    assert.equal(await page.evaluate("fixture.location().scrollHeight"), initial.scrollHeight);

    await page.evaluate("fixture.moveCropDown()");
    await page.waitForSelector(".modern-draw-floating-layer > div:not([hidden]) img", { state: "visible" });
    const virtualized = await checkRegistration(1);
    await touch("touchStart", points(70));
    for (const spread of [62, 53, 45, 38, 47, 58, 70]) {
      await touch("touchMove", points(spread));
      const targetZoom = spread / 70;
      await page.waitForFunction(`Math.abs(fixture.zoom() - ${targetZoom}) < 0.001`);
      const registered = await checkRegistration(targetZoom);
      const expectedTop = initial.textY + (virtualized.cropTop - initial.textY) * targetZoom;
      assert.ok(Math.abs(registered.cropTop - expectedTop) < 3, JSON.stringify({ registered, expectedTop }));
    }
    await touch("touchEnd", []);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const [label, zoom] of [["Zoom out", 0.9], ["Zoom in", 1]] as const) {
      await page.getByRole("button", { name: label, exact: true }).tap();
      await page.waitForFunction(`Math.abs(fixture.view.scaleY - ${zoom}) < 0.005`);
      await checkRegistration(zoom);
    }
    type Bounds = { left: number; top: number; width: number; height: number };
    type Layout = Record<"viewport" | "toolbar" | "title" | "properties" | "text", Bounds>;
    const layout = await page.evaluate<Layout>("fixture.layout()");
    await touch("touchStart", points(100));
    await touch("touchMove", points(36));
    await page.waitForFunction("Math.abs(fixture.view.scaleY - 0.36) < 0.005");
    await touch("touchEnd", []);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await checkRegistration(0.36);
    const zoomed = await page.evaluate<Layout>("fixture.layout()");
    for (const key of ["viewport", "toolbar"] as const) {
      for (const dimension of ["left", "top", "width", "height"] as const) {
        assert.ok(Math.abs(zoomed[key][dimension] - layout[key][dimension]) < 1, JSON.stringify(zoomed[key]));
      }
    }
    for (const key of ["title", "properties", "text"] as const) {
      assert.ok(Math.abs(zoomed[key].width - layout[key].width * 0.36) < 1, JSON.stringify(zoomed[key]));
      assert.ok(Math.abs(zoomed[key].left - zoomed.text.left) < 1, JSON.stringify(zoomed[key]));
    }
    for (const key of ["title", "properties"] as const) {
      assert.ok(Math.abs(zoomed[key].height - layout[key].height * 0.36) < 1, JSON.stringify(zoomed[key]));
    }
    await page.getByRole("button", { name: "Reset zoom", exact: true }).tap();
    await page.waitForFunction("Math.abs(fixture.view.scaleY - 1) < 0.005");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate("fixture.view.scrollDOM.scrollTop = 240");
    await page.waitForSelector(".cm-line .modern-draw-floating-image img", { state: "attached" });

    await page.evaluate("fixture.controller.setTool('select')");
    await page.waitForFunction("fixture.view.contentDOM.isContentEditable");

    await page.evaluate(`document.querySelector(".inline-title").focus({preventScroll: true})`);
    assert.equal(await page.evaluate("document.activeElement.classList.contains('inline-title')"), true);
    for (const tool of ["eraser", "pen", "highlighter", "lasso", "space", "space-horizontal"]) {
      await page.locator(`.modern-draw-toolbar [data-tool="${tool}"]`).tap();
      await page.waitForFunction("!fixture.view.contentDOM.isContentEditable");
      assert.equal(await page.evaluate("fixture.controller.activeTool"), tool);
      assert.equal(await page.evaluate(`(() => {
        const title = document.querySelector(".inline-title");
        title.focus({preventScroll: true});
        return document.activeElement === title;
      })()`), false);
      assert.equal(await page.evaluate(`fixture.view.contentDOM.dispatchEvent(
        new InputEvent("beforeinput", {bubbles: true, cancelable: true, inputType: "insertText", data: "x"})
      )`), false);
    }
    await page.locator('.modern-draw-toolbar [data-tool="pen"]').tap();
    const pressureModes = await page.evaluate(`(() => {
      const {view, controller, ink} = fixture;
      const draw = (id, y) => {
        const target = view.scrollDOM;
        const rect = target.getBoundingClientRect();
        for (const [type, x, pressure] of [["pointerdown", 180, 0.12], ["pointermove", 210, 0.86], ["pointerup", 230, 0]]) {
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
            pointerId: id, pointerType: "pen", clientX: rect.left + x, clientY: rect.top + y, pressure
          }));
        }
      };
      controller.updateSettings({...controller.settings, stylusPressure: false});
      draw(51, 80);
      controller.updateSettings({...controller.settings, stylusPressure: true});
      draw(52, 110);
      return ink.strokes.slice(-2).map(stroke => stroke.pressureSensitive ?? true);
    })()`);
    assert.deepEqual(pressureModes, [false, true]);
    const penPath = (points: number[][]) => page.evaluate((coordinates) => {
      const { view, ink } = (window as any).fixture;
      const rect = view.scrollDOM.getBoundingClientRect();
      const before = ink.strokes.length;
      coordinates.forEach(([x, y], index) => {
        const type = index === 0 ? "pointerdown" : index === coordinates.length - 1 ? "pointerup" : "pointermove";
        view.scrollDOM.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, isPrimary: true, pointerType: "pen", pointerId: 63,
          clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: type === "pointerup" ? 0 : 1
        }));
      });
      return ink.strokes.length - before;
    }, points);
    await page.locator('.modern-draw-toolbar [data-tool="select"]').tap();
    assert.equal(await penPath([[610, 80], [630, 85], [650, 90]]), 0);
    await page.evaluate(`fixture.controller.updateSettings({...fixture.controller.settings,
      penPresets: [{color: "#db2777", width: 4}]})`);
    await page.locator('.modern-draw-toolbar [data-tool="lasso"]').tap();
    assert.equal(await penPath([[165, 64], [246, 64], [246, 94], [165, 94], [165, 64]]), 0);
    const preset = page.getByRole("button", { name: "Use pen preset #db2777, 4px" });
    await preset.tap();
    assert.equal(await page.evaluate("fixture.controller.activeTool"), "lasso");
    assert.equal(await page.evaluate("fixture.ink.strokes.at(-2).color"), "#db2777");
    assert.notEqual(await page.evaluate("fixture.ink.strokes.at(-1).color"), "#db2777");
    await page.getByRole("button", { name: "Undo ink", exact: true }).tap();
    assert.notEqual(await page.evaluate("fixture.ink.strokes.at(-2).color"), "#db2777");

    await page.locator('.modern-draw-toolbar [data-tool="select"]').tap();
    await page.evaluate(`fixture.view.scrollDOM.scrollTop = 0;
      fixture.ink.commitFloatingImages(fixture.ink.floatingImages.map(image => ({...image, y: 100})))`);
    const sourceImage = page.locator(".cm-line .image-embed img");
    const handle = page.locator(".cm-line .modern-draw-image-resize-corner");
    const resizeImage = async () => {
      await sourceImage.tap();
      await handle.waitFor({ state: "visible" });
      await handle.evaluate((target) => {
        const bounds = target.getBoundingClientRect();
        for (const [type, delta] of [["pointerdown", 0], ["pointermove", 35], ["pointerup", 35]] as const) {
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, isPrimary: true, pointerId: 64, pointerType: "touch",
            button: 0, buttons: type === "pointerup" ? 0 : 1,
            clientX: bounds.left + bounds.width / 2 + delta, clientY: bounds.top + bounds.height / 2
          }));
        }
      });
    };
    await resizeImage();
    assert.equal(await page.evaluate("fixture.ink.floatingImages[0].width"), 130);
    await page.evaluate("fixture.ink.commitFloatingImages([])");
    await page.waitForFunction("!document.querySelector('.cm-line .image-embed').classList.contains('modern-draw-floating-image')");
    await resizeImage();
    assert.equal(await page.evaluate("fixture.view.state.doc.line(8).text"), "![[crop.png|135]]");
    const centered = page.getByRole("button", { name: "Centered text canvas; switch to left origin" });
    const left = page.getByRole("button", { name: "Left-origin text canvas; switch to centered" });
    await centered.tap();
    await left.waitFor();
    assert.equal(await page.evaluate("fixture.savedLayout('Test.md')"), "left");

    await page.locator('.modern-draw-toolbar [aria-label="Zoom in"]').tap();
    await page.waitForFunction("fixture.zoom() > 1");
    const remembered = await page.evaluate("fixture.zoom()");
    await page.evaluate("fixture.openNote('Another.md')");
    await page.waitForFunction("fixture.zoom() === 1");
    await centered.waitFor();
    assert.equal(await page.evaluate("fixture.savedLayout('Another.md')"), undefined);
    await page.evaluate("fixture.notes.delete('Test.md'); fixture.openNote('Test.md')");
    assert.equal(await page.evaluate("fixture.zoom()"), remembered);
    await left.waitFor();
    await left.tap();
    await centered.waitFor();
    assert.equal(await page.evaluate("fixture.savedLayout('Test.md')"), "center");

    await page.locator('.modern-draw-toolbar [data-tool="select"]').tap();
    await page.waitForFunction("fixture.view.contentDOM.isContentEditable");
    assert.equal(await page.evaluate(`(() => {
      const title = document.querySelector(".inline-title");
      title.focus({preventScroll: true});
      return document.activeElement === title;
    })()`), true);
    await page.setViewportSize({ width: 340, height: 220 });
    await preset.dblclick();
    const dialog = page.getByRole("dialog", { name: "Edit pen preset" });
    await dialog.waitFor();
    const popover = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const swatch = element.querySelector(".modern-draw-palette button")!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, focused: document.activeElement === element,
        swatchWidth: swatch.width, swatchHeight: swatch.height };
    });
    assert.ok(popover.left >= 0 && popover.top >= 0 && popover.right <= 340 && popover.bottom <= 220, JSON.stringify(popover));
    assert.equal(popover.focused, true);
    assert.equal(popover.swatchWidth, popover.swatchHeight);
  } finally {
    await browser.close();
  }
});
