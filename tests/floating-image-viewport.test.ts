import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const browserPath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((candidate) => candidate && existsSync(candidate));

test("a floating image stays visible after CodeMirror virtualizes its source line", { skip: !browserPath }, async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {EditorState} from '@codemirror/state';
      import {EditorView,Decoration,WidgetType} from '@codemirror/view';
      import {FloatingImageManager} from './src/floating-images';
      import {InkControls} from './src/ink-controls';
      import {InkDocument} from './src/ink-store';
      import {scaleDrawingContent} from './src/drawing-scale';
      const data='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="red"/></svg>';
      class ImageWidget extends WidgetType { toDOM(){const span=document.createElement('span');span.className='image-embed';span.setAttribute('src','photo.png');const img=span.appendChild(document.createElement('img'));img.src=data;return span;} }
      const decorations=Decoration.set([Decoration.replace({widget:new ImageWidget()}).range(0,5)]);
      const state=EditorState.create({doc:'image\\n'+'blank\\n'.repeat(500),extensions:[EditorView.decorations.of(decorations)]});
      const view=new EditorView({state,parent:document.querySelector('#editor')});
      const placement={id:'floating',source:'photo.png',occurrence:0,anchor:{pos:0,lineText:'image'},x:20,y:3000,width:100};
      const ink=new InkDocument('test.md',[{id:'ink',tool:'pen',color:'#000000',opacity:1,width:4,anchor:{pos:0,lineText:'image'},points:[{x:20,y:3000,pressure:0.5}]}],[placement]);
      const manager=new FloatingImageManager(view,{},()=>ink,()=>1,()=>{});
      const noop=()=>{};
      const controls=new InkControls({setTool:noop,setColor:noop,setStrokeSize:noop,setStyle:noop,togglePinnedStyle:noop,updatePinnedStyle:noop,movePinnedStyle:noop,
        undo:()=>{ink.undo();manager.refresh();},redo:()=>{ink.redo();manager.refresh();},importPdf:noop,
        scaleNote:()=>{const result=scaleDrawingContent(ink.strokes,ink.floatingImages,[],0.5);ink.commitState(result.strokes,result.images);manager.refresh();}
      },{includeSpace:false,includeHistory:true},document);
      document.body.appendChild(controls.root);
      window.fixture={view,manager,ink,controls};
    ` },
    bundle: true, write: false, format: "iife", platform: "browser",
    plugins: [{ name: "obsidian-renderer", setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
        export class Component {load(){} unload(){}}
        export const Platform = {isMobile: false};
        export function setIcon(){}
        export function normalizePath(value){return value;}
        export const MarkdownRenderer={async render(app,text,host){const span=host.appendChild(document.createElement('span'));span.className='image-embed';span.setAttribute('src','photo.png');const img=span.appendChild(document.createElement('img'));img.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="red"/></svg>';await img.decode();}};
      ` }));
    } }]
  });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    await page.setContent('<div id="editor" class="markdown-source-view mod-cm6"></div>');
    await page.addStyleTag({ content: readFileSync(path.resolve("styles.css"), "utf8") + "\n.cm-editor{height:400px}.cm-content{position:relative}.cm-scroller{overflow:auto;position:relative}.cm-line{line-height:24px}" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForSelector(".modern-draw-floating-layer img", { state: "attached" });
    await page.evaluate("fixture.view.dispatch({selection:{anchor:750}});fixture.view.scrollDOM.scrollTop=2850");
    await page.waitForFunction("fixture.view.viewport.from > 5");
    await page.waitForSelector(".modern-draw-floating-layer > div:not([hidden]) img", { state: "visible" });
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="Scale note"]').nextElementSibling.getAttribute('aria-label')`), "Import PDF pages or slides");
    await page.locator('[aria-label="Scale note"]').click();
    assert.deepEqual(await page.evaluate("[fixture.ink.strokes[0].width,fixture.ink.strokes[0].points[0].y,fixture.ink.floatingImages[0].width,fixture.ink.floatingImages[0].y]"), [2,1500,50,1500]);
    await page.locator('[aria-label="Undo ink"]').click();
    assert.deepEqual(await page.evaluate("[fixture.ink.strokes[0].width,fixture.ink.floatingImages[0].width]"), [4,100]);
    await page.locator('[aria-label="Redo ink"]').click();
    assert.equal(await page.evaluate("fixture.ink.floatingImages[0].width"), 50);
    await page.locator('[aria-label="Undo ink"]').click();
    const bounds = await page.locator(".modern-draw-floating-layer img").boundingBox();
    assert.ok(bounds && bounds.y > 0 && bounds.y < 400 && bounds.height === 80);
    await page.evaluate("fixture.view.scrollDOM.scrollTop=0");
    await page.waitForFunction("fixture.view.viewport.from === 0");
    await page.waitForFunction("document.querySelector('.modern-draw-floating-layer > div').hidden");
    await page.evaluate("fixture.view.scrollDOM.scrollTop=2850");
    await page.waitForSelector(".modern-draw-floating-layer > div:not([hidden]) img", { state: "visible" });
    assert.equal(await page.locator(".modern-draw-floating-layer img").count(), 1);
    await page.evaluate("fixture.removedImages=fixture.ink.floatingImages;fixture.ink.floatingImages=[];fixture.manager.refresh()");
    await page.waitForFunction("document.querySelectorAll('.modern-draw-floating-layer img').length===0");
    await page.evaluate("fixture.ink.floatingImages=fixture.removedImages;fixture.manager.refresh()");
    await page.waitForSelector(".modern-draw-floating-layer > div:not([hidden]) img", { state: "visible" });
    await page.evaluate("fixture.manager.destroy()");
    await page.evaluate("fixture.controls.destroy()");
    assert.equal(await page.locator(".modern-draw-floating-layer").count(), 0);
  } finally { await browser.close(); }
});
