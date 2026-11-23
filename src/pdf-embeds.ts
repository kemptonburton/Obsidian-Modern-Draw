import { loadPdfJs, MarkdownRenderChild, Menu, Notice, type App, type TFile } from "obsidian";
import { parsePdfRegion, pdfRegionBounds, pdfRegionSubpath, type PdfRegion, type PdfViewport } from "./pdf-region";
import { parseSnapshotRegion, SNAPSHOT_FOLDER, type LinkedSelection } from "./snapshot-region";
import { regionLinkIcon } from "./region-controls";

export const PDF_THEME_KEY = "pdfjs-is-themed";

interface EmbedContext {
  containerEl: HTMLElement;
}

type FileEmbed = MarkdownRenderChild & { loadFile(): Promise<void> };
type EmbedCreator = (context: EmbedContext, file: TFile, subpath: string) => FileEmbed;

export interface PdfPage {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
    transform: number[];
    background: string;
  }): { promise: Promise<void> };
  cleanup(): void;
}

export interface PdfLoadingTask {
  promise: Promise<{ numPages: number; getPage(page: number): Promise<PdfPage> }>;
  destroy(): Promise<void>;
}

export function openPdf(
  pdfjs: Awaited<ReturnType<typeof loadPdfJs>>, source: { url: string } | { data: ArrayBuffer }, owner: Document
): PdfLoadingTask {
  const resourceRoot = new URL("/lib/pdfjs/", owner.location.href).href;
  return pdfjs.getDocument({
    ...source,
    cMapUrl: resourceRoot + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: resourceRoot + "standard_fonts/",
    wasmUrl: resourceRoot + "wasm/",
    iccUrl: resourceRoot + "iccs/",
    isEvalSupported: false
  });
}

interface Crop {
  blob: Blob;
  width: number;
}

export class RegionEmbeds {
  private readonly active = new Set<RegionImageEmbed>();
  private readonly crops = new Map<string, Promise<Crop>>();
  private readonly documents = new Map<TFile, { task: PdfLoadingTask; mtime: number; users: number }>();

  constructor(private readonly app: App, private readonly open: (file: TFile, region: LinkedSelection) => void) {}

  install(): () => void {
    // Obsidian uses this registry in both Reading View and Live Preview.
    const registry = (this.app as App & {
      embedRegistry?: { embedByExtension?: Record<string, EmbedCreator> };
    }).embedRegistry?.embedByExtension;
    const createImageEmbed = registry?.png;
    if (!registry || !createImageEmbed) return () => {};
    const restore: (() => void)[] = [];
    for (const extension of ["pdf", "md", "canvas"]) {
      const native = registry[extension];
      if (!native) continue;
      const create: EmbedCreator = (context, file, subpath) => {
        const region = (extension === "pdf" ? parsePdfRegion : parseSnapshotRegion)(subpath ?? "");
        if (!region) return native(context, file, subpath);
        // Provide a native image widget so every capture shares its resize and edit controls.
        const embed = createImageEmbed(context, file, subpath);
        const crop = embed.addChild(new RegionImageEmbed(context.containerEl, file, region, this));
        embed.loadFile = () => crop.loadFile();
        return embed;
      };
      registry[extension] = create;
      restore.push(() => {
        if (registry[extension] === create) registry[extension] = native;
      });
    }
    return () => {
      for (const action of restore) action();
      for (const embed of this.active) embed.unload();
      this.crops.clear();
    };
  }

  attach(embed: RegionImageEmbed): void {
    this.active.add(embed);
  }

  detach(embed: RegionImageEmbed): void {
    this.active.delete(embed);
  }

  openRegion(file: TFile, region: LinkedSelection): void {
    this.open(file, region);
  }

  watch(embed: RegionImageEmbed): void {
    embed.registerEvent(this.app.vault.on("modify", (file) => {
      if ((file === embed.file && embed.isPdf) || file.path === embed.assetPath) void embed.loadFile();
    }));
    if (embed.assetPath) embed.registerEvent(this.app.vault.on("create", (file) => {
      if (file.path === embed.assetPath) void embed.loadFile();
    }));
  }

