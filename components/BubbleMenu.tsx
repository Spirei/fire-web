"use client";

import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";

export interface BubbleMenuItem {
  label: React.ReactNode;
  href?: string;
  ariaLabel?: string;
  rotation?: number;
  hoverStyles?: { bgColor?: string; textColor?: string };
  onClick?: () => void;
}

export default function BubbleMenu({
  logo,
  onMenuClick,
  className,
  style,
  menuAriaLabel = "切换菜单",
  menuBg,
  menuContentColor,
  useFixedPosition = false,
  items,
  animationEase = "back.out(1.5)",
  animationDuration = 0.5,
  staggerDelay = 0.12
}: {
  logo?: React.ReactNode;
  onMenuClick?: (open: boolean) => void;
  className?: string;
  style?: React.CSSProperties;
  menuAriaLabel?: string;
  menuBg?: string;
  menuContentColor?: string;
  useFixedPosition?: boolean;
  items?: BubbleMenuItem[];
  animationEase?: string;
  animationDuration?: number;
  staggerDelay?: number;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [dark, setDark] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const bubblesRef = useRef<(HTMLElement | null)[]>([]);
  const labelRefs = useRef<(HTMLElement | null)[]>([]);

  const menuItems = items && items.length > 0 ? items : [];
  const bg = menuBg ?? (dark ? "#1a212e" : "#ffffff");
  const fg = menuContentColor ?? (dark ? "#e5e7eb" : "#111111");
  const containerClassName = ["bubble-menu", useFixedPosition ? "fixed" : "absolute", className].filter(Boolean).join(" ");

  // 跟随深浅色主题（气泡与菜单底色自动适配）
  useEffect(() => {
    const el = document.documentElement;
    const check = () => setDark(el.classList.contains("dark"));
    check();
    const ob = new MutationObserver(check);
    ob.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => ob.disconnect();
  }, []);

  const handleToggle = () => {
    const nextState = !isMenuOpen;
    if (nextState) setShowOverlay(true);
    setIsMenuOpen(nextState);
    onMenuClick?.(nextState);
  };

  const handleItem = (item: BubbleMenuItem) => {
    item.onClick?.();
    setIsMenuOpen(false);
    onMenuClick?.(false);
  };

  useEffect(() => {
    const overlay = overlayRef.current;
    const bubbles = bubblesRef.current.filter(Boolean);
    const labels = labelRefs.current.filter(Boolean);
    if (!overlay || !bubbles.length) return;

    if (isMenuOpen) {
      gsap.set(overlay, { display: "flex" });
      gsap.killTweensOf([...bubbles, ...labels]);
      gsap.set(bubbles, { scale: 0, transformOrigin: "50% 50%" });
      gsap.set(labels, { y: 12, autoAlpha: 0 });

      bubbles.forEach((bubble, i) => {
        const delay = i * staggerDelay + gsap.utils.random(-0.05, 0.05);
        const tl = gsap.timeline({ delay });
        tl.to(bubble, { scale: 1, duration: animationDuration, ease: animationEase });
        if (labels[i]) {
          tl.to(labels[i], { y: 0, autoAlpha: 1, duration: animationDuration, ease: "power3.out" }, `-=${animationDuration * 0.9}`);
        }
      });
    } else if (showOverlay) {
      gsap.killTweensOf([...bubbles, ...labels]);
      gsap.to(labels, { y: 12, autoAlpha: 0, duration: 0.2, ease: "power3.in" });
      gsap.to(bubbles, {
        scale: 0,
        duration: 0.2,
        ease: "power3.in",
        onComplete: () => {
          gsap.set(overlay, { display: "none" });
          setShowOverlay(false);
        }
      });
    }
  }, [isMenuOpen, showOverlay, animationEase, animationDuration, staggerDelay]);

  // 桌面端恢复旋转角度
  useEffect(() => {
    const handleResize = () => {
      if (!isMenuOpen) return;
      const bubbles = bubblesRef.current.filter(Boolean);
      const isDesktop = window.innerWidth >= 900;
      bubbles.forEach((bubble, i) => {
        const item = menuItems[i];
        if (bubble && item) {
          gsap.set(bubble, { rotation: isDesktop ? (item.rotation ?? 0) : 0 });
        }
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isMenuOpen, menuItems]);

  // ESC 关闭
  useEffect(() => {
    if (!isMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsMenuOpen(false);
        onMenuClick?.(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMenuOpen, onMenuClick]);

  return (
    <>
      <nav className={containerClassName} style={style} aria-label="市场切换">
        <div className="bubble logo-bubble" aria-label="当前市场" style={{ background: bg }}>
          <span className="logo-content" style={{ color: fg }}>{logo}</span>
        </div>
        <button
          type="button"
          className={`bubble toggle-bubble menu-btn ${isMenuOpen ? "open" : ""}`}
          onClick={handleToggle}
          aria-label={menuAriaLabel}
          aria-pressed={isMenuOpen}
          style={{ background: bg }}
        >
          <span className="menu-line" style={{ background: fg }} />
          <span className="menu-line short" style={{ background: fg }} />
        </button>
      </nav>
      {showOverlay && (
        <div
          ref={overlayRef}
          className="bubble-menu-items fixed"
          aria-hidden={!isMenuOpen}
          onClick={() => {
            setIsMenuOpen(false);
            onMenuClick?.(false);
          }}
        >
          <ul className="pill-list" role="menu" aria-label="选择市场" onClick={(e) => e.stopPropagation()}>
            {menuItems.map((item, idx) => (
              <li key={idx} role="none" className="pill-col">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={item.ariaLabel || (typeof item.label === "string" ? item.label : "")}
                  className="pill-link"
                  style={
                    {
                      "--item-rot": `${item.rotation ?? 0}deg`,
                      "--pill-bg": bg,
                      "--pill-color": fg,
                      "--hover-bg": item.hoverStyles?.bgColor || "#0076DF",
                      "--hover-color": item.hoverStyles?.textColor || "#ffffff"
                    } as React.CSSProperties
                  }
                  ref={(el) => {
                    bubblesRef.current[idx] = el;
                  }}
                  onClick={() => handleItem(item)}
                >
                  <span
                    className="pill-label"
                    ref={(el) => {
                      labelRefs.current[idx] = el;
                    }}
                  >
                    {item.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
