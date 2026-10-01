"use client";

import { useId } from "react";
import { usePersistedState } from "@/lib/usePersistedState";
import { FourDoorDial } from "@/components/FourDoorArtwork";

/** Render only inside the actual viewport/device gate. Images start alongside the interactive chunk. */
export default function FourDoorLoading({ activeKey }: { activeKey: string }) {
  const [style] = usePersistedState<1 | 2>("fire:four-door-style", 1);
  const uid = useId().replace(/:/g, "");
  const index = Math.max(0, ["holdings", "assets", "fire", "global"].indexOf(activeKey));
  return <div className="four-door-zone" aria-hidden="true">
    <div className={`four-door-art is-style-${style === 2 ? 2 : 1}`}>
      <img className="four-door-window" src="/uploads/feature/four-door/window.png" alt="" fetchPriority="high" />
      <div className="four-door-wheel" style={{ transform: `rotate(${-index * 90}deg)` }}>
        {style === 2 ? <FourDoorDial uid={uid} /> : <img src="/uploads/feature/four-door/dial.png" alt="" fetchPriority="high" />}
      </div>
      {style === 2 && <><span className="four-door-hub" /><span className="four-door-gloss" /></>}
      <img className="four-door-pointer four-door-pointer-arch" src="/uploads/feature/four-door/pointer.png" alt="" />
      <img className="four-door-pointer four-door-pointer-tip" src="/uploads/feature/four-door/pointer.png" alt="" />
      <img className="four-door-hand" src="/uploads/feature/four-door/cursor-hand.png" alt="" />
    </div>
  </div>;
}
