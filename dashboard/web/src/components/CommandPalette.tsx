import { useEffect, useMemo, useRef, useState } from "react";
import type { AppCardView, ThemeMode, WorkspaceView } from "../types";
import {
  ActivityIcon,
  BotIcon,
  BoxIcon,
  GlobeIcon,
  LayoutGridIcon,
  LockIcon,
  MessageSquareIcon,
  MoonIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  SunIcon,
} from "./Icons";

export interface PaletteCommand {
  id: string;
  section: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  shortcut?: string;
  icon: "overview" | "chat" | "apps" | "activity" | "settings" | "web" | "agent" | "deploy" | "refresh" | "theme" | "setup" | "lock";
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  apps: AppCardView[];
  theme: ThemeMode;
  pendingPlansCount: number;
  canLock: boolean;
  onNavigate: (view: WorkspaceView) => void;
  onInspectApp: (app: AppCardView) => void;
  onOpenDeployModal: () => void;
  onToggleTheme: () => void;
  onRefresh: () => void;
  onOpenSetupWizard: () => void;
  onLock: () => void;
}

function CommandIconGlyph({ kind }: { kind: PaletteCommand["icon"] }) {
  const cls = "h-4 w-4";
  switch (kind) {
    case "overview":
      return <LayoutGridIcon className={cls} />;
    case "chat":
      return <MessageSquareIcon className={cls} />;
    case "apps":
      return <BoxIcon className={cls} />;
    case "activity":
      return <ActivityIcon className={cls} />;
    case "settings":
      return <SlidersIcon className={cls} />;
    case "web":
      return <GlobeIcon className={cls} />;
    case "agent":
      return <BotIcon className={cls} />;
    case "deploy":
      return <PlusIcon className={cls} />;
    case "refresh":
      return <RefreshIcon className={cls} />;
    case "theme":
      return <SunIcon className={cls} />;
    case "setup":
      return <ShieldIcon className={cls} />;
    case "lock":
      return <LockIcon className={cls} />;
  }
}

