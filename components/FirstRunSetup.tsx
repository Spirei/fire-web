"use client";

import PasswordInput from "@/components/PasswordInput";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Step = 1 | 2 | 3;

export default function FirstRunSetup({ requireSetupToken = false }: { requireSetupToken?: boolean }) {
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

  useEffect(() => {
    fetch("/api/settings/public")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const nextTitle = String(data?.settings?.title ?? "").trim();
        if (nextTitle) setTitle(nextTitle);
        if (typeof data?.settings?.allowRegister === "boolean") {
          setAllowRegister(data.settings.allowRegister);
        }
      })
      .catch(() => {});
  }, []);

  const step1Valid = useMemo(
    () => username.trim().length >= 3 && password.length >= 8 && confirm.length > 0,
    [username, password, confirm]
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
      <style>{`
        :root { color-scheme:dark; --bg:#0b0f16; --panel:#121923; --panel-2:#0f151e; --line:#273344; --text:#eef2f7; --muted:#8b98a9; --faint:#687588; --blue:#8db6ff; --green:#5bc69c; }
        .fr-page { width:min(100% - 48px,1020px); min-height:100dvh; margin:auto; display:flex; flex-direction:column; color:var(--text); background:var(--bg); font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif; }
        .fr-top { height:72px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); }
        .fr-brand { display:flex; align-items:center; gap:10px; font-size:15px; font-weight:650; }
        .fr-brand svg { width:20px; height:20px; }
        .fr-main { width:min(100%,680px); margin:0 auto; padding:72px 0 80px; flex:1; }
        .fr-kicker { margin:0 0 18px; color:var(--faint); font-size:11px; letter-spacing:.12em; }
        .fr-page h1 { margin:0; font-size:32px; line-height:1.25; letter-spacing:-.04em; font-weight:700; }
        .fr-panel { margin-top:42px; border:1px solid var(--line); border-radius:14px; background:var(--panel); overflow:hidden; }
        .fr-panel-head { display:flex; align-items:center; justify-content:space-between; padding:18px 20px; border-bottom:1px solid var(--line); }
        .fr-panel-head strong { font-size:14px; }
        .fr-step { color:var(--faint); font-size:11px; }
        .fr-form { padding:22px 20px 20px; }
        .fr-fields { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
        .fr-fields.single { grid-template-columns:1fr; }
        .fr-page label { display:grid; gap:8px; color:var(--muted); font-size:12px; }
        .fr-page input { width:100%; height:42px; padding:0 12px; border:1px solid var(--line); border-radius:8px; outline:none; color:var(--text); background:var(--panel-2); transition:border-color .18s,box-shadow .18s; }
        .fr-page input::placeholder { color:#5f6b7b; }
        .fr-error { margin-top:12px; color:#ff8d8d; font-size:12px; }
        .fr-actions { display:flex; justify-content:flex-end; align-items:center; gap:18px; margin-top:28px; }
        .fr-secondary { border:0; color:var(--muted); background:none; cursor:pointer; font-size:12px; }
        .fr-primary { display:inline-flex; align-items:center; gap:8px; height:38px; padding:0 15px; border:1px solid #9abcf2; border-radius:8px; color:#07101d; background:var(--blue); cursor:pointer; font-size:12px; font-weight:700; transition:background .18s,transform .18s; }
        .fr-primary:hover { background:#a8c7fa; transform:translateY(-1px); }
        .fr-primary:active { transform:scale(.98); }
        .fr-primary:disabled { opacity:.55; cursor:not-allowed; transform:none; }
        .fr-primary svg { width:14px; height:14px; }
        .fr-toggle { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:16px; padding-top:16px; border-top:1px solid var(--line); }
        .fr-toggle p { margin:4px 0 0; color:var(--faint); font-size:11px; line-height:1.6; }
        .fr-switch { width:36px; height:20px; border:0; border-radius:999px; position:relative; cursor:pointer; background:#3a3a3c; transition:background .3s; flex:none; }
        .fr-switch.on { background:#34c759; }
        .fr-switch span { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:transform .3s cubic-bezier(.32,.72,0,1); }
        .fr-switch.on span { transform:translateX(16px); }
        .fr-ready { display:grid; gap:8px; color:var(--muted); font-size:13px; line-height:1.7; }
        @media (max-width:620px) {
          .fr-page { width:min(100% - 28px,520px); }
          .fr-top { height:62px; }
          .fr-main { padding:52px 0 60px; }
          .fr-page h1 { font-size:28px; }
          .fr-fields { grid-template-columns:1fr; }
          .fr-actions { justify-content:space-between; }
          .fr-primary { flex:1; justify-content:center; }
        }
      `}</style>
      <div className="fr-page">
        <header className="fr-top">
          <div className="fr-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M3 17l5-6 4 3 6-8" />
              <path d="M15 6h3v3" />
            </svg>
            <span>Alcor</span>
          </div>
        </header>
        <main className="fr-main">
          <p className="fr-kicker">首次设置</p>
          <h1>{step === 3 ? "可以开始使用了" : "欢迎使用 Alcor"}</h1>
          <section className="fr-panel" aria-labelledby="setup-title">
            <div className="fr-panel-head">
              <strong id="setup-title">
                {step === 1 ? "创建管理员账户" : step === 2 ? "基础站点信息" : "开始使用"}
              </strong>
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
                <div className="fr-fields">
                  {requireSetupToken && <label htmlFor="fr-setup-token">安装令牌<PasswordInput id="fr-setup-token" type="password" value={setupToken} onChange={e => setSetupToken(e.target.value)} autoComplete="off" placeholder="部署时配置的 FIRE_SETUP_TOKEN" /></label>}
                  <label htmlFor="fr-username">
                    登录名
                    <input id="fr-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="例如：admin" autoComplete="username" autoFocus />
                  </label>
                  <label htmlFor="fr-password">
                    密码
                    <PasswordInput id="fr-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位，含字母和数字" autoComplete="new-password" />
                  </label>
                </div>
                <div className="fr-fields single" style={{ marginTop: 16 }}>
                  <label htmlFor="fr-confirm">
                    确认密码
                    <PasswordInput id="fr-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入密码" autoComplete="new-password" />
                  </label>
                </div>
                {error && <p className="fr-error">{error}</p>}
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
                    <input id="fr-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Alcor" autoFocus />
                  </label>
                </div>
                <div className="fr-toggle">
                  <div>
                    <strong style={{ fontSize: 13 }}>允许新用户注册</strong>
                    <p>关闭后只有管理员能创建账号。</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={allowRegister}
                    className={`fr-switch${allowRegister ? " on" : ""}`}
                    onClick={() => setAllowRegister((v) => !v)}
                  >
                    <span style={{ backgroundColor: "#fff" }} />
                  </button>
                </div>
                {error && <p className="fr-error">{error}</p>}
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
                  <p>管理员 <strong style={{ color: "var(--text)" }}>{username.trim()}</strong> 已创建。</p>
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
