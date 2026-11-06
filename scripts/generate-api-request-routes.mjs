import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, "contracts/fire-api-surface.json"), "utf8"),
);
fs.writeFileSync(
  path.join(root, "platform/contracts/fire-api-surface.json"),
  JSON.stringify(catalog, null, 2) + "\n",
);
const keys = new Set();
for (const row of catalog.operations) {
  if (
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
      row.method,
    ) ||
    !row.path.startsWith("/api/") ||
    keys.has(row.method + " " + row.path)
  )
    throw new Error("接口清单无效或重复");
  keys.add(row.method + " " + row.path);
}
const routes = [...new Set(catalog.operations.map((row) => row.path))].sort();
fs.writeFileSync(
  path.join(root, "lib/apiRequestRoutes.ts"),
  "// Generated from contracts/fire-api-surface.json.\nexport const API_REQUEST_ROUTES = " +
    JSON.stringify(routes, null, 2) +
    " as const;\n",
);