export function CommandPalette({
  open,
  onClose,
  apps,
  theme,
  pendingPlansCount,
  canLock,
  onNavigate,
  onInspectApp,
  onOpenDeployModal,
  onToggleTheme,
  onRefresh,
  onOpenSetupWizard,
  onLock,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands = useMemo<PaletteCommand[]>(() => {
    const items: PaletteCommand[] = [
      {
        id: "nav-overview",
        section: "Navigation",
        title: "Go to Overview",
        subtitle: "Server health, live telemetry, and quick controls",
        keywords: "home dashboard metrics cpu ram disk",
        shortcut: "G O",
        icon: "overview",
        run: () => onNavigate("overview"),
      },
      {
        id: "nav-chat",
        section: "Navigation",
        title: "Go to CTO Agent",
        subtitle: "Chat with your autonomous AI sysadmin & engineer",
        keywords: "ai hermes opencode prompt assistant",
        shortcut: "G C",
        icon: "chat",
        run: () => onNavigate("chat"),
      },
      {
        id: "nav-apps",
        section: "Navigation",
        title: "Go to Workloads & Apps",
        subtitle: `${apps.length} isolated container${apps.length === 1 ? "" : "s"} managed`,
        keywords: "docker containers services logs",
        shortcut: "G W",
        icon: "apps",
        run: () => onNavigate("apps"),
      },
      {
        id: "nav-activity",
        section: "Navigation",
        title: "Go to Approvals & Audit",
        subtitle:
          pendingPlansCount > 0
            ? `${pendingPlansCount} execution plan${pendingPlansCount === 1 ? "" : "s"} awaiting approval`
            : "Review execution plans and immutable audit history",
        keywords: "plans security history logs governance",
        shortcut: "G A",
        icon: "activity",
        run: () => onNavigate("activity"),
      },
      {
        id: "nav-settings",
        section: "Navigation",
        title: "Go to System & Settings",
        subtitle: "Baseline health scan, domain TLS, AI brain & preferences",
        keywords: "dns domain ssl provider persona",
        shortcut: "G S",
        icon: "settings",
        run: () => onNavigate("settings"),
      },
      {
        id: "action-deploy",
        section: "Quick Actions",
        title: "Deploy New Workload",
        subtitle: "Launch a guided Web App or Personal AI Agent plan",
        keywords: "create install new container app",
        icon: "deploy",
        run: onOpenDeployModal,
      },
      {
        id: "action-refresh",
        section: "Quick Actions",
        title: "Refresh Telemetry & Workloads",
        subtitle: "Sync live CPU, RAM, disk, apps, plans, and audit feed",
        keywords: "reload sync poll",
        icon: "refresh",
        run: onRefresh,
      },
      {
        id: "action-theme",
        section: "Quick Actions",
        title: `Switch to ${theme === "dark" ? "Light" : "Dark"} Appearance`,
        subtitle: "Toggle between Obsidian Studio dark and Porcelain Cloud light",
        keywords: "color mode appearance dark light",
        icon: "theme",
        run: onToggleTheme,
      },
      {
        id: "action-wizard",
        section: "Quick Actions",
        title: "Open Setup Wizard",
        subtitle: "Configure custom domain, AI provider, passphrase & channels",
        keywords: "onboarding domain opencode telegram",
        icon: "setup",
        run: onOpenSetupWizard,
      },
    ];

    if (canLock) {
      items.push({
        id: "action-lock",
        section: "Quick Actions",
        title: "Lock Dashboard Session",
        subtitle: "Clear local session token and return to sign-in screen",
        keywords: "logout signout security",
        icon: "lock",
        run: onLock,
      });
    }

    for (const app of apps) {
      items.push({
        id: `app-${app.slug}`,
        section: "Workloads",
        title: `Inspect ${app.name}`,
        subtitle: `${app.kind === "personal-agent" ? "Personal Agent" : "Web App"} · ${app.status} · ${app.domain ?? "internal network"}`,
        keywords: `${app.slug} ${app.domain ?? ""} ${app.status} logs restart`,
        icon: app.kind === "personal-agent" ? "agent" : "web",
        run: () => onInspectApp(app),
      });
    }

    return items;
  }, [
    apps,
    canLock,
    onInspectApp,
    onLock,
    onNavigate,
    onOpenDeployModal,
    onOpenSetupWizard,
    onRefresh,
    onToggleTheme,
    pendingPlansCount,
    theme,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((cmd) => {
      const haystack = `${cmd.title} ${cmd.subtitle ?? ""} ${cmd.keywords ?? ""} ${cmd.section}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(0);
    }
  }, [filtered.length, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          filtered.length > 0 ? (prev + 1) % filtered.length : 0,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0,
        );
      } else if (event.key === "Enter") {
        const chosen = filtered[selectedIndex];
        if (chosen) {
          event.preventDefault();
          onClose();
          chosen.run();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtered, onClose, open, selectedIndex]);

  if (!open) return null;

  // Group filtered commands by section while preserving flat index
  const grouped: Array<{ section: string; items: Array<{ cmd: PaletteCommand; flatIdx: number }> }> = [];
  filtered.forEach((cmd, flatIdx) => {
    let bucket = grouped.find((g) => g.section === cmd.section);
    if (!bucket) {
      bucket = { section: cmd.section, items: [] };
      grouped.push(bucket);
    }
    bucket.items.push({ cmd, flatIdx });
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--bg-backdrop)] px-4 pt-[12vh] backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="vps-elevated animate-fade-in w-full max-w-xl overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Jump to a view, inspect a workload, or run an action..."
            className="w-full bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          <kbd className="vps-kbd">ESC</kbd>
        </div>

        <div className="max-h-[54vh] overflow-y-auto p-2">
          {grouped.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-[var(--text-muted)]">
              No matching commands for &ldquo;{query}&rdquo;.
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.section} className="mb-2 last:mb-0">
                <p className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {group.section}
                </p>
                <div className="space-y-0.5">
                  {group.items.map(({ cmd, flatIdx }) => {
                    const active = flatIdx === selectedIndex;
                    return (
                      <button
                        key={cmd.id}
                        type="button"
                        onMouseEnter={() => setSelectedIndex(flatIdx)}
                        onClick={() => {
                          onClose();
                          cmd.run();
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition ${
                          active
                            ? "bg-[var(--accent-soft)] text-[var(--text-primary)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                        }`}
                      >
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                            active
                              ? "border-[var(--accent-border)] bg-[var(--bg-surface)] text-[var(--accent)]"
                              : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-muted)]"
                          }`}
                        >
                          {cmd.icon === "theme" && theme === "light" ? (
                            <MoonIcon className="h-4 w-4" />
                          ) : (
                            <CommandIconGlyph kind={cmd.icon} />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-[var(--text-primary)]">
                            {cmd.title}
                          </p>
                          {cmd.subtitle && (
                            <p className="truncate text-[11px] text-[var(--text-muted)]">
                              {cmd.subtitle}
                            </p>
                          )}
                        </div>
                        {cmd.shortcut && <kbd className="vps-kbd">{cmd.shortcut}</kbd>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <kbd className="vps-kbd">↑</kbd>
              <kbd className="vps-kbd">↓</kbd> navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="vps-kbd">↵</kbd> run
            </span>
          </div>
          <span>VPS OS Command Palette</span>
        </div>
      </div>
    </div>
  );
}
