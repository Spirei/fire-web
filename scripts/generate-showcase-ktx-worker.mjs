import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = KTX2Loader.BasisWorker.toString();
const body = worker.slice(worker.indexOf("{") + 1, worker.lastIndexOf("}")).trim();
if (!body.includes("addEventListener") || !body.includes("transcode")) {
  throw new Error("Three.js KTX2 worker changed; inspect it before regenerating");
}

// Three.js normally embeds this body in a blob worker. Blob workers inherit the
// page CSP, where allowing JS eval globally would weaken every app page.
const source = [
  "// Generated from Three.js KTX2Loader.BasisWorker; do not edit by hand.",
  `let _EngineFormat = ${JSON.stringify(KTX2Loader.EngineFormat)};`,
  `let _EngineType = ${JSON.stringify(KTX2Loader.EngineType)};`,
  `let _TranscoderFormat = ${JSON.stringify(KTX2Loader.TranscoderFormat)};`,
  `let _BasisFormat = ${JSON.stringify(KTX2Loader.BasisFormat)};`,
  "importScripts('/vendor/basis/basis_transcoder.js');",
  body
].join("\n");
fs.writeFileSync(path.join(root, "public/vendor/basis/showcase-ktx-worker.js"), `${source}\n`);
