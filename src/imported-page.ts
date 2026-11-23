/** The UUID in an imported page filename identifies its image across note layouts. */
export function importedPageName(source: string | null): string | undefined {
  if (!source) return;
  let decoded = source;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    // Some attachment names can contain a literal percent sign.
  }
  return decoded.split(/[/?#|]/).find((segment) => /-mdpage-[a-z0-9-]+-\d+\.(?:png|jpg)$/i.test(segment));
}

export function importedPageImages(root: HTMLElement): Map<string, HTMLImageElement> {
  const images = new Map<string, HTMLImageElement>();
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    if (image.closest("[hidden]")) continue;
    const embed = image.closest(".image-embed");
    const name = importedPageName(image.getAttribute("src")) ?? importedPageName(embed?.getAttribute("src") ?? null);
    if (name) images.set(name, image);
  }
  return images;
}
