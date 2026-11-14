"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", colorScheme: "light dark" }}>
        <main style={{ maxWidth: 480, margin: "15vh auto 0", padding: 24 }}>
          <h1>页面暂时无法加载</h1>
          <p>请稍后重试。</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
          {error.digest && <p><small>错误编号：{error.digest}</small></p>}
        </main>
      </body>
    </html>
  );
}
