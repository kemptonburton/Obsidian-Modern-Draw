import { FuzzySuggestModal, Modal, Notice, Setting, type App, type TFile } from "obsidian";
import { matchDrawingScale, measureDrawingScale, validateScale, type DrawingScale } from "./drawing-scale";
import type { InkStore } from "./ink-store";

export class ScaleNoteModal extends Modal {
  constructor(
    app: App,
    private readonly store: InkStore,
    private readonly sourcePath: string,
    private readonly targetScale: () => DrawingScale,
    private readonly apply: (factor: number) => void
  ) { super(app); }

  onOpen(): void {
    this.setTitle("Scale note");
    this.contentEl.createEl("p", { text: "Resize all ink, floating images, and linked rectangles together. 50% halves their size. 200% doubles it. You can undo the change." });
    let percentage = "100";
    const field = new Setting(this.contentEl).setName("Scale by (%)");
    let setPercentage = (value: string): void => { percentage = value; };
    field.addText((input) => {
      input.inputEl.type = "number";
      input.inputEl.step = "any";
      input.setValue(percentage).onChange((value) => { percentage = value; });
      setPercentage = (value) => { percentage = value; input.setValue(value); };
    });
    const reference = new Setting(this.contentEl).setName("Reference note")
      .setDesc("Match typical pen-stroke height, or match image width when both notes lack comparable handwriting.");
    reference.addButton((button) => button.setButtonText("Choose note").onClick(() => {
      new ScaleReferencePicker(this.app, async (file) => {
        try {
          const scale = await readScaleReference(this.app, this.store, file.path);
          const { factor, measure } = matchDrawingScale(this.targetScale(), scale);
          setPercentage(String(factor * 100));
          reference.setDesc(`${file.basename} · matched by ${measure}`);
        } catch (error) { new Notice(String(error)); }
      }, this.sourcePath).open();
    }));
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Apply scale").setCta().onClick(() => {
      try {
        const factor = Number(percentage) / 100;
        validateScale(factor);
        this.apply(factor);
        this.close();
      } catch (error) { new Notice(String(error)); }
    }));
  }
}

export async function readScaleReference(app: App, store: InkStore, path: string): Promise<DrawingScale> {
  const file = app.vault.getFileByPath(path);
  if (file?.extension !== "md") throw new Error(`Scale reference note could not be found: ${path}`);
  const ink = await store.getDocument(file.path);
  const scale = measureDrawingScale(ink.strokes, ink.floatingImages);
  if (!scale.handwriting && !scale.imageWidth) throw new Error("The reference note has no measurable handwriting or saved image widths.");
  return scale;
}

export class ScaleReferencePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void, private readonly exclude?: string) {
    super(app);
    this.setPlaceholder("Choose a scale reference note");
  }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles().filter((file) => file.path !== this.exclude); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}