  updateTheme(): void {
    const adapt = Boolean(this.app.loadLocalStorage(PDF_THEME_KEY));
    for (const embed of this.active) embed.containerEl.classList.toggle("mod-themed", adapt && embed.isPdf);
  }

  async crop(file: TFile, region: LinkedSelection, owner: Document): Promise<Crop> {
    if ("id" in region) {
      const asset = this.app.vault.getFileByPath(`${SNAPSHOT_FOLDER}/${region.id}.png`);
      if (!asset) throw new Error("Snapshot image is missing.");
      return {
        blob: new Blob([await this.app.vault.readBinary(asset)], { type: "image/png" }),
        width: Math.min(680, Math.max(1, Math.round(region.bounds.right - region.bounds.left)))
      };
    }
    const key = JSON.stringify([file.path, file.stat.mtime, pdfRegionSubpath(region)]);
    const cached = this.crops.get(key);
    if (cached) {
      this.crops.delete(key);
      this.crops.set(key, cached);
      return cached;
    }
    const crop = this.render(file, region, owner);
    this.crops.set(key, crop);
    if (this.crops.size > 24) this.crops.delete(this.crops.keys().next().value!);
    void crop.catch(() => {
      if (this.crops.get(key) === crop) this.crops.delete(key);
    });
    return crop;
  }

  private async render(file: TFile, region: PdfRegion, owner: Document): Promise<Crop> {
    const pdfjs = await loadPdfJs();
    let document = this.documents.get(file);
    if (!document || document.mtime !== file.stat.mtime) {
      const task = openPdf(pdfjs, { url: this.app.vault.getResourcePath(file) }, owner);
      document = { task, mtime: file.stat.mtime, users: 0 };
      this.documents.set(file, document);
    }
    document.users += 1;
    try {
      const page = await (await document.task.promise).getPage(region.page);
      const viewport = page.getViewport({ scale: 4 / 3 });
      const bounds = pdfRegionBounds(viewport, region);
      const left = Math.max(0, bounds.left);
      const top = Math.max(0, bounds.top);
      const width = Math.min(viewport.width, bounds.right) - left;
      const height = Math.min(viewport.height, bounds.bottom) - top;
      if (width <= 0 || height <= 0) throw new Error("PDF region is outside the page.");

      const ratio = Math.min(2, 2048 / Math.max(width, height));
      const canvas = owner.createElement("canvas");
      canvas.width = Math.ceil(width * ratio);
      canvas.height = Math.ceil(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not create a PDF preview canvas.");
      await page.render({
        canvasContext: context,
        viewport,
        transform: [ratio, 0, 0, ratio, -left * ratio, -top * ratio],
        background: "white"
      }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode PDF crop.")));
      });
      return { blob, width: Math.max(1, Math.round(width)) };
    } finally {
      document.users -= 1;
      if (document.users === 0) {
        if (this.documents.get(file) === document) this.documents.delete(file);
        void document.task.destroy().catch(console.error);
      }
    }
  }
}

class RegionImageEmbed extends MarkdownRenderChild {
  private readonly image: HTMLImageElement;
  private linkIcon?: HTMLButtonElement;
  private revision = 0;
  private url?: string;
  private blob?: Blob;

  constructor(
    container: HTMLElement,
    readonly file: TFile,
    private readonly region: LinkedSelection,
    private readonly embeds: RegionEmbeds
  ) {
    super(container);
    this.image = container.ownerDocument.createElement("img");
    this.image.className = this.isPdf ? "modern-draw-region-image modern-draw-pdf-crop" : "modern-draw-region-image";
    this.image.alt = this.description;
    this.image.draggable = false;
    this.image.tabIndex = 0;
  }

  get isPdf(): boolean {
    return "page" in this.region;
  }

