// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export interface CardDetails {
  cardKey: string;
  /** 卡号（允许空格，仅本地保存） */
  number: string;
  /** 有效期 MM/YY */
  expiry: string;
  /** 安全码 */
  cvv: string;
  /** 卡片备注（如「香港旅行和跨境消费扣账卡」） */
  note: string;
  /** 币种（如 HKD），余额与历史都按这个币种记账 */
  currency: string;
  /** 币种范围手动覆盖：'' = 自动推断，single / dual / multi / unknown = 用户指定 */
  currencyScope: string;
  /** 自定义卡面（用户自己上传的卡片照片）本地地址；空 = 用清单里的原图 */
  image: string;
  updatedAt: string;
}
export type CardBalanceKind = "deposit" | "withdraw" | "adjust";
export interface CardBalanceEntry {
  id: string;
  cardKey: string;
  kind: CardBalanceKind;
  /** 本次变动额（存入为正、取出为负） */
  delta: number;
  /** 变动后的余额 */
  balance: number;
  note: string;
  occurredAt: string;
  /** 这笔钱的另一端在券商账户（联动记了一笔方向相反的资金流水），资金记录里显示为自动 */
  brokerLinked: boolean;
}
interface DetailsRow {
  card_key: string;
  card_number: string;
  expiry: string;
  cvv: string;
  note: string;
  currency: string;
  currency_scope: string;
  image: string;
  updated_at: string;
}
interface BalanceRow {
  id: string;
  card_key: string;
  kind: string;
  delta: number;
  balance: number;
  note: string;
  occurred_at: string;
  fund_tx_id?: string;
}
