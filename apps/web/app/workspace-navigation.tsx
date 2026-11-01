"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

const primaryLinks = ["Overview", "Deployment", "Projects", "Campaigns", "Agents"] as const;
const mobileLinks = ["Overview", "Deployment", "Agents"] as const;

export function WorkspaceNavigation({ children, preview = true }: { children: ReactNode; preview?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const href = (label: string) => label === "Deployment" ? "/deployment" : label === "Overview" ? "/" : `/#${label.toLowerCase()}`;
  const current = (label: string) => label === "Deployment" ? pathname === "/deployment" : label === "Overview" && pathname === "/";

  return (
    <div className="workspace-frame" data-nav-collapsed={collapsed}>
      <aside className="side-nav" id="workspace-navigation" aria-label="Workspace navigation">
        <div className="side-nav-heading">
          <a className="workspace-brand" href="#workspace-content" aria-label="Death Of The Salesman home">
            <span aria-hidden="true">DS</span>
            <strong>Salesroom</strong>
          </a>
          <button
            className="nav-toggle"
            type="button"
            aria-expanded={!collapsed}
            aria-controls="primary-navigation"
            onClick={() => setCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{collapsed ? ">" : "<"}</span>
            <span className="nav-label">{collapsed ? "Expand navigation" : "Collapse navigation"}</span>
          </button>
        </div>
        <nav id="primary-navigation" aria-label="Primary">
          <ul className="primary-nav-list">
            {primaryLinks.map((label) => (
              <li key={label}>
                <a href={href(label)} aria-current={current(label) ? "page" : undefined}>
                  <span className="nav-symbol" aria-hidden="true">{label.slice(0, 1)}</span>
                  <span className="nav-label">{label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="workspace-body">
        <header className="command-bar">
          <form className="project-search" role="search">
            <label htmlFor="project-search">Search projects</label>
            <input id="project-search" name="project" type="search" placeholder={preview ? "Search synthetic projects" : "Project search unavailable"} disabled={!preview} />
          </form>
          <div className="command-actions">
            <button className="notification-button" type="button" aria-label={preview ? "Notifications, 2 unread" : "Notifications not loaded"} disabled={!preview}>
              <span aria-hidden="true">!</span>
              {preview && <span className="notification-count" aria-hidden="true">2</span>}
            </button>
            <details className="user-controls">
              <summary aria-label="Open user controls">
                <span className="user-monogram" aria-hidden="true">{preview ? "PG" : "?"}</span>
                <span className="user-name">{preview ? "Workspace owner" : "Owner access"}</span>
              </summary>
              <div className="user-menu">
                <button type="button">Preferences</button>
                {preview && <button type="button">Sign out preview</button>}
              </div>
            </details>
          </div>
        </header>

        <div id="workspace-content">{children}</div>
      </div>

      <nav className="mobile-tabs" aria-label="Mobile workspace tabs">
        {mobileLinks.map((label) => (
          <a key={label} href={href(label)} aria-current={current(label) ? "page" : undefined}>
            <span aria-hidden="true">{label.slice(0, 1)}</span>
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

