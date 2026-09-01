export const WORLD_ECONOMY_INDICATORS = {
  // 色阶阈值与 TradingView 全球经济地图保持一致。固定阈值也让跨年份对比具有可比性，
  // 避免按当年分位数重新着色后，同一种颜色在不同年份代表完全不同的数值。
  inflation: { code: "FP.CPI.TOTL.ZG", title: "全球通胀率，同比", shortTitle: "通胀率", unit: "%", description: "观察消费价格年度变化，识别全球通胀压力。", palette: "orange", thresholds: [0, 3, 7, 12, 25] },
  unemployment: { code: "SL.UEM.TOTL.ZS", title: "全球失业率", shortTitle: "失业率", unit: "%", description: "比较各经济体劳动力市场的松紧程度。", palette: "blue", thresholds: [3, 5, 7, 10, 13] },
  industry: { code: "NV.IND.MANF.KD.ZG", title: "全球工业活动，同比", shortTitle: "工业活动", unit: "%", description: "以制造业增加值年度增速观察工业活力。", palette: "cyan", thresholds: [0, 3, 6, 10, 15] },
  debt: { code: "GC.DOD.TOTL.GD.ZS", title: "政府债务对 GDP 占比", shortTitle: "政府债务", unit: "%", description: "比较中央政府债务占 GDP 的比重。", palette: "pink", thresholds: [30, 50, 70, 90, 110] },
  gdp: { code: "NY.GDP.MKTP.KD.ZG", title: "GDP 增长，同比", shortTitle: "GDP 增长", unit: "%", description: "观察实际 GDP 年度增长与经济周期变化。", palette: "sky", thresholds: [0, 3, 6, 8, 10] },
  rate: { code: "FR.INR.LEND", title: "贷款利率", shortTitle: "贷款利率", unit: "%", description: "比较银行贷款利率，观察主要经济体融资成本。", palette: "green", thresholds: [3, 5, 7, 12, 25] }
} as const;

export type WorldEconomyIndicator = keyof typeof WORLD_ECONOMY_INDICATORS;

export interface WorldEconomyCountry {
  code: string;
  name: string;
  mapName: string;
  value: number;
  year: number;
  flag: string;
  flagCode: string;
}

const NAME_ALIASES: Record<string, string> = {
  "Bahamas, The": "Bahamas", "Bosnia and Herzegovina": "Bosnia and Herz.", "Brunei Darussalam": "Brunei",
  "Central African Republic": "Central African Rep.", "Cote d'Ivoire": "Côte d'Ivoire", "Congo, Dem. Rep.": "Dem. Rep. Congo",
  "Congo, Rep.": "Congo", "Cabo Verde": "Cape Verde", Czechia: "Czech Rep.", "Dominican Republic": "Dominican Rep.",
  "Egypt, Arab Rep.": "Egypt", "Equatorial Guinea": "Eq. Guinea", "Gambia, The": "Gambia", "Hong Kong SAR, China": "Hong Kong",
  "Iran, Islamic Rep.": "Iran", "Kyrgyz Republic": "Kyrgyzstan", "Korea, Rep.": "Korea", "Korea, Dem. People's Rep.": "Dem. Rep. Korea",
  "North Macedonia": "Macedonia", "Russian Federation": "Russia", "Slovak Republic": "Slovakia", "Somalia, Fed. Rep.": "Somalia",
  "South Sudan": "S. Sudan", "Solomon Islands": "Solomon Is.", "Syrian Arab Republic": "Syria", Eswatini: "Swaziland", Turkiye: "Turkey",
  "Venezuela, RB": "Venezuela", "Viet Nam": "Vietnam", "West Bank and Gaza": "Palestine", "Yemen, Rep.": "Yemen",
  "Marshall Islands": "Marshall Is.", "Macao SAR, China": "Macao"
};

export const G20_CODES = new Set(["ARG", "AUS", "BRA", "CAN", "CHN", "FRA", "DEU", "IND", "IDN", "ITA", "JPN", "MEX", "RUS", "SAU", "ZAF", "KOR", "TUR", "GBR", "USA"]);

const cache = new Map<string, { at: number; data: WorldEconomyCountry[] }>();
const CACHE_TTL = 12 * 60 * 60 * 1000;

export function countryDisplayName(iso2: string, fallback: string) {
  return countryNameZh(iso2, fallback);
}

export async function getWorldEconomyData(indicator: WorldEconomyIndicator, year: number): Promise<WorldEconomyCountry[]> {
  const meta = WORLD_ECONOMY_INDICATORS[indicator];
  const cacheKey = `${indicator}:${year}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  const start = Math.max(1990, year - 5);
  const [countryRes, valueRes] = await Promise.all([
    fetch("https://api.worldbank.org/v2/country?format=json&per_page=400", { signal: AbortSignal.timeout(15000) }),
    fetch(`https://api.worldbank.org/v2/country/all/indicator/${meta.code}?format=json&per_page=20000&date=${start}:${year}`, { signal: AbortSignal.timeout(20000) })
  ]);
  if (!countryRes.ok || !valueRes.ok) throw new Error("World Bank 数据源暂不可用");

  const countryJson = await countryRes.json() as [unknown, Array<{ id: string; iso2Code: string; name: string; region: { id: string } }>];
  const valueJson = await valueRes.json() as [unknown, Array<{ countryiso3code: string; country: { value: string }; date: string; value: number | null }>];
  const countries = new Map((countryJson?.[1] ?? []).filter((item) => item.region?.id !== "NA").map((item) => [item.id, { name: item.name, iso2: item.iso2Code }]));
  const latest = new Map<string, WorldEconomyCountry>();
  for (const row of valueJson?.[1] ?? []) {
    const code = row.countryiso3code;
    if (!countries.has(code) || row.value == null || !Number.isFinite(Number(row.value))) continue;
    const rowYear = Number(row.date);
    const previous = latest.get(code);
    if (previous && previous.year >= rowYear) continue;
    const country = countries.get(code);
    const name = country?.name ?? row.country.value;
    latest.set(code, {
      code,
      name: countryDisplayName(country?.iso2 ?? "", name),
      mapName: NAME_ALIASES[name] ?? name,
      value: Number(row.value),
      year: rowYear,
      flag: countryFlagEmoji(country?.iso2 ?? ""),
      flagCode: (country?.iso2 ?? "").toLowerCase()
    });
  }
  const data = [...latest.values()];
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}
import { countryFlagEmoji, countryNameZh } from "./countryCatalog";
