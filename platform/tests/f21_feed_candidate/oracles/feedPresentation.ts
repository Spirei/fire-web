import type { FeedSegment, FeedSource } from "./feedTypes";

/** Evidence and navigation are separate: citing a sentence does not turn it into a link. */
export function restrainedFeedSegments(segments: FeedSegment[]): FeedSegment[] {
  const budget = Math.floor(segments.reduce((n, s) => n + s.text.length, 0) * 0.35);
  let linked = 0, count = 0;
  return segments.map(({ linkText, ...segment }) => {
    if (!segment.sourceId || typeof linkText !== "string" || linkText.length < 2 || linkText.length > 32 ||
      !segment.text.includes(linkText) || /[\r\n]/.test(linkText) || count >= 2 || linked + linkText.length > budget) return segment;
    count++; linked += linkText.length;
    return { ...segment, linkText };
  });
}

export type FeedBodyPart = { text: string; sourceId?: string };
export function feedBodyParts(segments: FeedSegment[], sources: FeedSource[]): FeedBodyPart[] {
  const sourceIds = new Set(sources.map(s => s.id));
  // Old posts are kept intact. At most their short attribution can be a link, never the whole sentence.
  const safe = restrainedFeedSegments(segments.map(segment => {
    if (!sourceIds.has(segment.sourceId || "")) return { text: segment.text };
    if (segment.linkText !== undefined) return segment;
    const attribution = segment.text.match(/^([^。！？\n]{2,28}?报道)/)?.[1];
    return { ...segment, ...(attribution ? { linkText: attribution } : {}) };
  }));
  return safe.flatMap(segment => {
    if (!segment.linkText) return [{ text: segment.text }];
    const at = segment.text.indexOf(segment.linkText);
    return [{ text: segment.text.slice(0, at) }, { text: segment.linkText, sourceId: segment.sourceId },
      { text: segment.text.slice(at + segment.linkText.length) }].filter(p => p.text);
  });
}
