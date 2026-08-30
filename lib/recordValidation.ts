export function validateRecordFields(
  name: string,
  code: string,
  price: number | "",
  qty: number | ""
): string | null {
  if (!name || name.length > 100 || !/^[A-Za-z0-9._-]{1,40}$/.test(code)) {
    return "请填写有效的股票名称和代码（名称≤100、代码≤40）";
  }
  if (price !== "" && price < 0) return "现价不能为负数";
  if (qty !== "" && qty < 0) return "数量不能为负数";
  // 成本允许为负：返佣、期权收入或累计回款可能令剩余持仓成本降至零以下。
  return null;
}
