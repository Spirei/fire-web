import { apiVersionFromPath, apiVersionTone } from "@/lib/apiVersionPresentation";

export default function ApiPathText({ path }: { path: string }) {
  const version = apiVersionFromPath(path);
  if (version === null) return <>{path}</>;
  const label = `v${version}`;
  return <>/api/<span className={`api-path-version api-version-tone-${apiVersionTone(version)}`} data-api-version={version}>{label}</span>{path.slice(5 + label.length)}</>;
}
