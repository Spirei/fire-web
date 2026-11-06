"use client";

import {
  IconSearch,
  IconTrash,
  IconLayoutGrid,
  IconList,
  IconRefresh,
  IconRestore,
  IconFolderPlus,
} from "@tabler/icons-react";
import { IconButton } from "@/components/Capsule";

export default function CollectionToolbar({
  query,
  onQuery,
  selecting,
  onToggleSelection,
  selectedCount,
  onRemove,
  removed = false,
  grid,
  onGrid,
  onRefresh,
  refreshing = false,
  busy = false,
  onImport,
}: {
  query: string;
  onQuery: (value: string) => void;
  selecting: boolean;
  onToggleSelection: () => void;
  selectedCount: number;
  onRemove: () => void;
  removed?: boolean;
  grid: boolean;
  onGrid: (value: boolean) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  busy?: boolean;
  onImport?: () => void;
}) {
  return (
    <div className="collection-toolbar">
      <label className="collection-search">
        <IconSearch size={19} />
        <input
          aria-label="搜索名称或代码"
          placeholder="搜索名称或代码"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      <button
        type="button"
        data-capsule="off"
        className="collection-select-button"
        aria-pressed={selecting}
        disabled={busy}
        onClick={onToggleSelection}
      >
        {selecting ? "完成选择" : "批量选择"}
      </button>
      <div className="collection-view-actions">
        {onImport && (
          <IconButton
            label="导入目录"
            disabled={busy || refreshing}
            onClick={onImport}
          >
            <IconFolderPlus size={19} />
          </IconButton>
        )}
        {selecting && selectedCount > 0 && (
          <IconButton
            label={removed ? "恢复所选素材" : "移除所选素材"}
            disabled={busy || refreshing}
            onClick={onRemove}
          >
            {removed ? <IconRestore size={19} /> : <IconTrash size={19} />}
          </IconButton>
        )}
        <IconButton
          label="网格视图"
          selected={grid}
          onClick={() => onGrid(true)}
        >
          <IconLayoutGrid size={19} />
        </IconButton>
        <IconButton
          label="列表视图"
          selected={!grid}
          onClick={() => onGrid(false)}
        >
          <IconList size={19} />
        </IconButton>
        <IconButton
          label="刷新素材"
          busy={refreshing}
          disabled={refreshing || busy}
          onClick={onRefresh}
        >
          <IconRefresh size={19} />
        </IconButton>
      </div>
    </div>
  );
}
