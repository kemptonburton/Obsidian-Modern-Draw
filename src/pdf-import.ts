import { FuzzySuggestModal, Modal, Notice, Setting, loadPdfJs, type App, type MarkdownFileInfo, type TFile } from "obsidian";
import { capturePdfCursor, notePdfInsertion, type NotePdfPlacement } from "./note-pdf-placement";
import { openPdf } from "./pdf-embeds";
import { createStrokeId } from "./model";

export interface ImportedPdfPage {
  file: TFile;
  width: number;
  height: number;
}

export interface PdfImportDestination {
  kind: "note" | "canvas";
  file: TFile;
  owner: Document;
  available(): boolean;
  insert(pages: ImportedPdfPage[], placement: NotePdfPlacement): void;
}

export function notePdfImportDestination(app: App, target: MarkdownFileInfo): PdfImportDestination | undefined {
  const note = target.file;
  const editor = target.editor;
  if (!note || !editor) return;
  const cursor = capturePdfCursor(editor.getValue(), editor.posToOffset(editor.getCursor("head")));
  return {
    kind: "note",
    file: note,
    owner: "containerEl" in target ? (target.containerEl as HTMLElement).ownerDocument : document,
    available: () => target.file === note && Boolean(target.editor),
    insert: (pages, placement) => {
      const editor = target.editor;
      if (!editor || target.file !== note) throw new Error("The destination note was closed.");
      const links = pages.map(({ file }) => "!" + app.fileManager.generateMarkdownLink(file, note.path, undefined, "760"));
      const { from, insert } = notePdfInsertion(editor.getValue(), links, placement === "cursor" ? cursor : undefined);
      editor.replaceRange(insert, editor.offsetToPos(from));
    }
  };
}

export class PdfImportModal extends Modal {
  constructor(app: App, private readonly target: PdfImportDestination) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Import PDF pages or slides");
    const placement = this.target.kind === "canvas"
      ? "Each page is added to this Canvas as an image card you can draw on."
      : "Each page is added as an image you can draw on.";
    this.contentEl.createEl("p", { text: placement + " For slide decks, use a PDF copy." });
    let insertPages: NotePdfPlacement = "end";
    if (this.target.kind === "note") {
      new Setting(this.contentEl).setName("Insert pages").addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", "Insert pages");
        dropdown.addOption("cursor", "At cursor").addOption("end", "End of note")
          .setValue(insertPages)
          .onChange((value) => { insertPages = value === "cursor" ? "cursor" : "end"; });
      });
    }
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const device = buttons.createEl("button", { text: "Choose a PDF" });
    const vault = buttons.createEl("button", { text: "Use a vault PDF" });
    const input = this.contentEl.createEl("input", { type: "file", attr: { accept: ".pdf,application/pdf" } });
    input.hidden = true;
    if (!this.target.available()) return;
    device.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      this.close();
      void importPages(this.app, this.target, insertPages, file.name, file.arrayBuffer());
    });
    vault.addEventListener("click", () => {
      const selectedPlacement = insertPages;
      this.close();
      new VaultPdfPicker(this.app, (file) => {
        void importPages(this.app, this.target, selectedPlacement, file.name, this.app.vault.readBinary(file));
      }).open();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class VaultPdfPicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("Choose a PDF from this vault");
  }

  getItems(): TFile[] { return this.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === "pdf"); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

async function importPages(
  app: App, target: PdfImportDestination, placement: NotePdfPlacement, filename: string, bytes: Promise<ArrayBuffer>
): Promise<void> {
  const progress = new Notice("Opening PDF…", 0);
  const pages: ImportedPdfPage[] = [];
  const { owner, file: destination } = target;
  const checkDestination = (): void => {
    if (!target.available()) throw new Error("The destination was closed or is read-only.");
  };
  try {
    const [pdfjs, data] = await Promise.all([loadPdfJs(), bytes]);
    const task = openPdf(pdfjs, { data }, owner);
    try {
      const pdf = await task.promise;
      const title = filename.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N} _-]/gu, "-").slice(0, 64) || "PDF";
      const importId = createStrokeId();
      for (let number = 1; number <= pdf.numPages; number += 1) {
        checkDestination();
        progress.setMessage(`Importing page ${number} of ${pdf.numPages}…`);
        const page = await pdf.getPage(number);
        try {
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(4, 2048 / Math.max(original.width, original.height)) });
          const canvas = owner.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Could not create a PDF drawing surface.");
          await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, 0, 0], background: "white" }).promise;
          let blob = await encodePage(canvas, "image/png");
          if (blob.size > 4_800_000) blob = await encodePage(canvas, "image/jpeg");
          canvas.width = canvas.height = 0;
          const extension = blob.type === "image/jpeg" ? "jpg" : "png";
          const path = await app.fileManager.getAvailablePathForAttachment(
            `${title}-mdpage-${importId}-${number}.${extension}`, destination.path
          );
          const image = await app.vault.createBinary(path, await blob.arrayBuffer());
          pages.push({ file: image, width: original.width, height: original.height });
        } finally {
          page.cleanup();
        }
      }
      checkDestination();
      target.insert(pages, placement);
    } finally {
      await task.destroy().catch(console.error);
    }
    new Notice(`Imported ${pages.length} PDF ${pages.length === 1 ? "page" : "pages"}.`);
  } catch (error) {
    await Promise.allSettled(pages.map(({ file }) => app.vault.delete(file)));
    console.error("Modern Draw: Could not import PDF pages.", error);
    new Notice(`Could not import PDF pages. ${error instanceof Error ? error.message : ""}`);
  } finally {
    progress.hide();
  }
}

function encodePage(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg"): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode PDF page.")), type, 0.94);
  });
}
