import { FuzzySuggestModal, Modal, Notice, Setting, type App, type TFile } from "obsidian";
import type ModernDrawPlugin from "./main";
import { convertExcalidrawNote, importExcalidraw, saveImportedDrawing, type ImportDrawing } from "./note-import";
import { decodeOneNotePage, oneNoteEntries, readOneNote, type OneNoteEntry } from "./onenote-import";
import { importNotability } from "./notability-import";
import { NOMINAL_IMPORT_WIDTH, validateScale, type ImportScaleOptions } from "./drawing-scale";
import { readScaleReference, ScaleReferencePicker } from "./scale-note-modal";

export class NoteImportModal extends Modal {
  constructor(app: App, private readonly plugin: ModernDrawPlugin) { super(app); }
  onOpen(): void {
    this.setTitle("Import notes and drawings");
    let folder = "04 - Fleeting/plugin tests";
    let kind: "md" | "canvas" = "md";
    let convertOriginal = false;
    let scalePercentage = String(this.plugin.settings.importScale * 100);
    let referencePath = this.plugin.settings.importScaleReference;
    let matchNotability = this.plugin.settings.matchNotabilityImportSize;
    new Setting(this.contentEl).setName("Destination folder").addText((t) => t.setValue(folder).onChange((v) => { folder = v.trim(); }));
    new Setting(this.contentEl).setName("Create").addDropdown((d) => d.addOption("md", "Markdown with Modern Draw ink").addOption("canvas", "Canvas with Modern Draw ink").onChange((v) => { kind = v === "canvas" ? "canvas" : "md"; }));
    new Setting(this.contentEl).setName("Import scale (%)").setDesc("Resizes ink and images together. At 100%, use the reference note’s scale.").addText((input) => {
      input.inputEl.type = "number";
      input.inputEl.step = "any";
      input.setValue(scalePercentage).onChange((value) => { scalePercentage = value; });
      input.inputEl.addEventListener("change", () => {
        const factor = Number(scalePercentage) / 100;
        if (Number.isFinite(factor) && factor > 0) void this.plugin.updateSetting("importScale", factor);
      });
    });
    const reference = new Setting(this.contentEl).setName("Scale reference");
    const standard = new Setting(this.contentEl).setName("Use standard import width")
      .setDesc(`Fit OneNote and Excalidraw drawings to ${NOMINAL_IMPORT_WIDTH} px when no reference note is selected.`)
      .addToggle((toggle) => toggle.setValue(matchNotability).onChange(async (value) => {
      matchNotability = value;
      await this.plugin.updateSetting("matchNotabilityImportSize", value);
    }));
    const updateReference = (): void => {
      reference.setDesc(referencePath || "Choose a note to match its handwriting size or, when needed, image width for future imports.");
      standard.setDisabled(Boolean(referencePath));
    };
    updateReference();
    reference.addButton((button) => button.setButtonText("Choose note").onClick(() => {
      new ScaleReferencePicker(this.app, async (file) => {
        try {
          await readScaleReference(this.app, this.plugin.store, file.path);
          referencePath = file.path;
          updateReference();
          await this.plugin.updateSetting("importScaleReference", referencePath);
        } catch (error) { new Notice(String(error)); }
      }).open();
    })).addButton((button) => button.setButtonText("Clear").onClick(async () => {
      referencePath = "";
      updateReference();
      await this.plugin.updateSetting("importScaleReference", referencePath);
    }));
    this.contentEl.createEl("p", { text: "Handwriting becomes editable ink. Images stay separate, and PDF rectangle links become native rectangle embeds. Imports create new files. OneNote requires the Windows desktop app with the notebook open and synced." });
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const buttons: HTMLButtonElement[] = [];
    const run = async (jobs: { name: string; folder: string; load: () => Promise<ImportDrawing>; convert?: TFile }[]): Promise<void> => {
      buttons.forEach((b) => { b.disabled = true; });
      let scaling: ImportScaleOptions;
      try {
        const factor = Number(scalePercentage) / 100;
        validateScale(factor);
        scaling = { factor, matchNotability, reference: referencePath ? await readScaleReference(this.app, this.plugin.store, referencePath) : undefined };
      } catch (error) {
        status.setText(String(error));
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      const failures: string[] = [];
      let completed = 0;
      const warnings: string[] = [];
      for (const job of jobs) {
        status.setText(`Importing ${completed + failures.length + 1} of ${jobs.length} — ${job.name}`);
        try {
          if (job.convert) await convertExcalidrawNote(this.app, this.plugin.store, job.convert, scaling);
          else {
            const drawing = await job.load();
            await saveImportedDrawing(this.app, this.plugin.store, drawing, job.folder, kind, undefined, scaling);
            warnings.push(...drawing.warnings);
          }
          completed++;
        }
        catch (error) { failures.push(`${job.name} — ${String(error)}`); }
      }
      status.setText(`Imported ${completed} of ${jobs.length}. ${[...failures, ...warnings].join("\n")}`);
      new Notice(`Imported ${completed} of ${jobs.length} notes.`);
      buttons.forEach((b) => { b.disabled = false; });
    };
    const files = (): TFile[] => this.app.vault.getFiles().filter((f) => f.extension === "excalidraw" || (f.extension === "md" && Boolean(this.app.metadataCache.getFileCache(f)?.frontmatter?.["excalidraw-plugin"])));
    new Setting(this.contentEl).setName("Notability notes").setDesc("Choose .note exports. Handwriting becomes editable ink. PDF backgrounds require a separate PDF export for now.").addButton((button) => {
      buttons.push(button.buttonEl);
      const input = this.contentEl.createEl("input", { type: "file", attr: { accept: ".note", multiple: "" } });
      input.hidden = true;
      button.setButtonText("Choose notes").onClick(() => input.click());
      input.addEventListener("change", () => {
        const selected = Array.from(input.files ?? []);
        input.value = "";
        void run(selected.map((file) => ({ name: file.name, folder, load: async () => importNotability(new Uint8Array(await file.arrayBuffer()), file.name) })));
      });
    });
    new Setting(this.contentEl).setName("Excalidraw action").setDesc("Convert original creates a normal Markdown note in the same location and saves the original drawing in _attachments as a backup. The destination folder applies to copies.").addDropdown((d) => d.addOption("copy", "Import a copy").addOption("convert", "Convert original to Markdown with ink").onChange((v) => { convertOriginal = v === "convert"; }));
    new Setting(this.contentEl).setName("Excalidraw note").addButton((b) => { buttons.push(b.buttonEl); b.setButtonText("Choose note").onClick(() => new ImportPicker(this.app, files(), (f) => f.path, (f) => { void run([{ name: f.basename, folder, convert: convertOriginal ? f : undefined, load: () => importExcalidraw(this.app, f) }]); }).open()); });
    let sourceFolder = "";
    new Setting(this.contentEl).setName("Excalidraw source folder").setDesc("Imports every Excalidraw note below this folder and preserves subfolders. Leave blank for the vault.").addText((t) => t.onChange((v) => { sourceFolder = v.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); })).addButton((b) => {
      buttons.push(b.buttonEl); b.setButtonText("Import folder").onClick(() => {
        const prefix = sourceFolder ? sourceFolder + "/" : "";
        void run(files().filter((f) => f.path.startsWith(prefix)).map((f) => ({ name: f.basename, convert: convertOriginal ? f : undefined, folder: [folder, f.path.slice(prefix.length).split("/").slice(0, -1).join("/")].filter(Boolean).join("/"), load: () => importExcalidraw(this.app, f) })));
      });
    });
    new Setting(this.contentEl).setName("OneNote page, section, or notebook").setDesc("Choose a page for a test import or choose a notebook to import its pages with the same folder structure.").addButton((b) => {
      buttons.push(b.buttonEl); b.setButtonText("Browse OneNote").onClick(async () => {
        b.setDisabled(true); status.setText("Reading OneNote notebooks…");
        try {
          const entries = oneNoteEntries(await readOneNote());
          new ImportPicker<OneNoteEntry>(this.app, entries, (e) => `${e.path} (${e.kind})`, (selected) => {
            const pages = selected.kind === "Page" ? [selected] : entries.filter((e) => e.kind === "Page" && e.path.startsWith(selected.path + "/"));
            void run(pages.map((e) => ({ name: e.name, folder: [folder, e.path.split("/").slice(0, -1).join("/")].filter(Boolean).join("/"), load: async () => decodeOneNotePage(await readOneNote(e.id), e.name) })));
          }).open();
          status.setText("Choose a OneNote page, section, or notebook.");
        } catch (error) { status.setText(String(error)); } finally { b.setDisabled(false); }
      });
    });
  }
}

class ImportPicker<T> extends FuzzySuggestModal<T> {
  constructor(app: App, private readonly items: T[], private readonly label: (item: T) => string, private readonly choose: (item: T) => void) { super(app); }
  getItems(): T[] { return this.items; }
  getItemText(item: T): string { return this.label(item); }
  onChooseItem(item: T): void { this.choose(item); }
}
