import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

/** Run Basis transcoding in a same-origin worker with its own narrow CSP. */
export class ShowcaseKTX2Loader extends KTX2Loader {
  override init(): Promise<void> {
    if (!this.transcoderPending) {
      this.transcoderPending = fetch("/vendor/basis/basis_transcoder.wasm")
        .then((response) => {
          if (!response.ok) throw new Error(`Basis transcoder HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then((binary) => {
          this.transcoderBinary = binary;
          this.workerPool.setWorkerCreator(() => {
            const worker = new Worker("/vendor/basis/showcase-ktx-worker.js");
            worker.addEventListener("error", (event) => console.error("[showcase] KTX2 worker error:", event.message));
            const transcoderBinary = binary.slice(0);
            worker.postMessage({ type: "init", config: this.workerConfig, transcoderBinary }, [transcoderBinary]);
            return worker;
          });
        });
    }
    return this.transcoderPending;
  }
}
