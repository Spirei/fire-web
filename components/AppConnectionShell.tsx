import type { ReactNode } from "react";
import type { AppConnectionBrand } from "@/lib/appConnectionBrand";
import AppConnectionIcon from "@/components/AppConnectionIcon";

export default function AppConnectionShell({ children, serverName, brand, section = "网页授权", headerAction, wide = false }: {
  children: ReactNode; serverName: string; brand: AppConnectionBrand; section?: string; headerAction?: ReactNode; wide?: boolean;
}) {
  return <div className="app-connection-shell">
    <header className="app-connection-header">
      <div className="app-connection-header-inner">
        <span className="app-connection-brand"><AppConnectionIcon src={brand.siteLogo} small site /><span>{brand.siteName} 账户</span></span>
        {headerAction || <span className="app-connection-section">{section}</span>}
      </div>
    </header>
    <main className={`app-connection-main${wide ? " is-wide" : ""}`}>{children}</main>
    <footer className="app-connection-footer"><span>{brand.siteName}</span><span aria-hidden="true">·</span><span>{serverName}</span></footer>
  </div>;
}
