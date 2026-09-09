"use client";

import { useEffect, useState } from "react";
import { getMarketBadge, subscribeMarketBadges, type MarketBadgeStyle } from "@/lib/marketBadge";

export function useMarketBadge(market: string, code: string): MarketBadgeStyle {
  const [, bump] = useState(0);
  useEffect(() => {
    const onChange = () => bump((value) => value + 1);
    const unsubscribe = subscribeMarketBadges(onChange);
    window.addEventListener("fire:market-badges-updated", onChange);
    return () => {
      unsubscribe();
      window.removeEventListener("fire:market-badges-updated", onChange);
    };
  }, []);
  return getMarketBadge(market, code);
}
