import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AuthGate } from "./components/AuthGate";
import { OnboardingWizard } from "./components/OnboardingWizard";
import type {
  AppCardView,
  AuditEventView,
  ExecutionPlanView,
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

export function App() {
  const [token, setToken] = useState<string>(() => readStoredToken());
  const [bootStatus, setBootStatus] = useState<OnboardingBootStatus | null>(null);
  const [onboardingPayload, setOnboardingPayload] = useState<OnboardingPayload | null>(
    null,
  );
  const [wizardManualOpen, setWizardManualOpen] = useState(false);

  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<SystemMetricsView | null>(null);
  const [apps, setApps] = useState<AppCardView[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventView[]>([]);
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState<ExecutionPlanView | null>(null);
  const [executionNote, setExecutionNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState(false);
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
      const [onboardingRes, metricsRes, appsRes, auditRes, plansRes] =
        await Promise.all([
          fetch("/api/onboarding/state", { headers }),
          fetch("/api/system/metrics", { headers }),
          fetch("/api/apps", { headers }),
          fetch("/api/audit?limit=15", { headers }),
          fetch("/api/chat/plans?limit=5", { headers }),
        ]);

      if (
        onboardingRes.status === 401 ||
        metricsRes.status === 401 ||
        appsRes.status === 401 ||
        auditRes.status === 401 ||
        plansRes.status === 401
      ) {
        persistToken("", false);
        setToken("");
        setOnboardingPayload(null);
        setAuthError("Your session expired or token was invalid. Please sign in again.");
        return;
      }

      const firstFailure = [
        onboardingRes,
        metricsRes,
        appsRes,
        auditRes,
        plansRes,
      ].find((res) => !res.ok);
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
      if (plansRes.ok) {
        const data = (await plansRes.json()) as { plans: ExecutionPlanView[] };
        const activePlan = data.plans.find(
          (candidate) =>
            candidate.status === "pending" || candidate.status === "approved",
        );
        if (activePlan) {
          setPlan((current) => current ?? activePlan);
        }
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
    setPlan(null);
    setAppMessage(null);
    setExecutionNote(null);
    setLogsView(null);
    setError(null);
    setAuthError(null);
  }

  function handleTokenRotated(newToken: string) {
    const keepPersistent = localStorage.getItem(TOKEN_STORAGE_KEY) !== null;
    persistToken(newToken, keepPersistent);
    setToken(newToken);
  }

  async function handlePlanSubmit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim()) return;
    setLoadingPlan(true);
    setExecutionNote(null);
    setError(null);
    try {
      const response = await fetch("/api/chat/plan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ goal }),
      });
      if (!response.ok) {
        throw new Error(await extractApiError(response));
      }
      const data = (await response.json()) as { plan: ExecutionPlanView };
      setPlan(data.plan);
      void loadState();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not reach Control API.",
      );
    } finally {
      setLoadingPlan(false);
    }
  }

  async function handleDecision(approved: boolean) {
    if (!plan || submittingDecision) return;
    setSubmittingDecision(true);
    setError(null);
    try {
      const response = await fetch("/api/chat/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          planId: plan.id,
          approved,
          decidedBy: "dashboard-admin",
        }),
      });
      if (!response.ok) {
        throw new Error(await extractApiError(response));
      }
      const data = (await response.json()) as { plan: ExecutionPlanView };
      setPlan(data.plan);
      void loadState();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not submit decision.",
      );
    } finally {
      setSubmittingDecision(false);
    }
  }

  async function handleExecutePlan() {
    if (!plan || submittingDecision) return;
    setSubmittingDecision(true);
    setError(null);
    setExecutionNote(null);
    try {
      const response = await fetch("/api/chat/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ planId: plan.id }),
      });
      if (!response.ok) {
        throw new Error(await extractApiError(response));
      }
      const data = (await response.json()) as {
        plan: ExecutionPlanView;
        execution: { summary: string };
      };
      setPlan(data.plan);
      setExecutionNote(data.execution.summary);
      void loadState();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not execute plan.",
      );
    } finally {
      setSubmittingDecision(false);
    }
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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">VPS OS</h1>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  offline
                    ? "bg-rose-500/15 text-rose-300"
                    : "bg-emerald-500/15 text-emerald-300"
                }`}
              >
                {offline ? "API Offline" : "Connected"}
              </span>
              {onboardingPayload?.state.llmConfigured && (
                <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-300">
                  CTO: {onboardingPayload.state.llmProvider}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Plug-and-Play Server Control &amp; Autonomous CTO
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadState()}
              disabled={refreshing}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            {isAuthenticated && onboardingPayload && (
              <button
                type="button"
                onClick={() => setWizardManualOpen((prev) => !prev)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-slate-700"
              >
                {showWizard && onboardingPayload.state.completed
                  ? "Dashboard"
                  : "Setup Wizard"}
              </button>
            )}
            {token && (
              <button
                type="button"
                onClick={handleLockToken}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
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
          onComplete={(starterPrompt) => {
            setWizardManualOpen(false);
            if (starterPrompt) {
              setGoal(starterPrompt);
            }
          }}
          onCancel={
            onboardingPayload.state.completed
              ? () => setWizardManualOpen(false)
              : undefined
          }
        />
      )}

      {isAuthenticated && !showWizard && (
        <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-3">
          <section className="space-y-6 lg:col-span-2">
            {offline && (
              <div
                role="alert"
                className="flex items-center justify-between rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200"
              >
                <span>Control API is unreachable. Telemetry may be stale.</span>
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
                  AI CTO provider is not connected yet. Add an API key or Ollama
                  endpoint to activate conversational server automation.
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
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
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
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
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
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
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
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs text-slate-400">Uptime &amp; Apps</p>
                <p className="mt-1 text-base font-medium">
                  {metrics ? formatUptime(metrics.uptimeSeconds) : "—"}
                </p>
                <p className="text-xs text-slate-500">
                  {apps.length} isolated workloads
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
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
                <p className="mt-2 rounded bg-slate-950 px-3 py-1.5 text-xs text-sky-300">
                  {appMessage}
                </p>
              )}
              {apps.length === 0 ? (
                <p className="mt-3 text-sm text-slate-400">
                  No workloads provisioned yet. Ask the CTO Agent on the right to
                  deploy an isolated web app or personal agent container.
                </p>
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {apps.map((app) => (
                    <div
                      key={app.slug}
                      className="rounded-lg border border-slate-800 bg-slate-950/70 p-4"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-100">
                          {app.name}
                        </span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
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
                            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] capitalize text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                          >
                            {action}
                          </button>
                        ))}
                        <button
                          type="button"
                          disabled={busyAppSlug === app.slug}
                          onClick={() => void handleViewLogs(app.slug)}
                          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-sky-300 hover:bg-slate-800 disabled:opacity-50"
                        >
                          Logs
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {logsView && (
                <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-3">
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

            <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
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
                      className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-slate-200">
                            {evt.action}
                          </span>
                          {evt.targetSlug && (
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
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
          </section>

          <aside className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-sm font-semibold text-slate-200">
              CTO Agent Chat
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Describe what you want in plain English. Changes generate a plan
              for your approval before execution.
            </p>

            <form onSubmit={handlePlanSubmit} className="mt-4 space-y-3">
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={3}
                placeholder="e.g. Deploy a personal life agent in its own folder with Telegram"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={loadingPlan || !goal.trim()}
                className="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {loadingPlan ? "Planning..." : "Generate Execution Plan"}
              </button>
            </form>

            {error && (
              <p className="mt-3 text-xs text-rose-400" role="alert">
                {error}
              </p>
            )}

            {plan && (
              <div className="mt-4 space-y-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-sky-300">
                    {plan.summary}
                  </p>
                  {plan.status && (
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                      {plan.status}
                    </span>
                  )}
                </div>
                <ul className="space-y-2">
                  {plan.steps.map((step) => (
                    <li key={step.id} className="text-xs text-slate-300">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{step.title}</span>
                        <span className="text-slate-500">
                          ({step.riskLevel})
                        </span>
                        {step.requiresApproval && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                            approval
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {step.description}
                      </p>
                    </li>
                  ))}
                </ul>
                {plan.requiresUserApproval && plan.status === "pending" && (
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      disabled={submittingDecision}
                      onClick={() => void handleDecision(true)}
                      className="flex-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {submittingDecision ? "Saving..." : "Approve Decision"}
                    </button>
                    <button
                      type="button"
                      disabled={submittingDecision}
                      onClick={() => void handleDecision(false)}
                      className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                )}
                {plan.status === "approved" && (
                  <div className="space-y-2 pt-1">
                    <p className="text-[11px] text-slate-400">
                      Decision recorded. Run execution when ready:
                    </p>
                    <button
                      type="button"
                      disabled={submittingDecision}
                      onClick={() => void handleExecutePlan()}
                      className="w-full rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {submittingDecision ? "Executing..." : "Execute Approved Plan"}
                    </button>
                  </div>
                )}
                {executionNote && (
                  <p className="text-[11px] text-emerald-300">{executionNote}</p>
                )}
              </div>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}
