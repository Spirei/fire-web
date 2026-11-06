function shouldFill(order, live) {
  const tp = order.triggerPrice ?? order.price;
  switch (order.orderType) {
    case "limit":
      return order.side === "buy" ? live <= order.price : live >= order.price;
    case "trigger_buy":
      return live <= tp;
    case "trigger_sell":
      return live >= tp;
    case "rebound_buy":
      return live >= tp;
    case "rebound_sell":
      return live <= tp;
    default:
      return false;
  }
}
module.exports = shouldFill;
