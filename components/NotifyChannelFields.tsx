"use client";
import type { ReactNode } from "react";
import PasswordInput from "./PasswordInput";
import type { SiteSettings } from "@/lib/types";

type Props = {
  site: SiteSettings;
  setSite: (next: SiteSettings) => void;
};

function Field({ label, hint, wide, children }: { label: string; hint: string; wide?: boolean; children: ReactNode }) {
  return <label className={wide ? "notify-field notify-span" : "notify-field"}><span>{label}</span>{children}<small>{hint}</small></label>;
}

function Switch({ on, label, hint, onClick }: { on: boolean; label: string; hint?: string; onClick: () => void }) {
  return <button type="button" role="switch" aria-checked={on} onClick={onClick} className="mail-settings-switch-row">
    <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
    <i className={on ? "is-on" : ""} aria-hidden="true"><em style={{ backgroundColor: "#fff" }} /></i>
  </button>;
}

export function WecomFields({ site, setSite }: Props) {
  const set = (patch: Partial<SiteSettings>) => setSite({ ...site, ...patch });
  return <div className="notify-sheet"><Switch on={site.wechatEnabled} label="启用" onClick={() => set({ wechatEnabled: !site.wechatEnabled })} /><div className="notify-grid">
    <Field label="名称" hint="通知渠道名称"><input value={site.wechatName} onChange={event => set({ wechatName: event.target.value })} autoComplete="off" /></Field>
    <div className="notify-switch-cell"><Switch on={site.wechatSmartRobot} label="使用智能机器人" hint="开启后使用智能机器人长连接，固定 dmPolicy=open、groupPolicy=disabled" onClick={() => set({ wechatSmartRobot: !site.wechatSmartRobot })} /></div>
    <Field label="企业 ID" hint="企业微信后台企业信息中的企业 ID"><input value={site.wechatCorpId} onChange={event => set({ wechatCorpId: event.target.value })} autoComplete="off" /></Field>
    <Field label="应用 AgentId" hint="企业微信自建应用的 AgentId"><input value={site.wechatAgentId} onChange={event => set({ wechatAgentId: event.target.value.replace(/\D/g, "").slice(0, 12) })} inputMode="numeric" autoComplete="off" /></Field>
    <Field label="应用 Secret" hint="企业微信自建应用的 Secret"><PasswordInput type="password" value={site.wechatSecret} onChange={event => set({ wechatSecret: event.target.value })} autoComplete="new-password" placeholder={site.wechatSecretConfigured ? "已保存 · 留空不修改" : ""} /></Field>
    <Field label="代理地址" hint="微信消息的转发代理地址。2022 年 6 月 20 日后创建的自建应用才需要，不使用代理时留空"><input value={site.wechatProxyUrl} onChange={event => set({ wechatProxyUrl: event.target.value })} placeholder="https://" autoComplete="off" /></Field>
    <Field label="Token" hint="微信企业自建应用 → API 接收消息配置中的 Token"><PasswordInput type="password" value={site.wechatToken} onChange={event => set({ wechatToken: event.target.value })} autoComplete="new-password" placeholder={site.wechatTokenConfigured ? "已保存 · 留空不修改" : ""} /></Field>
    <Field label="EncodingAESKey" hint="微信企业自建应用 → API 接收消息配置中的 EncodingAESKey"><PasswordInput type="password" value={site.wechatAesKey} onChange={event => set({ wechatAesKey: event.target.value })} autoComplete="new-password" placeholder={site.wechatAesKeyConfigured ? "已保存 · 留空不修改" : ""} /></Field>
    <Field wide label="管理员白名单" hint="可使用管理菜单及命令的用户 ID，多个 ID 用逗号分隔"><input value={site.wechatAdminIds} onChange={event => set({ wechatAdminIds: event.target.value })} autoComplete="off" /></Field>
  </div></div>;
}

