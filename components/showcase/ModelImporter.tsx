"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ModelPreview from "./ModelPreview";
import { buildImportedConfig } from "./presets/models";
import type { ShowcaseModelParams } from "./types";
import { showToast } from "@/lib/toast";
import "./model-importer.css";
import "./capsule.css";

/** 服务端体检报告（与 lib/glbInspect.ts 的 GlbReport 对齐） */
export interface ImportReport {
  file: string;
  bytes: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  notes: string[];
  info: {
    generator: string;
    materials: Array<{ name: string; emissive?: number[]; emissiveStrength?: number; clearcoat?: number; clearcoatRoughness?: number; roughness?: number; metallic?: number; alphaMode?: string }>;
    images: Array<{ name: string; mime: string; bytes: number; width?: number; height?: number }>;
    maxImageSize: number;
    imageBytes: number;
    meshes: Array<{ name: string; primitives: number; materials: string[] }>;
    nodeCount: number;
    animations: number;
    skins: number;
    extensionsUsed: string[];
    extensionsRequired: string[];
  };
  suggestions: {
    maxTextureSize: number;
    emissiveIntensity?: number;
    clearcoatRoughness?: number;
    wheelPattern?: string;
    materialNames: string[];
  };
}

interface ImportedModelRow {
  id: string;
  label: string;
  note: string;
  file: string;
  cover?: string;
  params: ShowcaseModelParams;
  updatedAt: string;
  /** 随仓库分发的内置车（素材在 public/mclaren/），不能删也不能改文件 */
  builtin?: boolean;
}

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

function mb(bytes: number) {
  return `${(bytes / 1048576).toFixed(bytes > 104857600 ? 0 : 1)} MB`;
}

