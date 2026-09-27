import type { ZxcvbnFactory } from "@zxcvbn-ts/core";

let estimator: Promise<ZxcvbnFactory> | undefined;
function loadEstimator() {
  if (!estimator) estimator = Promise.all([
    import("@zxcvbn-ts/core"), import("@zxcvbn-ts/language-common"), import("@zxcvbn-ts/language-en")
  ]).then(([core, common, en]) => new core.ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...en.dictionary },
    graphs: common.adjacencyGraphs,
    translations: en.translations
  })).catch(error => { estimator = undefined; throw error; });
  return estimator;
}

// Browser-local estimate, not a guarantee or a breach/reuse check. No password result cache.
export async function estimatePasswordStrength(password: string, userInputs: string[] = [], signal?: AbortSignal) {
  const engine = await loadEstimator();
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  return engine.check(password.slice(0, 128), userInputs.filter(Boolean)).score;
}

export const PASSWORD_STRENGTH_LABELS = ["很弱", "较弱", "一般", "强", "很强"] as const;
