export type AllocationRouteBox = { l: number; r: number; t: number; b: number };
type Point = { x: number; y: number };

function roundedPath(points: Point[], cornerRadius = 12): string {
  const path = points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  let d = `M${path[0].x},${path[0].y}`;
  for (let i = 1; i < path.length - 1; i++) {
    const before = path[i - 1], at = path[i], after = path[i + 1];
    const incoming = Math.hypot(at.x - before.x, at.y - before.y), outgoing = Math.hypot(after.x - at.x, after.y - at.y);
    const radius = Math.min(cornerRadius, incoming / 2, outgoing / 2);
    const entry = { x: at.x + (before.x - at.x) * radius / incoming, y: at.y + (before.y - at.y) * radius / incoming };
    const exit = { x: at.x + (after.x - at.x) * radius / outgoing, y: at.y + (after.y - at.y) * radius / outgoing };
    d += ` L${entry.x},${entry.y} Q${at.x},${at.y} ${exit.x},${exit.y}`;
  }
  const end = path[path.length - 1];
  return `${d} L${end.x},${end.y}`;
}

export function allocationCategoryRoute(hub: AllocationRouteBox, target: AllocationRouteBox, destinationTop: number) {
  const cx = (hub.l + hub.r) / 2, cy = (hub.t + hub.b) / 2, ty = (target.t + target.b) / 2;
  if (target.l > hub.r) {
    const mx = (hub.r + target.l) / 2;
    return { forward: `M${hub.r},${cy} C${mx},${cy} ${mx},${ty} ${target.l},${ty}`, returning: `M${target.l},${ty} C${mx},${ty} ${mx},${cy} ${hub.r},${cy}` };
  }
  // Phone categories share the bottom port and stay in the list's left gutter.
  const laneY = destinationTop - 12, laneX = target.l - 14;
  const points = [{ x: cx, y: hub.b }, { x: cx, y: laneY }, { x: laneX, y: laneY }, { x: laneX, y: ty }, { x: target.l, y: ty }];
  return { forward: roundedPath(points), returning: roundedPath([...points].reverse()) };
}

/** Preserve the fan-in/out ports; only the pulse crosses between them along the card border. */
export function allocationRoute(source: AllocationRouteBox, hub: AllocationRouteBox, target: AllocationRouteBox, destinationTop: number) {
  const sy = (source.t + source.b) / 2, cy = (hub.t + hub.b) / 2, cx = (hub.l + hub.r) / 2, mx = (source.r + hub.l) / 2;
  const path = `M${source.r},${sy} C${mx},${sy} ${mx},${cy} ${hub.l},${cy}`;
  const upper = sy < cy, desktop = target.l > hub.r;
  const border: Point[] = desktop
    ? [{ x: hub.l, y: cy }, { x: hub.l, y: upper ? hub.t : hub.b }, { x: hub.r, y: upper ? hub.t : hub.b }, { x: hub.r, y: cy }]
    : upper
      ? [{ x: hub.l, y: cy }, { x: hub.l, y: hub.t }, { x: hub.r, y: hub.t }, { x: hub.r, y: hub.b }, { x: cx, y: hub.b }]
      : [{ x: hub.l, y: cy }, { x: hub.l, y: hub.b }, { x: cx, y: hub.b }];
  const continuation = (d: string) => d.slice(d.indexOf(" "));
  const outgoing = allocationCategoryRoute(hub, target, destinationTop);
  return { path, forward: `${path}${continuation(roundedPath(border, 13))}${continuation(outgoing.forward)}`,
    returning: `${outgoing.returning}${continuation(roundedPath([...border].reverse(), 13))} C${mx},${cy} ${mx},${sy} ${source.r},${sy}` };
}
