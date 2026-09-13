import type { SearchMatch } from "./types";

export interface MainstreamCrypto {
  code: string;
  name: string;
  id: string;
  aliases: string[];
}

// 以 OKX / Binance 的高市值、高成交量常见币为范围；稳定币保留，ETF、概念股和小币种不在此表。
export const MAINSTREAM_CRYPTO: MainstreamCrypto[] = [
  { code: "BTC", name: "Bitcoin", id: "bitcoin", aliases: ["bitcoin", "btc", "比特币"] },
  { code: "ETH", name: "Ethereum", id: "ethereum", aliases: ["ethereum", "ether", "eth", "以太坊", "以太币"] },
  { code: "USDT", name: "Tether", id: "tether", aliases: ["tether", "usdt", "泰达币"] },
  { code: "BNB", name: "BNB", id: "binancecoin", aliases: ["bnb", "binance coin", "币安币"] },
  { code: "XRP", name: "XRP", id: "ripple", aliases: ["xrp", "ripple", "瑞波币"] },
  { code: "USDC", name: "USD Coin", id: "usd-coin", aliases: ["usdc", "usd coin"] },
  { code: "SOL", name: "Solana", id: "solana", aliases: ["sol", "solana", "索拉纳"] },
  { code: "TRX", name: "TRON", id: "tron", aliases: ["trx", "tron", "波场"] },
  { code: "DOGE", name: "Dogecoin", id: "dogecoin", aliases: ["doge", "dogecoin", "狗狗币"] },
  { code: "ADA", name: "Cardano", id: "cardano", aliases: ["ada", "cardano", "艾达币"] },
  { code: "AVAX", name: "Avalanche", id: "avalanche-2", aliases: ["avax", "avalanche", "雪崩"] },
  { code: "LINK", name: "Chainlink", id: "chainlink", aliases: ["link", "chainlink"] },
  { code: "TON", name: "Toncoin", id: "the-open-network", aliases: ["ton", "toncoin"] },
  { code: "BCH", name: "Bitcoin Cash", id: "bitcoin-cash", aliases: ["bch", "bitcoin cash", "比特币现金"] },
  { code: "DOT", name: "Polkadot", id: "polkadot", aliases: ["dot", "polkadot", "波卡"] },
  { code: "LTC", name: "Litecoin", id: "litecoin", aliases: ["ltc", "litecoin", "莱特币"] },
  { code: "SHIB", name: "Shiba Inu", id: "shiba-inu", aliases: ["shib", "shiba inu", "柴犬币"] },
  { code: "SUI", name: "Sui", id: "sui", aliases: ["sui"] },
  { code: "XLM", name: "Stellar", id: "stellar", aliases: ["xlm", "stellar", "恒星币"] },
  { code: "UNI", name: "Uniswap", id: "uniswap", aliases: ["uni", "uniswap"] },
  { code: "OKB", name: "OKB", id: "okb", aliases: ["okb"] }
];

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactAliasPattern = new RegExp(`^(?:${MAINSTREAM_CRYPTO.flatMap((item) => item.aliases).map(escapeRegExp).join("|")})$`, "i");
const mainstreamCodes = new Set(MAINSTREAM_CRYPTO.map((item) => item.code));

export function isMainstreamCryptoCode(code: string): boolean {
  return mainstreamCodes.has(code.trim().toUpperCase());
}

export function searchMainstreamCrypto(query: string): SearchMatch[] {
  const q = normalize(query);
  if (!q) return [];
  const exact = exactAliasPattern.test(q);
  return MAINSTREAM_CRYPTO.filter((item) => item.aliases.some((alias) => {
    const normalizedAlias = normalize(alias);
    return exact ? normalizedAlias === q : normalizedAlias.startsWith(q);
  })).map((item) => ({
    symbol: `CRYPTO:${item.id}`,
    code: item.code,
    name: item.name,
    market: "ASSET",
    price: null,
    changePct: null,
    type: "crypto"
  }));
}