function slugify(name: string) {
  return name
    .replace(/\.glb$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** 导出的 .glb 文件名常常是「模型名__来源」，去掉尾巴上更好认 */
function prettyLabel(name: string) {
  return name
    .replace(/\.glb$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

export default function ModelImporter({ existing }: { existing: ImportedModelRow[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const coverTargetRef = useRef<string | null>(null);
  /** 卡片顺序：拖动后本地先变，再写服务端（首页车型条照这个顺序排） */
  const [order, setOrder] = useState(() => existing.map((row) => row.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const [coverBusy, setCoverBusy] = useState<string | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在编辑的已登记车型（null = 新导入）；编辑时不重新上传，直接改参数 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 预览用的素材文件名：新上传=刚上传的文件，编辑已有=那一行的文件 */
  const [previewFile, setPreviewFile] = useState<string | null>(null);

  const [meta, setMeta] = useState({ id: "", label: "", note: "" });
  const [params, setParams] = useState<ShowcaseModelParams>({});
  const [previewKey, setPreviewKey] = useState(0);
  const [structure, setStructure] = useState<{
    carBox: number[];
    carBoxRaw: number[];
    carMaterials: string[];
    carMeshes: string[];
    wheelGroups: number;
  } | null>(null);
  const [wheelPick, setWheelPick] = useState<string[]>([]);

  const reset = useCallback(() => {
    setReport(null);
    setError(null);
    setProgress(0);
    setFileName("");
    setStructure(null);
    setWheelPick([]);
    setSavedId(null);
    setPreviewFile(null);
    setEditingId(null);
  }, []);

  const upload = useCallback(
    (file: File) => {
      reset();
      if (!/\.glb$/i.test(file.name)) {
        setError("只支持 .glb 单文件：.gltf + 贴图文件夹无法在这里导入");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`文件 ${mb(file.size)} 超过 ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB 上限`);
        return;
      }
      const name = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
      setFileName(name);
      setUploading(true);
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open("POST", `/api/showcase/models/upload?name=${encodeURIComponent(name)}`);
      xhr.setRequestHeader("Content-Type", "model/gltf-binary");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        setUploading(false);
        xhrRef.current = null;
        let payload: { error?: string; report?: ImportReport; file?: string; suggested?: { id: string; label: string; note: string } } = {};
        try {
          payload = JSON.parse(xhr.responseText) as typeof payload;
        } catch {
          setError("服务端返回异常，请看容器日志");
          return;
        }
        if (xhr.status >= 400) {
          setError(payload.error ?? `上传失败（${xhr.status}）`);
          if (payload.report) setReport(payload.report);
          return;
        }
        if (!payload.report) {
          setError("没有拿到体检报告");
          return;
        }
        const data = payload.report;
        setReport(data);
        setPreviewFile(data.file);
        setEditingId(null);
        setMeta({
          id: payload.suggested?.id ?? slugify(name),
          label: payload.suggested?.label ?? prettyLabel(name),
          note: payload.suggested?.note ?? ""
        });
        setWheelPick(
          data.suggestions.materialNames.filter((material) => /wheel|tyre|tire|rim/i.test(material))
        );
        setParams({
          length: 5.6,
          maxTextureSize: data.suggestions.maxTextureSize,
          emissiveIntensity: data.suggestions.emissiveIntensity,
          clearcoatRoughness: data.suggestions.clearcoatRoughness,
          envMapIntensity: 1,
          wheelAxis: "x",
          wheelLateral: "x",
          wheelLongitudinal: "y"
        });
      };
      xhr.onerror = () => {
        setUploading(false);
        setError("上传中断：检查网络或容器是否允许大文件");
      };
      xhr.send(file);
    },
    [reset]
  );

  // 轮子材质多选 → wheelPattern（转成正则源码，转义特殊字符）
  useEffect(() => {
    setParams((prev) => {
      const pattern = wheelPick.length
        ? wheelPick.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
        : undefined;
      if (prev.wheelPattern === pattern) return prev;
      return { ...prev, wheelPattern: pattern };
    });
  }, [wheelPick]);

  const previewConfig = useMemo(() => {
    if (!previewFile) return null;
    // 预览只依赖「会影响建模结构」的参数：朝向、车长、轮子、贴图上限
    return buildImportedConfig({
      file: previewFile,
      version: previewKey,
      params: {
        length: params.length,
        yaw: params.yaw,
        pitch: params.pitch,
        wheelPattern: params.wheelPattern,
        wheelAxis: params.wheelAxis,
        wheelLateral: params.wheelLateral,
        wheelLongitudinal: params.wheelLongitudinal,
        maxTextureSize: params.maxTextureSize,
        emissiveIntensity: params.emissiveIntensity,
        clearcoatRoughness: params.clearcoatRoughness,
        envMapIntensity: params.envMapIntensity
      }
    });
    // previewKey 用来在改完参数后手动重建引擎
  }, [params, previewFile, previewKey]);

  /** 从原始包围盒判断哪根轴朝上：车高永远是最小的那一维 */
  const upHint = useMemo(() => {
    if (!structure?.carBoxRaw?.length) return null;
    const [x, y, z] = structure.carBoxRaw;
    const smallest = Math.min(x, y, z);
    if (smallest === y) return { axis: "Y" as const, text: "Y 轴朝上（常规，无需修正）" };
    if (smallest === z) return { axis: "Z" as const, text: "Z 轴朝上（需要绕 X 轴 -90° 修正）" };
    return { axis: "X" as const, text: "X 轴朝上（模型可能躺倒了，需要绕 X 轴修正）" };
  }, [structure]);

  const wheelsOk = structure ? structure.wheelGroups >= 4 : false;

  /** 轮子候选材质：优先用预览里真实加载出来的材质名（编辑已有车型时也能拿到） */
  const materialOptions = useMemo(() => {
    if (structure?.carMaterials?.length) return structure.carMaterials;
    return report?.suggestions.materialNames ?? [];
  }, [report, structure]);

  const save = useCallback(async () => {
    const file = report?.file ?? previewFile;
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      // 新导入 → 新增登记；从清单里点「改参数」进来 → 改的是同一条记录
      const response = await fetch(editingId ? `/api/showcase/models/${editingId}` : "/api/showcase/models", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: meta.id,
          label: meta.label,
          note: meta.note,
          file,
          params: { ...params, pitch: params.pitch }
        })
      });
      const payload = (await response.json()) as { error?: string; model?: ImportedModelRow };
      if (!response.ok) {
        setError(payload.error ?? "保存失败");
        return;
      }
      setSavedId(payload.model?.id ?? meta.id);
      setNotice(`已保存车型 ${payload.model?.label ?? meta.label}，回首页就能在车型条里看到它`);
    } catch {
      setError("保存失败：网络异常");
    } finally {
      setSaving(false);
    }
  }, [editingId, meta, params, previewFile, report]);

  const removeModel = useCallback(
    async (row: ImportedModelRow, withFile: boolean) => {
      const response = await fetch(`/api/showcase/models/${row.id}${withFile ? "?file=1" : ""}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        setError(payload.error ?? "删除失败");
        return;
      }
      setNotice(`已删除车型 ${row.label}${withFile ? "（素材文件一并删除）" : "（素材文件保留在 uploads 卷）"}`);
      router.refresh();
    },
    [router]
  );

  /** 卡片按当前顺序排（内置车也在顺序表里，可以拖到任意位置） */
  const orderedRows = useMemo(() => {
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...existing].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  }, [existing, order]);

  const persistOrder = useCallback(
    async (ids: string[]) => {
      try {
        const response = await fetch("/api/showcase/models/order", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids })
        });
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          showToast(payload.error ?? "顺序保存失败", "err");
          return;
        }
        showToast("顺序已保存，首页车型条同步");
        router.refresh();
      } catch {
        showToast("顺序保存失败：网络异常", "err");
      }
    },
    [router]
  );

  /** 拖动排序：拖到某张卡上就插到它前面 */
  const moveCard = useCallback(
    (targetId: string) => {
      if (!dragId || dragId === targetId) return;
      setOrder((prev) => {
        const list = prev.filter((id) => id !== dragId);
        const at = list.indexOf(targetId);
        list.splice(at < 0 ? list.length : at, 0, dragId);
        void persistOrder(list);
        return list;
      });
    },
    [dragId, persistOrder]
  );

  /** 拖到队尾：拖到某张卡上只会插到它前面，所以「排到最后」需要单独一个落点 */
  const moveToEnd = useCallback(() => {
    if (!dragId) return;
    setOrder((prev) => {
      if (prev[prev.length - 1] === dragId) return prev;
      const list = [...prev.filter((id) => id !== dragId), dragId];
      void persistOrder(list);
      return list;
    });
  }, [dragId, persistOrder]);

  const uploadCover = useCallback(
    async (id: string, file: File) => {
      setCoverBusy(id);
      try {
        const response = await fetch(`/api/showcase/models/cover?id=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file
        });
        const payload = (await response.json()) as { error?: string; cover?: string };
        if (!response.ok) {
          showToast(payload.error ?? "封面上传失败", "err");
          return;
        }
        showToast("封面已更新");
        router.refresh();
      } catch {
        showToast("封面上传失败：网络异常", "err");
      } finally {
        setCoverBusy(null);
      }
    },
    [router]
  );

  const clearCover = useCallback(
    async (id: string) => {
      setCoverBusy(id);
      try {
        const response = await fetch(`/api/showcase/models/cover?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          showToast(payload.error ?? "移除封面失败", "err");
          return;
        }
        showToast("已移除封面");
        router.refresh();
      } finally {
        setCoverBusy(null);
      }
    },
    [router]
  );

  return (
    <div className="mp-root">
      <header className="mp-head">
        <div>
          <p className="mp-kicker">车型导入</p>
          <h1>导入一台车</h1>
          <p className="mp-sub">
            模型只放在服务器 uploads 卷（<code>public/uploads/mclaren/models/</code>），不进 Git、不进镜像。
            上传后会先做一轮体检，再在预览里摆正、认轮子，最后写进车型条。
          </p>
        </div>
        <Link className="mp-back fire-cap" href="/">
          返回首页
        </Link>
      </header>

      {notice && <div className="mp-notice">{notice}</div>}
      {error && <div className="mp-error">{error}</div>}

      <section className="mp-step">
        <h2>
          <span>1</span> 选文件
        </h2>
        <div
          className={`mp-drop${dragging ? " on" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) upload(file);
          }}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".glb"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload(file);
              event.target.value = "";
            }}
          />
          {uploading ? (
            <div className="mp-upload">
              <b>{fileName}</b>
              <div className="mp-bar">
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <small>上传中 {Math.round(progress * 100)}%（大模型请耐心等待，离开页面会中断）</small>
            </div>
          ) : (
            <>
              <b>把 .glb 拖进来，或点这里选择文件</b>
              <small>单文件 ≤ 250MB；Draco / Meshopt / KTX2 压缩的模型会被拒收并给出改法</small>
            </>
          )}
        </div>
      </section>

      {report && (
        <section className="mp-step">
          <h2>
            <span>2</span> 体检报告
          </h2>
          <div className="mp-report">
            <div className="mp-report-head">
              <b>{report.file}</b>
              <span>{mb(report.bytes)}</span>
              <span>导出器：{report.info.generator}</span>
              <span>
                网格 {report.info.meshes.length} · 材质 {report.info.materials.length} · 贴图 {report.info.images.length}（最大{" "}
                {report.info.maxImageSize || "?"}px）
              </span>
            </div>
            {report.errors.length > 0 && (
              <ul className="mp-list bad">
                {report.errors.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {report.warnings.length > 0 && (
              <ul className="mp-list warn">
                {report.warnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {report.notes.length > 0 && (
              <ul className="mp-list note">
                {report.notes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <details>
              <summary>材质与贴图明细</summary>
              <table className="mp-table">
                <thead>
                  <tr>
                    <th>材质</th>
                    <th>贴图</th>
                    <th>金属度 / 粗糙度</th>
                    <th>发光 / 清漆</th>
                  </tr>
                </thead>
                <tbody>
                  {report.info.materials.map((material) => (
                    <tr key={material.name}>
                      <td>{material.name}</td>
                      <td>{report.info.images.length ? "—" : "无贴图"}</td>
                      <td>
                        {material.metallic ?? 1} / {material.roughness ?? 1}
                      </td>
                      <td>
                        {material.emissive && material.emissive.some((v) => v > 0.01)
                          ? `发光 ${material.emissiveStrength ?? 1}`
                          : material.clearcoat
                            ? `清漆 ${material.clearcoat}（粗糙度 ${material.clearcoatRoughness ?? 1}）`
                            : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        </section>
      )}

      {previewFile && !error && (
        <section className="mp-step">
          <h2>
            <span>3</span> 摆正与认轮子
          </h2>
          <div className="mp-tune">
            <div className="mp-preview-wrap">
              {previewConfig && <ModelPreview key={previewKey} config={previewConfig} onDebug={setStructure} />}
              <div className="mp-preview-foot">
                <button type="button" className="mp-ghost fire-cap" onClick={() => setPreviewKey((prev) => prev + 1)}>
                  重新加载预览
                </button>
                {structure && (
                  <span>
                    原始包围盒 {structure.carBoxRaw.join(" × ")} · 归一化后 {structure.carBox.join(" × ")} 米 ·{" "}
                    {structure.wheelGroups >= 4 ? `识别到 ${structure.wheelGroups} 个轮子` : "没认出轮子"}
                  </span>
                )}
              </div>
              {upHint && <div className="mp-hint">朝向判断：{upHint.text}</div>}
            </div>

            <div className="mp-form">
              <label>
                车型代号（英文，用于本地偏好与接口）
                <input value={meta.id} onChange={(event) => setMeta({ ...meta, id: event.target.value.toLowerCase() })} placeholder="mp4-5" />
              </label>
              <label>
                车型名称（显示在车型条上）
                <input value={meta.label} onChange={(event) => setMeta({ ...meta, label: event.target.value })} placeholder="MP4/5" />
              </label>
              <label>
                年份 / 说明
                <input value={meta.note} onChange={(event) => setMeta({ ...meta, note: event.target.value })} placeholder="1989" />
              </label>
              <label>
                车长（米）：决定归一化比例，真车 4.6 / 5.6
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  max="12"
                  value={params.length ?? 5.6}
                  onChange={(event) => setParams({ ...params, length: Number(event.target.value) })}
                />
              </label>
              <label>
                朝向修正（度）：绕 Y 轴
                <input
                  type="number"
                  step="15"
                  value={params.yaw ?? 0}
                  onChange={(event) => setParams({ ...params, yaw: Number(event.target.value) })}
                />
              </label>
              <label>
                前后轴：纵向轴
                <select
                  value={params.wheelLongitudinal ?? "y"}
                  onChange={(event) => setParams({ ...params, wheelLongitudinal: event.target.value as "x" | "y" | "z" })}
                >
                  <option value="x">X</option>
                  <option value="y">Y</option>
                  <option value="z">Z</option>
                </select>
              </label>
              <label>
                左右轴
                <select
                  value={params.wheelLateral ?? "x"}
                  onChange={(event) => setParams({ ...params, wheelLateral: event.target.value as "x" | "y" | "z" })}
                >
                  <option value="x">X</option>
                  <option value="y">Y</option>
                  <option value="z">Z</option>
                </select>
              </label>
              <label>
                贴图上限（像素）：4K 模型选 2048 更省显存
                <input
                  type="number"
                  step="512"
                  min="256"
                  max="8192"
                  value={params.maxTextureSize ?? 4096}
                  onChange={(event) => setParams({ ...params, maxTextureSize: Number(event.target.value) })}
                />
              </label>
              <label>
                发光强度上限
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="4"
                  value={params.emissiveIntensity ?? 0.45}
                  onChange={(event) => setParams({ ...params, emissiveIntensity: Number(event.target.value) })}
                />
              </label>
              <label>
                清漆粗糙度下限
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={params.clearcoatRoughness ?? 0.3}
                  onChange={(event) => setParams({ ...params, clearcoatRoughness: Number(event.target.value) })}
                />
              </label>

              <div className="mp-wheel">
                <p>
                  轮子材质（勾中才会自转；一个材质盖四个轮子时，引擎会按象限拆开）
                  {!wheelsOk && <em>当前没认出轮子，请至少勾一项</em>}
                </p>
                <div className="mp-wheel-list">
                  {materialOptions.map((material) => (
                    <label key={material} className={wheelPick.includes(material) ? "on" : ""}>
                      <input
                        type="checkbox"
                        checked={wheelPick.includes(material)}
                        onChange={(event) =>
                          setWheelPick((prev) =>
                            event.target.checked ? [...prev, material] : prev.filter((name) => name !== material)
                          )
                        }
                      />
                      <span>{material}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {previewFile && !error && (
        <section className="mp-step mp-save">
          <h2>
            <span>4</span> 保存并上线
          </h2>
          <p>
            保存后会写进 uploads 卷的 <code>showroom.json</code>，首页车型条末尾就会出现这辆车；
            之后再调参数不用重新上传，改完再点一次保存即可。
          </p>
          <div className="mp-save-row">
            <button type="button" className="mp-primary fire-cap fire-cap-primary" onClick={() => void save()} disabled={saving || !meta.id || !meta.label}>
              {saving ? "保存中…" : "保存车型"}
            </button>
            <button
              type="button"
              className="mp-ghost fire-cap"
              onClick={() => setPreviewKey((prev) => prev + 1)}
              disabled={saving}
            >
              按当前参数重载预览
            </button>
          </div>
        </section>
      )}

      <section className="mp-step">
        <h2>
          <span>·</span> 车型清单
        </h2>
        {/* 封面文件选择：卡片上的「传封面」统一走这个隐藏输入 */}
        <input
          ref={coverInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            const target = coverTargetRef.current;
            event.target.value = "";
            coverTargetRef.current = null;
            if (file && target) void uploadCover(target, file);
          }}
        />
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orderedRows.map((row) => (
            <article
              key={row.id}
              draggable
              onDragStart={() => setDragId(row.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                moveCard(row.id);
              }}
              className={`flex flex-col overflow-hidden rounded-2xl border bg-white shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-pop dark:bg-[#16181d] ${
                dragId === row.id
                  ? "border-edge-strong opacity-70 dark:border-white/30"
                  : "border-edge dark:border-white/10"
              }`}
            >
              {/* 卡面：没自定义封面时用车型代号占位；模型缩略图要现场加载上百 MB 的 glb，太重不在这里做。
                  高度按卡面宽度的百分比给（aspect = 100 / 52）：52% 是「车不被切」的临界点 ——
                  图片铺满卡面宽度时，可见的纵向窗口 = 卡宽 × 52%，再小一点车头 / 轮胎就会被裁掉。 */}
              <div className="relative flex aspect-[100/52] w-full shrink-0 items-center justify-center overflow-hidden bg-bg-gray/60 dark:bg-white/[0.04]">
                {row.cover ? (
                  // 封面是 uploads 卷里的图片，用原生 img 直接加载最省事（尺寸固定，不会抖动）
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.cover} alt={`${row.label} 封面`} className="h-full w-full object-cover" />
                ) : (
                  <span className="px-3 text-center text-[26px] font-extrabold leading-none tracking-[0.04em] text-ink-2 dark:text-white/85">
                    {row.label}
                  </span>
                )}
                {/* 封面上缘压一层浅渐变：封面是白底照片时，左上的拖动柄与角标也能看清（48px 不压到车） */}
                <span
                  className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/40 to-transparent"
                  aria-hidden="true"
                />
                <span
                  className="absolute left-2 top-2 flex h-7 w-7 cursor-grab items-center justify-center rounded-full bg-black/55 text-[13px] text-white backdrop-blur active:cursor-grabbing"
                  title="拖动排序（首页车型条会同步）"
                  aria-hidden="true"
                >
                  ⠿
                </span>
                <span className="absolute left-11 top-3 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                  {row.builtin ? "内置" : "手动导入"}
                </span>
                {row.note && (
                  <span className="absolute right-3 top-3 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                    {row.note}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-3">
                <code className="truncate text-[11px] text-muted dark:text-white/55" title={row.file}>
                  {row.file}
                </code>
                <span className="text-[11px] text-faint dark:text-white/40">
                  {row.builtin
                    ? "预设写在 presets/mcl35m.ts"
                    : `长 ${row.params.length ?? "-"} m · 朝向 ${row.params.yaw ?? 0}° · 轮子 ${row.params.wheelPattern ?? "未指定"}`}
                </span>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 lg:flex-nowrap lg:overflow-x-auto lg:[scrollbar-width:none] lg:[&::-webkit-scrollbar]:hidden">
                  {!row.builtin && (
                    <button
                      type="button"
                      className="fire-cap px-2 py-1 text-[11px] font-semibold"
                      onClick={() => {
                        setEditingId(row.id);
                        setSavedId(null);
                        setNotice(null);
                        setError(null);
                        setReport(null);
                        setPreviewFile(row.file);
                        setMeta({ id: row.id, label: row.label, note: row.note });
                        setParams(row.params);
                        setWheelPick(
                          row.params.wheelPattern
                            ? row.params.wheelPattern.split("|").map((part) => part.replace(/\\/g, ""))
                            : []
                        );
                        setPreviewKey((prev) => prev + 1);
                      }}
                    >
                      改参数
                    </button>
                  )}
                  {/* 封面内置车也能换：只改卡面照片，素材与参数仍随仓库分发 */}
                  <button
                    type="button"
                    /* 上传中显示标准的「已开启」态：点一下之后有明确反馈 */
                    className={`fire-cap px-2 py-1 text-[11px] font-semibold${coverBusy === row.id ? " on" : ""}`}
                    disabled={coverBusy === row.id}
                    onClick={() => {
                      coverTargetRef.current = row.id;
                      coverInputRef.current?.click();
                    }}
                  >
                    {coverBusy === row.id ? "上传中…" : row.cover ? "换封面" : "传封面"}
                  </button>
                  {row.cover && (
                    <button
                      type="button"
                      className={`fire-cap px-2 py-1 text-[11px] font-semibold${coverBusy === row.id ? " on" : ""}`}
                      disabled={coverBusy === row.id}
                      onClick={() => void clearCover(row.id)}
                    >
                      去封面
                    </button>
                  )}
                  {row.builtin ? (
                    <span className="text-[11px] text-faint dark:text-white/40">内置车随仓库分发，不可删除</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="fire-cap px-2 py-1 text-[11px] font-semibold"
                        onClick={() => void removeModel(row, false)}
                      >
                        移出清单
                      </button>
                      <button
                        type="button"
                        className="fire-cap fire-cap-danger px-2 py-1 text-[11px] font-semibold"
                        onClick={() => void removeModel(row, true)}
                      >
                        删除并删文件
                      </button>
                    </>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
        {/* 拖动时才出现：拖到某张卡上只会插到它前面，想排到最后要点这里 */}
        {dragId && (
          <div
            className="mt-3 flex h-11 items-center justify-center rounded-2xl border border-dashed border-edge-strong text-[11.5px] font-semibold text-muted dark:border-white/25 dark:text-white/60"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              moveToEnd();
            }}
          >
            松手排到最后
          </div>
        )}
      </section>
    </div>
  );
}