  get assetPath(): string | undefined {
    return "id" in this.region ? `${SNAPSHOT_FOLDER}/${this.region.id}.png` : undefined;
  }

  private get description(): string {
    return "page" in this.region
      ? `PDF selection from ${this.file.basename}, page ${this.region.page}`
      : `Snapshot of ${this.file.basename}`;
  }

  onload(): void {
    this.containerEl.classList.add("image-embed", "modern-draw-region-embed");
    this.containerEl.dataset.modernDrawRegion = "page" in this.region ? pdfRegionSubpath(this.region) : this.region.id;
    if (this.isPdf) this.containerEl.classList.add("modern-draw-pdf-embed");
    this.containerEl.appendChild(this.image);
    this.linkIcon = regionLinkIcon(this.containerEl, `Open source: ${this.description}`, () => {
      this.embeds.openRegion(this.file, this.region);
    });
    this.registerDomEvent(this.image, "click", (event) => {
      // Obsidian opens its image viewer on the click preceding dblclick when
      // an image is already selected. Leave zoom available in the image actions.
      if (event.detail > 1 || this.containerEl.classList.contains("is-selected")
        || this.containerEl.closest(".markdown-reading-view")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    this.registerDomEvent(this.image, "dblclick", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.embeds.openRegion(this.file, this.region);
    });
    this.registerDomEvent(this.image, "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      this.embeds.openRegion(this.file, this.region);
    });
    this.registerDomEvent(this.containerEl, "contextmenu", (event) => this.openImageMenu(event), true);
    this.embeds.attach(this);
    this.embeds.updateTheme();
    this.embeds.watch(this);
  }

  async loadFile(): Promise<void> {
    const revision = ++this.revision;
    try {
      const { blob, width } = await this.embeds.crop(this.file, this.region, this.containerEl.ownerDocument);
      if (revision !== this.revision) return;
      this.releaseUrl();
      this.blob = blob;
      this.url = URL.createObjectURL(blob);
      const displayWidth = Math.min(10_000, Math.round(("page" in this.region ? this.region.width : undefined) ?? width));
      this.image.style.setProperty("--modern-draw-region-image-width", `${displayWidth}px`);
      if (!this.image.getAttribute("alt")) this.image.alt = this.description;
      this.image.src = this.url;
    } catch (error) {
      if (revision !== this.revision) return;
      if (!this.url) this.image.alt = `${this.description} is unavailable`;
      console.error("Modern Draw: Could not render linked image.", error);
    }
  }

  onunload(): void {
    this.revision += 1;
    this.releaseUrl();
    this.embeds.detach(this);
    this.containerEl.classList.remove("image-embed", "modern-draw-region-embed", "modern-draw-pdf-embed", "mod-themed");
    delete this.containerEl.dataset.modernDrawRegion;
    this.linkIcon?.remove();
    this.image.remove();
  }

  private openImageMenu(event: MouseEvent): void {
    // The native image menu assumes a separate image file. Copy the raster
    // here and keep file actions from targeting the source PDF.
    const target = event.target as Element | null;
    if (target !== this.image && !target?.closest(".image-wrapper")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const menu = new Menu();
    const blob = this.blob;
    if (blob) menu.addItem((item) => item.setTitle("Copy image").setIcon("copy").onClick(() => {
      void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
        .catch(() => new Notice("Could not copy the linked image."));
    }));
    menu.addItem((item) => item.setTitle("Open source region").setIcon("file").onClick(() => {
      this.embeds.openRegion(this.file, this.region);
    }));
    const handle = this.containerEl.querySelector(".image-resize-corner");
    if (handle && this.image.hasAttribute("width")) {
      menu.addItem((item) => item.setTitle("Reset size").setIcon("rotate-ccw").onClick(() => {
        handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }));
    }
    menu.showAtMouseEvent(event);
  }

  private releaseUrl(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    this.blob = undefined;
  }
}
