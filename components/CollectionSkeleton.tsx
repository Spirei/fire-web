/** Shared, layout-sized placeholders: no fabricated rows or repeated loading prose. */
export default function CollectionSkeleton({
  grid = false,
  count = false,
}: {
  grid?: boolean;
  count?: boolean;
}) {
  if (count)
    return <span className="collection-count-skeleton" aria-hidden="true" />;
  return (
    <div
      className={`collection-skeleton ${grid ? "is-grid" : ""}`}
      role="status"
      aria-label="正在加载素材"
      aria-busy="true"
    >
      <span className="sr-only">正在加载素材</span>
      {Array.from({ length: grid ? 6 : 5 }, (_, i) => (
        <div key={i} className="collection-skeleton-row" aria-hidden="true">
          <i />
          <span>
            <b />
            <b />
          </span>
        </div>
      ))}
    </div>
  );
}
