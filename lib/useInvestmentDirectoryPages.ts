import { useCallback, useEffect, useRef, useState } from "react";

const FRESH_FOR = 30_000;
const MAX_CACHED_PAGES = 32;
const UPDATE_EVENTS = ["fire:records-updated", "fire:orders-updated", "fire:funds-updated"];

type Cached<Page> = { value: Page; at: number };

export function useInvestmentDirectoryPages<Page>({ path, foreground, read, resetPage }: {
  path: string | null;
  foreground: boolean;
  read: (path: string, signal: AbortSignal) => Promise<Page>;
  resetPage: () => void;
}) {
  const cache = useRef(new Map<string, Cached<Page>>());
  const requests = useRef(new Map<string, { controller: AbortController; response: Promise<void> }>());
  const [, setUpdated] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<{ path: string; message: string }>();
  const [accessError, setAccessError] = useState<string>();

  const cancel = useCallback(() => {
    for (const { controller } of requests.current.values()) controller.abort();
    requests.current.clear();
  }, []);

  const load = useCallback((key: string) => {
    const inFlight = requests.current.get(key);
    if (inFlight) return inFlight.response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("读取超时，请重试")), 15_000);
    const response = read(key, controller.signal).then(value => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const pages = cache.current;
      pages.delete(key);
      pages.set(key, { value, at: Date.now() });
      if (pages.size > MAX_CACHED_PAGES) pages.delete(pages.keys().next().value!);
      setUpdated(version => version + 1);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) {
        const reason: unknown = controller.signal.reason;
        if (reason instanceof Error && reason.name !== "AbortError") throw reason;
        return;
      }
      const status = (failure as { status?: number })?.status;
      if (status === 401 || status === 403 || status === 409) {
        cancel();
        cache.current.clear();
        setAccessError(failure instanceof Error ? failure.message : "请核对当前登录账户");
      }
      throw failure;
    }).finally(() => {
      clearTimeout(timeout);
      if (requests.current.get(key)?.controller === controller) requests.current.delete(key);
    });
    requests.current.set(key, { controller, response });
    return response;
  }, [cancel, read]);

  useEffect(() => () => {
    cancel();
    cache.current.clear();
  }, [cancel, read]);
  useEffect(() => {
    if (!foreground) cancel();
  }, [cancel, foreground]);
  useEffect(() => {
    const invalidate = () => {
      cancel();
      for (const saved of cache.current.values()) saved.at = 0;
      resetPage();
      setAttempt(value => value + 1);
    };
    for (const event of UPDATE_EVENTS) window.addEventListener(event, invalidate);
    return () => { for (const event of UPDATE_EVENTS) window.removeEventListener(event, invalidate); };
  }, [cancel, resetPage]);

  useEffect(() => {
    if (!path || !foreground) return;
    let active = true;
    setError(undefined);
    setAccessError(undefined);
    const saved = cache.current.get(path);
    if (!saved || Date.now() - saved.at >= FRESH_FOR) {
      void load(path).catch((failure: unknown) => {
        if (active) setError({ path, message: failure instanceof Error ? failure.message : "读取失败，请重试" });
      });
    }
    return () => { active = false; };
  }, [attempt, foreground, load, path]);

  const recheck = () => {
    if (path) {
      const saved = cache.current.get(path);
      if (saved) saved.at = 0;
    }
    setError(undefined);
    setAttempt(value => value + 1);
  };

  const page = path ? cache.current.get(path)?.value : undefined;
  return {
    page,
    accessBlocked: !!accessError,
    error: accessError ?? (error?.path === path ? error.message : undefined),
    recheck,
    preload: useCallback(async (key: string) => {
      const saved = cache.current.get(key);
      if (!saved || Date.now() - saved.at >= FRESH_FOR) await load(key);
    }, [load]),
  };
}
