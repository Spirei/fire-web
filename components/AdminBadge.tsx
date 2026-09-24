/** 管理员头像角标由组件直接绘制，避免依赖部署时单独挂载的图标目录。 */
export default function AdminBadge({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="管理员"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="32" cy="32" r="32" fill="#087CFA" />
      <path d="M36.5 9 17.8 34.7h12.6L27 55l19.2-27.2H33.4L36.5 9Z" fill="#fff" />
    </svg>
  );
}