export function TelegramFields({ site, setSite }: Props) {
  const set = (patch: Partial<SiteSettings>) => setSite({ ...site, ...patch });
  return <div className="notify-sheet">
    <Switch on={site.telegramEnabled} label="启用" onClick={() => set({ telegramEnabled: !site.telegramEnabled })} />
    <div className="notify-grid">
      <Field label="名称" hint="通知渠道名称"><input value={site.telegramName} onChange={event => set({ telegramName: event.target.value })} autoComplete="off" /></Field>
      <Field label="Bot Token" hint="Telegram 机器人 token，格式 123456:ABC"><PasswordInput type="password" value={site.telegramBotToken} onChange={event => set({ telegramBotToken: event.target.value })} autoComplete="new-password" placeholder={site.telegramBotTokenConfigured ? "已保存 · 留空不修改" : ""} /></Field>
      <Field label="Chat ID" hint="接收消息的用户、群组或频道 Chat ID，多个用逗号分隔"><input value={site.telegramChatId} onChange={event => set({ telegramChatId: event.target.value })} autoComplete="off" /></Field>
      <Field label="用户白名单" hint="可使用机器人的用户 ID，多个用逗号分隔。不填则所有用户都能使用"><input value={site.telegramUserIds} onChange={event => set({ telegramUserIds: event.target.value })} autoComplete="off" /></Field>
      <Field label="管理员白名单" hint="可使用管理菜单及命令的用户 ID，多个 ID 用逗号分隔"><input value={site.telegramAdminIds} onChange={event => set({ telegramAdminIds: event.target.value })} autoComplete="off" /></Field>
      <Field wide label="代理 API 地址" hint="自定义代理 API 地址，默认 https://api.telegram.org"><input value={site.telegramApiBase} onChange={event => set({ telegramApiBase: event.target.value })} placeholder="https://api.telegram.org" autoComplete="off" /></Field>
    </div>
  </div>;
}

export function FeishuFields({ site, setSite }: Props) {
  const set = (patch: Partial<SiteSettings>) => setSite({ ...site, ...patch });
  return <div className="notify-sheet">
    <Switch on={site.feishuEnabled} label="启用" onClick={() => set({ feishuEnabled: !site.feishuEnabled })} />
    <div className="notify-grid">
      <Field label="名称" hint="通知渠道名称"><input value={site.feishuName} onChange={event => set({ feishuName: event.target.value })} autoComplete="off" /></Field>
      <Field label="App ID" hint="飞书开放平台应用的 App ID"><input value={site.feishuAppId} onChange={event => set({ feishuAppId: event.target.value })} autoComplete="off" /></Field>
      <Field label="App Secret" hint="飞书开放平台应用的 App Secret"><PasswordInput type="password" value={site.feishuAppSecret} onChange={event => set({ feishuAppSecret: event.target.value })} autoComplete="new-password" placeholder={site.feishuAppSecretConfigured ? "已保存 · 留空不修改" : ""} /></Field>
      <Field label="默认用户 Open ID" hint="默认通知接收用户的 Open ID，留空则优先使用互动用户"><input value={site.feishuOpenId} onChange={event => set({ feishuOpenId: event.target.value })} autoComplete="off" /></Field>
      <Field label="默认群聊 Chat ID" hint="默认通知接收群聊的 Chat ID，和 Open ID 二选一即可"><input value={site.feishuChatId} onChange={event => set({ feishuChatId: event.target.value })} autoComplete="off" /></Field>
      <Field label="管理员白名单" hint="允许执行命令和管理操作的 Open ID，多个用逗号分隔"><input value={site.feishuAdminIds} onChange={event => set({ feishuAdminIds: event.target.value })} autoComplete="off" /></Field>
      <Field label="Verification Token" hint="飞书事件订阅的 Verification Token，启用事件校验时填写"><PasswordInput type="password" value={site.feishuVerificationToken} onChange={event => set({ feishuVerificationToken: event.target.value })} autoComplete="new-password" placeholder={site.feishuVerificationTokenConfigured ? "已保存 · 留空不修改" : ""} /></Field>
      <Field label="Encrypt Key" hint="飞书事件订阅的 Encrypt Key，启用消息加密时填写"><PasswordInput type="password" value={site.feishuEncryptKey} onChange={event => set({ feishuEncryptKey: event.target.value })} autoComplete="new-password" placeholder={site.feishuEncryptKeyConfigured ? "已保存 · 留空不修改" : ""} /></Field>
    </div>
  </div>;
}

