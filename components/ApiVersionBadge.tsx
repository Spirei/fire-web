import { apiVersionTone } from "@/lib/apiVersionPresentation";

export default function ApiVersionBadge({ version, fullLabel = false }: { version: number; fullLabel?: boolean }) {
  return <span className={`api-version-badge api-version-tone-${apiVersionTone(version)}`}
    data-api-version={version} aria-label={`API 版本 v${version}`} title={`API v${version}`}>
    {fullLabel ? `API v${version}` : `v${version}`}
  </span>;
}
