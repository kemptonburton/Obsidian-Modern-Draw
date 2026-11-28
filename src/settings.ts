import { App, PluginSettingTab, Setting } from "obsidian";
import manifest from "../manifest.json";
import type ModernDrawPlugin from "./main";
import { NoteImportModal } from "./import-modal";
import { parseRegionDisplay, type InkLocation, type ToolbarAlignment } from "./model";

export class ModernDrawSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ModernDrawPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: `Modern Draw ${manifest.version}` });
    new Setting(containerEl).setName("Import Excalidraw, OneNote, and Notability").setDesc("Import notes and drawings with editable Modern Draw ink.").addButton((button) => button.setButtonText("Import notes").onClick(() => new NoteImportModal(this.app, this.plugin).open()));
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Ink is saved in .ink.json files in your vault. Enable Sync all other types on each device to sync drawings."
    });

    new Setting(containerEl)
      .setName("Use the stylus eraser tip")
      .setDesc("A stylus eraser tip erases while using a drawing tool. The selected cursor and lasso tools also apply to the stylus.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoDrawWithPen).onChange(async (value) => {
          await this.plugin.updateSetting("autoDrawWithPen", value);
        })
      );

    new Setting(containerEl)
      .setName("Stylus pressure affects width")
      .setDesc("Turn off for new Apple Pencil and stylus strokes to stay at the selected pen width.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.stylusPressure)
        .onChange((value) => this.plugin.updateSetting("stylusPressure", value)));

    new Setting(containerEl)
      .setName("Default location for new ink files")
      .setDesc("Existing drawings stay in the folder where they were saved.")
      .addDropdown((dropdown) => dropdown
        .addOption("root", "Vault folder")
        .addOption("same", "Same folder as current file")
        .addOption("subfolder", "In subfolder under current folder")
        .addOption("fixed", "In the folder specified below")
        .setValue(this.plugin.settings.inkLocation)
        .onChange(async (value) => {
          await this.plugin.updateSetting("inkLocation", value as InkLocation);
          this.display();
        }));
    const location = this.plugin.settings.inkLocation;
    if (location === "subfolder" || location === "fixed") {
      const relative = location === "subfolder";
      const key = relative ? "inkSubfolder" : "inkFolder";
      new Setting(containerEl)
        .setName(relative ? "Subfolder name" : "Folder path")
        .setDesc(relative ? "A folder inside the source file’s folder." : "A folder relative to the vault root.")
        .addText((input) => {
          input.setPlaceholder("_ink").setValue(this.plugin.settings[key]);
          input.inputEl.addEventListener("change", () => {
            const value = input.getValue().trim();
            if (!value || value.split(/[\\/]/).some((part) => !part.trim() || part.startsWith("."))
              || /[:*?"<>|]/.test(value)) {
              input.setValue(this.plugin.settings[key]);
              return;
            }
            void this.plugin.updateSetting(key, value.replace(/\\/g, "/"));
          });
        });
    }

    new Setting(containerEl)
      .setName("Writing hand")
      .setDesc("Choose a hand to enable the bottom palm rest.")
      .addDropdown((dropdown) => dropdown
        .addOption("off", "Off")
        .addOption("left", "Left hand")
        .addOption("right", "Right hand")
        .setValue(this.plugin.settings.writingHand)
        .onChange((value) => this.plugin.updateSetting("writingHand", value === "left" || value === "right" ? value : "off")));

    new Setting(containerEl)
      .setName("Toolbar alignment")
      .setDesc("Choose where the toolbar sits in notes and Canvas.")
      .addDropdown((dropdown) => dropdown
        .addOption("writing-hand", "Follow writing hand")
        .addOption("center", "Centered")
        .addOption("left", "Left")
        .addOption("right", "Right")
        .setValue(this.plugin.settings.toolbarAlignment)
        .onChange((value) => this.plugin.updateSetting("toolbarAlignment", value as ToolbarAlignment)));

    new Setting(containerEl)
      .setName("Double-tap to switch eraser")
      .setDesc("Double-tap the drawing area with a finger or stylus to switch between the eraser and your last pen or highlighter.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.doubleTapToErase)
        .onChange((value) => this.plugin.updateSetting("doubleTapToErase", value)));

    new Setting(containerEl)
      .setName("Palm rest height")
      .setDesc("Block finger and palm gestures that start in the bottom 5% to 45% of the drawing area. Your stylus can still write there.")
      .addSlider((slider) => slider.setLimits(5, 45, 1).setDynamicTooltip()
        .setValue(this.plugin.settings.palmRestHeight)
        .onChange((value) => this.plugin.updateSetting("palmRestHeight", value)));

    new Setting(containerEl)
      .setName("Stylus-only touch drawing")
      .setDesc("Use your fingers to scroll and pinch to zoom above the palm rest. Use a stylus or mouse to draw.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.penOnly)
        .onChange((value) => this.plugin.updateSetting("penOnly", value)));

    new Setting(containerEl)
      .setName("Black and white export")
      .setDesc("Print pen strokes in black and highlighter strokes in gray. Imported pages print in grayscale.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.monochromeExport)
        .onChange((value) => this.plugin.updateSetting("monochromeExport", value)));

    new Setting(containerEl)
      .setName("Show drawing toolbar")
      .setDesc("Show drawing controls in Markdown editors and Canvas.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showToolbar).onChange(async (value) => {
          await this.plugin.updateSetting("showToolbar", value);
        })
      );

    new Setting(containerEl)
      .setName("Default pen color")
      .setDesc("Used when a note or Canvas pane opens. Pen style presets are shared across panes.")
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.settings.penColor).onChange(async (value) => {
          await this.plugin.updateSetting("penColor", value);
        })
      );

    new Setting(containerEl)
      .setName("Default pen width")
      .setDesc(`${this.plugin.settings.penWidth.toFixed(1)} px. Each open pane can then use its own working size.`)
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 0.5)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.penWidth)
          .onChange(async (value) => {
            await this.plugin.updateSetting("penWidth", value);
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Default highlighter color")
      .setDesc("Used when a note or Canvas pane opens. Highlighter style presets are shared across panes.")
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.settings.highlighterColor).onChange(async (value) => {
          await this.plugin.updateSetting("highlighterColor", value);
        })
      );

    new Setting(containerEl)
      .setName("Default highlighter width")
      .setDesc(`${this.plugin.settings.highlighterWidth.toFixed(0)} px. Each open pane can then use its own working size.`)
      .addSlider((slider) =>
        slider
          .setLimits(8, 40, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.highlighterWidth)
          .onChange(async (value) => {
            await this.plugin.updateSetting("highlighterWidth", value);
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Eraser radius")
      .setDesc(`${this.plugin.settings.eraserRadius.toFixed(0)} px`)
      .addSlider((slider) =>
        slider
          .setLimits(4, 40, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.eraserRadius)
          .onChange(async (value) => {
            await this.plugin.updateSetting("eraserRadius", value);
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Linked rectangle display")
      .setHeading()
      .setDesc("Choose how linked areas appear at the source. Jumps always give a brief outline.");

    for (const [key, label] of [
      ["noteRegionDisplay", "Notes"],
      ["canvasRegionDisplay", "Canvas"],
      ["pdfRegionDisplay", "PDFs"]
    ] as const) {
      new Setting(containerEl)
        .setName(label)
        .addDropdown((dropdown) => dropdown
          .addOption("hidden", "Hidden")
          .addOption("icon", "Link icon only")
          .addOption("border", "Dotted border and link icon")
          .addOption("full", "Full highlight and link icon")
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            const display = parseRegionDisplay(value);
            if (display) await this.plugin.updateSetting(key, display);
          })
        );
    }

    new Setting(containerEl)
      .setName("Normal rectangle color")
      .setDesc("Used for resting linked rectangles.")
      .addColorPicker((picker) => picker.setValue(this.plugin.settings.regionOutlineColor)
        .onChange(async (value) => this.plugin.updateSetting("regionOutlineColor", value)));

    new Setting(containerEl)
      .setName("Active highlight color")
      .setDesc("Used when hovering a sidebar link or jumping to a linked spot.")
      .addColorPicker((picker) => picker.setValue(this.plugin.settings.regionHighlightColor)
        .onChange(async (value) => this.plugin.updateSetting("regionHighlightColor", value)));

    new Setting(containerEl)
      .setName("Pin title and properties horizontally")
      .setDesc("Keep the inline note title and Properties block visible while panning across the drawing canvas.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pinHeaderDuringHorizontalScroll).onChange(async (value) => {
          await this.plugin.updateSetting("pinHeaderDuringHorizontalScroll", value);
        })
      );

    new Setting(containerEl)
      .setName("Ink smoothing")
      .setDesc("Higher values produce cleaner curves; lower values follow raw pen input more closely.")
      .addSlider((slider) =>
        slider
          .setLimits(0.2, 1, 0.05)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.strokeSmoothing)
          .onChange(async (value) => {
            await this.plugin.updateSetting("strokeSmoothing", value);
          })
      );
  }
}
