/** @type {import('next').NextConfig} */

// 局域网开发来源：本机默认放行；额外地址用 DEV_ORIGINS 环境变量配置（逗号分隔，
// 如 DEV_ORIGINS=http://192.168.x.x），换 IP 只改 .env.local 即可，无需改代码。
const lanOrigins = (process.env.DEV_ORIGINS || "localhost")
  .split(",")
  .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/:\d+$/, ""))
  .filter(Boolean);
const allowedDevOrigins = ["localhost", "127.0.0.1", ...lanOrigins];

const nextConfig = {
  // 开发与生产使用独立缓存目录，避免 next build 覆盖 dev 分块后触发 ChunkLoadError。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // 局域网访问开发资源（避免 cross-origin 警告，Next 未来大版本将强制要求）
  allowedDevOrigins,
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    // 生产更严格；开发模式放行 HMR（ws）与 source-map 所需
    const csp = isProd
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'"
        ].join("; ")
      : [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'self' ws:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'"
        ].join("; ");
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : [])
        ]
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }]
      },
      {
        // 世界地图约 3 MB（gzip 后约 1 MB），内容随版本发布而更新。
        // 浏览器可直接复用一天，之后一周内后台校验，避免每次打开地图都阻塞首屏。
        source: "/maps-world.json",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }]
      }
    ];
  }
};

export default nextConfig;
