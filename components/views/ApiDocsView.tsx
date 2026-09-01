"use client";

import { showToast } from "@/lib/toast";
import SettingsHeader, { SubNavIcon } from "@/components/SettingsHeader";
import { copyText } from "@/lib/clipboard";

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Endpoint {
  method: Method;
  path: string;
  desc: string;
  auth: boolean;
}

const CATEGORIES: { title: string; endpoints: Endpoint[] }[] = [
  {
    title: "认证与账号",
    endpoints: [
      { method: "POST", path: "/api/auth/login", desc: "登录，创建会话", auth: false },
      { method: "POST", path: "/api/auth/register", desc: "注册新账号", auth: false },
      { method: "GET", path: "/api/auth/me", desc: "获取当前登录用户", auth: true },
      { method: "PUT", path: "/api/auth/profile", desc: "更新昵称 / 邮箱 / 头像等资料（修改邮箱需 currentPassword）", auth: true },
      { method: "POST", path: "/api/auth/password", desc: "修改登录密码", auth: true },
      { method: "POST", path: "/api/auth/logout", desc: "退出登录", auth: true }
    ]
  },
  {
    title: "股票记录",
    endpoints: [
      { method: "GET", path: "/api/records", desc: "获取全部股票记录", auth: true },
      { method: "POST", path: "/api/records", desc: "新增股票记录", auth: true },
      { method: "PUT", path: "/api/records/{id}", desc: "更新指定记录", auth: true },
      { method: "DELETE", path: "/api/records/{id}", desc: "删除指定记录", auth: true },
      { method: "POST", path: "/api/records/batch-delete", desc: "按 ID 批量删除", auth: true },
      { method: "DELETE", path: "/api/records", desc: "清空全部记录（需 body.password）", auth: true }
    ]
  },
  {
    title: "行情与数据源",
    endpoints: [
      { method: "POST", path: "/api/quotes", desc: "批量获取实时行情", auth: true },
      { method: "POST", path: "/api/charts", desc: "当日分时走势（迷你图）", auth: true },
      { method: "GET", path: "/api/search?q={关键词}", desc: "股票代码 / 名称搜索联想", auth: true },
      { method: "GET", path: "/api/indices", desc: "大盘指数：开盘 / 最新 / 涨跌幅", auth: true },
      { method: "GET", path: "/api/ticker", desc: "顶部全球指数栏：行情 + 迷你走势", auth: false },
      { method: "GET", path: "/api/earnings", desc: "美股财报预报日历", auth: false }
    ]
  },
  {
    title: "日志与用户",
    endpoints: [
      { method: "GET", path: "/api/activities", desc: "操作日志", auth: true },
      { method: "GET", path: "/api/users", desc: "用户列表", auth: true },
      { method: "PUT", path: "/api/users/{id}", desc: "修改用户信息", auth: true },
      { method: "DELETE", path: "/api/users/{id}", desc: "删除用户", auth: true },
      { method: "POST", path: "/api/users/{id}/reset-password", desc: "重置用户密码", auth: true }
    ]
  },
  {
    title: "网站与系统",
    endpoints: [
      { method: "GET", path: "/api/settings", desc: "读取网站设置", auth: true },
      { method: "PUT", path: "/api/settings", desc: "更新网站设置", auth: true },
      { method: "GET", path: "/api/settings/public", desc: "首页公开设置", auth: false },
      { method: "POST", path: "/api/upload", desc: "上传图标 / 背景 / 头像", auth: true },
      { method: "GET", path: "/api/db/status", desc: "数据库状态", auth: true },
      { method: "POST", path: "/api/db/test", desc: "测试数据库连接", auth: true }
    ]
  }
];

const METHOD_CLS: Record<Method, string> = {
  GET: "bg-brand-light text-brand-deep",
  POST: "bg-bg-gray text-ink-2",
  PUT: "bg-brand-light text-brand-deep",
  DELETE: "bg-up-bg text-up"
};

async function copyPath(path: string) {
  const ok = await copyText(path);
  if (ok) {
    showToast(`已复制 ${path}`);
  } else {
    showToast("复制失败，请手动复制", "err");
  }
}

const CATEGORY_ICONS: Record<string, string> = {
  "认证与账号": "profile",
  股票记录: "stocks",
  行情与数据源: "api",
  日志与用户: "list",
  网站与系统: "sitemanage"
};

export default function ApiDocsView() {
  return (
    <div className="flex flex-col gap-5 rounded-card border border-edge bg-white p-6 shadow-card">
      <SettingsHeader
        name="api"
        title="API 开发接口"
        desc="后端全部接口一览：带「需登录」的接口依赖登录会话（Cookie），「公开」接口无需登录"
        action={
          <a
            href="/api-docs"
            target="_blank"
            rel="noopener noreferrer"
            title="打开 API 规范文档"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-brand-deep dark:hover:bg-white/10 dark:hover:text-[#8ec2ff]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </a>
        }
      />

      {CATEGORIES.map((cat) => (
        <div key={cat.title} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-edge text-muted">
              <SubNavIcon name={CATEGORY_ICONS[cat.title] || "api"} className="h-3.5 w-3.5" />
            </span>
            <span className="text-[13px] font-bold text-ink-2">{cat.title}</span>
          </div>
          <div className="data-table-scroll rounded-[12px] border border-edge">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
                  <th className="px-3.5 py-2.5 text-left">方法</th>
                  <th className="px-3.5 py-2.5 text-left">接口</th>
                  <th className="hidden px-3.5 py-2.5 text-left sm:table-cell">说明</th>
                  <th className="px-3.5 py-2.5 text-right">鉴权</th>
                </tr>
              </thead>
              <tbody>
                {cat.endpoints.map((ep) => (
                  <tr key={`${ep.method}-${ep.path}`} className="border-t border-edge transition-colors hover:bg-[#fafbfc] dark:hover:bg-[#1a212e]">
                    <td className="px-3.5 py-2.5">
                      <span className={`inline-block min-w-[58px] rounded-full px-2 py-0.5 text-center text-xs font-bold ${METHOD_CLS[ep.method]}`}>
                        {ep.method}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <code className="break-all font-mono text-[13px] text-ink">{ep.path}</code>
                        <button
                          type="button"
                          onClick={() => copyPath(ep.path)}
                          className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-colors hover:bg-brand-light hover:text-brand-deep"
                          title="复制接口路径"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                    </td>
                    <td className="hidden px-3.5 py-2.5 text-muted sm:table-cell">{ep.desc}</td>
                    <td className="px-3.5 py-2.5 text-right">
                      {ep.auth ? (
                        <span className="text-xs text-muted">需登录</span>
                      ) : (
                        <span className="text-xs font-semibold text-down">公开</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
