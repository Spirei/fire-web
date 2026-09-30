/** 浮动助手收起时不订阅。换页只改这个值，避免整棵助手树跟着重绘。 */
let page = "";
const listeners = new Set<(page: string) => void>();

export function setAssistantPage(next: string) {
  page = next;
}

export function currentAssistantPage() {
  return page;
}

export function subscribeAssistantPage(listener: (page: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAssistantPage() {
  const current = page;
  listeners.forEach((listener) => listener(current));
}
