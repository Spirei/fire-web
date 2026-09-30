/** 工作区面板被收起后仍挂在树上。连续动画要看面板是否隐藏，不能只看视口相交。 */
export function panelIsShown(element: Element | null) {
  const panel = element?.closest(".tab-panel");
  return !panel || !panel.hasAttribute("hidden");
}

export function observePanelVisibility(element: Element, onChange: () => void) {
  const panel = element.closest(".tab-panel");
  if (!panel) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  return () => observer.disconnect();
}
