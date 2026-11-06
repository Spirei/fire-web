/** Five visible entries including All; choosing an overflow market keeps it visible. */
export function materialMarketSlots(
  order: string[],
  counts: Record<string, number>,
  selected: string,
  limit = 5,
) {
  const available = [...new Set(order)].filter(
    (market) => Number(counts[market]) > 0,
  );
  const visible = available.slice(0, Math.max(1, limit - 1));
  if (available.includes(selected) && !visible.includes(selected))
    visible[visible.length - 1] = selected;
  return {
    visible,
    more: available.filter((market) => !visible.includes(market)),
  };
}
