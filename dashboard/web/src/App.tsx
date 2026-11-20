import { useCallback, useEffect, useState } from "react";
import { AgentChat } from "./components/AgentChat";
import { AuthGate } from "./components/AuthGate";
import {
  MessageSquareIcon,
  ServerIcon,
  SlidersIcon,
  SparklesIcon,
} from "./components/Icons";
import { OnboardingWizard } from "./components/OnboardingWizard";
import type {
  AppCardView,
  AuditEventView,
  OnboardingBootStatus,
  OnboardingPayload,
  SystemMetricsView,
} from "./types";

const TOKEN_STORAGE_KEY = "vps_os_admin_token";

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

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function providerBadgeLabel(provider: string | null | undefined): string {
  switch (provider) {
    case "opencode":
      return "OpenCode";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "openrouter":
      return "OpenRouter";
    case "nous":
      return "Nous";
    case "ollama":
      return "Ollama";
    default:
      return provider || "CTO";
  }
}

export function App() {
  const [token, setToken] = useState<string>(() => readStoredToken());
  const [bootStatus, setBootStatus] = useState<OnboardingBootStatus | null>(null);
  const [onboardingPayload, setOnboardingPayload] = useState<OnboardingPayload | null>(
    null,
  );
  const [wizardManualOpen, setWizardManualOpen] = useState(false);
  const [activeView, setActiveView] = useState<"chat" | "server">("chat");
  const [showInspector, setShowInspector] = useState(true);
  const [starterPrompt, setStarterPrompt] = useState<string | null>(null);

  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<SystemMetricsView | null>(null);
  const [apps, setApps] = useState<AppCardView[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAppSlug, setBusyAppSlug] = useState<string | null>(null);
  const [appMessage, setAppMessage] = useState<string | null>(null);
  const [logsView, setLogsView] = useState<{
    slug: string;
    lines: string[];
  } | null>(null);

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
      const [onboardingRes, metricsRes, appsRes, auditRes] = await Promise.all([
        fetch("/api/onboarding/state", { headers }),
        fetch("/api/system/metrics", { headers }),
        fetch("/api/apps", { headers }),
        fetch("/api/audit?limit=15", { headers }),
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
        setAuthError("Your session expired or token was invalid. Please sign in again.");
        return;
      }

      const firstFailure = [onboardingRes, metricsRes, appsRes, auditRes].find(
        (res) => !res.ok,
      );
      if (firstFailure) {
        setError(`Control API returned ${firstFailure.status}.`);
      }

      if (onboardingRes.ok) {
        setOnboardingPayload((await onboardingRes.json()) as OnboardingPayload);
      }
      if (metricsRes.ok) {
        setMetrics((await metricsRes.json()) as SystemMetricsView);
      }
      if (appsRes.ok) {
        const data = (await appsRes.json()) as { apps: AppCardView[] };
        setApps(data.apps);
      }
      if (auditRes.ok) {
        const data = (await auditRes.json()) as { events: AuditEventView[] };
        setAuditEvents(data.events);
      }
      if (!firstFailure) {
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
    const intervalId = window.setInterval(() => {
      void loadState();
    }, 15_000);
    return () => window.clearInterval(intervalId);
  }, [loadState]);

  function handleLockToken() {
    persistToken("", false);
    setToken("");
    setOnboardingPayload(null);
    setWizardManualOpen(false);
    setMetrics(null);
    setApps([]);
    setAuditEvents([]);
    setAppMessage(null);
    setLogsView(null);
    setError(null);
    setAuthError(null);
  }

  function handleTokenRotated(newToken: string) {
    const keepPersistent = localStorage.getItem(TOKEN_STORAGE_KEY) !== null;
    persistToken(newToken, keepPersistent);
    setToken(newToken);
  }

  async function handleLifecycle(
    slug: string,
    action: "start" | "stop" | "restart",
  ) {
    setBusyAppSlug(slug);
    setAppMessage(null);
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
      setAppMessage(`${slug}: ${action} -> ${data.app.status}`);
      void loadState();
    } catch (err) {
      setAppMessage(
        err instanceof Error ? err.message : `Could not ${action} ${slug}.`,
      );
    } finally {
      setBusyAppSlug(null);
    }
  }

  async function handleViewLogs(slug: string) {
    setBusyAppSlug(slug);
    setAppMessage(null);
    try {
      const response = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/logs?tail=50`,
        { headers: authHeaders() },
      );
      if (!response.ok) {
        throw new Error(await extractApiError(response));
      }
      const data = (await response.json()) as { slug: string; lines: string[] };
      setLogsView(data);
    } catch (err) {
      setAppMessage(
        err instanceof Error ? err.message : `Could not load logs for ${slug}.`,
      );
    } finally {
      setBusyAppSlug(null);
    }
  }

  const isAuthenticated = Boolean(
    bootStatus && (!bootStatus.authRequired || token),
  );
  const showWizard = Boolean(
    isAuthenticated &&
      onboardingPayload &&
      (!onboardingPayload.state.completed || wizardManualOpen),
  );

  return (
    <div className="min-h-screen bg-[#090a0e] text-slate-100">
      {/* Compact T3-Style Top Command Bar */}
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#0d0f15]/95 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300">
                <SparklesIcon className="h-4 w-4" />
              </span>
              <span className="text-sm font-semibold tracking-tight text-slate-100">
                VPS OS
              </span>
            </div>

            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                offline
                  ? "bg-rose-500/15 text-rose-300"
                  : "bg-emerald-500/15 text-emerald-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  offline ? "bg-rose-400" : "bg-emerald-400"
                }`}
              />
              {offline ? "Offline" : "Connected"}
            </span>

            {isAuthenticated && !showWizard && (
              <nav
                aria-label="Workspace views"
                className="ml-1 inline-flex rounded-lg border border-white/[0.08] bg-black/30 p-0.5 text-xs"
              >
                <button
                  type="button"
                  onClick={() => setActiveView("chat")}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition ${
                    activeView === "chat"
                      ? "bg-white/[0.1] text-slate-100"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <MessageSquareIcon className="h-3.5 w-3.5" />
                  Agent Chat
                </button>
                <button
                  type="button"
                  onClick={() => setActiveView("server")}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition ${
                    activeView === "server"
                      ? "bg-white/[0.1] text-slate-100"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <ServerIcon className="h-3.5 w-3.5" />
                  Server &amp; Apps
                  <span className="rounded bg-white/[0.08] px-1.5 py-0.2 font-mono text-[10px] text-slate-300">
                    {apps.length}
                  </span>
                </button>
              </nav>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onboardingPayload?.state.llmConfigured && (
              <button
                type="button"
                onClick={() => setWizardManualOpen(true)}
                className="hidden items-center gap-1.5 rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-200 transition hover:bg-sky-500/15 sm:inline-flex"
              >
                <SlidersIcon className="h-3 w-3" />
                {providerBadgeLabel(onboardingPayload.state.llmProvider)}
                {onboardingPayload.state.llmModel
                  ? ` · ${onboardingPayload.state.llmModel}`
                  : ""}
              </button>
            )}
            <button
              type="button"
              onClick={() => void loadState()}
              disabled={refreshing}
              className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:bg-white/[0.07] disabled:opacity-50"
            >
              {refreshing ? "Syncing..." : "Refresh"}
            </button>
            {isAuthenticated && onboardingPayload && (
              <button
                type="button"
                onClick={() => setWizardManualOpen((prev) => !prev)}
                className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-sky-300 transition hover:bg-white/[0.07]"
              >
                {showWizard && onboardingPayload.state.completed
                  ? "Back to Workspace"
                  : "Setup"}
              </button>
            )}
            {token && (
              <button
                type="button"
                onClick={handleLockToken}
                className="rounded-lg border border-white/[0.08] bg-transparent px-2.5 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/[0.05] hover:text-slate-200"
              >
                Lock
              </button>
            )}
          </div>
        </div>
      </header>

      {bootStatus && !isAuthenticated && (
        <AuthGate
          bootStatus={bootStatus}
          error={authError}
          busy={authBusy}
          onClaimCode={handleClaimCode}
          onLoginPassphrase={handleLoginPassphrase}
          onUnlockToken={handleUnlockToken}
        />
      )}

      {showWizard && onboardingPayload && (
        <OnboardingWizard
          payload={onboardingPayload}
          authHeaders={authHeaders}
          onTokenRotated={handleTokenRotated}
          onRefreshState={loadState}
          onComplete={(prompt) => {
            setWizardManualOpen(false);
            setActiveView("chat");
            if (prompt) {
              setStarterPrompt(prompt);
            }
          }}
          onCancel={
            onboardingPayload.state.completed
              ? () => setWizardManualOpen(false)
              : undefined
          }
        />
      )}

      {/* Primary Workspace: Agentic Chat + Collapsible Live Server Inspector */}
      {isAuthenticated && !showWizard && activeView === "chat" && (
        <div className="flex min-w-0">
          <div className="min-w-0 flex-1">
            <AgentChat
              authHeaders={authHeaders}
              onboardingPayload={onboardingPayload}
              metrics={metrics}
              apps={apps}
              initialPrompt={starterPrompt}
              onConsumeInitialPrompt={() => setStarterPrompt(null)}
              onOpenSetupWizard={() => setWizardManualOpen(true)}
              onRefreshDashboard={loadState}
              showInspector={showInspector}
              onToggleInspector={() => setShowInspector((prev) => !prev)}
            />
          </div>

          {showInspector && (
            <aside className="hidden h-[calc(100vh-53px)] w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/[0.07] bg-[#0d0f15] p-4 lg:flex">
              {offline && (
                <div
                  role="alert"
                  className="rounded-xl border border-rose-500/35 bg-rose-950/35 px-3 py-2 text-xs text-rose-200"
                >
                  Control API unreachable. Telemetry may be stale.
                </div>
              )}

              {/* Compact Telemetry Card */}
              <div className="rounded-xl border border-white/[0.07] bg-[#12151d] p-3.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Server Telemetry
                  </h3>
                  <span className="font-mono text-[10.5px] text-slate-500">
                    {metrics ? formatUptime(metrics.uptimeSeconds) : "—"}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm font-medium text-slate-100">
                  {metrics?.hostname ?? "Awaiting host"}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-white/[0.06] bg-black/25 p-2">
                    <span className="text-[10px] text-slate-500">CPU / Load</span>
                    <p className="mt-0.5 font-mono text-xs text-slate-200">
                      {metrics
                        ? `${metrics.cpuCount}c · ${metrics.loadAverage1m}`
                        : "—"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-white/[0.06] bg-black/25 p-2">
                    <span className="text-[10px] text-slate-500">Memory</span>
                    <p className="mt-0.5 font-mono text-xs text-slate-200">
                      {metrics ? `${metrics.memoryUsagePercent}%` : "—"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Live Installed Apps */}
              <div className="rounded-xl border border-white/[0.07] bg-[#12151d] p-3.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Workloads ({apps.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => setActiveView("server")}
                    className="text-[11px] text-sky-400 hover:text-sky-300"
                  >
                    Manage all
                  </button>
                </div>

                {appMessage && (
                  <p className="mt-2 rounded-lg bg-black/40 px-2.5 py-1.5 text-[11px] text-sky-300">
                    {appMessage}
                  </p>
                )}

                {apps.length === 0 ? (
                  <p className="mt-2.5 text-xs leading-relaxed text-slate-500">
                    No isolated workloads yet. Ask the CTO Agent to deploy an app or
                    personal agent.
                  </p>
                ) : (
                  <div className="mt-2.5 space-y-2">
                    {apps.map((app) => (
                      <div
                        key={app.slug}
                        className="rounded-lg border border-white/[0.06] bg-black/25 p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-slate-100">
                            {app.name}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] ${
                              app.status === "running"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : app.status === "error"
                                  ? "bg-rose-500/15 text-rose-300"
                                  : "bg-white/[0.07] text-slate-300"
                            }`}
                          >
                            {app.status}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[10.5px] text-slate-500">
                          {app.domain ?? "internal network"}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(["start", "stop", "restart"] as const).map((action) => (
                            <button
                              key={action}
                              type="button"
                              disabled={busyAppSlug === app.slug}
                              onClick={() => void handleLifecycle(app.slug, action)}
                              className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] capitalize text-slate-300 hover:bg-white/[0.08] disabled:opacity-50"
                            >
                              {action}
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={busyAppSlug === app.slug}
                            onClick={() => void handleViewLogs(app.slug)}
                            className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-sky-300 hover:bg-white/[0.08] disabled:opacity-50"
                          >
                            Logs
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {logsView && (
                  <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/50 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10.5px] text-slate-300">
                        {logsView.slug} logs
                      </span>
                      <button
                        type="button"
                        onClick={() => setLogsView(null)}
                        className="text-[10.5px] text-slate-400 hover:text-slate-200"
                      >
                        Close
                      </button>
                    </div>
                    <pre className="mt-1.5 max-h-36 overflow-auto font-mono text-[10.5px] text-slate-300">
                      {logsView.lines.length > 0
                        ? logsView.lines.join("\n")
                        : "(no log lines)"}
                    </pre>
                  </div>
                )}
              </div>

              {/* Recent Audit Mini-Feed */}
              <div className="rounded-xl border border-white/[0.07] bg-[#12151d] p-3.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Recent Audit
                </h3>
                {auditEvents.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">No events yet.</p>
                ) : (
                  <ul className="mt-2.5 space-y-2">
                    {auditEvents.slice(0, 6).map((evt) => (
                      <li
                        key={evt.id}
                        className="rounded-lg border border-white/[0.05] bg-black/25 px-2.5 py-1.5 text-[11px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-slate-200">
                            {evt.action}
                          </span>
                          <span className="shrink-0 text-[10px] text-slate-500">
                            {new Date(evt.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[10.5px] text-slate-400">
                          {evt.summary}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      {/* Full Server & Apps Operations View */}
      {isAuthenticated && !showWizard && activeView === "server" && (
        <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
          {(offline || error) && (
            <div
              role="alert"
              className="flex items-center justify-between rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200"
            >
              <span>
                {error ?? "Control API is unreachable. Telemetry may be stale."}
              </span>
              <button
                type="button"
                onClick={() => void loadState()}
                className="rounded bg-rose-800/60 px-2.5 py-1 font-medium hover:bg-rose-700/60"
              >
                Retry
              </button>
            </div>
          )}

          {onboardingPayload && !onboardingPayload.state.llmConfigured && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
              <span>
                AI CTO provider is not connected yet. Connect OpenCode, OpenAI,
                Claude, or Ollama in Setup Wizard.
              </span>
              <button
                type="button"
                onClick={() => setWizardManualOpen(true)}
                className="rounded-lg bg-amber-600/80 px-3 py-1 font-medium text-white hover:bg-amber-500"
              >
                Open Setup Wizard
              </button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-white/[0.08] bg-[#12151d] p-4">
              <p className="text-xs text-slate-400">Host</p>
              <p className="mt-1 truncate text-base font-medium">
                {metrics?.hostname ?? "—"}
              </p>
              <p className="text-xs text-slate-500">
                {metrics
                  ? `${metrics.cpuCount} vCPU · load ${metrics.loadAverage1m}`
                  : "Awaiting telemetry"}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-[#12151d] p-4">
              <p className="text-xs text-slate-400">Memory</p>
              <p className="mt-1 text-base font-medium">
                {metrics
                  ? `${metrics.memoryUsedMb} / ${metrics.memoryTotalMb} MB`
                  : "—"}
              </p>
              <p className="text-xs text-slate-500">
                {metrics ? `${metrics.memoryUsagePercent}% used` : "Idle"}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-[#12151d] p-4">
              <p className="text-xs text-slate-400">Disk</p>
              <p className="mt-1 text-base font-medium">
                {metrics?.disk
                  ? `${Math.round(metrics.disk.usedMb / 1024)} / ${Math.round(metrics.disk.totalMb / 1024)} GB`
                  : "—"}
              </p>
              <p className="text-xs text-slate-500">
                {metrics?.disk ? `${metrics.disk.usagePercent}% used` : "Unavailable"}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-[#12151d] p-4">
              <p className="text-xs text-slate-400">Uptime &amp; Apps</p>
              <p className="mt-1 text-base font-medium">
                {metrics ? formatUptime(metrics.uptimeSeconds) : "—"}
              </p>
              <p className="text-xs text-slate-500">
                {apps.length} isolated workloads
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#12151d] p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-200">
                Installed Apps &amp; Personal Agents
              </h2>
              {metrics?.collectedAt && (
                <span className="text-[11px] text-slate-500">
                  Updated {new Date(metrics.collectedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            {appMessage && (
              <p className="mt-2 rounded bg-black/40 px-3 py-1.5 text-xs text-sky-300">
                {appMessage}
              </p>
            )}
            {apps.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">
                No workloads provisioned yet. Switch to Agent Chat to deploy an
                isolated web app or personal agent container.
              </p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {apps.map((app) => (
                  <div
                    key={app.slug}
                    className="rounded-lg border border-white/[0.07] bg-black/25 p-4"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-100">{app.name}</span>
                      <span className="rounded bg-white/[0.08] px-2 py-0.5 text-xs text-slate-300">
                        {app.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      {app.kind} · {app.domain ?? "internal only"}
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                      Limits: {app.cpuLimit} CPU / {app.memoryLimitMb} MB RAM
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {(["start", "stop", "restart"] as const).map((action) => (
                        <button
                          key={action}
                          type="button"
                          disabled={busyAppSlug === app.slug}
                          onClick={() => void handleLifecycle(app.slug, action)}
                          className="rounded border border-white/[0.1] bg-white/[0.03] px-2 py-1 text-[11px] capitalize text-slate-300 hover:bg-white/[0.08] disabled:opacity-50"
                        >
                          {action}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={busyAppSlug === app.slug}
                        onClick={() => void handleViewLogs(app.slug)}
                        className="rounded border border-white/[0.1] bg-white/[0.03] px-2 py-1 text-[11px] text-sky-300 hover:bg-white/[0.08] disabled:opacity-50"
                      >
                        Logs
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {logsView && (
              <div className="mt-4 rounded-lg border border-white/[0.08] bg-black/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">
                    Logs: {logsView.slug}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLogsView(null)}
                    className="text-xs text-slate-400 hover:text-slate-200"
                  >
                    Close
                  </button>
                </div>
                <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] text-slate-300">
                  {logsView.lines.length > 0
                    ? logsView.lines.join("\n")
                    : "(no log lines)"}
                </pre>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-[#12151d] p-5">
            <h2 className="text-sm font-semibold text-slate-200">
              Recent Audit Trail
            </h2>
            {auditEvents.length === 0 ? (
              <p className="mt-3 text-xs text-slate-400">
                No audit events recorded yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {auditEvents.map((evt) => (
                  <li
                    key={evt.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium text-slate-200">
                          {evt.action}
                        </span>
                        {evt.targetSlug && (
                          <span className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                            {evt.targetSlug}
                          </span>
                        )}
                        <span className="text-[10px] uppercase text-slate-500">
                          {evt.riskLevel}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">
                        {evt.summary}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-slate-500">
                      {new Date(evt.createdAt).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
