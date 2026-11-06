// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export interface CustomCard {
  id: string;
  name: string;
  bank: string;
  region: string;
  type: string;
  brand: string;
  level: string;
  /** 卡面图片地址（/uploads/... ） */
  image: string;
  currencyScope: string;
  createdAt: string;
}
interface CustomCardRow {
  id: string;
  name: string;
  bank: string;
  region: string;
  type: string;
  brand: string;
  level: string;
  image: string;
  currency_scope: string;
  created_at: string;
}
