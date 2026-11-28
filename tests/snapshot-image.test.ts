import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { chromium, webkit } from "playwright-core";

const useWebKit = process.env.MODERN_DRAW_TEST_WEBKIT === "1";
const browserPath = (useWebKit ? [webkit.executablePath()] : [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"
]).find((candidate) => candidate && existsSync(candidate));

test("browser capture crops note images and raster ink, and includes Canvas vector ink", { skip: !browserPath }, async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `import { renderSnapshotImage } from "./src/snapshot-image"; window.renderSnapshotImage = renderSnapshotImage;` },
    platform: "browser", format: "iife", bundle: true, write: false
  });
  const browser = await (useWebKit ? webkit : chromium).launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 480 }, deviceScaleFactor: 2 });
    await page.setContent(`
      <style>
        .surface { margin: 20px 30px; position: relative; width: 240px; height: 150px; background: white; overflow: hidden; }
        #note div { position: absolute; width: 160px; height: 90px; transform: scale(.75); transform-origin: top left; }
        #note :is(img, canvas) { position: absolute; left: 16px; width: 24px; height: 24px; }
        #photo { top: 16px; }
        #ink { top: 60px; }
        #plane { position:absolute; transform: translate(20px, 30px) scale(1.5); transform-origin: top left; }
        .modern-draw-canvas-overlay { position:absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; }
      </style>
      <div class="surface" id="note"><div><img id="photo"><canvas id="ink" width="24" height="24"></canvas></div></div>
      <div class="surface" id="canvas"><div id="plane">
        <svg class="modern-draw-canvas-overlay"><path fill="#008000" d="M30 20H55V40H30Z"/></svg>
      </div></div>
    `);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const source = document.createElement("canvas");
      source.width = source.height = 24;
      const photoPaint = source.getContext("2d")!;
      photoPaint.fillStyle = "red";
      photoPaint.fillRect(0, 0, 24, 24);
      const photo = document.querySelector<HTMLImageElement>("#photo")!;
      photo.src = source.toDataURL();
      await photo.decode();
      const inkPaint = document.querySelector<HTMLCanvasElement>("#ink")!.getContext("2d")!;
      inkPaint.fillStyle = "blue";
      inkPaint.fillRect(0, 0, 24, 24);

      const captures = [];
      for (const [selector, samples] of [["#note", [[14, 14], [14, 46]]], ["#canvas", [[73, 65]]]] as const) {
        const root = document.querySelector<HTMLElement>(selector)!;
        const box = root.getBoundingClientRect();
        const png = await (window as any).renderSnapshotImage(root, {
          left: box.left + 8, top: box.top + 8, right: box.left + 138, bottom: box.top + 118
        });
        const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
        const image = new Image();
        image.src = url;
        await image.decode();
        URL.revokeObjectURL(url);
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const colors = samples.map(([x, y]) => Array.from(context.getImageData(x * 2, y * 2, 1, 1).data));
        captures.push({ size: [canvas.width, canvas.height], colors });
      }
      return captures;
    });
    assert.deepEqual(result[0], { size: [260, 220], colors: [[255, 0, 0, 255], [0, 0, 255, 255]] });
    assert.deepEqual(result[1], { size: [260, 220], colors: [[0, 128, 0, 255]] });
  } finally {
    await browser.close();
  }
});
