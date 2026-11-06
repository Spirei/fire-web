// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export interface WatchGroupDto {
  id: string;
  name: string;
  icon: string;
  sort: number;
  visible: number; // -1 自动 / 0 隐藏 / 1 显示
  kind: "market" | "custom";
  market: string;
}
interface WatchGroupRow {
  id: string;
  user_id: string;
  name: string;
  icon: string;
  sort: number;
  visible: number;
  kind: "market" | "custom";
  market: string;
  created_at: string;
}
