"use client";

import { useEffect, useState } from "react";
import { getMarketBadge, isMarketBadgeVisible, subscribeMarketBadges, type MarketBadgeStyle } from "@/lib/marketBadge";

function useMarketBadgeTick() {
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
}

export function useMarketBadge(market: string, code: string): MarketBadgeStyle {
  useMarketBadgeTick();
  return getMarketBadge(market, code);
}

export function useMarketBadgeVisible() {
  useMarketBadgeTick();
  return isMarketBadgeVisible();
}
