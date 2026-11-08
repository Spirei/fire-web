"use client";

import PasswordInput from "@/components/PasswordInput";
import PasswordStrength from "@/components/PasswordStrength";
import ThemeToggle from "@/components/ThemeToggle";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Step = 1 | 2 | 3;

export default function FirstRunSetup({ requireSetupToken = false, initialBrand = { logo: "", favicon: "" } }: { requireSetupToken?: boolean; initialBrand?: { logo: string; favicon: string } }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [title, setTitle] = useState("Alcor");
  const [allowRegister, setAllowRegister] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [brand, setBrand] = useState(initialBrand);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const brandImage = [brand.logo, brand.favicon, "/site-icon.svg"].find(src => src && !failedImages.includes(src));

  function failBrandImage(src: string) {
    setFailedImages(current => current.includes(src) ? current : [...current, src]);
  }

  useEffect(() => {
    fetch("/api/settings/public")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const nextTitle = String(data?.settings?.title ?? "").trim();
        if (nextTitle) setTitle(nextTitle);
        if (data?.settings) {
          setBrand({ logo: data.settings.siteLogo || "", favicon: data.settings.ico || "" });
          setFailedImages([]);
        }
        if (typeof data?.settings?.allowRegister === "boolean") {
          setAllowRegister(data.settings.allowRegister);
        }
      })
      .catch(() => {});
  }, []);

  const step1Valid = useMemo(
    () => username.trim().length >= 3 && password.length >= 8 && confirm.length > 0 && (!requireSetupToken || setupToken.length > 0),
    [username, password, confirm, requireSetupToken, setupToken]
  );

  async function createAdmin() {
    setError("");
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, setupToken })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "创建管理员失败");
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建管理员失败");
    } finally {
      setLoading(false);
    }
  }

  async function saveSite() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() || "Alcor", allowRegister })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存站点信息失败");
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存站点信息失败");
    } finally {
      setLoading(false);
    }
  }

  function skipToLogin() {
    router.push("/login?skipSetup=1");
  }

  return (
    <>
      <div className="fr-page">
        <header className="fr-top">
          <div className="fr-brand">
            {brandImage ? <img key={brandImage} src={brandImage} alt="" ref={image => {
              if (image?.complete && image.naturalWidth === 0) failBrandImage(brandImage);
            }} onError={() => failBrandImage(brandImage)} /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M3 17l5-6 4 3 6-8" />
              <path d="M15 6h3v3" />
            </svg>}
            <span>Alcor</span>
          </div>
          <ThemeToggle />
        </header>
        <main className="fr-main">
          <section className="fr-panel" aria-labelledby="setup-title">
            <div className="fr-panel-head">
              <h1 id="setup-title">
                {step === 1 ? "创建管理员账户" : step === 2 ? "设置网站" : "设置完成"}
              </h1>
              <span className="fr-step">{step} / 3</span>
            </div>
            {step === 1 && (
              <form
                className="fr-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createAdmin();
                }}
              >
                <div className={`fr-fields${requireSetupToken ? "" : " single"}`}>
                  {requireSetupToken && <label htmlFor="fr-setup-token">安装令牌<PasswordInput id="fr-setup-token" type="password" value={setupToken} onChange={e => setSetupToken(e.target.value)} maxLength={512} autoComplete="off" aria-label="安装令牌" /></label>}
                  <label htmlFor="fr-username">
                    登录名
                    <input id="fr-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
                  </label>
                </div>
                <div className="fr-fields fr-password-fields">
                  <div className="fr-password-field"><label htmlFor="fr-password">
                    密码
                    <PasswordInput id="fr-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位，含字母和数字" maxLength={128} autoComplete="new-password" />
                  </label><PasswordStrength password={password} userInputs={[username]} /></div>
                  <label htmlFor="fr-confirm">
                    确认密码
                    <PasswordInput id="fr-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入密码" maxLength={128} autoComplete="new-password" />
                  </label>
                </div>
                {error && <p className="fr-error" role="alert">{error}</p>}
                <div className="fr-actions">
                  <button className="fr-secondary" type="button" onClick={skipToLogin}>稍后设置</button>
                  <button className="fr-primary" type="submit" disabled={loading || !step1Valid}>
                    {loading ? "正在创建…" : "继续设置"}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                  </button>
                </div>
              </form>
            )}
            {step === 2 && (
              <form
                className="fr-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveSite();
                }}
              >
                <div className="fr-fields single">
                  <label htmlFor="fr-title">
                    网站标题
                    <input id="fr-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
                  </label>
                </div>
                <div className="fr-toggle">
                  <div>
                    <strong id="fr-register-label" style={{ fontSize: 13 }}>允许新用户注册</strong>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-labelledby="fr-register-label"
                    aria-checked={allowRegister}
                    className={`fr-switch${allowRegister ? " on" : ""}`}
                    onClick={() => setAllowRegister((v) => !v)}
                  >
                    <span style={{ backgroundColor: "#fff" }} />
                  </button>
                </div>
                {error && <p className="fr-error" role="alert">{error}</p>}
                <div className="fr-actions">
                  <button className="fr-secondary" type="button" onClick={() => setStep(3)}>跳过</button>
                  <button className="fr-primary" type="submit" disabled={loading}>
                    {loading ? "正在保存…" : "保存并继续"}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                  </button>
                </div>
              </form>
            )}
            {step === 3 && (
              <div className="fr-form">
                <div className="fr-ready">
                  <p>管理员 <strong style={{ color: "var(--fr-text)" }}>{username.trim()}</strong> 已创建。</p>
                </div>
                <div className="fr-actions">
                  <button className="fr-primary" type="button" onClick={() => router.push("/records")}>
                    进入 Alcor
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                  </button>
                </div>
              </div>
            )}
          </section>
        </main>
      </div>
    </>
  );
}
