import type { InkPoint, ModernDrawSettings } from "./model";

export interface PinchGesture {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  scale: number;
}

export function isPalmPointer(event: PointerEvent, viewport: HTMLElement, settings: ModernDrawSettings): boolean {
  return event.pointerType === "touch" && inPalmRest(event, viewport, settings);
}

function inPalmRest(
  contact: Pick<Touch, "clientX" | "clientY">, viewport: HTMLElement, settings: ModernDrawSettings
): boolean {
  if (settings.writingHand === "off") return false;
  const bounds = viewport.getBoundingClientRect();
  return contact.clientY >= bounds.bottom - bounds.height * settings.palmRestHeight / 100
    && contact.clientY <= bounds.bottom && contact.clientX >= bounds.left && contact.clientX <= bounds.right;
}

export function guardDrawingTouches(
  host: HTMLElement,
  viewport: HTMLElement,
  getSettings: () => ModernDrawSettings,
  hasInkGesture: () => boolean,
  isControl: (target: EventTarget | null) => boolean,
  onPinch?: (gesture: PinchGesture) => void,
  onPinchEnd?: () => void
): () => void {
  const listeners = new AbortController();
  const blockedTouches = new Set<number>();
  const navigationTouches = new Set<number>();
  let pinch: { first: number; second: number; x: number; y: number; distance: number } | undefined;

  // WebKit can start scrolling even after a canceled pointerdown. Cancel the
  // corresponding touch events while leaving ordinary finger scrolling available.
  const guard = (event: TouchEvent): void => {
    if (isControl(event.target)) return;
    const drawing = hasInkGesture();
    const starting = event.type === "touchstart";
    let block = drawing;
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const touch = event.changedTouches[index];
      if (drawing || (starting && inPalmRest(touch, viewport, getSettings()))) {
        blockedTouches.add(touch.identifier);
      } else if (onPinch && starting) {
        const bounds = viewport.getBoundingClientRect();
        if (touch.clientX >= bounds.left && touch.clientX <= bounds.right
          && touch.clientY >= bounds.top && touch.clientY <= bounds.bottom) navigationTouches.add(touch.identifier);
      }
      block ||= blockedTouches.has(touch.identifier);
    }
    if (onPinch && !drawing && navigationTouches.size >= 2) {
      const contacts = Array.from(event.touches).filter(({ identifier }) =>
        navigationTouches.has(identifier) && !blockedTouches.has(identifier));
      const [first, second] = contacts.sort((a, b) => a.identifier - b.identifier);
      if (first && second) {
        const x = (first.clientX + second.clientX) / 2;
        const y = (first.clientY + second.clientY) / 2;
        const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
        const previous = pinch;
        pinch = { first: first.identifier, second: second.identifier, x, y, distance };
        if (!starting && previous?.first === pinch.first && previous.second === pinch.second
          && previous.distance > 0 && distance > 0) {
          onPinch({ clientX: x, clientY: y, deltaX: x - previous.x, deltaY: y - previous.y, scale: distance / previous.distance });
        }
        block = true;
      }
    }
    if (block) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const release = (event: TouchEvent): void => {
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const { identifier } = event.changedTouches[index];
      blockedTouches.delete(identifier);
      navigationTouches.delete(identifier);
    }
    if (!pinch || navigationTouches.has(pinch.first) && navigationTouches.has(pinch.second)) return;
    if (navigationTouches.has(pinch.first)) blockedTouches.add(pinch.first);
    if (navigationTouches.has(pinch.second)) blockedTouches.add(pinch.second);
    pinch = undefined;
    onPinchEnd?.();
  };
  const { signal } = listeners;
  host.addEventListener("touchstart", guard, { capture: true, passive: false, signal });
  host.addEventListener("touchmove", guard, { capture: true, passive: false, signal });
  host.addEventListener("touchend", release, { capture: true, passive: true, signal });
  host.addEventListener("touchcancel", release, { capture: true, passive: true, signal });
  return () => listeners.abort();
}

export function blockPointer(event: PointerEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function pointerSamples(event: PointerEvent): PointerEvent[] {
  const samples = event.getCoalescedEvents?.();
  return samples?.length ? samples : [event];
}

export function appendStylusEnd(points: InkPoint[], point: InkPoint): void {
  const previous = points.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) > 0.15) {
    points.push({ ...point, pressure: previous.pressure });
  }
}

export function updatePalmRest(element: HTMLElement, settings: ModernDrawSettings): void {
  element.hidden = settings.writingHand === "off";
  element.style.height = `${settings.palmRestHeight}%`;
}
