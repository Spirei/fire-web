// Original platform badges; only these two fixed identities are allowlisted.
const BADGE_SHAPE = "M8.82.521a1.596 1.596 0 012.36 0l.362.398c.42.46 1.07.635 1.664.445l.512-.163a1.596 1.596 0 012.043 1.18l.115.525a1.596 1.596 0 001.218 1.218l.525.115a1.596 1.596 0 011.18 2.043l-.163.513a1.596 1.596 0 00.446 1.663l.397.362a1.596 1.596 0 010 2.36l-.397.362c-.461.42-.635 1.07-.446 1.664l.163.512a1.59 1.59 0 01-1.18 2.043l-.525.115a1.596 1.596 0 00-1.218 1.218l-.115.525a1.596 1.596 0 01-2.043 1.18l-.512-.163a1.596 1.596 0 00-1.664.445l-.362.398a1.596 1.596 0 01-2.36 0l-.362-.398a1.596 1.596 0 00-1.663-.445l-.513.163a1.596 1.596 0 01-2.043-1.18l-.115-.525a1.59 1.59 0 00-1.218-1.218l-.525-.115a1.596 1.596 0 01-1.18-2.043l.164-.512a1.596 1.596 0 00-.446-1.664L.52 11.18a1.596 1.596 0 010-2.36l.398-.362c.46-.42.635-1.07.446-1.663L1.2 6.282a1.596 1.596 0 011.18-2.043l.525-.115a1.596 1.596 0 001.218-1.218l.115-.525A1.596 1.596 0 016.282 1.2l.513.163c.594.19 1.244.015 1.663-.445L8.821.52z";

export function feedPersonBadgeColor(personId:string) {
  return personId==="trump"?"#f43f6b":personId==="duan"?"#1d9bf0":undefined;
}

export default function FeedPersonBadge({personId}:{personId:string}) {
  if(personId!=="trump"&&personId!=="duan")return null;
  const platform=personId;
  const color = feedPersonBadgeColor(platform);
  return (
    <svg aria-label={platform === "trump" ? "Truth Social 已认证" : "雪球认证"} viewBox="0 0 20 20" role="img" className="feed-person-badge">
      <path d={BADGE_SHAPE} fill={color} />
      <path d="M6.66 7.464 5.012 9.111l3.85 3.85 5.483-5.481-1.966-1.966-3.835 3.836L6.66 7.464z" fill="#fff" />
      {platform === "trump" && <path opacity=".5" d="m11.25 15.55-1.646-1.848 1.646-1.646 1.887 1.887-1.887 1.606z" fill="#fff" />}
    </svg>
  );
}
