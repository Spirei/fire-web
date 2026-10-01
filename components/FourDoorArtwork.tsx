function polar(radius: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return [100 + radius * Math.sin(rad), 100 - radius * Math.cos(rad)] as const;
}

function sectorPath(startDeg: number, endDeg: number, inner: number, outer: number) {
  const [x0, y0] = polar(outer, startDeg);
  const [x1, y1] = polar(outer, endDeg);
  const [x2, y2] = polar(inner, endDeg);
  const [x3, y3] = polar(inner, startDeg);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${outer},${outer} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${inner},${inner} 0 0 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
}

export function FourDoorDial({ uid }: { uid: string }) {
  const blue = `fd-${uid}-blue`;
  const charcoal = `fd-${uid}-charcoal`;
  const ember = `fd-${uid}-ember`;
  const moss = `fd-${uid}-moss`;
  const rim = `fd-${uid}-rim`;
  const gloss = `fd-${uid}-gloss`;
  const arrow = `fd-${uid}-arrow`;
  return (
    <svg className="four-door-dial" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <radialGradient id={blue} cx="42%" cy="32%" r="78%">
          <stop offset="0%" stopColor="#5ec4ff" />
          <stop offset="46%" stopColor="#1f86e6" />
          <stop offset="100%" stopColor="#0d5fb8" />
        </radialGradient>
        <radialGradient id={charcoal} cx="62%" cy="38%" r="80%">
          <stop offset="0%" stopColor="#4a4e55" />
          <stop offset="52%" stopColor="#1c1f24" />
          <stop offset="100%" stopColor="#0b0c0e" />
        </radialGradient>
        <radialGradient id={ember} cx="48%" cy="68%" r="78%">
          <stop offset="0%" stopColor="#ff6d5c" />
          <stop offset="48%" stopColor="#ee3a2f" />
          <stop offset="100%" stopColor="#b51b16" />
        </radialGradient>
        <radialGradient id={moss} cx="32%" cy="58%" r="78%">
          <stop offset="0%" stopColor="#8ae05a" />
          <stop offset="48%" stopColor="#4cbf34" />
          <stop offset="100%" stopColor="#278a1f" />
        </radialGradient>
        <linearGradient id={rim} x1="20%" y1="8%" x2="80%" y2="92%">
          <stop offset="0%" stopColor="#f4e2a4" />
          <stop offset="42%" stopColor="#c9a24a" />
          <stop offset="100%" stopColor="#7a5a1c" />
        </linearGradient>
        <radialGradient id={gloss} cx="34%" cy="28%" r="62%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.38" />
          <stop offset="38%" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <marker id={arrow} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="5.8" markerHeight="5.8" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0.6 1.2 11.4 6 0.6 10.8Z" fill="#fff" />
        </marker>
      </defs>
      <circle cx="100" cy="100" r="99" fill={`url(#${rim})`} />
      <circle cx="100" cy="100" r="93.5" fill="#1a1308" />
      <path d={sectorPath(-45, 45, 16, 92)} fill={`url(#${blue})`} />
      <path d={sectorPath(45, 135, 16, 92)} fill={`url(#${charcoal})`} />
      <path d={sectorPath(135, 225, 16, 92)} fill={`url(#${ember})`} />
      <path d={sectorPath(225, 315, 16, 92)} fill={`url(#${moss})`} />
      {[-45, 45, 135, 225].map((deg) => {
        const [x1, y1] = polar(16, deg);
        const [x2, y2] = polar(92, deg);
        return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,.22)" strokeWidth="1.2" />;
      })}
      <ellipse cx="78" cy="72" rx="46" ry="28" fill={`url(#${gloss})`} transform="rotate(-28 78 72)" />
      <path
        d="M131 158 C 117 176 86 176 74 159"
        fill="none"
        stroke="#fff"
        strokeWidth="3.8"
        strokeLinecap="round"
        markerEnd={`url(#${arrow})`}
      />
    </svg>
  );
}
