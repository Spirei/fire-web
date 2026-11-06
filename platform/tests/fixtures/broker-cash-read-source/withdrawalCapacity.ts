export function withdrawalCapacity(balance:number|null,fundCash:number|null,reserved:number|null,manual:boolean) {
  const complete=manual&&balance!==null&&fundCash!==null&&reserved!==null&&[balance,fundCash,reserved].every(Number.isFinite);
  return {amount:complete?Math.max(0,Math.min(balance!,fundCash!-reserved!)):null,reservedGlobalBuyCash:reserved,basis:'min_broker_balance_and_owner_fund_cash_after_reservations'};
}
