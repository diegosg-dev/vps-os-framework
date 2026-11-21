import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityView } from "./components/ActivityView";
import { AgentChat } from "./components/AgentChat";
import { AuthGate } from "./components/AuthGate";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog, type ConfirmDialogState } from "./components/ConfirmDialog";
import {
  ActivityIcon,
  BoxIcon,
  CommandIcon,
  LayoutGridIcon,
  LockIcon,
  MenuIcon,
  MessageSquareIcon,
  MoonIcon,
  RefreshIcon,
  ServerIcon,
  SlidersIcon,
  SunIcon,
  VpsOsLogo,
  XIcon,
} from "./components/Icons";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { OverviewView } from "./components/OverviewView";
import { SettingsView } from "./components/SettingsView";
import { CapacityBar } from "./components/TelemetryCharts";
import { ToastStack } from "./components/ToastStack";
import { WorkloadDrawer } from "./components/WorkloadDrawer";
import { WorkloadsView } from "./components/WorkloadsView";
import { formatUptime, providerDisplayName } from "./lib/format";
import type {
  AppCardView,
  AuditEventView,
  ExecutionPlanView,
  OnboardingBootStatus,
  OnboardingPayload,
  SystemMetricsView,
  TelemetrySampleView,
  ThemeMode,
  ToastItem,
  ToastTone,
  WorkspaceView,
} from "./types";

const TOKEN_STORAGE_KEY = "vps_os_admin_token";
const THEME_STORAGE_KEY = "vps_os_theme";
const POLL_STORAGE_KEY = "vps_os_poll_ms";

function readStoredToken(): string {
  return (
    sessionStorage.getItem(TOKEN_STORAGE_KEY) ??
    localStorage.getItem(TOKEN_STORAGE_KEY) ??
    ""
  );
}

