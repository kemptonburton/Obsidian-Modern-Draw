import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const context = await esbuild.context({
  absWorkingDir: projectRoot,
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  bundle: true,
  loader: { ".ps1": "text" },
  external: ["obsidian", "electron", "@codemirror/commands", "@codemirror/state", "@codemirror/view", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: fileURLToPath(new URL("./main.js", import.meta.url))
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Modern Draw: watching for changes...");
}
