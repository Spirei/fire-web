/** @type {import('next').NextConfig} */

// 局域网开发来源：本机默认放行；额外地址用 DEV_ORIGINS 环境变量配置（逗号分隔，
// 如 DEV_ORIGINS=http://192.168.x.x），换 IP 只改 .env.local 即可，无需改代码。
const lanOrigins = (process.env.DEV_ORIGINS || "")
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
  webpack(config, { dev }) {
    if (dev) {
      // 行情、财报等后台任务会持续写入这些运行时目录。若让 webpack 监听，
      // 本地开发页会被反复整页刷新，旧页面随后请求到已失效的 chunk。
      const runtimeData = ["**/data/**", "**/public/uploads/**"];
      const ignored = config.watchOptions?.ignored;
      config.watchOptions = {
        ...config.watchOptions,
        // Next 默认值是 RegExp，不能塞进字符串数组（webpack 会拒绝启动）。
        ignored: ignored instanceof RegExp
          ? new RegExp(`${ignored.source}|[\\/]data[\\/]|[\\/]public[\\/]uploads[\\/]`, ignored.flags)
          : [...(Array.isArray(ignored) ? ignored : ignored ? [ignored] : []), ...runtimeData]
      };
    }
    return config;
  },
  // 局域网访问开发资源（避免 cross-origin 警告，Next 未来大版本将强制要求）
  allowedDevOrigins,
  async rewrites() {
    return { beforeFiles: [
      { source: "/uploads/reports/:path*", destination: "/api/private-reports/:path*" },
      // 草稿以 .draft- 开头；必须先走动态读取，否则 public 静态服务拒绝隐藏文件并返回 400。
      { source: "/uploads/mclaren/models/:file", destination: "/api/showcase/model-files/:file" }
    ] };
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    // 生产更严格；开发模式放行 HMR（ws）与 source-map 所需
    const csp = isProd
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          // blob: 给 GLTFLoader 解析模型内嵌贴图用：three 走 ImageBitmapLoader（fetch(blob:) → createImageBitmap），
          // 因此 connect-src 必须放行 blob:；img-src 一并放行，兼容走 <img src=blob:> 的老浏览器。
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          "connect-src 'self' blob:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'"
        ].join("; ")
      : [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          "connect-src 'self' ws: blob:",
          "worker-src 'self' blob:",
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
        source: "/uploads/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'" },
          // 上传素材（名人头像、股票图标等）极少变化：允许浏览器直接用上一次成功加载的副本
          // 立即绘制（刷新不再出现首字母占位），同时在一小时后后台静默校验，有更新再换新图。
          { key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }
        ]
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }]
      },
      {
        // 浏览器刷新一开始即可复用静态站点图标，不退回通用地球占位。
        source: "/site-icon.svg",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      },
      {
        // 组合时间序列（几十 KB、内容按 30 秒粒度变化）：允许浏览器私有缓存 + ETag 条件请求，
        // 刷新页面时命中 304 就不再重传正文；其余接口继续 no-store。
        source: "/api/v1/portfolio-series",
        headers: [{ key: "Cache-Control", value: "private, max-age=30, must-revalidate" }]
      },
      {
        // 世界地图约 3 MB（gzip 后约 1 MB），内容随版本发布而更新。
        // 浏览器可直接复用一天，之后一周内后台校验，避免每次打开地图都阻塞首屏。
        source: "/maps-world.json",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }]
      },
      {
        // 默认车型（MCL35M）与两张环境贴图随仓库分发：车模放 public/mclaren/，
        // 约 23MB + 3MB，保证别人克隆或部署后开箱就有车可看。
        source: "/mclaren/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      },
      {
        // 其余车型与隧道环境贴图放 uploads 卷手动导入，不进仓库也不进镜像。
        // 这些文件按文件名版本化（preset 里带 ?v=），长缓存 + immutable，刷新不再回服务器校验。
        source: "/uploads/mclaren/models/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      },
      {
        source: "/uploads/mclaren/env/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      }
    ];
  }
};

export default nextConfig;
