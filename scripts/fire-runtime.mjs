import fs from "node:fs";
import path from "node:path";

export function pythonExecutable(backend, env = process.env, platform = process.platform) {
  if (env.FIRE_PYTHON) return env.FIRE_PYTHON;
  const local = path.join(backend, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return fs.existsSync(local) ? local : "python3";
}

