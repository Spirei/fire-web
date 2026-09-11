/**
 * 卡背安全码（CVV / CVC）的规则 —— 客户端展示与服务端数据清洗共用这一处，
 * 避免两边各写一份判断、日后漂移。
 *
 * 中国大陆的借记卡背面**没有**安全码（线上支付走密码 / 短信验证，卡号 + 有效期也刷不了）。
 * 其他地区 / 卡种（如香港、海外的借记卡大多带 CVC）是否带安全码暂无结论，一律按「有」处理。
 * 以后要扩规则只改这里。
 */
export interface CardIdentity {
  type?: string;
  region?: string;
}

export function hasSecurityCode(card: CardIdentity): boolean {
  return !(card.region === "中国内地" && card.type === "借记卡");
}
