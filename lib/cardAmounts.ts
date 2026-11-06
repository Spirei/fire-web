// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export interface CardAmount {
  cardKey: string;
  amount: number;
  currency: string;
  note: string;
  updatedAt: string;
}
interface CardAmountRow {
  card_key: string;
  amount: number;
  currency: string;
  note: string;
  updated_at: string;
}
