import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Call the JS entry with Node on every OS; Windows cannot execute POSIX npm shims.
export const gltfCli = fileURLToPath(new URL('../node_modules/@gltf-transform/cli/bin/cli.js', import.meta.url));
export function runGltf(args, env = process.env) {
  return spawnSync(process.execPath, [gltfCli, ...args], { stdio: 'inherit', env, windowsHide: true });
}
