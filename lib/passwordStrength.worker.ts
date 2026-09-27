import { estimatePasswordStrength } from "./passwordStrength";

const pending = new Map<number, AbortController>();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; cancel?: boolean; password?: string; userInputs?: string[] }>) => void) | null;
  postMessage: (message: { id: number; score?: number; failed?: boolean }) => void;
};
scope.onmessage = event => {
  const { id, cancel, password, userInputs } = event.data;
  if (cancel) { pending.get(id)?.abort(); pending.delete(id); return; }
  if (typeof password !== "string") return;
  const controller = new AbortController();
  pending.set(id, controller);
  void estimatePasswordStrength(password, userInputs, controller.signal).then(score => {
    if (!controller.signal.aborted) scope.postMessage({ id, score });
  }).catch(() => {
    if (!controller.signal.aborted) scope.postMessage({ id, failed: true });
  }).finally(() => pending.delete(id));
};
