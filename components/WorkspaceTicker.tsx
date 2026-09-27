"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const IndexTicker = dynamic(() => import("@/components/IndexTicker"));

/** 手机及设置页隐藏顶栏时，不加载指数模块，也不启动轮询。 */
export default function WorkspaceTicker() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="app-shell-ticker min-w-0 overflow-hidden">
    {visible ? <IndexTicker /> : <div className="h-[42px] w-[300px]" aria-hidden="true" />}
  </div>;
}
