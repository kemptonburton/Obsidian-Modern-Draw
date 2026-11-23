import type { InkFileData, InkFileRevisions, InkPoint, InkRevision, InkStroke } from "./model";

type PackedStroke = Omit<InkStroke, "points"> & { points: number[] };
type PackedInk = Omit<InkFileData, "version" | "strokes"> & { version: 2; strokes: PackedStroke[] };

export function encodeInk(data: InkFileData): string {
  const strokes = data.strokes.map(({ points, ...style }): PackedStroke => {
    const coordinates: number[] = [];
    for (const { x, y, pressure } of points) {
      coordinates.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(pressure * 1000) / 1000);
    }
    return { ...style, points: coordinates };
  });
  return JSON.stringify({ ...data, version: 2, strokes } satisfies PackedInk);
}

export function decodeInk(raw: string): InkFileData {
  const data = JSON.parse(raw) as InkFileData | PackedInk | null;
  if (!data || (data.version !== 1 && data.version !== 2)
    || typeof data.sourcePath !== "string" || !Array.isArray(data.strokes)
    || (data.floatingImages !== undefined && !Array.isArray(data.floatingImages))
    || (data.snapshotRegions !== undefined && !Array.isArray(data.snapshotRegions))
    || (data.verticalSpaces !== undefined && !Array.isArray(data.verticalSpaces))
    || (data.revisions !== undefined && !validRevisions(data.revisions))) {
    throw new Error("Unsupported drawing file.");
  }
  if (data.version === 1) return data;

  const strokes = data.strokes.map(({ points, ...style }): InkStroke => {
    if (!Array.isArray(points) || points.length % 3 !== 0) throw new Error("Invalid stroke points.");
    const unpacked: InkPoint[] = [];
    for (let index = 0; index < points.length; index += 3) {
      const [x, y, pressure] = [points[index], points[index + 1], points[index + 2]];
      if (![x, y, pressure].every(Number.isFinite)) throw new Error("Invalid stroke coordinates.");
      unpacked.push({ x, y, pressure });
    }
    return { ...style, points: unpacked };
  });
  return { ...data, version: 1, strokes };
}

function validRevisions(revisions: InkFileRevisions): boolean {
  if (!revisions || !Number.isSafeInteger(revisions.clock) || revisions.clock < 0) return false;
  const validStamp = (stamp: InkRevision) => Array.isArray(stamp)
    && Number.isSafeInteger(stamp[0]) && stamp[0] >= 0 && stamp[0] <= revisions.clock
    && typeof stamp[1] === "string" && (stamp[2] === undefined || stamp[2] === true);
  return (revisions.canvasLayout === undefined || validStamp(revisions.canvasLayout))
    && [revisions.strokes, revisions.floatingImages, revisions.verticalSpaces, revisions.snapshotRegions].every((group) =>
      group === undefined || (group !== null && typeof group === "object" && !Array.isArray(group)
        && Object.values(group).every(validStamp)));
}

export function recordInkChanges(previous: InkFileData, next: InkFileData, writer: string): InkFileData {
  const revisions = previous.revisions;
  const clock = Math.max(Date.now(), (revisions?.clock ?? 0) + 1);
  const revision: InkRevision = [clock, writer];
  const strokes = recordItemChanges(previous.strokes, next.strokes, revisions?.strokes, revision);
  const floatingImages = recordItemChanges(previous.floatingImages, next.floatingImages, revisions?.floatingImages, revision);
  const verticalSpaces = recordItemChanges(previous.verticalSpaces, next.verticalSpaces, revisions?.verticalSpaces, revision);
  const snapshotRegions = recordItemChanges(previous.snapshotRegions, next.snapshotRegions, revisions?.snapshotRegions, revision);
  const canvasLayout = previous.canvasLayout === next.canvasLayout ? revisions?.canvasLayout : revision;
  if (strokes === revisions?.strokes && floatingImages === revisions?.floatingImages
    && verticalSpaces === revisions?.verticalSpaces && snapshotRegions === revisions?.snapshotRegions
    && canvasLayout === revisions?.canvasLayout) {
    return { ...next, updatedAt: previous.updatedAt, revisions };
  }
  return { ...next, revisions: { clock, strokes, floatingImages, verticalSpaces, snapshotRegions, canvasLayout } };
}

