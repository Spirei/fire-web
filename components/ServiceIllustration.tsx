/** Decorative, theme-aware vectors; service state remains real text outside the artwork. */
export function ServiceIllustration({ kind }: { kind: string }) {
  return (
    <svg
      className="service-illustration"
      viewBox="0 0 300 150"
      fill="none"
      aria-hidden="true"
    >
      <path className="illustration-sky" d="M0 0h300v150H0z" />
      <path
        className="illustration-ridge"
        d="M0 119 48 60l39 37 41-60 42 50 40-39 90 71v31H0Z"
      />
      <path
        className="illustration-land"
        d="M16 128 76 64l44 43 48-73 58 70 57 24Z"
      />
      <path
        className="illustration-horizon"
        d="M19 129h262M46 129V99m-8 9 8-9 8 9m199 21V91m-9 10 9-10 9 10"
      />
      <path
        className="illustration-peak"
        d="m48 60-12 27 13-7 8 7-5-15zm80-23-16 27 15-5 14 10-8-22z"
      />
      <circle className="illustration-sun" cx="239" cy="36" r="13" />
      <g
        className="illustration-drawing"
        strokeWidth="0.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === "postgresql" ? (
          <>
            <path className="illustration-paper" d="M85 36h124v93H85z" />
            <path d="M96 47h20m-20 7h12" />
            <path
              className="illustration-blue"
              d="M118 66v37c0 8 13 14 29 14s29-6 29-14V66"
            />
            <ellipse
              className="illustration-blue"
              cx="147"
              cy="66"
              rx="29"
              ry="13"
            />
            <path
              className="illustration-database-seam"
              d="M118 84c0 8 13 14 29 14s29-6 29-14"
            />
            <path
              className="illustration-green"
              d="M201 129v-24c-19 0-24-13-24-13 17-5 24 7 24 13 0-18 13-28 23-29 2 19-8 28-23 29"
            />
            <path d="M192 129h20l4-16h-28z" className="illustration-paper" />
          </>
        ) : kind === "redis" ? (
          <>
            <path className="illustration-paper" d="M79 43h127v75H79z" />
            <path d="M89 54h18m-18 7h9m82 46h16" />
            <path
              className="illustration-blue"
              d="m128 34-22 45h27l-8 34 42-53h-29l12-26z"
            />
            <path className="illustration-green" d="M179 80h39v27h-39z" />
            <path className="illustration-symbol" d="m188 93 6 6 14-14" />
            <path d="M59 81h14m-14 8h14m149-31h16m-9-7 9 7-9 7" />
            <circle className="illustration-coral" cx="77" cy="117" r="13" />
            <path className="illustration-symbol" d="M71 117h12m-6-6v12" />
          </>
        ) : (
          <>
            <path className="illustration-paper" d="M81 37h126v91H81z" />
            <path d="M94 49h30m-30 8h17" />
            <path
              className="illustration-blue"
              d="M111 70h65v14h-65zm0 22h65v14h-65z"
            />
            <circle className="illustration-outline" cx="121" cy="77" r="2" />
            <circle className="illustration-outline" cx="121" cy="99" r="2" />
            <path className="illustration-symbol" d="M133 77h30m-30 22h30" />
            <circle className="illustration-coral" cx="205" cy="107" r="22" />
            <path className="illustration-symbol" d="m195 107 7 7 14-15" />
            <path d="M55 99l10-5 10 5v17l-10 6-10-6zm0 0 10 6 10-6m-10 6v17" />
            <path
              className="illustration-green"
              d="M207 58c7-18 23-14 24-6 9-8 20 1 14 9h-38z"
            />
          </>
        )}
      </g>
    </svg>
  );
}