function persistToken(value: string, remember: boolean): void {
  if (!value) {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  if (remember) {
    localStorage.setItem(TOKEN_STORAGE_KEY, value);
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } else {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function readStoredTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return saved === "light" ? "light" : "dark";
}

function readStoredPollMs(): number {
  const raw = localStorage.getItem(POLL_STORAGE_KEY);
  if (raw === null) return 15_000;
  const parsed = Number(raw);
  return [0, 5_000, 15_000, 30_000].includes(parsed) ? parsed : 15_000;
}

const VIEW_META: Record<WorkspaceView, { label: string; subtitle: string }> = {
  overview: { label: "Overview", subtitle: "Mission Control" },
  chat: { label: "CTO Agent", subtitle: "Autonomous Studio" },
  apps: { label: "Workloads", subtitle: "Apps & Agents" },
  activity: { label: "Approvals & Audit", subtitle: "Governance" },
  settings: { label: "System & Settings", subtitle: "Configuration" },
};

export function App() {
  const [token, setToken] = useState<string>(() => readStoredToken());
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(() => readStoredPollMs());

  const [bootStatus, setBootStatus] = useState<OnboardingBootStatus | null>(null);
  const [onboardingPayload, setOnboardingPayload] = useState<OnboardingPayload | null>(
    null,
  );
  const [wizardManualOpen, setWizardManualOpen] = useState(false);
  const [activeView, setActiveView] = useState<WorkspaceView>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showChatInspector, setShowChatInspector] = useState(false);
  const [starterPrompt, setStarterPrompt] = useState<string | null>(null);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [inspectedSlug, setInspectedSlug] = useState<string | null>(null);
  const [inspectedTab, setInspectedTab] = useState<"overview" | "logs">("overview");
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<SystemMetricsView | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<TelemetrySampleView[]>([]);
  const [apps, setApps] = useState<AppCardView[]>([]);
  const [plans, setPlans] = useState<ExecutionPlanView[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [busyAppSlug, setBusyAppSlug] = useState<string | null>(null);
  const [planBusyId, setPlanBusyId] = useState<string | null>(null);
  const [executionNotes, setExecutionNotes] = useState<Record<string, string>>({});

  const goChordRef = useRef<number>(0);

  // Sync theme token attribute on <html>
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const handlePollChange = useCallback((ms: number) => {
    setPollIntervalMs(ms);
    localStorage.setItem(POLL_STORAGE_KEY, String(ms));
  }, []);

  const notify = useCallback(
    (title: string, tone: ToastTone = "info", description?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, title, tone, description }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, 4200);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const authHeaders = useCallback((): Record<string, string> => {
    return token ? { authorization: `Bearer ${token}` } : {};
  }, [token]);

  const extractApiError = useCallback(async (response: Response): Promise<string> => {
    try {
      const payload = (await response.json()) as { error?: string };
      return payload.error ?? `API returned ${response.status}`;
    } catch {
      return `API returned ${response.status}`;
    }
  }, []);

  const handleClaimCode = useCallback(
    async (setupCode: string, remember: boolean) => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        const res = await fetch("/api/auth/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ setupCode }),
        });
        if (!res.ok) {
          throw new Error(await extractApiError(res));
        }
        const data = (await res.json()) as { token?: string };
        const sessionToken = data.token ?? "";
        persistToken(sessionToken, remember);
        setToken(sessionToken);
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : "Could not verify setup code.",
        );
      } finally {
        setAuthBusy(false);
      }
    },
    [extractApiError],
  );

  const handleLoginPassphrase = useCallback(
    async (passphrase: string, remember: boolean) => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase }),
        });
        if (!res.ok) {
          throw new Error(await extractApiError(res));
        }
        const data = (await res.json()) as { token?: string };
        const sessionToken = data.token ?? "";
        persistToken(sessionToken, remember);
        setToken(sessionToken);
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "Sign in failed.");
      } finally {
        setAuthBusy(false);
      }
    },
    [extractApiError],
  );

  const handleUnlockToken = useCallback(
    async (candidateToken: string, remember: boolean) => {
      const trimmed = candidateToken.trim();
      if (!trimmed) return;
      setAuthBusy(true);
      setAuthError(null);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: trimmed }),
        });
        if (!res.ok) {
          throw new Error(await extractApiError(res));
        }
        const data = (await res.json()) as { token?: string };
        const sessionToken = data.token ?? trimmed;
        persistToken(sessionToken, remember);
        setToken(sessionToken);
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "Invalid Admin Token.");
      } finally {
        setAuthBusy(false);
      }
    },
    [extractApiError],
  );

  // Consume one-time setup fragment (#claim=... or #setup-token=...) and scrub browser URL.
  useEffect(() => {
    const rawHash = window.location.hash;
    if (!rawHash || rawHash.length < 2) return;
    const params = new URLSearchParams(rawHash.slice(1));
    const claimCode = params.get("claim");
    const setupToken = params.get("setup-token");

    if (claimCode || setupToken) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      if (claimCode) {
        void handleClaimCode(claimCode, false);
      } else if (setupToken) {
        persistToken(setupToken, false);
        setToken(setupToken);
      }
    }
  }, [handleClaimCode]);

  const loadState = useCallback(async () => {
    setRefreshing(true);
    try {
      const statusRes = await fetch("/api/onboarding/status");
      setOffline(false);
      if (!statusRes.ok) {
        setError(`Control API returned ${statusRes.status}.`);
        return;
      }
      const statusJson = (await statusRes.json()) as OnboardingBootStatus;
      setBootStatus(statusJson);

      if (statusJson.authRequired && !token) {
        setOnboardingPayload(null);
        setError(null);
        return;
      }

      const headers = authHeaders();
      const [onboardingRes, metricsRes, historyRes, appsRes, plansRes, auditRes] =
        await Promise.all([
          fetch("/api/onboarding/state", { headers }),
          fetch("/api/system/metrics", { headers }),
          fetch("/api/system/metrics/history?limit=30", { headers }),
          fetch("/api/apps", { headers }),
          fetch("/api/chat/plans?limit=50", { headers }),
          fetch("/api/audit?limit=100", { headers }),
        ]);

      if (
        onboardingRes.status === 401 ||
        metricsRes.status === 401 ||
        appsRes.status === 401 ||
        auditRes.status === 401
      ) {
        persistToken("", false);
        setToken("");
        setOnboardingPayload(null);
        setAuthError(
          "Your session expired or token was invalid. Please sign in again.",
        );
        return;
      }

      const criticalFailure = [onboardingRes, metricsRes, appsRes, auditRes].find(
        (res) => !res.ok,
      );
      if (criticalFailure) {
        setError(`Control API returned ${criticalFailure.status}.`);
      }

      if (onboardingRes.ok) {
        setOnboardingPayload((await onboardingRes.json()) as OnboardingPayload);
      }
      if (metricsRes.ok) {
        const latest = (await metricsRes.json()) as SystemMetricsView;
        setMetrics(latest);
      }
      if (historyRes.ok) {
        const hData = (await historyRes.json()) as {
          samples: TelemetrySampleView[];
        };
        setMetricsHistory(hData.samples ?? []);
      }
      if (appsRes.ok) {
        const data = (await appsRes.json()) as { apps: AppCardView[] };
        setApps(data.apps);
      }
      if (plansRes.ok) {
        const data = (await plansRes.json()) as { plans: ExecutionPlanView[] };
        setPlans(data.plans ?? []);
      }
      if (auditRes.ok) {
        const data = (await auditRes.json()) as { events: AuditEventView[] };
        setAuditEvents(data.events);
      }
      if (!criticalFailure) {
        setError(null);
      }
    } catch {
      setOffline(true);
      setError(
        "Control API unreachable. Start @vps-os/dashboard-api or check your connection.",
      );
    } finally {
      setRefreshing(false);
    }
  }, [authHeaders, token]);

  useEffect(() => {
    void loadState();
    if (pollIntervalMs <= 0) return;
    const intervalId = window.setInterval(() => {
      void loadState();
    }, pollIntervalMs);
    return () => window.clearInterval(intervalId);
  }, [loadState, pollIntervalMs]);

  const isAuthenticated = Boolean(
    bootStatus && (!bootStatus.authRequired || token),
  );
  const showWizard = Boolean(
    isAuthenticated &&
      onboardingPayload &&
      (!onboardingPayload.state.completed || wizardManualOpen),
  );

  // Global keyboard shortcuts (Ctrl/Cmd+K for Command Palette, G+letter nav)
  useEffect(() => {
    if (!isAuthenticated || showWizard) return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }
      const target = event.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inEditable || event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      const now = Date.now();
      if (key === "g") {
        goChordRef.current = now;
        return;
      }
      if (now - goChordRef.current < 800) {
        if (key === "o") setActiveView("overview");
        else if (key === "c") setActiveView("chat");
        else if (key === "w") setActiveView("apps");
        else if (key === "a") setActiveView("activity");
        else if (key === "s") setActiveView("settings");
        goChordRef.current = 0;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAuthenticated, showWizard]);

  function handleLockToken() {
    persistToken("", false);
    setToken("");
    setOnboardingPayload(null);
    setWizardManualOpen(false);
    setMetrics(null);
    setMetricsHistory([]);
    setApps([]);
    setPlans([]);
    setAuditEvents([]);
    setInspectedSlug(null);
    setError(null);
    setAuthError(null);
    notify("Session locked", "info");
  }

  function handleTokenRotated(newToken: string) {
    const keepPersistent = localStorage.getItem(TOKEN_STORAGE_KEY) !== null;
    persistToken(newToken, keepPersistent);
    setToken(newToken);
  }

  const executeLifecycle = useCallback(
    async (slug: string, action: "start" | "stop" | "restart") => {
      setBusyAppSlug(slug);
      setError(null);
      try {
        const response = await fetch(
          `/api/apps/${encodeURIComponent(slug)}/lifecycle`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...authHeaders(),
            },
            body: JSON.stringify({ action }),
          },
        );
        if (!response.ok) {
          throw new Error(await extractApiError(response));
        }
        const data = (await response.json()) as { app: AppCardView };
        notify(
          `${slug} ${action} succeeded`,
          "success",
          `Current status: ${data.app.status}`,
        );
        await loadState();
      } catch (err) {
        notify(
          `Could not ${action} ${slug}`,
          "error",
          err instanceof Error ? err.message : undefined,
        );
      } finally {
        setBusyAppSlug(null);
      }
    },
    [authHeaders, extractApiError, loadState, notify],
  );

  const handleLifecycleRequest = useCallback(
    (slug: string, action: "start" | "stop" | "restart") => {
      if (action === "stop") {
        const target = apps.find((a) => a.slug === slug);
        setConfirmDialog({
          title: `Stop ${target?.name ?? slug}?`,
          description: target?.domain
            ? `Stopping this workload will make https://${target.domain} temporarily unavailable until you start it again.`
            : "This isolated container will stop gracefully. Persistent workspace files and data volumes stay intact.",
          confirmLabel: "Stop Workload",
          tone: "danger",
          onConfirm: async () => {
            setConfirmBusy(true);
            try {
              await executeLifecycle(slug, "stop");
              setConfirmDialog(null);
            } finally {
              setConfirmBusy(false);
            }
          },
        });
        return;
      }
      void executeLifecycle(slug, action);
    },
    [apps, executeLifecycle],
  );

  const handleCreateDeployPlan = useCallback(
    async (goal: string) => {
      try {
        const res = await fetch("/api/chat/plan", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ goal }),
        });
        if (!res.ok) {
          throw new Error(await extractApiError(res));
        }
        await loadState();
        setActiveView("activity");
        notify(
          "Deployment plan created",
          "success",
          "Review the steps in Approvals & Audit before executing.",
        );
      } catch (err) {
        notify(
          "Could not create deployment plan",
          "error",
          err instanceof Error ? err.message : undefined,
        );
      }
    },
    [authHeaders, extractApiError, loadState, notify],
  );

  const handlePlanDecision = useCallback(
    async (planId: string, approved: boolean) => {
      setPlanBusyId(planId);
      try {
        const res = await fetch("/api/chat/approve", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            planId,
            approved,
            decidedBy: onboardingPayload?.state.persona.ownerName || "dashboard-admin",
          }),
        });
        if (!res.ok) {
          throw new Error(await extractApiError(res));
        }
        await loadState();
        notify(
          approved ? "Execution plan approved" : "Execution plan rejected",
          approved ? "success" : "info",
          approved ? "Click Execute Approved Plan to run it safely." : undefined,
        );
      } catch (err) {
        notify(
          "Could not update plan",
          "error",
          err instanceof Error ? err.message : undefined,
        );
      } finally {
        setPlanBusyId(null);
      }
    },
    [authHeaders, extractApiError, loadState, notify, onboardingPayload?.state.persona.ownerName],
  );

  const handleExecutePlan = useCallback(
    async (planId: string) => {
      setPlanBusyId(planId);
      try {
        const res = await fetch("/api/chat/execute", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ planId }),
        });
        if (!res.ok) {
          throw new Error(await extractApiError(res));
        }
        const data = (await res.json()) as {
          execution: { summary: string };
        };
        setExecutionNotes((prev) => ({ ...prev, [planId]: data.execution.summary }));
        await loadState();
        notify("Execution plan completed", "success", data.execution.summary);
      } catch (err) {
        notify(
          "Plan execution failed",
          "error",
          err instanceof Error ? err.message : undefined,
        );
      } finally {
        setPlanBusyId(null);
      }
    },
    [authHeaders, extractApiError, loadState, notify],
  );

  function handleQuickAskCto(prompt: string) {
    setStarterPrompt(prompt);
    setActiveView("chat");
  }

  function handleInspectApp(app: AppCardView, tab: "overview" | "logs" = "overview") {
    setInspectedSlug(app.slug);
    setInspectedTab(tab);
  }

  const inspectedApp = inspectedSlug
    ? apps.find((a) => a.slug === inspectedSlug) ?? null
    : null;
  const pendingPlansCount = plans.filter((p) => p.status === "pending").length;
  const runningAppsCount = apps.filter((a) => a.status === "running").length;

  const navItems: Array<{
    id: WorkspaceView;
    label: string;
    icon: "overview" | "chat" | "apps" | "activity" | "settings";
    badge?: string | number | undefined;
    badgeTone?: "default" | "warning" | undefined;
  }> = [
    { id: "overview", label: "Overview", icon: "overview" },
    { id: "chat", label: "CTO Agent", icon: "chat" },
    {
      id: "apps",
      label: "Workloads",
      icon: "apps",
      badge: `${runningAppsCount}/${apps.length}`,
    },
    {
      id: "activity",
      label: "Approvals & Audit",
      icon: "activity",
      badge: pendingPlansCount > 0 ? pendingPlansCount : undefined,
      badgeTone: pendingPlansCount > 0 ? "warning" : "default",
    },
    { id: "settings", label: "System & Settings", icon: "settings" },
  ];

  function renderNavIcon(kind: (typeof navItems)[number]["icon"]) {
    const cls = "h-4 w-4 shrink-0";
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
    }
  }

  const renderSidebarContent = () => (
    <div className="flex h-full flex-col">
      {/* Brand Header */}
      <div className="flex h-14 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4">
        <button
          type="button"
          onClick={() => {
            setActiveView("overview");
            setWizardManualOpen(false);
            setMobileNavOpen(false);
          }}
          className="flex items-center gap-2.5 text-left"
        >
          <VpsOsLogo className="h-8 w-8 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-none tracking-tight text-[var(--text-primary)]">
              VPS OS
            </p>
            <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
              Personal Cloud OS
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] lg:hidden"
          aria-label="Close navigation menu"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Primary Navigation */}
      <nav aria-label="Primary navigation" className="flex-1 space-y-1 p-3">
        <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Control Plane
        </p>
        {navItems.map((item) => {
          const active = !showWizard && activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setWizardManualOpen(false);
                setActiveView(item.id);
                setMobileNavOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium transition ${
                active
                  ? "bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_0_0_1px_var(--accent-border)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              }`}
            >
              <span className="flex items-center gap-2.5 truncate">
                {renderNavIcon(item.icon)}
                <span className="truncate">{item.label}</span>
              </span>
              {item.badge !== undefined && (
                <span
                  className={`tabular-nums rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                    item.badgeTone === "warning"
                      ? "bg-amber-500/20 text-[var(--warning)]"
                      : "bg-[var(--bg-inset)] text-[var(--text-muted)]"
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Pinned Compact Host Status Card */}
      <div className="border-t border-[var(--border-subtle)] p-3">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-primary)]">
              <ServerIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
              <span className="truncate">{metrics?.hostname ?? "Awaiting host"}</span>
            </span>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                offline ? "bg-[var(--danger)]" : "bg-[var(--success)] animate-pulse-dot"
              }`}
              title={offline ? "Control API offline" : "Control API connected"}
            />
          </div>
          {metrics && (
            <div className="mt-2.5 space-y-2">
              <div>
                <div className="flex justify-between text-[10.5px] text-[var(--text-muted)]">
                  <span>RAM</span>
                  <span className="tabular-nums font-mono">{metrics.memoryUsagePercent}%</span>
                </div>
                <div className="mt-1">
                  <CapacityBar percent={metrics.memoryUsagePercent} tone="violet" heightClass="h-1" />
                </div>
              </div>
              {metrics.disk && (
                <div>
                  <div className="flex justify-between text-[10.5px] text-[var(--text-muted)]">
                    <span>Disk</span>
                    <span className="tabular-nums font-mono">{metrics.disk.usagePercent}%</span>
                  </div>
                  <div className="mt-1">
                    <CapacityBar percent={metrics.disk.usagePercent} tone="success" heightClass="h-1" />
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between pt-0.5 text-[10px] text-[var(--text-muted)]">
                <span>Uptime {formatUptime(metrics.uptimeSeconds)}</span>
                <span className="truncate">
                  {providerDisplayName(onboardingPayload?.state.llmProvider)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Unauthenticated or First-Boot Minimal Header Shell
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        <header className="flex h-14 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <VpsOsLogo className="h-7 w-7" />
            <span className="text-sm font-semibold tracking-tight">VPS OS</span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                offline
                  ? "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
                  : "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  offline ? "bg-[var(--danger)]" : "bg-[var(--success)]"
                }`}
              />
              {offline ? "Offline" : "Connected"}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
            className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs"
            aria-label="Toggle appearance theme"
          >
            {theme === "dark" ? (
              <SunIcon className="h-3.5 w-3.5" />
            ) : (
              <MoonIcon className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">
              {theme === "dark" ? "Light" : "Dark"}
            </span>
          </button>
        </header>

        {bootStatus ? (
          <AuthGate
            bootStatus={bootStatus}
            error={authError}
            busy={authBusy}
            onClaimCode={handleClaimCode}
            onLoginPassphrase={handleLoginPassphrase}
            onUnlockToken={handleUnlockToken}
          />
        ) : (
          <div className="flex min-h-[70vh] items-center justify-center p-6 text-xs text-[var(--text-muted)]">
            {error ?? "Connecting to VPS OS Control API..."}
          </div>
        )}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Desktop Persistent Sidebar Rail */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-rail)] lg:block">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Slide-Over Navigation Drawer */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-50 flex bg-[var(--bg-backdrop)] backdrop-blur-xs lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        >
          <aside
            className="h-full w-64 border-r border-[var(--border-default)] bg-[var(--bg-rail)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {renderSidebarContent()}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Contextual Top Bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] lg:hidden"
              aria-label="Open navigation menu"
            >
              <MenuIcon className="h-4.5 w-4.5" />
            </button>

            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                {showWizard ? "Setup Wizard" : VIEW_META[activeView].label}
              </span>
              <span className="hidden text-xs text-[var(--text-muted)] sm:inline">
                / {showWizard ? "Onboarding" : VIEW_META[activeView].subtitle}
              </span>
            </div>
          </div>

          {/* Center Command Palette Trigger */}
          {!showWizard && (
            <button
              type="button"
              onClick={() => setCommandPaletteOpen(true)}
              className="hidden max-w-xs flex-1 items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 text-xs text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)] md:flex"
            >
              <span className="inline-flex items-center gap-2 truncate">
                <CommandIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Search commands, apps, actions...</span>
              </span>
              <kbd className="vps-kbd">Ctrl K</kbd>
            </button>
          )}

          {/* Right Global Controls */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                offline
                  ? "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
                  : "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  offline ? "bg-[var(--danger)]" : "bg-[var(--success)] animate-pulse-dot"
                }`}
              />
              <span className="hidden sm:inline">{offline ? "Offline" : "Live"}</span>
            </span>

            <button
              type="button"
              onClick={() => void loadState()}
              disabled={refreshing}
              className="vps-btn-secondary inline-flex h-8 w-8 items-center justify-center rounded-lg"
              title="Refresh telemetry and workloads"
              aria-label="Refresh dashboard"
            >
              <RefreshIcon
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin text-[var(--accent)]" : ""}`}
              />
            </button>

            <button
              type="button"
              onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
              className="vps-btn-secondary inline-flex h-8 w-8 items-center justify-center rounded-lg"
              title={`Switch to ${theme === "dark" ? "Light" : "Dark"} mode`}
              aria-label="Toggle color theme"
            >
              {theme === "dark" ? (
                <SunIcon className="h-3.5 w-3.5" />
              ) : (
                <MoonIcon className="h-3.5 w-3.5" />
              )}
            </button>

            {token && (
              <button
                type="button"
                onClick={handleLockToken}
                className="vps-btn-secondary inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--text-secondary)]"
                title="Lock dashboard session"
              >
                <LockIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Lock</span>
              </button>
            )}
          </div>
        </header>

        {/* Global Offline / API Error Alert Bar */}
        {(offline || error) && !showWizard && activeView !== "chat" && (
          <div className="border-b border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-2.5 sm:px-6">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 text-xs text-[var(--danger)]">
              <span>{error ?? "Control API unreachable. Telemetry may be stale."}</span>
              <button
                type="button"
                onClick={() => void loadState()}
                className="rounded-lg bg-rose-600 px-3 py-1 font-medium text-white hover:bg-rose-500"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Active Workspace View */}
        <main className={`vps-aura min-w-0 flex-1 ${activeView === "chat" && !showWizard ? "overflow-hidden" : ""}`}>
          {showWizard && onboardingPayload ? (
            <OnboardingWizard
              payload={onboardingPayload}
              authHeaders={authHeaders}
              onTokenRotated={handleTokenRotated}
              onRefreshState={loadState}
              onComplete={(prompt) => {
                setWizardManualOpen(false);
                if (prompt) {
                  setStarterPrompt(prompt);
                  setActiveView("chat");
                } else {
                  setActiveView("overview");
                }
                notify("Setup saved", "success", "Your VPS OS workspace is ready.");
              }}
              onCancel={
                onboardingPayload.state.completed
                  ? () => setWizardManualOpen(false)
                  : undefined
              }
            />
          ) : activeView === "overview" ? (
            <OverviewView
              metrics={metrics}
              history={metricsHistory}
              apps={apps}
              plans={plans}
              auditEvents={auditEvents}
              onboardingPayload={onboardingPayload}
              offline={offline}
              onNavigate={setActiveView}
              onQuickAskCto={handleQuickAskCto}
              onInspectApp={handleInspectApp}
              onOpenDeployModal={() => {
                setActiveView("apps");
                setDeployModalOpen(true);
              }}
              onOpenSetupWizard={() => setWizardManualOpen(true)}
            />
          ) : activeView === "chat" ? (
            <AgentChat
              authHeaders={authHeaders}
              onboardingPayload={onboardingPayload}
              metrics={metrics}
              apps={apps}
              auditEvents={auditEvents}
              busyAppSlug={busyAppSlug}
              initialPrompt={starterPrompt}
              onConsumeInitialPrompt={() => setStarterPrompt(null)}
              onOpenSetupWizard={() => setWizardManualOpen(true)}
              onRefreshDashboard={loadState}
              onLifecycle={handleLifecycleRequest}
              onInspectApp={handleInspectApp}
              onNavigate={setActiveView}
              showInspector={showChatInspector}
              onToggleInspector={() => setShowChatInspector((prev) => !prev)}
              onNotify={notify}
            />
          ) : activeView === "apps" ? (
            <WorkloadsView
              apps={apps}
              totalHostMemoryMb={metrics?.memoryTotalMb ?? 4096}
              totalHostCpus={metrics?.cpuCount ?? 2}
              busyAppSlug={busyAppSlug}
              deployModalOpen={deployModalOpen}
              onOpenDeployModal={() => setDeployModalOpen(true)}
              onCloseDeployModal={() => setDeployModalOpen(false)}
              onLifecycle={handleLifecycleRequest}
              onInspectApp={handleInspectApp}
              onCreateDeployPlan={handleCreateDeployPlan}
              onAskCto={handleQuickAskCto}
              onNotify={notify}
            />
          ) : activeView === "activity" ? (
            <ActivityView
              plans={plans}
              auditEvents={auditEvents}
              planBusyId={planBusyId}
              executionNotes={executionNotes}
              onApprovePlan={(id) => void handlePlanDecision(id, true)}
              onRejectPlan={(id) => void handlePlanDecision(id, false)}
              onExecutePlan={(id) => void handleExecutePlan(id)}
              onNotify={notify}
            />
          ) : (
            <SettingsView
              onboardingPayload={onboardingPayload}
              theme={theme}
              pollIntervalMs={pollIntervalMs}
              canLock={Boolean(token)}
              authHeaders={authHeaders}
              onChangeTheme={setTheme}
              onChangePollInterval={handlePollChange}
              onOpenSetupWizard={() => setWizardManualOpen(true)}
              onRefreshState={loadState}
              onLock={handleLockToken}
              onNotify={notify}
            />
          )}
        </main>
      </div>

      {/* Global Slide-Over Workload Inspector & Log Viewer */}
      <WorkloadDrawer
        app={inspectedApp}
        initialTab={inspectedTab}
        totalHostMemoryMb={metrics?.memoryTotalMb ?? 4096}
        totalHostCpus={metrics?.cpuCount ?? 2}
        busy={Boolean(inspectedApp && busyAppSlug === inspectedApp.slug)}
        authHeaders={authHeaders}
        onClose={() => setInspectedSlug(null)}
        onLifecycle={handleLifecycleRequest}
        onAskCto={handleQuickAskCto}
        onNotify={notify}
      />

      {/* Global Command Palette (Ctrl+K / Cmd+K) */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        apps={apps}
        theme={theme}
        pendingPlansCount={pendingPlansCount}
        canLock={Boolean(token)}
        onNavigate={(view) => {
          setWizardManualOpen(false);
          setActiveView(view);
        }}
        onInspectApp={(app) => handleInspectApp(app, "overview")}
        onOpenDeployModal={() => {
          setWizardManualOpen(false);
          setActiveView("apps");
          setDeployModalOpen(true);
        }}
        onToggleTheme={() =>
          setTheme((prev) => (prev === "dark" ? "light" : "dark"))
        }
        onRefresh={() => void loadState()}
        onOpenSetupWizard={() => setWizardManualOpen(true)}
        onLock={handleLockToken}
      />

      {/* Safe Confirmation Dialog for Risky Actions */}
      <ConfirmDialog
        dialog={confirmDialog}
        busy={confirmBusy}
        onClose={() => setConfirmDialog(null)}
      />

      {/* Toast Notification Stack */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
