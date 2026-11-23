import { setIcon } from "obsidian";
import type { RegionDisplay } from "./model";
import { REGION_ICON, REGION_LABEL } from "./snapshot-region";

export class RegionAppearance {
  private readonly listeners = new Set<() => void>();
  constructor(public display: RegionDisplay) {}

  update(display: RegionDisplay): void {
    if (this.display === display) return;
    this.display = display;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function regionControl(parent: HTMLElement, select: () => void) {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.className = "clickable-icon modern-draw-control modern-draw-region-control";
  button.setAttribute("aria-label", REGION_LABEL);
  setIcon(button, REGION_ICON);
  button.addEventListener("click", select);
  parent.appendChild(button);
  return {
    setArmed: (armed: boolean) => button.setAttribute("aria-pressed", String(armed)),
    destroy: () => button.remove()
  };
}

export function regionLinkIcon(parent: HTMLElement, label: string, open: () => void): HTMLButtonElement {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.className = "modern-draw-region-link-icon";
  button.setAttribute("aria-label", label);
  setIcon(button, "arrow-up-right");
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    open();
  });
  parent.appendChild(button);
  return button;
}
