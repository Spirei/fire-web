"use client";
import { Capsule } from "@/components/Capsule";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconPencil, IconPhotoPlus, IconRefresh } from "@tabler/icons-react";
import { clientRequestId } from "@/lib/randomId";
import type { User } from "@/lib/types";
import AppSelect from "@/components/AppSelect";
import { showToast } from "@/lib/toast";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
type Profile = {
  revision: number;
  bio: string;
  gender: string;
  background: {
    sha256: string;
  } | null;
};
type Activity = {
  total: number;
  activeDays: number;
  longest: number;
  current: number;
  since: number;
  today: string;
  days: Record<string, number>;
};
export default function PersonalHome({
  user: initialUser,
}: {
  user: User;
  onEdit?: () => void;
}) {
  const [user, setUser] = useState(initialUser),
    [profile, setProfile] = useState<Profile | null>(null),
    [activity, setActivity] = useState<Activity | null>(null),
    [error, setError] = useState(""),
    [activityError, setActivityError] = useState(""),
    [editing, setEditing] = useState(false),
    [nickname, setNickname] = useState(initialUser.nickname || ""),
    [bio, setBio] = useState(""),
    [gender, setGender] = useState("unspecified"),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const avatar = useRef<HTMLInputElement>(null),
    background = useRef<HTMLInputElement>(null),
    foreground = useWorkspaceForeground();
  useEffect(() => {
    if (!foreground) return;
    const c = new AbortController();
    setError("");
    fetch("/api/auth/personal-home", { signal: c.signal, cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.error || "资料读取失败");
        return d;
      })
      .then((d) => {
        if (!c.signal.aborted) {
          setUser(d.user);
          setProfile(d.profile);
          if (!editing) {
            setNickname(d.user.nickname || "");
            setBio(d.profile.bio);
            setGender(d.profile.gender);
          }
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [foreground, tick]);
  useEffect(() => {
    if (!foreground) return;
    const c = new AbortController();
    setActivityError("");
    fetch("/api/auth/personal-activity", {
      signal: c.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.error || "请求统计读取失败");
        return d;
      })
      .then((d) => {
        if (!c.signal.aborted) setActivity(d);
      })
      .catch((e) => {
        if (!c.signal.aborted) setActivityError(e.message);
      });
    return () => c.abort();
  }, [foreground, tick]);
  const name = user.nickname || user.username;
  async function save() {
    if (!profile || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/auth/personal-home", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: clientRequestId(),
          revision: profile.revision,
          nickname,
          bio,
          gender,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "保存失败");
      setUser(d.user);
      setProfile(d.profile);
      setEditing(false);
      window.dispatchEvent(new Event("fire:user-updated"));
      showToast("资料已保存");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存失败", "err");
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File, kind: "avatar" | "background") {
    if (busy || !profile) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      if (kind === "avatar") form.set("kind", "avatar");
      else {
        form.set("requestId", clientRequestId());
        form.set("revision", String(profile.revision));
      }
      const r = await fetch(
        kind === "avatar" ? "/api/upload" : "/api/auth/personal-home",
        { method: "POST", body: form },
      );
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "上传失败");
      if (kind === "background") {
        setProfile(d.profile);
        setUser(d.user);
      } else {
        setUser((u) => ({ ...u, avatar: d.url }));
        window.dispatchEvent(new Event("fire:user-updated"));
      }
      showToast(kind === "avatar" ? "头像已更新" : "背景已更新");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "上传失败", "err");
    } finally {
      setBusy(false);
    }
  }
  const calendar = useMemo(() => {
    if (!activity) return null;
    const today = new Date(`${activity.today}T00:00:00Z`),
      start = new Date(today);
    start.setUTCMonth(start.getUTCMonth() - 11, 1);
    const end = new Date(today);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    const offset = (start.getUTCDay() + 6) % 7,
      cells: Array<{
        day: string;
        count: number;
        known: boolean;
      } | null> = Array(offset).fill(null),
      months: {
        name: string;
        col: number;
      }[] = [];
    for (
      let date = new Date(start);
      date <= end;
      date.setUTCDate(date.getUTCDate() + 1)
    ) {
      const day = date.toISOString().slice(0, 10);
      if (date.getUTCDate() === 1)
        months.push({
          name: `${date.getUTCMonth() + 1}月`,
          col: Math.floor(cells.length / 7) + 1,
        });
      cells.push({
        day,
        count: activity.days[day] || 0,
        known:
          day >=
            new Date(activity.since + 8 * 3600000).toISOString().slice(0, 10) &&
          day <= activity.today,
      });
    }
    return {
      cells,
      months,
      weeks: Math.ceil(cells.length / 7),
      label: `${start.getUTCFullYear()}年${start.getUTCMonth() + 1}月 — ${end.getUTCFullYear()}年${end.getUTCMonth() + 1}月`,
    };
  }, [activity]);
  return (
    <section className="personal-home" aria-label="个人主页">
      <header
        className="personal-cover"
        style={
          profile?.background
            ? {
                backgroundImage: `linear-gradient(transparent,rgba(0,0,0,.45)),url('/api/auth/personal-home?kind=background&v=${profile.background.sha256}')`,
              }
            : undefined
        }
      >
        <button
          type="button"
          data-capsule="off"
          className="personal-background-target"
          aria-label="上传个人背景"
          disabled={busy || !profile}
          onClick={() => background.current?.click()}
        >
          <span className="personal-background-edit">
            <IconPhotoPlus size={20} />
          </span>
        </button>
        <button
          type="button"
          data-capsule="off"
          className="personal-avatar-edit"
          aria-label="更换头像"
          disabled={busy || !profile}
          onClick={() => avatar.current?.click()}
        >
          {user.avatar ? (
            <img src={user.avatar} alt={`${name} 头像`} />
          ) : (
            <span className="personal-home-avatar">{name.slice(0, 1)}</span>
          )}
          <span className="personal-avatar-pencil">
            <IconPencil size={17} />
          </span>
        </button>
        <input
          ref={avatar}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f, "avatar");
            e.target.value = "";
          }}
        />
        <input
          ref={background}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f, "background");
            e.target.value = "";
          }}
        />
        <h1>{name}</h1>
        <p>@{user.username}</p>
        {profile?.bio && !editing && (
          <p className="personal-bio">{profile.bio}</p>
        )}
        <button
          type="button"
          className="personal-edit"
          data-capsule="off"
          disabled={!profile || busy}
          onClick={() => {
            if (!editing) {
              setNickname(user.nickname || "");
              setBio(profile?.bio || "");
              setGender(profile?.gender || "unspecified");
            }
            setEditing((v) => !v);
          }}
        >
          {editing ? "收起编辑" : "编辑资料"}
        </button>
      </header>
      {error && (
        <p role="alert">
          {error}
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      {editing && (
        <form
          className="personal-inline-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2>编辑资料</h2>
          <div className="personal-readonly">
            <span>
              用户名 <b>{user.username}</b>
            </span>
            <span>
              UID <b>{user.uid || "—"}</b>
            </span>
            <span>
              角色 <b>{user.role === "admin" ? "管理员" : "用户"}</b>
            </span>
            <span>
              邮箱{" "}
              <b>
                {user.email || "未绑定"}
                {user.email
                  ? user.emailVerified
                    ? " · 已验证"
                    : " · 未验证"
                  : ""}
              </b>
            </span>
          </div>
          <label>
            昵称
            <input
              value={nickname}
              maxLength={20}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
          <label>
            简介
            <textarea
              value={bio}
              maxLength={160}
              rows={3}
              onChange={(e) => setBio(e.target.value)}
            />
          </label>
          <label>
            性别
            <AppSelect
              ariaLabel="性别"
              value={gender}
              options={[
                { value: "unspecified", label: "不指定" },
                { value: "male", label: "男" },
                { value: "female", label: "女" },
              ]}
              onChange={setGender}
            />
          </label>
          <div>
            <Capsule variant="primary" className="" type="submit" disabled={busy}>
              保存资料
            </Capsule>
            <Capsule variant="secondary"
              className=""
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              取消
            </Capsule>
          </div>
        </form>
      )}
      <div className="personal-home-stats">
        {[
          ["累计请求", activity?.total],
          ["活跃天数", activity?.activeDays],
          ["最长连续", activity?.longest],
          ["当前连续", activity?.current],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <strong>
              {typeof value === "number" ? value.toLocaleString() : "—"}
            </strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <section className="personal-request-history">
        <header>
          <h2>API 请求次数</h2>
          <button
            type="button"
            data-capsule="off"
            aria-label="刷新本人请求统计"
            onClick={() => setTick((n) => n + 1)}
          >
            <IconRefresh size={18} />
          </button>
        </header>
        {activityError ? (
          <p role="alert">{activityError}</p>
        ) : !calendar ? (
          <p role="status">正在读取本人请求统计</p>
        ) : (
          <div className="personal-heatmap">
            <div className="personal-heatmap-scroll">
              <div
                className="personal-heatmap-months"
                style={{
                  gridTemplateColumns: `repeat(${calendar.weeks},minmax(9px,1fr))`,
                }}
              >
                {calendar.months.map((m) => (
                  <span key={m.col} style={{ gridColumn: m.col }}>
                    {m.name}
                  </span>
                ))}
              </div>
              <div
                className="personal-heatmap-cells"
                style={{
                  gridTemplateColumns: `repeat(${calendar.weeks},minmax(9px,1fr))`,
                }}
              >
                {calendar.cells.map((cell, index) =>
                  cell ? (
                    <span
                      role="img"
                      tabIndex={0}
                      key={cell.day}
                      data-level={
                        !cell.known
                          ? "unknown"
                          : cell.count === 0
                            ? "0"
                            : cell.count < 10
                              ? "1"
                              : cell.count < 50
                                ? "2"
                                : cell.count < 150
                                  ? "3"
                                  : "4"
                      }
                      aria-label={`${cell.day} · ${cell.known ? `${cell.count} 次 API 请求` : "未采集"}`}
                      title={`${cell.day} · ${cell.known ? `${cell.count} 次 API 请求` : "未采集"}`}
                    />
                  ) : (
                    <i key={index} />
                  ),
                )}
              </div>
            </div>
            <footer>
              <span>{calendar.label}</span>
              <span>
                少 <i data-level="0" />
                <i data-level="1" />
                <i data-level="2" />
                <i data-level="3" />
                <i data-level="4" /> 多
              </span>
            </footer>
            <p className="personal-observation-note">
              本人请求自{" "}
              {activity
                ? new Date(activity.since).toLocaleDateString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })
                : "—"}{" "}
              起采集；此前日期未采集。
            </p>
          </div>
        )}
      </section>
    </section>
  );
}
