import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawVaultPath = process.argv.slice(2).join(" ") || process.env.MODERN_DRAW_VAULT;
// npm.cmd may preserve command-shell carets around quoted arguments in some Windows hosts.
const vaultPath = rawVaultPath?.replace(/\^/g, "").replace(/^["']|["']$/g, "");

if (!vaultPath) {
  console.error('Usage: npm run deploy -- "C:\\path\\to\\vault"');
  process.exitCode = 2;
} else {
  const obsidianFolder = path.join(path.resolve(vaultPath), ".obsidian");
  try {
    const info = await stat(obsidianFolder);
    if (!info.isDirectory()) throw new Error(".obsidian is not a directory");
  } catch {
    console.error(`Not an Obsidian vault: ${path.resolve(vaultPath)}`);
    process.exitCode = 2;
  }

  if (!process.exitCode) {
    const target = path.join(obsidianFolder, "plugins", "modern-draw");
    await mkdir(target, { recursive: true });
    for (const filename of ["main.js", "styles.css", "manifest.json"]) {
      await copyFile(path.join(projectRoot, filename), path.join(target, filename));
    }
    console.log(`Modern Draw installed to ${target}`);
    console.log("In Obsidian, enable Modern Draw under Settings → Community plugins, or reload it after later builds.");
  }
}
