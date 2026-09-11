/**
 * 卡面主题标签：素材库的上游元数据里没有「主题」这一维，这里按卡名关键词自动打标。
 * 只做提示与筛选用，不写回数据；以后要人工维护标签，覆盖这张表即可。
 */
const THEME_RULES: { key: string; label: string; test: RegExp }[] = [
  {
    key: "ip",
    label: "联名 IP",
    test: /联名|HelloKitty|HelloKitty|宝可梦|Pokemon|航海王|OnePiece|大卫贝肯|小财娘|哆啦|柯南|Disney|迪士尼|米奇|漫威|Marvel|高达|Gundam|EVA|初音|蜡笔小新|龙珠|火影|海贼|史努比|Snoopy|不二家|樱桃小丸子|托马斯|小黄人|奥特曼|LINE|布朗熊|屁桃|斑马|幸运熊|卡皮巴拉|小刘鸭|汪汪队|皮卡丘/
  },
  { key: "virtual", label: "虚拟卡", test: /虚拟|Virtual|数字卡|Apple Pay|Google Pay|e卡|电子卡/i },
  { key: "zodiac", label: "生肖", test: /生肖|龙年|蛇年|马年|羊年|猴年|鸡年|狗年|猪年|鼠年|牛年|虎年|兔年/ },
  { key: "anniversary", label: "纪念 / 限定", test: /纪念|周年|限定|典藏|珍藏|首发|联名限定/ },
  { key: "campus", label: "校园 / 青年", test: /校园|学生|青年|Young|青春|大学|毕业/i },
  { key: "travel", label: "商旅 / 航空", test: /商旅|航空|旅行|里程|飞行|环球|Travel|Avios|Asia Miles|蓝天/i },
  { key: "cute", label: "动物 / 萌系", test: /熊猫|猫|狗|兔|熊|宠物|萌|卡通|花朵|樱花|草莓|Kitty|精灵/ },
  { key: "fintech", label: "数字银行", test: /Wise|Revolut|Monzo|Chime|N26|Chase UK|Cash App|Vivid|Bunq|Pockit|Zilch/i },
  { key: "gold", label: "金卡 / 白金以上", test: /金卡|白金|钻石|世界|无限|Platinum|Signature|Infinite|World Elite|Precious|Titanium/i }
];

export const CARD_TAG_ORDER = THEME_RULES.map((rule) => rule.label);

export function cardTagsOf(name: string): string[] {
  const value = String(name || "");
  return THEME_RULES.filter((rule) => rule.test.test(value)).map((rule) => rule.label);
}
