export interface CountryCatalogItem {
  mapName: string;
  iso2: string;
  name: string;
  flag: string;
  flagCode: string;
}

// ISO 3166-1 alpha-2。名称由浏览器/Node 的 ICU 生成，避免维护一份容易遗漏的中文译名表。
const ISO2_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(" ");

// ECharts/Natural Earth 地图中的缩写名 → ISO2。未列出的标准名称会自动通过英文 ICU 名称匹配。
const MAP_NAME_TO_ISO2: Record<string, string> = {
  "Aland": "AX", "Antigua and Barb.": "AG", "Bahamas": "BS", "Bolivia": "BO",
  "Bosnia and Herz.": "BA", "Br. Indian Ocean Ter.": "IO", "Brunei": "BN", "Cape Verde": "CV",
  "Cayman Is.": "KY", "Central African Rep.": "CF", "Congo": "CG", "Curaçao": "CW",
  "Czech Rep.": "CZ", "Côte d'Ivoire": "CI", "Dem. Rep. Congo": "CD", "Dem. Rep. Korea": "KP",
  "Dominican Rep.": "DO", "Egypt": "EG", "Eq. Guinea": "GQ", "Faeroe Is.": "FO",
  "Falkland Is.": "FK", "Fr. Polynesia": "PF", "Fr. S. Antarctic Lands": "TF",
  "Heard I. and McDonald Is.": "HM", "Iran": "IR", "Korea": "KR", "Kyrgyzstan": "KG",
  "Lao PDR": "LA", "Macedonia": "MK", "Micronesia": "FM", "Moldova": "MD",
  "N. Cyprus": "CY", "N. Mariana Is.": "MP", "Palestine": "PS", "Russia": "RU",
  "S. Geo. and S. Sandw. Is.": "GS", "S. Sudan": "SS", "Saint Helena": "SH",
  "Myanmar": "MM", "Saint Lucia": "LC", "Siachen Glacier": "IN", "Solomon Is.": "SB",
  "St. Pierre and Miquelon": "PM", "St. Vin. and Gren.": "VC", "Trinidad and Tobago": "TT",
  "Swaziland": "SZ", "Syria": "SY", "São Tomé and Principe": "ST", "Tanzania": "TZ",
  "Turkey": "TR", "Turks and Caicos Is.": "TC", "U.S. Virgin Is.": "VI",
  "United Kingdom": "GB", "United States": "US", "Venezuela": "VE", "Vietnam": "VN",
  "W. Sahara": "EH", "Yemen": "YE",
  "Dhekelia": "CY", "Somaliland": "SO", "St-Martin": "MF", "Sint Maarten": "SX",
  "Kosovo": "XK", "San Marino": "SM", "Monaco": "MC", "USNB Guantanamo Bay": "CU",
  "Gibraltar": "GI", "Vatican": "VA", "Cyprus U.N. Buffer Zone": "CY", "Baikonur": "KZ",
  "Akrotiri": "CY", "Aruba": "AW", "Taiwan": "TW", "Pitcairn Is.": "PN",
  "Marshall Is.": "MH", "U.S. Minor Outlying Is.": "UM", "St. Kitts and Nevis": "KN",
  "St-Barthélemy": "BL", "Anguilla": "AI", "British Virgin Is.": "VG", "Guernsey": "GG",
  "Indian Ocean Ter.": "IO", "Norfolk Island": "NF", "Cook Is.": "CK",
  "Wallis and Futuna Is.": "WF", "Tuvalu": "TV", "Maldives": "MV", "Nauru": "NR",
  "Coral Sea Is.": "AU", "Clipperton I.": "FR", "Macao": "MO",
  "Ashmore and Cartier Is.": "AU", "Bajo Nuevo Bank": "CO", "Serranilla Bank": "CO",
  "Scarborough Reef": "PH", "Spratly Is.": ""
};

const NAME_ZH_OVERRIDES: Record<string, string> = {
  AX: "奥兰群岛", BO: "玻利维亚", CD: "刚果民主共和国", CG: "刚果共和国", CI: "科特迪瓦",
  CZ: "捷克", FM: "密克罗尼西亚", GB: "英国", HK: "中国香港", KR: "韩国", KP: "朝鲜",
  LA: "老挝", MO: "中国澳门", MK: "北马其顿", PS: "巴勒斯坦", RU: "俄罗斯",
  ST: "圣多美和普林西比", SZ: "斯威士兰", TR: "土耳其", TW: "中国台湾", US: "美国",
  VA: "梵蒂冈", VE: "委内瑞拉", VN: "越南", XK: "科索沃"
};

const MAP_NAME_ZH_OVERRIDES: Record<string, string> = {
  "N. Cyprus": "北塞浦路斯", "Siachen Glacier": "锡亚琴冰川",
  "Dhekelia": "德凯利亚基地", "Cyprus U.N. Buffer Zone": "塞浦路斯联合国缓冲区",
  "Akrotiri": "阿克罗蒂利基地", "Baikonur": "拜科努尔", "Somaliland": "索马里兰",
  "Spratly Is.": "南沙群岛", "Scarborough Reef": "黄岩岛"
};

function displayName(locale: string, code: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

export function countryFlagEmoji(iso2: string) {
  const code = iso2.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code)
    ? code.replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    : "🌐";
}

const ENGLISH_TO_ISO2 = new Map(ISO2_CODES.map((iso2) => [displayName("en", iso2), iso2]));

export function countryIso2ForMapName(mapName: string) {
  return MAP_NAME_TO_ISO2[mapName] || ENGLISH_TO_ISO2.get(mapName) || "";
}

export function countryNameZh(iso2: string, fallback: string) {
  const code = iso2.trim().toUpperCase();
  return NAME_ZH_OVERRIDES[code] || (code ? displayName("zh-CN", code) : fallback) || fallback;
}

export function countryCatalogForMapNames(mapNames: string[]): CountryCatalogItem[] {
  return mapNames
    .filter(Boolean)
    .map((mapName) => {
      const iso2 = countryIso2ForMapName(mapName);
      return {
        mapName,
        iso2,
        name: MAP_NAME_ZH_OVERRIDES[mapName] || countryNameZh(iso2, mapName),
        flag: countryFlagEmoji(iso2),
        flagCode: iso2.toLowerCase()
      };
    });
}

export function allCountryCatalog(): CountryCatalogItem[] {
  const list = ISO2_CODES.map((iso2) => ({
    mapName: displayName("en", iso2),
    iso2,
    name: countryNameZh(iso2, iso2),
    flag: countryFlagEmoji(iso2),
    flagCode: iso2.toLowerCase()
  }));
  // 欧盟：非 ISO 国家码，单独补充，便于货币/旗帜素材库统一使用本地 eu.svg
  if (!list.some((c) => c.iso2 === "EU")) {
    list.push({ mapName: "European Union", iso2: "EU", name: "欧盟", flag: "🇪🇺", flagCode: "eu" });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
