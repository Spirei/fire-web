// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export interface BackupConfig {
  enabled: boolean;
  /** 备份间隔（小时）：1 每小时 / 24 每天 / 168 每周 / 720 每月 */
  intervalHours: number;
  /** 保留份数 */
  keep: number;
  /** 上次备份时间戳 */
  lastAt: number;
  lastFile: string;
  lastSize: number;
}
type BackupState = {
  lastCheckAt: number;
  runningBackup: Promise<{ name: string; size: number }> | null;
  activeBackupName: string | null;
  deletingBackupNames: Set<string>;
};
