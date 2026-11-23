import type { EditorView } from "@codemirror/view";
import type { MarkdownView, Pos } from "obsidian";
import { REGION_FLASH_MS } from "./snapshot-region";

export class RegionArrival {
  private readonly current = new WeakMap<HTMLElement, object>();
  private readonly flashes = new Map<HTMLElement, () => void>();
  private destroyed = false;

  highlight(container: HTMLElement, locate: () => HTMLElement | undefined, reveal = false, signal?: AbortSignal): void {
    const owner = container.ownerDocument.defaultView ?? window;
    const request = {};
    this.current.set(container, request);
    const deadline = owner.performance.now() + 2500;
    const render = () => {
      if (this.destroyed || signal?.aborted || !container.isConnected || this.current.get(container) !== request) return;
      const image = locate();
      if (!image) {
        if (owner.performance.now() < deadline) owner.requestAnimationFrame(render);
        return;
      }
      if (reveal) image.scrollIntoView({ block: "nearest", inline: "nearest" });
      this.flashes.get(image)?.();
      image.classList.add("modern-draw-region-arrival");
      const timer = signal ? undefined : owner.setTimeout(() => remove(), REGION_FLASH_MS);
      const remove = () => {
        owner.clearTimeout(timer);
        signal?.removeEventListener("abort", remove);
        image.classList.remove("modern-draw-region-arrival");
        this.flashes.delete(image);
      };
      this.flashes.set(image, remove);
      signal?.addEventListener("abort", remove, { once: true });
    };
    owner.requestAnimationFrame(render);
  }

  destroy(): void {
    this.destroyed = true;
    for (const remove of this.flashes.values()) remove();
  }
}

export function linkedImage(container: HTMLElement, key: string): HTMLElement | undefined {
  return imageCandidates(container, key)[0]?.image;
}

export function markdownLinkLine(view: MarkdownView, position: Pos): HTMLElement | undefined {
  const editor = view.editor as typeof view.editor & { cm?: EditorView };
  const cm = view.getMode() === "source" ? editor.cm : undefined;
  if (!cm || position.start.line >= cm.state.doc.lines) return;
  const line = cm.state.doc.line(position.start.line + 1);
  if (line.to < cm.viewport.from || line.from > cm.viewport.to) return;
  const node = cm.domAtPos(Math.min(line.from + position.start.col, line.to)).node;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  return element?.closest<HTMLElement>(".cm-line, .cm-embed-block") ?? undefined;
}

export function markdownLinkedImage(view: MarkdownView, key: string, position: Pos): HTMLElement | undefined {
  const candidates = imageCandidates(view.contentEl, key);
  const editor = view.editor as typeof view.editor & { cm?: EditorView };
  const cm = view.getMode() === "source" ? editor.cm : undefined;
  if (cm) {
    let closest: HTMLElement | undefined;
    let distance = Infinity;
    for (const { embed, image } of candidates) {
      if (!cm.contentDOM.contains(embed)) continue;
      try {
        const offset = cm.posAtDOM(embed);
        const delta = Math.abs(offset - position.start.offset);
        if (cm.state.doc.lineAt(offset).number - 1 === position.start.line && delta < distance) {
          closest = image;
          distance = delta;
        }
      } catch {
        // A section can be detached while CodeMirror replaces its widgets.
      }
    }
    return closest;
  }
  const pane = view.contentEl.getBoundingClientRect();
  const center = (pane.top + pane.bottom) / 2;
  const scored = candidates.map(({ image }) => {
    const rect = image.getBoundingClientRect();
    return { image, distance: Math.abs((rect.top + rect.bottom) / 2 - center) };
  });
  return scored.sort((a, b) => a.distance - b.distance)[0]?.image;
}

function imageCandidates(container: HTMLElement, key: string): { embed: HTMLElement; image: HTMLElement }[] {
  const embeds = container.querySelectorAll<HTMLElement>("[data-modern-draw-region]");
  const matches: { embed: HTMLElement; image: HTMLElement }[] = [];
  for (const embed of embeds) {
    if (embed.dataset.modernDrawRegion !== key) continue;
    const image = embed.querySelector<HTMLElement>(".modern-draw-region-image");
    if (image && image.getBoundingClientRect().width > 0) matches.push({ embed, image });
  }
  return matches;
}
