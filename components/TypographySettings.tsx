"use client";
import AppSelect from "./AppSelect";
import { useEffect, useRef, useState } from "react";
import { IconUpload } from "@tabler/icons-react";
import { SITE_FONTS, FONT_WEIGHTS, resolveFont, type UploadedFont } from "@/lib/typography";
import { useTypography } from "./TypographyProvider";
import { SubNavIcon } from "./SettingsHeader";
export function TypographyPreview() {
  const { font, weight } = useTypography();
  return <div className="typography-preview" aria-label="字体实时预览" style={{ fontFamily: resolveFont(font).family, fontWeight: weight }}>
      <div className="typography-preview-chrome"><span className="typography-window-dots" aria-hidden="true"><i/><i/><i/></span></div>
      {/* Buffett's 1986 shareholder letter: https://www.berkshirehathaway.com/letters/1986.html */}
      <div className="typography-preview-content"><span className="typography-specimen" aria-hidden="true">Aa</span><div className="typography-preview-copy"><span className="typography-preview-title">别人贪婪时恐惧，</span><div className="typography-quote-end"><span>别人恐惧时贪婪。</span><span className="typography-signature">— 沃伦·巴菲特</span></div><span className="typography-preview-numbers">π 3.1415926</span></div></div>
    </div>;
}
export default function TypographySettings() {
  const { font, weight, chooseFont, chooseWeight } = useTypography();
  const [uploaded, setUploaded] = useState<UploadedFont[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/fonts", { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "字体加载失败");
      setUploaded(data.fonts);
    }).catch(() => { if (!controller.signal.aborted) setError("字体列表加载失败，请重试"); });
    return () => controller.abort();
  }, []);
  async function upload(file: File) {
    setError(""); setBusy(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("字体不能超过 10 MB");
      if (!/\.(woff2?|ttf|otf)$/i.test(file.name)) throw new Error("请选择 WOFF2、WOFF、TTF 或 OTF 字体");
      // 浏览器先验证可解码，避免损坏文件上传后影响全站文字。
      await new FontFace("fire-upload-check", await file.arrayBuffer()).load().catch(() => { throw new Error("字体文件无效"); });
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/api/fonts", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "上传失败，请重试");
      const item = data.font as UploadedFont;
      setUploaded(current => [...current.filter(font => font.id !== item.id), item]);
      // 应用前完成加载，保持当前页面文字稳定。
      const face = await new FontFace(item.id, `url(/uploads/fonts/${item.id})`, { weight: "100 900" }).load().catch(() => { throw new Error("字体加载失败，请重试"); });
      document.fonts.add(face);
      chooseFont(item.id);
    } catch (error) { setError(error instanceof TypeError ? "上传失败，请重试" : error instanceof Error ? error.message : "上传失败，请重试"); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  const options = [...SITE_FONTS, ...uploaded].map(item => ({ value: item.id, label: item.name }));
  if (!options.some(item => item.value === font)) options.push({ value: font, label: "自定义字体" });
  return <section className="typography-settings" aria-label="字体设置">
    <div className="appearance-card typography-card">
      <div className="appearance-row"><span className="typography-label"><SubNavIcon name="typography" className="h-6 w-6"/><span>字体</span></span><AppSelect value={font} onChange={value => chooseFont(resolveFont(value).id)} options={options} className="typography-select" menuClassName="typography-select-menu" ariaLabel="字体"/></div>
      <div className="appearance-row"><span className="appearance-label">字重</span><div className="typography-weights" role="group" aria-label="文字字重">{FONT_WEIGHTS.map(item => <button type="button" data-capsule="off" key={item.value} aria-pressed={weight === item.value} onClick={() => chooseWeight(item.value)} style={{ fontWeight: item.value }}>{item.name}</button>)}</div></div>
      <div className="appearance-row typography-upload-row"><span className="typography-label"><IconUpload size={22} stroke={1.7}/><span>自定义字体</span></span><button type="button" className="typography-upload" disabled={busy} onClick={() => input.current?.click()}>{busy ? "上传中…" : "上传字体"}</button><input ref={input} type="file" hidden accept=".woff2,.woff,.ttf,.otf" aria-label="上传自定义字体" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }}/></div>
      {error && <p className="typography-upload-error" role="alert">{error}</p>}
    </div>
  </section>;
}
