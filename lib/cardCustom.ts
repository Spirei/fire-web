/**
 * 自定义卡片：素材库里没有的卡。
 *
 * 用户自己上传卡面照片 + 填卡名 / 银行 / 地区 / 类型 / 卡组织 / 等级 / 币种范围，
 * 存进 custom_cards 之后会并进卡面库（全部卡面里能看到，并自动进「我的卡」），
 * 之后的卡片详情、卡包、余额历史、资产分析联动都走和其它卡完全一样的逻辑。
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./db";

export interface CustomCard {
  id: string;
  name: string;
  bank: string;
  region: string;
  type: string;
  brand: string;
  level: string;
  /** 卡面图片地址（/uploads/... ） */
  image: string;
  currencyScope: string;
  createdAt: string;
}

interface CustomCardRow {
  id: string;
  name: string;
  bank: string;
  region: string;
  type: string;
  brand: string;
  level: string;
  image: string;
  currency_scope: string;
  created_at: string;
}

function toCard(row: CustomCardRow): CustomCard {
  return {
    id: row.id,
    name: row.name || "",
    bank: row.bank || "",
    region: row.region || "",
    type: row.type || "",
    brand: row.brand || "",
    level: row.level || "",
    image: row.image || "",
    currencyScope: row.currency_scope || "",
    createdAt: row.created_at
  };
}

export function listCustomCards(userId: string): CustomCard[] {
  const rows = getDb()
    .prepare(
      "SELECT id, name, bank, region, type, brand, level, image, currency_scope, created_at FROM custom_cards WHERE user_id = ? ORDER BY created_at ASC"
    )
    .all(userId) as CustomCardRow[];
  return rows.map(toCard);
}

/** 新增一张自定义卡（字段都已在上游接口校验过长度） */
export function createCustomCard(
  userId: string,
  input: { name: string; bank: string; region: string; type: string; brand: string; level: string; image: string; currencyScope: string }
): CustomCard {
  const id = randomUUID();
  const now = new Date().toISOString();
  const scope = ["single", "dual", "multi", "unknown"].includes(input.currencyScope) ? input.currencyScope : "";
  getDb()
    .prepare(
      `INSERT INTO custom_cards (id, user_id, name, bank, region, type, brand, level, image, currency_scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name,
      input.bank,
      input.region,
      input.type,
      input.brand,
      input.level,
      input.image,
      scope,
      now
    );
  return {
    id,
    name: input.name,
    bank: input.bank,
    region: input.region,
    type: input.type,
    brand: input.brand,
    level: input.level,
    image: input.image,
    currencyScope: scope,
    createdAt: now
  };
}

/** 删除自定义卡（同时把它从「我的卡」里摘掉） */
export function deleteCustomCard(userId: string, id: string): boolean {
  const db = getDb();
  const card = db.prepare("SELECT image FROM custom_cards WHERE user_id = ? AND id = ?").get(userId, id) as { image: string } | undefined;
  if (!card) return false;
  db.prepare("DELETE FROM custom_cards WHERE user_id = ? AND id = ?").run(userId, id);
  if (card.image) {
    db.prepare("DELETE FROM card_holdings WHERE user_id = ? AND card_key = ?").run(userId, card.image);
  }
  return true;
}

/** 删除自定义卡时，它在素材库里登记的那条卡面素材也要一起摘掉 */
export function customCardImageOf(userId: string, id: string): string {
  const row = getDb().prepare("SELECT image FROM custom_cards WHERE user_id = ? AND id = ?").get(userId, id) as { image: string } | undefined;
  return row?.image ?? "";
}
