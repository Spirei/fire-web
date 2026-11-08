/** A compact observation: text carries the state as well as the colored dot. */
export default function StatusIndicator({state,label,observedAt,size="sm"}:{state:string;label?:string;observedAt?:string|null;size?:"sm"|"md"}) {
  const names:Record<string,string>={up:'已连接',down:'连接失败',unknown:'未检测',unconfigured:'未配置',checking:'检测中',stale:'待复查'};
  return <span className="status-indicator" data-state={state} data-size={size} role="status" title={observedAt ? `上次检测：${new Date(observedAt).toLocaleString('zh-CN')}` : undefined}><i aria-hidden="true"/>{label || names[state] || names.unknown}</span>;
}
