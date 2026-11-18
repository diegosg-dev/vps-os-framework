import { useCallback, useEffect, useState, type FormEvent } from "react";

interface SystemMetricsView {
  hostname: string;
  cpuCount: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsagePercent: number;
  uptimeSeconds: number;
}

interface AppCardView {
  slug: string;
  name: string;
  kind: "web-app" | "personal-agent";
  domain: string | null;
  status: string;
  cpuLimit: string;
  memoryLimitMb: number;
}

interface PlanStepView {
  id: string;
  title: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
}

interface ExecutionPlanView {
  id: string;
  goal: string;
  summary: string;
  requiresUserApproval: boolean;
  status?: "pending" | "approved" | "rejected" | "executed";
  steps: PlanStepView[];
}

export function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem("vps_os_admin_token") ?? "",
  );
  const [tokenInput, setTokenInput] = useState(token);
  const [metrics, setMetrics] = useState<SystemMetricsView | null>(null);
  const [apps, setApps] = useState<AppCardView[]>([]);
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState<ExecutionPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);

  const authHeaders = useCallback((): Record<string, string> => {
    return token ? { authorization: `Bearer ${token}` } : {};
  }, [token]);

  const loadState = useCallback(async () => {
    try {
      const [metricsRes, appsRes] = await Promise.all([
        fetch("/api/system/metrics", { headers: authHeaders() }),
        fetch("/api/apps", { headers: authHeaders() }),
      ]);
      if (metricsRes.status === 401 || appsRes.status === 401) {
        setError("Enter your VPS OS Admin Token to unlock server controls.");
        return;
      }
      if (metricsRes.ok) {
        setMetrics((await metricsRes.json()) as SystemMetricsView);
      }
      if (appsRes.ok) {
        const data = (await appsRes.json()) as { apps: AppCardView[] };
        setApps(data.apps);
      }
      setError(null);
    } catch {
      // Control API may be offline in standalone Vite preview mode.
    }
  }, [authHeaders]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  function handleSaveToken(event: FormEvent) {
    event.preventDefault();
    const trimmed = tokenInput.trim();
    sessionStorage.setItem("vps_os_admin_token", trimmed);
    setToken(trimmed);
  }

  async function extractApiError(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: string };
      return payload.error ?? `API returned ${response.status}`;
    } catch {
      return `API returned ${response.status}`;
    }
  }

  async function handlePlanSubmit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim()) return;
    setLoadingPlan(true);
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not reach Control API.",
      );
    } finally {
      setLoadingPlan(false);
    }
  }

  async function handleDecision(approved: boolean) {
    if (!plan) return;
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not submit decision.",
      );
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">VPS OS</h1>
            <p className="text-xs text-slate-400">
              Plug-and-Play Server Control & Autonomous CTO
            </p>
          </div>
          <form onSubmit={handleSaveToken} className="flex items-center gap-2">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Admin token"
              aria-label="Admin token"
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              Unlock
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-3">
        <section className="space-y-6 lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <p className="text-xs text-slate-400">Host</p>
              <p className="mt-1 text-base font-medium">
                {metrics?.hostname ?? "ubuntu-vps"}
              </p>
              <p className="text-xs text-slate-500">
                {metrics ? `${metrics.cpuCount} vCPU` : "Connect Control API"}
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
              <p className="text-xs text-slate-400">Isolated Workloads</p>
              <p className="mt-1 text-base font-medium">{apps.length}</p>
              <p className="text-xs text-slate-500">Locked apartments</p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-sm font-semibold text-slate-200">
              Installed Apps & Personal Agents
            </h2>
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
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-200">
            CTO Agent Chat
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Describe what you want in plain English. Changes generate a plan
            for your approval first.
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
                <p className="text-xs font-medium text-sky-300">{plan.summary}</p>
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
                      <span className="text-slate-500">({step.riskLevel})</span>
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
                    onClick={() => void handleDecision(true)}
                    className="flex-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecision(false)}
                    className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
