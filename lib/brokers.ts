/* ---------- 券商（Broker）数据模型与规范 ----------
 *
 * 券商 = 分组管理中的券商分组，供 Web 前端与 iOS / Android 客户端统一消费。
 *
 * 模型（v1 接口返回）：
 *   {
 *     id:   string  // 券商唯一 ID（分组 ID，如 g1785588859092-0，小写为准）
 *     name: string  // 券商名称（如 长桥证劵）
 *     icon: string  // 券商图标本地 URL（/uploads/asset/broker/…），无图标时为空字符串，客户端用名称首字母兜底
 *   }
 *
 * 存储：
 *   - 券商列表：设置 site_settings.groups（[{ id, name }]，顺序即展示顺序）
 *   - 券商图标：素材库 assets（type=broker，code=分组ID，name=券商名，url=图标）
 *   - 持仓记录：records.group_name 存券商名称（改名时由 syncRecordGroups 全局同步）
 *
 * 规范化约定（AGENTS.md 同步维护）：
 *   - 券商 ID 一律以小写分组 ID 为规范；素材 code 存库为大写，匹配时大小写不敏感
 *   - 图标文件名按券商名称（长桥证劵.png），存放 public/uploads/asset/broker/
 *   - 客户端展示：icon 为空时回退名称首字母；名称以 name 字段为准
 */
import { getSiteSettings, updateSiteSettings } from "@/lib/settings";
import { getAssets } from "@/lib/assets";
import { clearRecordGroup, renameRecordGroup } from "@/lib/store";
import type { GroupConfig } from "@/lib/types";

export interface Broker {
  id: string;
  name: string;
  /** 券商别名（如 盈透证券 → IBKR），无别名时为空字符串 */
  alias: string;
  icon: string;
}

/** 券商列表：设置分组 + 素材库图标合并（按设置顺序），图标匹配大小写不敏感 */
export function getBrokers(): Broker[] {
  const settings = getSiteSettings();
  const icons = new Map<string, string>();
  getAssets().forEach((a) => {
    if (a.type === "broker") icons.set(a.code.toLowerCase(), a.url);
  });
  return settings.groups.map((g) => ({
    id: g.id,
    name: g.name,
    alias: g.alias ?? "",
    icon: icons.get(g.id.toLowerCase()) ?? ""
  }));
}

/** 券商增删改后同步持仓记录：改名 → 更新记录分组；删除 → 清空对应记录分组 */
export function syncRecordGroups(prev: GroupConfig[], next: GroupConfig[]) {
  const prevMap = new Map(prev.map((g) => [g.id, g.name]));
  const nextMap = new Map(next.map((g) => [g.id, g.name]));
  nextMap.forEach((name, id) => {
    const old = prevMap.get(id);
    if (old && old !== name) renameRecordGroup(old, name);
  });
  prevMap.forEach((name, id) => {
    if (!nextMap.has(id)) clearRecordGroup(name);
  });
}

/** 全量保存券商列表（覆盖式）：更新设置 + 同步记录分组 + 返回最新列表 */
export function saveBrokers(groups: GroupConfig[]): Broker[] {
  const before = getSiteSettings();
  const settings = updateSiteSettings({ groups });
  syncRecordGroups(before.groups, settings.groups);
  return getBrokers();
}
