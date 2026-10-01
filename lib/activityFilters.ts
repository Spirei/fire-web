export type ActivityScope = "user" | "system" | "requests";

export function activityFilters(params: { get: (name: string) => string | null }, isAdmin: boolean) {
  const selected = params.get("scope");
  const scope: ActivityScope = selected === "requests" && isAdmin ? "requests" : selected === "system" ? "system" : "user";
  const page = Number(params.get("page") || "1");
  return { scope, page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1, query: params.get("q") || "" };
}
