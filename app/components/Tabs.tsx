"use client";

import { useEffect, useState, type ReactNode } from "react";

// App shell: one panel at a time, like a modern web app.
// - Desktop (>=700px): left sidebar nav, content on the right.
// - iPhone / narrow: content on top, fixed bottom tab bar.
// The active tab is synced to the URL hash (#overview, #board, ...)
// so a link from another screen (e.g. /positions) can open a tab
// directly, and the back button / refresh keeps the tab.
// Tabs with an href (e.g. Positions, a separate page) render as
// links instead of panels. All panels are server-rendered by the
// page and passed in as nodes — this component only shows/hides.
export interface TabDef {
  id: string;
  label: string;
  icon: string;
  href?: string;
  node?: ReactNode;
}

export default function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const panelTabs = tabs.filter((t) => !t.href);
  const [active, setActive] = useState(initial ?? panelTabs[0]?.id ?? "");

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace("#", "");
      if (panelTabs.some((t) => t.id === h)) setActive(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (id: string) => {
    setActive(id);
    window.history.replaceState(null, "", `#${id}`);
  };

  const activeTab = panelTabs.find((t) => t.id === active) ?? panelTabs[0];

  return (
    <div className="app-shell">
      <style>{`
        .app-shell { display: block; }
        .side-nav { display: none; }
        .bottom-nav {
          position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
          display: flex; background: #fff; border-top: 1px solid #e0e4ea;
          padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
          box-shadow: 0 -1px 6px rgba(0,0,0,0.06);
        }
        .nav-item {
          flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
          padding: 4px 2px; border: none; background: none; cursor: pointer;
          font-size: 10px; color: #5f6368; text-decoration: none; font-family: inherit;
        }
        .nav-item.active { color: #0b1f3a; font-weight: 700; }
        .nav-item .nav-icon { font-size: 18px; line-height: 1; }
        .panel { padding-bottom: 76px; }
        @media (min-width: 700px) {
          .app-shell { display: flex; gap: 20px; align-items: flex-start; }
          .side-nav {
            display: flex; flex-direction: column; gap: 4px; position: sticky; top: 16px;
            min-width: 168px; background: #fff; border: 1px solid #e0e4ea; border-radius: 18px; padding: 10px;
          }
          .side-nav .nav-item { flex-direction: row; gap: 10px; font-size: 14px; padding: 10px 12px; border-radius: 10px; justify-content: flex-start; }
          .side-nav .nav-item.active { background: #eef4fb; }
          .bottom-nav { display: none; }
          .panel { flex: 1; padding-bottom: 0; min-width: 0; }
        }
      `}</style>

      <nav className="side-nav" aria-label="Sections">
        {tabs.map((t) =>
          t.href ? (
            <a key={t.id} className="nav-item" href={t.href}>
              <span className="nav-icon">{t.icon}</span> {t.label}
            </a>
          ) : (
            <button key={t.id} className={`nav-item${activeTab?.id === t.id ? " active" : ""}`} onClick={() => select(t.id)}>
              <span className="nav-icon">{t.icon}</span> {t.label}
            </button>
          ),
        )}
      </nav>

      <div className="panel">{activeTab?.node}</div>

      <nav className="bottom-nav" aria-label="Sections">
        {tabs.map((t) =>
          t.href ? (
            <a key={t.id} className="nav-item" href={t.href}>
              <span className="nav-icon">{t.icon}</span> {t.label}
            </a>
          ) : (
            <button key={t.id} className={`nav-item${activeTab?.id === t.id ? " active" : ""}`} onClick={() => select(t.id)}>
              <span className="nav-icon">{t.icon}</span> {t.label}
            </button>
          ),
        )}
      </nav>
    </div>
  );
}
