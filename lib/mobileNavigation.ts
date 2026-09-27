export function mobileGestureAxis(dx: number, dy: number): "pending" | "back" | "scroll" {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return "pending";
  return dx > 0 && dx > Math.abs(dy) * 1.5 ? "back" : "scroll";
}

export function shouldFinishMobileBack(distance: number, width: number, velocity: number) {
  return distance >= Math.min(110, width * .28) || (distance >= 48 && velocity >= .55);
}

export function mobilePanelDirection(from: string, to: string): "forward" | "back" | "none" {
  if (from === to) return "none";
  if (from === "pnl" && to === "assets") return "back";
  if (from === "assets" && to === "pnl") return "forward";
  const tabs = ["assets", "watchlist", "holdings", "settings"];
  const source = tabs.indexOf(from), target = tabs.indexOf(to);
  return source >= 0 && target >= 0 ? target > source ? "forward" : "back" : "none";
}
