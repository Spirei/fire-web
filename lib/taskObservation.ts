import { platformRequest } from "./platformRequest";

type TaskIdentity = { id: string; request_id: string; kind: string };

/** Resolve a receipt once per observer, then read that exact task. No writes or retries. */
export function taskObservation<T extends TaskIdentity>(
  requestId: string,
  matches: (task: T) => boolean,
  mismatch: string,
) {
  let taskId: string | undefined;
  const validate = (task: T, expectedId?: string) => {
    if (!task || !task.id || task.request_id !== requestId ||
      (expectedId && task.id !== expectedId) || !matches(task)) throw new Error(mismatch);
    return task;
  };
  return async (signal: AbortSignal, headers: HeadersInit): Promise<T> => {
    signal.throwIfAborted();
    if (!taskId) {
      const receipt = validate(await platformRequest<T>(
        "/api/fire/tasks/receipts/" + requestId, { signal, headers },
      ));
      signal.throwIfAborted();
      taskId = receipt.id;
    }
    const task = validate(await platformRequest<T>(
      "/api/fire/tasks/" + taskId, { signal, headers },
    ), taskId);
    signal.throwIfAborted();
    return task;
  };
}
