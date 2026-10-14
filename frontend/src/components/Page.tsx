import type { ReactNode } from "react";

/**
 * The frame every screen (except the live session) is built on: a fixed
 * header with the title, a one-line description, actions and optional tabs,
 * and a scrolling body. Header and body share one column whose width comes
 * from Settings → Appearance → Page width, so every screen lines up.
 *
 * Body content goes in <div className="page-content"> (or a view that renders
 * one), which applies the same gutters as the header.
 */
export default function Page({ title, subtitle, actions, tabs, children }: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <header className={`page-bar ${tabs ? "has-tabs" : ""}`}>
        <div className="page-bar-top">
          <div className="page-titles">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
        {tabs && <nav className="page-tabs" role="tablist">{tabs}</nav>}
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

export function PageTab({ active, onClick, icon, count, title, children }: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  count?: number;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button role="tab" aria-selected={active} title={title}
      className={`page-tab ${active ? "active" : ""}`} onClick={onClick}>
      {icon}{children}
      {count !== undefined && <span className="page-tab-count">{count}</span>}
    </button>
  );
}
