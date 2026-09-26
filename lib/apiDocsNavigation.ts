type TocGroup = { slug: string; children: readonly { slug: string }[] };

/** One ordered geometry snapshot handles skipped headings and the final short section. */
export function resolveApiReadingHeading(
  headings: readonly { slug: string; top: number }[], edge: number, atEnd: boolean
): string | undefined {
  if (atEnd) return headings.at(-1)?.slug;
  let slug = headings[0]?.slug;
  for (const heading of headings) {
    if (heading.top <= edge) slug = heading.slug;
    else break;
  }
  return slug;
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
