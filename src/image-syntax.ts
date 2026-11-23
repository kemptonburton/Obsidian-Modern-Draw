export interface ImageSyntaxRange {
  from: number;
  to: number;
  text: string;
}

const IMAGE_SYNTAX = /!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\((?:\\.|[^)\n])+\)/g;

export function findImageSyntaxRanges(lineText: string): ImageSyntaxRange[] {
  return Array.from(lineText.matchAll(IMAGE_SYNTAX), (match) => ({
    from: match.index,
    to: match.index + match[0].length,
    text: match[0]
  }));
}

export function selectImageSyntaxRange(
  lineText: string,
  source: string,
  occurrence: number,
  approximateOffset: number
): ImageSyntaxRange | null {
  const ranges = findImageSyntaxRanges(lineText);
  if (ranges.length === 0) return null;
  const normalizedSource = source.toLowerCase();
  const sourceMatches = ranges.filter((range) => range.text.toLowerCase().includes(normalizedSource));
  if (sourceMatches.length > 0) return sourceMatches[Math.min(occurrence, sourceMatches.length - 1)];
  return ranges.reduce((closest, range) =>
    Math.abs(range.from - approximateOffset) < Math.abs(closest.from - approximateOffset) ? range : closest
  );
}
import { resolveAnchor } from "./anchors";
import type { FloatingImagePlacement } from "./model";


/** Remove embed syntax while preserving surrounding text and drawing-space lines. */
export function imageDeletionRanges(text: string, images: readonly FloatingImagePlacement[]): { from: number; to: number }[] {
  const ranges = new Map<number, { from: number; to: number }>();
  for (const image of images) {
    const anchor = resolveAnchor(text, image.anchor);
    const matchesSource = (range: ImageSyntaxRange): boolean => imageSource(range.text) === imageSource(image.source);
    const matches = findImageSyntaxRanges(anchor.lineText).filter(matchesSource);
    const match = matches[image.occurrence];
    if (match) ranges.set(anchor.pos + match.from, { from: anchor.pos + match.from, to: anchor.pos + match.to });
    else {
      const elsewhere = findImageSyntaxRanges(text).filter(matchesSource);
      if (elsewhere.length === 1) ranges.set(elsewhere[0].from, { from: elsewhere[0].from, to: elsewhere[0].to });
    }
  }
  return [...ranges.values()].sort((first, second) => first.from - second.from);
}

function imageSource(syntax: string): string {
  let source = syntax;
  if (source.startsWith("![[")) source = source.slice(3, -2).split("|")[0];
  else if (source.startsWith("![")) source = source.slice(source.indexOf("](") + 2, -1).replace(/\s+["'][\s\S]*["']$/, "").replace(/^<|>$/g, "");
  try { source = decodeURIComponent(source); } catch { /* A filename can contain a literal percent sign. */ }
  return source.toLowerCase();
}
