"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  IconTrash,
  IconLayoutGrid,
  IconPencil,
  IconGripVertical,
  IconUpload,
  IconRestore,
  IconCheck,
  IconDotsVertical,
} from "@tabler/icons-react";
import {
  useWorkspaceSearchParams,
  useWorkspaceLocationGuard,
} from "@/lib/workspacePanel";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
import SafeAssetImage from "@/components/SafeAssetImage";
import MarketIcon from "@/components/MarketIcon";
import AppModal, { ModalForm, ModalField, ModalMedia, ModalActions, ModalChoiceGrid } from "@/components/AppModal";
import AssetImageControl from "@/components/AssetImageControl";
import { uploadMaterialImage } from "@/lib/materialImageUpload";
import CollectionToolbar from "@/components/CollectionToolbar";
import CollectionSkeleton from "@/components/CollectionSkeleton";
import Pagination from "@/components/Pagination";
import AppSelect from "@/components/AppSelect";
import { materialMarketSlots } from "@/lib/materialMarkets";
import { readMaterialResponse } from "@/lib/materialRead";
import { Capsule } from "@/components/Capsule";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import { appConfirm } from "@/lib/appDialog";
import { showToast } from "@/lib/toast";
import { marketMeta } from "@/lib/types";
const categories = [
  ["market", "市场图标"],
  ["stock", "股票图标"],
  ["crypto", "加密货币"],
  ["metal", "贵金属"],
  ["flag", "国家/地区旗帜"],
  ["broker", "券商图标"],
  ["group", "股票分组"],
  ["card", "卡片"],
] as const;
const markets = [
  "US",
  "HK",
  "CN",
  "JP",
  "KR",
  "SG",
  "UK",
  "DE",
  "FR",
  "AU",
  "CA",
  "IN",
  "TW",
  "BR",
];
type Item = {
  id: string;
  type: string;
  market: string;
  code: string;
  name: string;
  url: string;
  urlDark?: string;
  imageUrl?: string;
  brokerMarkets: string[];
};
type Listing = {
  marketCounts: Record<string, number>;
  removedCount?: number;
  assets: Item[];
  total: number;
  page: number;
  revision: string;
};
export default function AssetCatalogView({
  ownerId = "",
  initial,
}: {
  ownerId?: string;
  initial?: import("@/lib/workspaceInitial").WorkspaceInitial["material"];
}) {
  const params = useWorkspaceSearchParams(),
    guard = useWorkspaceLocationGuard(),
    foreground = useWorkspaceForeground();
  const foregroundRef = useRef(foreground);
  foregroundRef.current = foreground;
  const type = categories.some((c) => c[0] === params.get("tab"))
      ? params.get("tab")!
      : "market",
    market = params.get("market") || "ALL",
    query = (params.get("q") || "").slice(0, 200),
    page = Math.max(1, Number(params.get("page")) || 1),
    grid = params.get("view") === "grid",
    removed = type !== "group" && params.get("removed") === "1";
  const [listing, setListing] = useState<Listing | null>(initial?.data ?? null),
    [loading, setLoading] = useState(!initial),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0),
    [selecting, setSelecting] = useState(false),
    [selection, setSelection] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Item | null>(null),
    [name, setName] = useState(""),
    [classification, setClassification] = useState<string[]>([]),
    [order, setOrder] = useState(markets),
    [importRows, setImportRows] = useState<
      | {
          file: File;
          target: Item | null;
        }[]
      | null
    >(null);
  const marketCountCache = useRef(new Map<string, Record<string, number>>());
  const pageCache = useRef(new Map<string, { data: Listing; at: number }>(initial ? [[initial.key, {data:initial.data,at:Date.now()}]] : []));
  const seenTick = useRef(0);
  const directoryFile = useRef<HTMLInputElement>(null);
  const editorFile = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<Item | null>(null);
  const imageFile = useRef<HTMLInputElement>(null);
  const chooseImage = (item: Item) => { uploadTarget.current = item; imageFile.current?.click(); };
  const IdentityText = selecting ? "span" : "button";
  const toggleSelection = (id: string) =>
    setSelection((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
    );
  const table = useRef<HTMLDivElement>(null),
    positions = useRef(new Map<string, DOMRect>());
  const bar = useRef<HTMLElement>(null),
    drag = useRef<string | null>(null),
    readKey = `${ownerId}|${type}|${market}|${query}|${page}|${removed}`,
    [loadedKey, setLoadedKey] = useState(initial?.key ?? "");
  const current = useRef(readKey);
  current.current = readKey;
  const displayed =
    loadedKey === readKey ? listing : pageCache.current.get(readKey)?.data;
  const rows = displayed?.assets || [];
  const total = displayed?.total || 0;
  const marketSlots =
    type === "stock"
      ? materialMarketSlots(
          order,
          displayed?.marketCounts ||
            marketCountCache.current.get(`${ownerId}|${removed}`) ||
            {},
          market,
        )
      : { visible: order, more: [] };
  const update = (patch: Record<string, string | null>) => {
    if (!guard()) return;
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    window.history.replaceState(null, "", `?${next}`);
  };
  useLayoutEffect(() => {
    const nav = bar.current,
      selected = nav?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (nav && selected) {
      const left = selected.offsetLeft - nav.offsetLeft;
      if (left < nav.scrollLeft) nav.scrollLeft = left;
      else if (left + selected.offsetWidth > nav.scrollLeft + nav.clientWidth)
        nav.scrollLeft = left + selected.offsetWidth - nav.clientWidth;
    }
  }, [type]);
  useEffect(() => {
    setSelection([]);
    setSelecting(false);
    setEditing(null);
    setImportRows(null);
  }, [readKey]);
  useEffect(() => {
    if (!foreground) return;
    const cached = pageCache.current.get(readKey);
    const forced = tick !== seenTick.current;
    seenTick.current = tick;
    if (cached) {
      setListing(cached.data);
      setLoadedKey(readKey);
    }
    if (cached && Date.now() - cached.at < 60000 && !forced) {
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const p = new URLSearchParams({
      type,
      market,
      q: query.slice(0, 200),
      page: String(page),
      removed: removed ? "1" : "0",
    });
    readMaterialResponse(
      type === "group" ? "/api/v1/watch-groups" : `/api/assets/catalog?${p}`,
      controller.signal,
    )
      .then((d) => {
        if (type === "group") {
          const groups = (d.data?.groups || []).filter(
            (g: { kind: string; name: string }) =>
              g.kind === "custom" &&
              (!query ||
                g.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
          );
          const safe = Math.min(
            page,
            Math.max(1, Math.ceil(groups.length / 10)),
          );
          return {
            assets: groups
              .slice((safe - 1) * 10, safe * 10)
              .map((g: { id: string; name: string; icon: string }) => ({
                id: g.id,
                type: "group",
                market: "GROUP",
                code: g.id,
                name: g.name,
                url: g.icon,
                brokerMarkets: [],
              })),
            total: groups.length,
            page: safe,
            revision: "owner-groups",
            marketCounts: {},
          };
        }
        if (!Array.isArray(d.assets) || !Number.isFinite(d.total) || !Number.isFinite(d.page)) throw Error("素材响应不完整，请重试");
        return d as Listing;
      })
      .then((d) => {
        if (
          controller.signal.aborted ||
          current.current !== readKey ||
          !foregroundRef.current ||
          document.hidden
        )
          return;
        if (type === "stock")
          marketCountCache.current.set(
            `${ownerId}|${removed}`,
            d.marketCounts || {},
          );
        pageCache.current.delete(readKey);
        pageCache.current.set(readKey, { data: d, at: Date.now() });
        if (pageCache.current.size > 20)
          pageCache.current.delete(pageCache.current.keys().next().value!);
        setListing(d);
        setSelection((ids) =>
          ids.filter((id) => d.assets.some((asset: Item) => asset.id === id)),
        );
        setLoadedKey(readKey);
      })
      .catch((e) => {
        if (!controller.signal.aborted && current.current === readKey && foregroundRef.current) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted && current.current === readKey) setLoading(false);
      });
    return () => controller.abort();
  }, [readKey, tick, foreground]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.settings?.assetMarketOrder))
          setOrder([
            ...new Set<string>([...d.settings.assetMarketOrder, ...markets]),
          ]);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useLayoutEffect(() => {
    if (loading) return;
    for (const node of table.current?.querySelectorAll<HTMLElement>(
      "[data-material-id]",
    ) || []) {
      const before = positions.current.get(node.dataset.materialId!);
      const after = node.getBoundingClientRect();
      if (
        before &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        const x = before.left - after.left,
          y = before.top - after.top;
        if (x || y)
          node.animate(
            [{ transform: `translate(${x}px,${y}px)` }, { transform: "none" }],
            { duration: 200, easing: "ease-out" },
          );
      }
    }
    positions.current.clear();
  }, [listing, loading]);
  const capturePositions = () => {
    positions.current = new Map(
      Array.from(
        table.current?.querySelectorAll<HTMLElement>("[data-material-id]") ||
          [],
      ).map((node) => [node.dataset.materialId!, node.getBoundingClientRect()]),
    );
  };
  const refresh = () => {
    pageCache.current.clear();
    setTick((n) => n + 1);
  };
  async function mutate(
    action: string,
    ids: string[],
    extra: Record<string, unknown> = {},
  ) {
    if (!listing || busy) return false;
    setBusy(true);
    try {
      const r = await fetch("/api/assets/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          requestId: crypto.randomUUID(),
          ids,
          revision: listing.revision,
          ...extra,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "操作失败");
      setSelection([]);
      setSelecting(false);
      refresh();
      window.dispatchEvent(new Event("fire:assets-updated"));
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "操作失败", "err");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function remove(ids: string[]) {
    if (type === "group") {
      if (
        busy ||
        !(await appConfirm(
          `清除所选 ${ids.length} 个分组的图标？分组和记录保留。`,
        ))
      )
        return;
      setBusy(true);
      let done = 0;
      try {
        for (const id of ids) {
          const response = await fetch(
            `/api/v1/watch-groups/${encodeURIComponent(id)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ icon: "" }),
            },
          );
          if (!response.ok) throw Error("清除失败");
          done++;
        }
        setSelection([]);
        setSelecting(false);
        showToast("分组图标已清除");
      } catch (e) {
        showToast(
          `已完成 ${done} 项，${e instanceof Error ? e.message : "清除失败"}`,
          "err",
        );
      } finally {
        setBusy(false);
        refresh();
        window.dispatchEvent(new Event("fire:assets-updated"));
      }
      return;
    }
    if (
      await appConfirm(
        `${removed ? "恢复" : "移除"}所选 ${ids.length} 项素材？${removed ? "" : "原文件和已有关联保留。"}`,
      )
    ) {
      if (await mutate(removed ? "restore" : "remove", ids))
        showToast(removed ? "已恢复素材" : "已移除素材");
    }
  }
  async function save() {
    if (!editing || busy) return;
    if (type === "group") {
      setEditing(null);
      return;
    }
    setBusy(true);
    try {
      setBusy(false);
      if (!(await mutate("rename", [editing.id], { name: name.trim(), ...(type === "broker" ? { markets: classification } : {}) }))) return;
      setEditing(null);
      refresh();
      window.dispatchEvent(new Event("fire:assets-updated"));
      showToast("素材已保存");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File, item: Item) {
    const form = new FormData();
    if (item.type === "group") {
      form.set("file", file);
      const response = await fetch(
        `/api/v1/watch-groups/${encodeURIComponent(item.id)}/icon`,
        { method: "POST", body: form },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.message || "上传失败");
      return { ...item, url: data.data.group.icon, imageUrl: undefined };
    }
    return {...item,...await uploadMaterialImage(file,item)};
  }
  async function importFiles() {
    if (!importRows || busy) return;
    setBusy(true);
    let done = 0;
    try {
      for (const row of importRows) {
        if (row.target) {
          await upload(row.file, row.target);
          done++;
        }
      }
      setImportRows(null);
      refresh();
      window.dispatchEvent(new Event("fire:assets-updated"));
      showToast(`已更新 ${done} 项素材`);
    } catch (e) {
      showToast(
        `已完成 ${done} 项，${e instanceof Error ? e.message : "导入失败"}`,
        "err",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function dropMarket(target: string) {
    const source = drag.current;
    drag.current = null;
    if (
      type !== "stock" ||
      !source ||
      source === target ||
      !order.includes(source) ||
      !order.includes(target)
    )
      return;
    const before = order,
      next = [...order];
    next.splice(
      next.indexOf(target),
      0,
      ...next.splice(next.indexOf(source), 1),
    );
    setOrder(next);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetMarketOrder: next }),
      });
      if (!r.ok) throw Error("保存市场顺序失败");
      window.dispatchEvent(new Event("fire:settings-updated"));
      showToast("市场顺序已保存");
    } catch (e) {
      setOrder(before);
      showToast(e instanceof Error ? e.message : "保存失败", "err");
    }
  }
  const beginEdit = (item: Item) => {
    setEditing(item);
    setName(item.name);
    setClassification(item.brokerMarkets || []);
  };
  return (
    <div className="material-catalog">
      <header>
        <h2>素材库</h2>
      </header>
      <section className="material-catalog-panel">
        <nav
          ref={bar}
          className="material-categories"
          role="tablist"
          aria-label="素材分类"
        >
          {categories.map(([key, label]) => (
            <button
              type="button"
              key={key}
              role="tab"
              aria-selected={type === key}
              data-capsule="off"
              onClick={() =>
                update({
                  tab: key,
                  market: null,
                  page: null,
                  q: null,
                  removed: null,
                })
              }
            >
              {label}
            </button>
          ))}
        </nav>
        {(type === "stock" || type === "broker") && (
          <div className="material-market-area">
            <span>市场{type === "stock" && <small> 按住拖动排序</small>}</span>
            <div className="material-markets">
              <button
                type="button"
                data-capsule="off"
                aria-pressed={market === "ALL"}
                onClick={() => update({ market: "ALL", page: null })}
              >
                <IconLayoutGrid size={18} />
                全部
              </button>
              {marketSlots.visible
                .filter((m) => markets.includes(m))
                .map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-capsule="off"
                    aria-pressed={market === m}
                    draggable={type === "stock"}
                    onDragStart={(e) => {
                      drag.current = m;
                      e.dataTransfer.setData("text/plain", m);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void dropMarket(m);
                    }}
                    onDragEnd={() => {
                      drag.current = null;
                    }}
                    onClick={() => update({ market: m, page: null })}
                  >
                    <MarketIcon market={m} className="h-5 w-5" />
                    {marketMeta(m).label}
                    {type === "stock" && <IconGripVertical size={13} />}
                  </button>
                ))}
              {marketSlots.more.length > 0 && (
                <AppSelect
                  value={market}
                  ariaLabel="更多市场"
                  triggerContent={<IconDotsVertical size={20} />}
                  className="material-market-more"
                  options={marketSlots.more.map((m) => ({
                    value: m,
                    label: marketMeta(m).label,
                  }))}
                  onChange={(m) => update({ market: m, page: null })}
                />
              )}
            </div>
          </div>
        )}
        <CollectionToolbar
          query={query}
          onQuery={(q) => update({ q: q || null, page: null })}
          selecting={selecting}
          onToggleSelection={() => {
            setSelecting((v) => !v);
            setSelection([]);
          }}
          selectedCount={selection.length}
          onRemove={() => void remove(selection)}
          removed={removed}
          grid={grid}
          onGrid={(next) => update({ view: next ? "grid" : null })}
          onRefresh={refresh}
          refreshing={loading}
          busy={busy}
          onImport={() => directoryFile.current?.click()}
        />
        <div className="material-count">
          {displayed ? <>{total} 项素材</> : <CollectionSkeleton count />}
          {removed ? " · 已移除" : ""}
          {type !== "group" &&
            (removed || Number(displayed?.removedCount) > 0) && (
              <Capsule
                variant="secondary"
                className="material-trash-toggle"
                onClick={() =>
                  update({ removed: removed ? null : "1", page: null })
                }
              >
                {removed ? "返回素材" : `已移除 ${displayed?.removedCount}`}
              </Capsule>
            )}
          {selecting && (
            <label>
              <input
                type="checkbox"
                aria-label="选择本页全部素材"
                checked={
                  rows.length > 0 && rows.every((r) => selection.includes(r.id))
                }
                onChange={(e) =>
                  setSelection(e.target.checked ? rows.map((r) => r.id) : [])
                }
              />
              本页全选 · 已选 {selection.length} 项
            </label>
          )}
        </div>
        {error ? (
          <div role="alert">
            {error}
            <button type="button" onClick={refresh}>
              重试
            </button>
          </div>
        ) : !displayed ? (
          <CollectionSkeleton grid={grid} />
        ) : (
          <div
            ref={table}
            className={`material-table ${grid ? "is-grid" : ""}`}
            data-kind={type}
          >
            {!grid && (
              <div className="material-table-head">
                <span>序号</span>
                <span>{type === "market" ? "市场" : "名称 / 代码"}</span>
                {(type === "stock" || type === "broker") && <span>市场</span>}
                <span />
              </div>
            )}
            {rows.map((item, index) => (
              <article
                key={item.id}
                data-material-id={item.id}
                className={`material-row ${selecting ? "is-selecting" : ""} ${selection.includes(item.id) ? "is-selected" : ""}`}
                role={selecting ? "checkbox" : undefined}
                aria-checked={
                  selecting ? selection.includes(item.id) : undefined
                }
                aria-label={selecting ? `选择 ${item.name}` : undefined}
                tabIndex={selecting ? 0 : undefined}
                onClick={selecting ? () => toggleSelection(item.id) : undefined}
                onKeyDown={(e) => {
                  if (
                    selecting &&
                    e.target === e.currentTarget &&
                    (e.key === "Enter" || e.key === " ")
                  ) {
                    e.preventDefault();
                    toggleSelection(item.id);
                  }
                }}
                draggable={
                  type === "broker" &&
                  !query &&
                  market === "ALL" &&
                  !removed &&
                  !selecting &&
                  !busy
                }
                onDragStart={(e) => {
                  drag.current = item.id;
                  e.dataTransfer.setData("text/plain", item.id);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (type === "broker" && drag.current) {
                    const ids = rows.map((r) => r.id),
                      from = ids.indexOf(drag.current),
                      to = ids.indexOf(item.id);
                    if (from >= 0 && to >= 0) {
                      ids.splice(to, 0, ...ids.splice(from, 1));
                      capturePositions();
                      void mutate("order", ids);
                    }
                  }
                  drag.current = null;
                }}
                onDragEnd={() => {
                  drag.current = null;
                }}
              >
                <span className="material-rank">
                  {selecting ? (
                    <span
                      className="material-selection-mark"
                      aria-hidden="true"
                    >
                      {selection.includes(item.id) && <IconCheck size={14} />}
                    </span>
                  ) : type === "broker" ? (
                    <IconGripVertical size={16} />
                  ) : (
                    ((displayed?.page || page) - 1) * 10 + index + 1
                  )}
                </span>
                <div className="material-identity">
                  <AssetImageControl src={item.imageUrl || item.url} name={item.name} card={type === "card"}
                    disabled={busy || removed} onUpload={selecting || removed ? undefined : () => chooseImage(item)} />
                  <IdentityText type={selecting ? undefined : "button"} className="material-identity-text" data-capsule="off"
                    disabled={selecting ? undefined : busy} onClick={selecting ? undefined : () => beginEdit(item)}>
                    <strong title={item.name || item.code}>{item.name || item.code}</strong>
                    {(type !== "card" || item.code.toLocaleLowerCase() !== item.name.toLocaleLowerCase()) && <small>
                      {type === "stock" && <MarketCodeBadge market={item.market} code={item.code} alwaysVisible className="material-stock-badge" />}
                      <span className="material-code" title={item.code}>{item.code}</span>
                    </small>}
                  </IdentityText>
                </div>
                <div className="material-row-market">
                  {type === "stock" && (
                    <>
                      <MarketIcon market={item.market} className="h-4 w-4" />
                      {marketMeta(item.market).label}
                    </>
                  )}
                  {type === "broker" && !selecting && (
                    <button
                      type="button"
                      data-capsule="off"
                      aria-label={`修改${item.name}分类`}
                      onClick={() => beginEdit(item)}
                    >
                      {item.brokerMarkets.length
                        ? item.brokerMarkets
                            .map((m) => marketMeta(m).label)
                            .join(" · ")
                        : "未分类"}
                    </button>
                  )}
                </div>
                <div className="material-row-actions">
                  {!selecting && (
                    <>
                      {!removed && (
                        <button
                          type="button"
                          data-capsule="off"
                          aria-label={`编辑 ${item.name}`}
                          onClick={() => beginEdit(item)}
                        >
                          <IconPencil size={18} />
                        </button>
                      )}
                      <button
                        type="button"
                        data-capsule="off"
                        disabled={busy}
                        aria-label={`${removed ? "恢复" : "移除"} ${item.name}`}
                        onClick={() => void remove([item.id])}
                      >
                        {removed ? (
                          <IconRestore size={18} />
                        ) : (
                          <IconTrash size={18} />
                        )}
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
            {!rows.length && <p className="material-empty">没有匹配的素材</p>}
          </div>
        )}
        <Pagination
          page={displayed?.page || page}
          total={Math.max(1, Math.ceil(total / 10))}
          onChange={(n) => update({ page: String(n) })}
        />
      </section>
      <input ref={imageFile} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        onChange={async event => {
          const file = event.target.files?.[0], item = uploadTarget.current;
          event.target.value = "";
          if (!file || !item || busy) return;
          setBusy(true);
          try {
            const updated = await upload(file, item);
            setEditing(current => current?.id === item.id ? updated : current);
            refresh();
            window.dispatchEvent(new Event("fire:assets-updated"));
            showToast("图片已更新");
          } catch (error) { showToast(error instanceof Error ? error.message : "上传失败", "err"); }
          finally { setBusy(false); uploadTarget.current = null; }
        }} />
      <input
        ref={directoryFile}
        type="file"
        hidden
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length > 100) {
            showToast("每次最多导入 100 个文件", "err");
            return;
          }
          setImportRows(
            files
              .filter((f) => /\.(png|jpe?g|svg|webp|gif)$/i.test(f.name))
              .map((file) => {
                const stem = file.name.replace(/\.[^.]+$/, "").toLowerCase();
                const candidates = rows.filter(
                  (r) => r.code.toLowerCase() === stem,
                );
                const unique =
                  files.filter(
                    (f) =>
                      f.name.replace(/\.[^.]+$/, "").toLowerCase() === stem,
                  ).length === 1;
                return {
                  file,
                  target:
                    unique && candidates.length === 1 ? candidates[0] : null,
                };
              }),
          );
          e.target.value = "";
        }}
      />
      {editing && (
        <AppModal
          title="编辑素材"
          size="sm"
          className="material-editor"
          closeDisabled={busy}
          onClose={() => setEditing(null)}
        >
          <ModalForm
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <ModalMedia plain card={type === "card"}
              preview={
                <SafeAssetImage
                  src={editing.imageUrl || editing.url}
                  fallback={<span>{editing.name.slice(0, 1)}</span>}
                  style={{ width: "100%", height: "100%" }}
                  className="h-full w-full object-contain"
                />
              }
            >
              <div>
                <strong>{editing.name}</strong>
                <small>
                  {[editing.market, editing.code].filter(Boolean).join(" · ")}
                </small>
              </div>
              <Capsule
                variant="secondary"
                disabled={busy}
                onClick={() => editorFile.current?.click()}
              >
                <IconUpload size={16} />
                {busy ? "处理中" : "替换图片"}
              </Capsule>
            </ModalMedia>
            <input
              ref={editorFile}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setBusy(true);
                try {
                  const updated = await upload(file, editing);
                  setEditing(updated);
                  refresh();
                  showToast("图片已更新");
                } catch (error) {
                  showToast(
                    error instanceof Error ? error.message : "上传失败",
                    "err",
                  );
                } finally {
                  setBusy(false);
                  e.target.value = "";
                }
              }}
            />
            <ModalField>
              名称
              <input
                data-autofocus
                value={name}
                disabled={busy || type === "group"}
                required
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </ModalField>
            {type === "broker" && (
              <fieldset>
                <legend>市场分类</legend>
                <ModalChoiceGrid options={markets.map(value => ({value, label: marketMeta(value).label}))}
                  values={classification} disabled={busy} onChange={setClassification} />
              </fieldset>
            )}
            <ModalActions>
              <Capsule
                variant="secondary"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </Capsule>
              <Capsule type="submit" disabled={busy || !name.trim()}>
                {busy ? "保存中" : type === "group" ? "完成" : "保存更改"}
              </Capsule>
            </ModalActions>
          </ModalForm>
        </AppModal>
      )}
      {importRows && (
        <AppModal
          title="确认目录导入"
          closeDisabled={busy}
          onClose={() => {
            if (!busy) setImportRows(null);
          }}
        >
          <div className="material-import-preview">
            {importRows.map((r, i) => (
              <p key={i}>
                {r.file.name} ·{" "}
                {r.target ? `替换 ${r.target.name}` : "未匹配，跳过"}
              </p>
            ))}
          </div>
          <ModalActions>
            <Capsule
              variant="secondary"
              disabled={busy}
              onClick={() => setImportRows(null)}
            >
              取消
            </Capsule>
            <Capsule
              disabled={busy || !importRows.some((r) => r.target)}
              onClick={() => void importFiles()}
            >
              {busy ? "导入中" : "确认导入"}
            </Capsule>
          </ModalActions>
        </AppModal>
      )}
    </div>
  );
}
