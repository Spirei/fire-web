type SearchDestination = { label: string; group: string; keywords: string };

function normalizePlatformSearch(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function matchPlatformDestinations<T extends SearchDestination>(destinations: T[], query: string): T[] {
  const phrase = normalizePlatformSearch(query);
  if (!phrase) return [];

  const terms = phrase.split(" ");
  const matches: { destination: T; rank: number }[] = [];
  for (const destination of destinations) {
    const label = normalizePlatformSearch(destination.label);
    const group = normalizePlatformSearch(destination.group);
    const keywords = normalizePlatformSearch(destination.keywords);
    const text = `${label} ${group} ${keywords}`;
    if (!terms.every(term => text.includes(term))) continue;

    let rank = 4;
    if (label === phrase) rank = 0;
    else if (label.startsWith(phrase)) rank = 1;
    else if (terms.every(term => label.includes(term))) rank = 2;
    else if (text.includes(phrase)) rank = 3;
    matches.push({ destination, rank });
  }
  return matches.sort((a, b) => a.rank - b.rank).map(match => match.destination);
}
