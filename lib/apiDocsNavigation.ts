type TocGroup = { slug: string; children: readonly { slug: string }[] };

/** IO percentage margins use root width, not height; use pixels for a vertical reading band. */
export function apiTocReadingMargin(height: number): string {
  const bottom = Number.isFinite(height) && height > 0 ? Math.floor(height * .72) : 0;
  return `0px 0px -${bottom}px 0px`;
}

/** Only committed selection or reading position moves the marker, never hover. */
export function resolveApiTocSelection(
  groups: readonly TocGroup[],
  selected: string | null,
  reading: string | null,
  expanded: ReadonlySet<string>
): { slug: string | undefined; accentIndex: number } {
  const contains = (slug: string | null) => !!slug && groups.some(group => group.slug === slug || group.children.some(child => child.slug === slug));
  let slug = contains(selected) ? selected! : contains(reading) ? reading! : groups[0]?.slug;
  const index = groups.findIndex(group => group.slug === slug || group.children.some(child => child.slug === slug));
  const parent = groups[index];
  if (parent && parent.slug !== slug && !expanded.has(parent.slug)) slug = parent.slug;
  return { slug, accentIndex: Math.max(0, index) % 7 };
}