export function QqFields({ site, setSite }: Props) {
  const set = (patch: Partial<SiteSettings>) => setSite({ ...site, ...patch });
  return <div className="notify-sheet">
    <Switch on={site.qqEnabled} label="启用" onClick={() => set({ qqEnabled: !site.qqEnabled })} />
    <div className="notify-grid">
      <Field label="名称" hint="通知渠道名称"><input value={site.qqName} onChange={event => set({ qqName: event.target.value })} autoComplete="off" /></Field>
      <Field label="AppID" hint="QQ 开放平台机器人 AppID"><input value={site.qqAppId} onChange={event => set({ qqAppId: event.target.value.replace(/\D/g, "").slice(0, 20) })} inputMode="numeric" autoComplete="off" /></Field>
      <Field label="AppSecret" hint="QQ 开放平台机器人 AppSecret"><PasswordInput type="password" value={site.qqAppSecret} onChange={event => set({ qqAppSecret: event.target.value })} autoComplete="new-password" placeholder={site.qqAppSecretConfigured ? "已保存 · 留空不修改" : ""} /></Field>
      <Field label="用户 OpenID" hint="默认接收者 openid（单聊），用户需曾与机器人交互过"><input value={site.qqUserOpenId} onChange={event => set({ qqUserOpenId: event.target.value })} autoComplete="off" /></Field>
      <Field label="群组 OpenID" hint="默认群组 openid（群聊），与用户 OpenID 二选一"><input value={site.qqGroupOpenId} onChange={event => set({ qqGroupOpenId: event.target.value })} autoComplete="off" /></Field>
      <Field wide label="管理员白名单" hint="可使用管理菜单及命令的用户 ID，多个 ID 用逗号分隔"><input value={site.qqAdminIds} onChange={event => set({ qqAdminIds: event.target.value })} autoComplete="off" /></Field>
    </div>
  </div>;
}

export function DiscordFields({ site, setSite }: Props) {
  const set = (patch: Partial<SiteSettings>) => setSite({ ...site, ...patch });
  return <div className="notify-sheet">
    <Switch on={site.discordEnabled} label="启用" onClick={() => set({ discordEnabled: !site.discordEnabled })} />
    <div className="notify-grid">
      <Field label="名称" hint="通知渠道名称"><input value={site.discordName} onChange={event => set({ discordName: event.target.value })} autoComplete="off" /></Field>
      <Field label="Bot Token" hint="Discord Bot Token，需在开发者后台开启 Message Content Intent"><PasswordInput type="password" value={site.discordBotToken} onChange={event => set({ discordBotToken: event.target.value })} autoComplete="new-password" placeholder={site.discordBotTokenConfigured ? "已保存 · 留空不修改" : ""} /></Field>
      <Field label="服务器 ID" hint="可选。限制使用的服务器；为空则使用已加入的任意服务器"><input value={site.discordGuildId} onChange={event => set({ discordGuildId: event.target.value.replace(/\D/g, "").slice(0, 22) })} inputMode="numeric" autoComplete="off" /></Field>
      <Field label="频道 ID" hint="可选。默认广播频道；为空则自动选择可发送消息的频道"><input value={site.discordChannelId} onChange={event => set({ discordChannelId: event.target.value.replace(/\D/g, "").slice(0, 22) })} inputMode="numeric" autoComplete="off" /></Field>
      <Field wide label="管理员白名单" hint="可使用管理菜单及命令的用户 ID，多个 ID 用逗号分隔"><input value={site.discordAdminIds} onChange={event => set({ discordAdminIds: event.target.value })} autoComplete="off" /></Field>
    </div>
  </div>;
}

export function WebPushFields({ site, setSite }: Props) {
  const set = (patch: Partial<SiteSettings>) => setSite({ ...site, ...patch });
  return <div className="notify-sheet">
    <Switch on={site.webPushEnabled} label="启用" onClick={() => set({ webPushEnabled: !site.webPushEnabled })} />
    <div className="notify-grid">
      <Field label="名称" hint="通知渠道名称"><input value={site.webPushName} onChange={event => set({ webPushName: event.target.value })} autoComplete="off" /></Field>
      <Field label="登录用户名" hint="只有对应的用户登录后才会推送消息"><input value={site.webPushUsername} onChange={event => set({ webPushUsername: event.target.value })} autoComplete="off" /></Field>
    </div>
  </div>;
}
