import type { DrawingTool, ModernDrawSettings } from "./model";

export type ControllerChange =
  | { kind: "tool"; source?: object }
  | { kind: "settings" };

type ControllerSubscriber = (change: ControllerChange) => void;

export interface ModernDrawController {
  readonly settings: ModernDrawSettings;
  readonly activeTool: DrawingTool;
  setTool(tool: DrawingTool, source?: object): void;
  updateSettings(settings: ModernDrawSettings): void;
  subscribe(subscriber: ControllerSubscriber): () => void;
}

export class DrawingController implements ModernDrawController {
  activeTool: DrawingTool = "select";
  settings: ModernDrawSettings;
  private readonly subscribers = new Set<ControllerSubscriber>();

  constructor(settings: ModernDrawSettings) {
    this.settings = settings;
  }

  setTool(tool: DrawingTool, source?: object): void {
    if (this.activeTool === tool && source !== undefined) return;
    this.activeTool = tool;
    this.emit({ kind: "tool", source });
  }

  updateSettings(settings: ModernDrawSettings): void {
    this.settings = settings;
    this.emit({ kind: "settings" });
  }

  subscribe(subscriber: ControllerSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private emit(change: ControllerChange): void {
    for (const subscriber of this.subscribers) subscriber(change);
  }
}