function recordItemChanges<T extends { id: string }>(
  previous: T[] | undefined, next: T[] | undefined, revisions: Record<string, InkRevision> | undefined, revision: InkRevision
): Record<string, InkRevision> | undefined {
  if (previous === next) return revisions;
  const remaining = new Map(previous?.map((item) => [item.id, item]));
  const changes: Array<[string, InkRevision]> = [];
  for (const item of next ?? []) {
    if (!sameItem(item, remaining.get(item.id))) changes.push([item.id, revision]);
    remaining.delete(item.id);
  }
  for (const id of remaining.keys()) changes.push([id, [revision[0], revision[1], true]]);
  return changes.length ? { ...revisions, ...Object.fromEntries(changes) } : revisions;
}

/** Missing entries in a downloaded snapshot may be edits the other device has never seen. */
export function mergeInk(local: InkFileData, incoming: InkFileData): InkFileData {
  const localRevisions = local.revisions;
  const remoteRevisions = incoming.revisions;
  const preferLocal = local.updatedAt > incoming.updatedAt;
  const strokes = mergeItems(local.strokes, incoming.strokes, localRevisions?.strokes, remoteRevisions?.strokes, preferLocal);
  const images = mergeItems(local.floatingImages, incoming.floatingImages,
    localRevisions?.floatingImages, remoteRevisions?.floatingImages, preferLocal);
  const spaces = mergeItems(local.verticalSpaces, incoming.verticalSpaces,
    localRevisions?.verticalSpaces, remoteRevisions?.verticalSpaces, preferLocal);
  const regions = mergeItems(local.snapshotRegions, incoming.snapshotRegions,
    localRevisions?.snapshotRegions, remoteRevisions?.snapshotRegions, preferLocal);
  const layoutRevision = compareRevision(localRevisions?.canvasLayout, remoteRevisions?.canvasLayout);
  const useLocalLayout = layoutRevision > 0
    || (layoutRevision === 0 && local.canvasLayout !== undefined && (incoming.canvasLayout === undefined || preferLocal));
  const revisions: InkFileRevisions | undefined = localRevisions || remoteRevisions ? {
    clock: Math.max(localRevisions?.clock ?? 0, remoteRevisions?.clock ?? 0),
    strokes: strokes.revisions,
    floatingImages: images.revisions,
    verticalSpaces: spaces.revisions,
    snapshotRegions: regions.revisions,
    canvasLayout: useLocalLayout ? localRevisions?.canvasLayout : remoteRevisions?.canvasLayout
  } : undefined;
  return {
    ...incoming,
    updatedAt: preferLocal ? local.updatedAt : incoming.updatedAt,
    strokes: strokes.items,
    floatingImages: images.items,
    verticalSpaces: spaces.items,
    snapshotRegions: regions.items,
    canvasLayout: useLocalLayout ? local.canvasLayout : incoming.canvasLayout,
    revisions
  };
}

function mergeItems<T extends { id: string }>(
  local: T[] | undefined, incoming: T[] | undefined,
  localRevisions: Record<string, InkRevision> | undefined, incomingRevisions: Record<string, InkRevision> | undefined,
  preferLocal: boolean
): { items: T[]; revisions?: Record<string, InkRevision> } {
  const localById = new Map(local?.map((item) => [item.id, item]));
  const remoteById = new Map(incoming?.map((item) => [item.id, item]));
  const localVersions = new Map(Object.entries(localRevisions ?? {}));
  const remoteVersions = new Map(Object.entries(incomingRevisions ?? {}));
  const ids = new Set([...remoteById.keys(), ...localById.keys(), ...remoteVersions.keys(), ...localVersions.keys()]);
  const items: T[] = [];
  const changes: Array<[string, InkRevision]> = [];
  for (const id of ids) {
    const current = localById.get(id);
    const remote = remoteById.get(id);
    const currentRevision = localVersions.get(id);
    const remoteRevision = remoteVersions.get(id);
    const order = compareRevision(currentRevision, remoteRevision);
    const useLocal = order > 0 || (order === 0 && !!current && (!remote || (preferLocal && !currentRevision)));
    const revision = useLocal ? currentRevision : remoteRevision;
    const item = useLocal ? current : remote;
    if (revision) changes.push([id, revision]);
    if (item && !revision?.[2]) items.push(item);
  }
  return { items, revisions: changes.length ? Object.fromEntries(changes) : undefined };
}

function compareRevision(local?: InkRevision, incoming?: InkRevision): number {
  if (!local) return incoming ? -1 : 0;
  if (!incoming) return 1;
  return local[0] - incoming[0] || (local[1] > incoming[1] ? 1 : local[1] < incoming[1] ? -1 : 0);
}

function sameItem<T>(item: T, previous: T | undefined): boolean {
  return item === previous || (previous !== undefined && JSON.stringify(item) === JSON.stringify(previous));
}
