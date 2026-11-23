import { sameInkStyle, type DrawingTool, type InkStylePreset, type InkTool, type ModernDrawSettings } from "./model";

export interface SavedInkPreset {
  tool: InkTool;
  preset: InkStylePreset;
}

export function orderedInkPresets(settings: ModernDrawSettings): SavedInkPreset[] {
  const presets: SavedInkPreset[] = [
    ...settings.penPresets.map((preset): SavedInkPreset => ({ tool: "pen", preset })),
    ...settings.highlighterPresets.map((preset): SavedInkPreset => ({ tool: "highlighter", preset }))
  ];
  return presets.sort((first, second) =>
    (first.preset.order ?? Number.MAX_SAFE_INTEGER) - (second.preset.order ?? Number.MAX_SAFE_INTEGER));
}

export function moveInkPreset(
  settings: ModernDrawSettings, source: SavedInkPreset, before: SavedInkPreset | null
): ModernDrawSettings {
  const presets = orderedInkPresets(settings);
  const from = presets.findIndex((entry) => samePreset(entry, source));
  const to = before ? presets.findIndex((entry) => samePreset(entry, before)) : presets.length;
  if (from < 0 || to < 0 || to === from || to === from + 1) return settings;

  const [moved] = presets.splice(from, 1);
  presets.splice(to > from ? to - 1 : to, 0, moved);
  const penPresets: InkStylePreset[] = [];
  const highlighterPresets: InkStylePreset[] = [];
  presets.forEach(({ tool, preset }, order) => {
    (tool === "pen" ? penPresets : highlighterPresets).push({ ...preset, order });
  });
  return { ...settings, penPresets, highlighterPresets };
}

function samePreset(first: SavedInkPreset, second: SavedInkPreset): boolean {
  return first.tool === second.tool && sameInkStyle(first.preset, second.preset);
}

/** Per-surface working style. Shared settings are only used as initial defaults. */
export class LocalInkStyle {
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;

  constructor(settings: ModernDrawSettings) {
    this.penColor = settings.penColor;
    this.penWidth = settings.penWidth;
    this.highlighterColor = settings.highlighterColor;
    this.highlighterWidth = settings.highlighterWidth;
  }

  colorFor(tool: DrawingTool): string {
    return tool === "highlighter" ? this.highlighterColor : this.penColor;
  }

  widthFor(tool: DrawingTool): number {
    return tool === "highlighter" ? this.highlighterWidth : this.penWidth;
  }

  setColor(tool: DrawingTool, color: string): void {
    if (tool === "highlighter") this.highlighterColor = color;
    else this.penColor = color;
  }

  setWidth(tool: DrawingTool, width: number): void {
    if (tool === "highlighter") this.highlighterWidth = width;
    else this.penWidth = width;
  }
}

export function toggleInkPreset(settings: ModernDrawSettings, tool: InkTool, style: InkStylePreset): ModernDrawSettings {
  const key = tool === "pen" ? "penPresets" : "highlighterPresets";
  const presets = settings[key];
  if (presets.some((preset) => sameInkStyle(preset, style))) {
    return { ...settings, [key]: presets.filter((preset) => !sameInkStyle(preset, style)) };
  }
  const firstOrder = orderedInkPresets(settings)[0]?.preset.order;
  const added = firstOrder === undefined ? style : { ...style, order: firstOrder - 1 };
  return { ...settings, [key]: [added, ...presets].slice(0, 12) };
}

export function updateInkPreset(
  settings: ModernDrawSettings, tool: InkTool, original: InkStylePreset, replacement: InkStylePreset | null
): ModernDrawSettings {
  const key = tool === "pen" ? "penPresets" : "highlighterPresets";
  const presets = settings[key];
  const index = presets.findIndex((preset) => sameInkStyle(preset, original));
  if (index < 0) return settings;
  const updated = [...presets];
  if (replacement) updated[index] = { ...replacement, order: presets[index].order };
  else updated.splice(index, 1);
  return { ...settings, [key]: updated };
}
