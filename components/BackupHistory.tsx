"use client";

import { CapsuleLink } from "@/components/Capsule";
import StatusIndicator from "@/components/StatusIndicator";

export type BackupHistoryItem = {
  id: string;
  created_at: string;
  bytes: number;
  sha256: string;
  verified_at: string | null;
  download_available: boolean;
};

/** One readable history layout for the backup page and its management dialog. */
export default function BackupHistory({ items, downloads = false }: {
  items: BackupHistoryItem[];
  downloads?: boolean;
}) {
  return <div className="backup-history-wrap">
    <table className="backup-history">
      <thead><tr><th>创建时间</th><th>大小</th><th>校验状态</th><th>SHA-256</th>{downloads && <th>备份文件</th>}</tr></thead>
      <tbody>{items.map(item => {
        const timestamp = item.created_at.slice(0, 19);
        return <tr key={item.id}>
          <td data-label="创建时间"><time dateTime={item.created_at} className="backup-history-time"><span>{timestamp.slice(0, 10)}</span><small>{timestamp.slice(11)} UTC</small></time></td>
          <td data-label="大小" className="backup-history-size"><span>{(item.bytes / 1048576).toFixed(1)} <small>MB</small></span></td>
          <td data-label="校验状态"><StatusIndicator state={item.verified_at ? "up" : "unknown"} label={item.verified_at ? "已校验" : "待校验"} /></td>
          <td data-label="SHA-256"><code className="backup-history-hash" title={item.sha256}>{item.sha256}</code></td>
          {downloads && <td data-label="备份文件">{item.download_available ? <CapsuleLink size="sm" variant="secondary" href={`/api/fire/backups/${item.id}/download`}>下载加密备份</CapsuleLink> : <span className="text-ink-3">已按保留策略清理</span>}</td>}
        </tr>;
      })}</tbody>
    </table>
    {!items.length && <p className="backup-history-empty">暂无备份</p>}
  </div>;
}
