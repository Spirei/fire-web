"use client";

import { useEffect, useRef, useState } from "react";
import { IconPhotoPlus, IconX } from "@tabler/icons-react";
import { Capsule, IconButton } from "@/components/Capsule";
import { MaterialUploadPending, uploadMaterialImage } from "@/lib/materialImageUpload";
import { accountReadHeaders } from "@/lib/privateReadContext";
import { clientRequestId } from "@/lib/randomId";
import { readFailure } from "@/lib/readFailure";

type SavedBroker = { id: string; type: "broker"; market: "OTHER"; code: string; name: string };

export default function BrokerMaterialForm({ ownerId, locked, onBusy, onCreated, onFinish, onCancel }: {
  ownerId: string;
  locked: boolean;
  onBusy: (busy: boolean) => void;
  onCreated: () => void;
  onFinish: (broker: SavedBroker) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [saved, setSaved] = useState<SavedBroker | null>(null);
  const [pendingId, setPendingId] = useState<string>();
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const request = useRef<{ key: string; id: string } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const chooser = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function submit() {
    const brokerName = name.trim();
    const brokerCode = code.trim().toUpperCase();
    if (locked || busy.current || !brokerName || !brokerCode) return;
    busy.current = true;
    onBusy(true);
    setError("");
    let catalogChanged = false;
    try {
      let broker = saved;
      if (!broker) {
        setStage("正在保存券商…");
        const key = JSON.stringify([brokerName, brokerCode]);
        if (request.current?.key !== key) request.current = { key, id: clientRequestId() };
        const response = await fetch("/api/assets/catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...accountReadHeaders(ownerId) },
          body: JSON.stringify({ action: "create-broker", name: brokerName, code: brokerCode, requestId: request.current.id }),
          signal: AbortSignal.timeout(20_000),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(readFailure(data, "券商保存结果尚未确认，请重试"));
        if (!data?.assetId) throw new Error("券商保存结果尚未确认，请重试");
        broker = { id: data.assetId, type: "broker", market: "OTHER", name: brokerName, code: brokerCode };
        catalogChanged = true;
        onCreated();
        if (!mounted.current) return;
        setSaved(broker);
      }
      if (file) {
        setStage(pendingId ? "正在核对图标上传…" : "正在上传图标…");
        await uploadMaterialImage(file, broker, { ownerId, pendingRequestId: pendingId });
        catalogChanged = true;
      }
      if (mounted.current) onFinish(broker);
    } catch (cause) {
      if (mounted.current) {
        setPendingId(cause instanceof MaterialUploadPending ? cause.requestId : undefined);
        setError(cause instanceof Error ? cause.message : "操作失败，请重试");
      }
    } finally {
      if (catalogChanged) window.dispatchEvent(new Event("fire:assets-updated"));
      busy.current = false;
      if (mounted.current) setStage("");
      onBusy(false);
    }
  }

  return (
    <form id="material-new-broker" className="material-broker-form" aria-label="新增券商" aria-busy={!!stage}
      onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="material-broker-fields">
        <label>
          券商名称
          <input autoFocus required maxLength={120} disabled={!!saved || !!stage} value={name}
            onChange={event => { setName(event.target.value); setError(""); }} />
        </label>
        <label>
          英文代码
          <input aria-label="券商英文代码" placeholder="如 IBKR" required maxLength={35}
            pattern={String.raw`[A-Za-z][A-Za-z0-9._\-]{0,34}`} autoCapitalize="characters" spellCheck={false}
            disabled={!!saved || !!stage} value={code} onChange={event => { setCode(event.target.value); setError(""); }} />
        </label>
      </div>
      <div className="material-broker-footer">
        <div className="material-broker-icon-choice">
          {preview && <img src={preview} alt="券商图标预览" className="material-broker-preview" />}
          <input ref={chooser} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={event => {
              const next = event.target.files?.[0];
              event.target.value = "";
              if (!next) return;
              if (next.size > 2 * 1024 * 1024) { setError("券商图标最大 2 MB"); return; }
              setFile(next);
              setError("");
            }} />
          <Capsule variant="secondary" disabled={!!stage || !!pendingId} onClick={() => chooser.current?.click()}>
            <IconPhotoPlus size={17} />{file ? "更换图标" : "选择图标（选填）"}
          </Capsule>
          {file && <span className="material-broker-file" title={file.name}>{file.name}</span>}
          {file && !stage && !pendingId && <IconButton label="清除已选图标" size="sm" onClick={() => { setFile(null); setError(""); }}>
            <IconX size={16} />
          </IconButton>}
        </div>
        <div className="material-broker-actions">
          <Capsule variant="secondary" disabled={!!stage} onClick={() => {
            if (saved) {
              onFinish(saved);
              window.dispatchEvent(new Event("fire:assets-updated"));
            } else onCancel();
          }}>
            {saved ? "完成" : "取消"}
          </Capsule>
          <Capsule type="submit" busy={!!stage} disabled={locked || !name.trim() || !code.trim() || (!!saved && !file)}>
            {stage || (pendingId ? "核对上传" : saved ? "重试上传" : "保存券商")}
          </Capsule>
        </div>
      </div>
      {stage && <p role="status" className="sr-only">{stage}</p>}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{saved ? "券商已保存。 " : ""}{error}</p>}
    </form>
  );
}
