// 浏览器契约类型；业务由 Fire 内置后端统一执行。
import type {CardAmount} from "./cardAmounts";
import type {CardDetails} from "./cardWallet";
import type {CustomCard} from "./cardCustom";
export interface CardManifest {
  regions: unknown[];
  typeOrder: string[];
  updatedAt: string | null;
  source: string;
}
export interface CardLibraryPayload extends CardManifest {
  amounts: CardAmount[];
  tags: Record<string, string[]>;
  holdings: string[];
  /**
   * 服务端当前时间（毫秒）：首帧就要用 —— 「新加的卡置顶」和 NEW 角标都按 3 天窗口算，
   * 客户端自己取时间的话，服务端首帧只能画默认顺序，挂载后重排会让卡片"跳位置"。
   */
  nowMs: number;
  /**
   * 卡面首次入库时间（卡面 key → ISO）：新入库的卡（脚本导入的新卡 / 自己新建的卡）
   * 3 天内置顶并挂 NEW。升级前的老素材不在表里 → 视为不是新卡。
   */
  firstSeen: Record<string, string>;
  /** 卡背信息（卡号 / 有效期 / 安全码 / 备注 / 币种）：卡包与卡片详情首帧就要用 */
  details: Record<string, CardDetails>;
  /** 卡面覆盖表（卡面文件 → 实际图片地址）：素材库换过图的卡走这里，没登记的卡回退清单原图 */
  covers: Record<string, string>;
  /** 用户自建卡（素材库里没有的卡）：并进卡面库一起展示 */
  customCards: CustomCard[];
}
