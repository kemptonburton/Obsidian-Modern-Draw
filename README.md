# Modern Draw for Obsidian

Write with an Apple Pencil, sketch over a Markdown note, or mark up a PDF slide on Canvas. Modern Draw adds editable vector ink to Obsidian's **Live Preview** and **Canvas**. You can type, draw, and work with images on the same page. Your notes stay as ordinary Markdown or Canvas files, and the ink lives alongside them in your vault.

## What you can do

- **Draw and annotate.** Use a pen, highlighter, or stroke eraser with a mouse or stylus. Save frequently used colors and widths as presets. Turn off pressure-based line width for a consistent stroke.
- **Work with text and ink together.** Select text and ink in the same rows, delete them together, or restore both with Undo. Use the lasso to select and move ink, text, and images, or insert space between sections.
- **Arrange the page.** Float an image out of the text flow, then move or resize it. Choose centered, left-aligned, or scrollable left alignment. Scrollable left adds blank writing space on the right and a faint guide along the left edge of the page. Zoom from 10% to 250% with pinch, toolbar buttons, or Ctrl/Cmd+wheel. Each device keeps its own layout and zoom for each note.
- **Mark up PDFs and slides.** Import PDF pages into a note or onto Canvas. In notes, page-relative ink follows the image when its display width changes. On desktop, export a note to PDF or a Canvas to an image.
- **Reuse a region.** Copy a rectangle from a note, Canvas, or PDF into another note. Double-click the capture to jump back to its source.

## Install from source

You need Obsidian 1.5.0 or later and Node.js 20 or later on the computer building the plugin.

```sh
git clone https://github.com/kemptonburton/Obsidian-Modern-Draw.git
cd Obsidian-Modern-Draw
npm ci
npm run deploy -- "/path/to/your/vault"
```

Replace the last argument with your vault folder. For example, on Windows you can use `"C:/Notes/My Vault"`. Open **Settings → Community plugins**, allow community plugins if prompted, and enable **Modern Draw**. Open a note in Live Preview or open a Canvas to see the toolbar.

For a manual install, run `npm run build` and copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/modern-draw/` in the vault. To update an existing install, replace those three files and reload Obsidian on each device.

## Write on iPad

1. Open **Settings → Modern Draw** and enable **Stylus-only touch drawing**. One finger scrolls and two fingers pinch to zoom while Apple Pencil draws.
2. Choose your **Writing hand** and adjust **Palm rest height**. The bottom rest blocks finger and palm gestures while accepting Pencil strokes.
3. Use **Stylus pressure affects width** to choose between pressure-sensitive and consistent lines. If you want to switch between the eraser and your last drawing tool by tapping twice on the page, enable **Double-tap to switch eraser**.
4. Switch to **Select** when you want the text cursor and keyboard. Tap an image to show its resize handle. The selection tools also apply to Apple Pencil. To recolor ink, lasso it and tap one of your saved pen presets.

## Import existing notes

Open **Import notes** in Modern Draw settings or search the command palette for **Import Excalidraw, OneNote, or Notability notes**. Imports can create Markdown notes or Canvas files with editable ink.

| Source | What to import |
| --- | --- |
| Excalidraw | Choose one drawing or copy a folder of drawings while preserving its structure. The optional **Convert original** action keeps the note path and saves a backup of the drawing. |
| OneNote | Choose a page, section, or notebook from the Windows desktop app. Open and sync the notebook in OneNote first. |
| Notability | Choose exported `.note` files. Export PDF backgrounds separately and import them using the PDF tool. |

Choose a **Scale reference** if you want new imports to match the handwriting and image size of an existing note. For a note that is already imported, use the **Scale note** toolbar button. Both controls resize the drawing itself. The zoom buttons change your view of the note.

## Ink files and Obsidian Sync

With the default storage setting, `Lectures/Week 1.md` saves its ink to `Lectures/_ink/Week 1.md.ink.json`. In **Settings → Modern Draw**, use **Default location for new ink files** to choose a different location. Keep the ink files and any attachments when backing up or moving a vault.

Modern Draw saves each committed stroke to the vault. For Obsidian Sync, install Modern Draw on both devices, enable **Sync all other types** and **Images**, and include your ink and attachment folders. Once both devices are running the current build, Modern Draw merges changes it receives for an open drawing, including deliberate erases. Obsidian Sync handles when files are transferred. [Obsidian Sync settings](https://obsidian.md/help/sync/settings)

## Develop

```sh
npm ci
npm run check
```

`check` runs TypeScript, the tests, and a production build. Use `npm run dev` to rebuild as you edit, or `npm run deploy -- "/path/to/test-vault"` to build and install a copy for testing in Obsidian.

Ink anchored to a Markdown line moves with edits above it. If the line wraps differently after a font or width change, the strokes retain their shape. Note and Canvas exports use Obsidian's desktop interfaces.

## License

[MIT](LICENSE)
