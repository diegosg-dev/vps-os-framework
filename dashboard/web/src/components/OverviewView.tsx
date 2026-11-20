import { useState, type FormEvent } from "react";
import {
  computeServerHealth,
  cpuLoadPercent,
  formatMbToGb,
  formatRelativeTime,
  formatUptime,
  providerDisplayName,
} from "../lib/format";
import type {
  AppCardView,
  AuditEventView,
  ExecutionPlanView,
  OnboardingPayload,
  SystemMetricsView,
  TelemetrySampleView,
  WorkspaceView,
} from "../types";
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  BoxIcon,
  CheckCircleIcon,
  ClockIcon,
  CpuIcon,
  GlobeIcon,
  HardDriveIcon,
  PlusIcon,
  ServerIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
  ZapIcon,
} from "./Icons";
import { CapacityBar, ResourceRing, SparklineArea } from "./TelemetryCharts";

interface OverviewViewProps {
  metrics: SystemMetricsView | null;
  history: TelemetrySampleView[];
  apps: AppCardView[];
  plans: ExecutionPlanView[];
  auditEvents: AuditEventView[];
  onboardingPayload: OnboardingPayload | null;
  offline: boolean;
  onNavigate: (view: WorkspaceView) => void;
  onQuickAskCto: (prompt: string) => void;
  onInspectApp: (app: AppCardView, tab?: "overview" | "logs") => void;
  onOpenDeployModal: () => void;
  onOpenSetupWizard: () => void;
}

const QUICK_CTO_CHIPS = [
  "Check server capacity & security posture",
  "Deploy a new web app with automatic HTTPS",
  "Create a personal AI agent in a locked folder",
  "Review my recent container logs for issues",
];

export function OverviewView({
  metrics,
  history,
  apps,
  plans,
  auditEvents,
  onboardingPayload,
  offline,
  onNavigate,
  onQuickAskCto,
  onInspectApp,
  onOpenDeployModal,
  onOpenSetupWizard,
}: OverviewViewProps) {
  const [quickPrompt, setQuickPrompt] = useState("");

  const health = computeServerHealth(metrics, apps, onboardingPayload, offline);
  const runningCount = apps.filter((a) => a.status === "running").length;
  const stoppedCount = apps.filter((a) => a.status === "stopped").length;
  const pendingPlans = plans.filter((p) => p.status === "pending");
  const approvedPlans = plans.filter((p) => p.status === "approved");
  const cpuPct = cpuLoadPercent(metrics);

  const cpuSeries = history.map((s) => s.cpuLoadPercent);
  const ramSeries = history.map((s) => s.memoryUsagePercent);
  const diskSeries = history
    .map((s) => s.diskUsagePercent)
    .filter((v): v is number => v !== null);

  const healthColor =
    health.tone === "success"
      ? "var(--success)"
      : health.tone === "warning"
        ? "var(--warning)"
        : "var(--danger)";

  const ownerName = onboardingPayload?.state.persona.ownerName || "Server Owner";
  const domain = onboardingPayload?.state.domain;
  const dnsVerified = onboardingPayload?.state.dnsVerified ?? false;
  const hermesReady = onboardingPayload?.hermesStatus.reachable ?? false;
  const baselineChecks = onboardingPayload?.state.baselineScan?.checks ?? [];

  function handleQuickPromptSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = quickPrompt.trim();
    if (!trimmed) return;
    setQuickPrompt("");
    onQuickAskCto(trimmed);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Hero Mission Control Banner */}
      <section className="vps-card relative overflow-hidden rounded-2xl p-5 sm:p-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full opacity-25 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, rgba(56,189,248,0.45) 0%, rgba(99,102,241,0.22) 55%, transparent 100%)",
          }}
        />
        <div className="relative flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="flex items-start gap-4">
            <ResourceRing
              percent={health.score}
              size={66}
              strokeWidth={5.5}
              color={healthColor}
              label={`${health.score}`}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                    health.tone === "success"
                      ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                      : health.tone === "warning"
                        ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
                        : "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      health.tone === "success"
                        ? "bg-[var(--success)] animate-pulse-dot"
                        : health.tone === "warning"
                          ? "bg-[var(--warning)]"
                          : "bg-[var(--danger)]"
                    }`}
                  />
                  System {health.label}
                </span>
                {domain && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                    <GlobeIcon className="h-3 w-3 text-[var(--accent)]" />
                    {domain}
                    {dnsVerified && (
                      <CheckCircleIcon className="h-3 w-3 text-[var(--success)]" />
                    )}
                  </span>
                )}
                {onboardingPayload?.state.baselineScan?.osRelease && (
                  <span className="hidden rounded-full border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-0.5 text-[11px] text-[var(--text-muted)] sm:inline">
                    {onboardingPayload.state.baselineScan.osRelease}
                  </span>
                )}
              </div>

              <h1 className="mt-2 text-xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-2xl">
                {metrics?.hostname ?? "VPS Control Plane"}
                <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
                  · Welcome back, {ownerName}
                </span>
              </h1>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)] sm:text-[13px]">
                {health.headline}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onOpenDeployModal}
              className="vps-btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Deploy Workload
            </button>
            <button
              type="button"
              onClick={() => onNavigate("chat")}
              className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-xs font-medium"
            >
              <SparklesIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
              Open CTO Studio
            </button>
          </div>
        </div>
      </section>

      {/* Pending Approvals / Actionable Alert Strip */}
      {(pendingPlans.length > 0 || approvedPlans.length > 0) && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--warning-border)] bg-[var(--warning-soft)] px-4 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[var(--warning-border)] bg-[var(--bg-surface)] text-[var(--warning)]">
              <ShieldIcon className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-semibold text-[var(--text-primary)]">
                {pendingPlans.length > 0
                  ? `${pendingPlans.length} Execution Plan${pendingPlans.length === 1 ? "" : "s"} awaiting your approval`
                  : `${approvedPlans.length} Approved Plan${approvedPlans.length === 1 ? "" : "s"} ready to execute`}
              </p>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
                {pendingPlans[0]?.summary ?? approvedPlans[0]?.summary}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("activity")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-400"
          >
            Review Queue
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </button>
        </section>
      )}

      {/* Unconfigured AI Provider Reminder */}
      {onboardingPayload && !onboardingPayload.state.llmConfigured && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-soft)] px-4 py-3.5">
          <div className="flex items-center gap-3">
            <SparklesIcon className="h-4.5 w-4.5 shrink-0 text-[var(--accent)]" />
            <p className="text-xs text-[var(--text-primary)]">
              Connect <strong>OpenCode</strong>, <strong>Claude</strong>,{" "}
              <strong>OpenAI</strong>, or <strong>Ollama</strong> to unlock live multi-step Autonomous CTO reasoning.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenSetupWizard}
            className="vps-btn-primary rounded-lg px-3 py-1.5 text-xs font-medium"
          >
            Configure AI Brain
          </button>
        </section>
      )}

      {/* 4 Live Telemetry KPI Cards with SVG Sparklines */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* CPU & Load */}
        <div className="vps-card flex flex-col justify-between rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <CpuIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
              CPU &amp; Load
            </span>
            <span className="tabular-nums rounded-md border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-muted)]">
              {metrics ? `${metrics.cpuCount} vCPU` : "—"}
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <p className="tabular-nums text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
              {metrics ? `${cpuPct}%` : "—"}
            </p>
            <span className="tabular-nums font-mono text-[11px] text-[var(--text-muted)]">
              1m load {metrics?.loadAverage1m ?? "—"}
            </span>
          </div>
          <div className="mt-3">
            <SparklineArea
              values={cpuSeries.length > 0 ? cpuSeries : [cpuPct, cpuPct]}
              color="var(--accent)"
              height={38}
              ariaLabel="CPU load history"
            />
          </div>
        </div>

        {/* Memory */}
        <div className="vps-card flex flex-col justify-between rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <ServerIcon className="h-3.5 w-3.5 text-[var(--violet)]" />
              Memory (RAM)
            </span>
            <span className="tabular-nums rounded-md border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-muted)]">
              {metrics ? formatMbToGb(metrics.memoryTotalMb) : "—"}
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <p className="tabular-nums text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
              {metrics ? `${metrics.memoryUsagePercent}%` : "—"}
            </p>
            <span className="tabular-nums font-mono text-[11px] text-[var(--text-muted)]">
              {metrics
                ? `${formatMbToGb(metrics.memoryUsedMb)} used`
                : "Awaiting host"}
            </span>
          </div>
          <div className="mt-3">
            <SparklineArea
              values={
                ramSeries.length > 0
                  ? ramSeries
                  : [metrics?.memoryUsagePercent ?? 0, metrics?.memoryUsagePercent ?? 0]
              }
              color="var(--violet)"
              height={38}
              ariaLabel="Memory usage history"
            />
          </div>
        </div>

        {/* Storage */}
        <div className="vps-card flex flex-col justify-between rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <HardDriveIcon className="h-3.5 w-3.5 text-[var(--success)]" />
              Root Storage
            </span>
            <span className="tabular-nums rounded-md border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-muted)]">
              {metrics?.disk ? metrics.disk.mountPath : "/"}
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <p className="tabular-nums text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
              {metrics?.disk ? `${metrics.disk.usagePercent}%` : "—"}
            </p>
            <span className="tabular-nums font-mono text-[11px] text-[var(--text-muted)]">
              {metrics?.disk
                ? `${Math.round(metrics.disk.usedMb / 1024)} / ${Math.round(metrics.disk.totalMb / 1024)} GB`
                : "Unavailable"}
            </span>
          </div>
          <div className="mt-3 space-y-2">
            <SparklineArea
              values={
                diskSeries.length > 0
                  ? diskSeries
                  : [metrics?.disk?.usagePercent ?? 0, metrics?.disk?.usagePercent ?? 0]
              }
              color="var(--success)"
              height={38}
              ariaLabel="Storage usage history"
            />
          </div>
        </div>

        {/* Workloads & Uptime */}
        <div className="vps-card flex flex-col justify-between rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <BoxIcon className="h-3.5 w-3.5 text-[var(--warning)]" />
              Isolated Workloads
            </span>
            <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-[var(--text-muted)]">
              <ClockIcon className="h-3 w-3" />
              {metrics ? formatUptime(metrics.uptimeSeconds) : "—"}
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <p className="tabular-nums text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
              {runningCount}
              <span className="ml-1 text-sm font-normal text-[var(--text-muted)]">
                / {apps.length} live
              </span>
            </p>
            <span className="text-[11px] text-[var(--text-muted)]">
              {stoppedCount} stopped
            </span>
          </div>
          <div className="mt-4 space-y-1.5">
            <CapacityBar
              percent={apps.length > 0 ? (runningCount / apps.length) * 100 : 0}
              tone="success"
              heightClass="h-2"
            />
            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>
                {apps.filter((a) => a.kind === "web-app").length} web apps ·{" "}
                {apps.filter((a) => a.kind === "personal-agent").length} agents
              </span>
              <button
                type="button"
                onClick={() => onNavigate("apps")}
                className="font-medium text-[var(--accent)] hover:underline"
              >
                Manage →
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Quick Ask Autonomous CTO Bar */}
      <section className="vps-card rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]">
              <ZapIcon className="h-3.5 w-3.5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                Ask your Autonomous CTO
              </h2>
              <p className="text-[11.5px] text-[var(--text-muted)]">
                Describe what you want in plain English — no Linux or Docker commands required.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                onboardingPayload?.state.llmConfigured
                  ? "bg-[var(--success)]"
                  : "bg-[var(--warning)]"
              }`}
            />
            {providerDisplayName(onboardingPayload?.state.llmProvider)}
            {onboardingPayload?.state.llmModel
              ? ` · ${onboardingPayload.state.llmModel}`
              : ""}
          </span>
        </div>

        <form
          onSubmit={handleQuickPromptSubmit}
          className="mt-3.5 flex flex-col gap-2 sm:flex-row"
        >
          <input
            type="text"
            value={quickPrompt}
            onChange={(e) => setQuickPrompt(e.target.value)}
            placeholder="e.g. Deploy a private wiki at wiki.acmecloud.dev or check why a container restarted..."
            className="vps-input flex-1 rounded-xl px-3.5 py-2.5 text-xs sm:text-[13px]"
          />
          <button
            type="submit"
            disabled={!quickPrompt.trim()}
            className="vps-btn-primary inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold"
          >
            <SparklesIcon className="h-3.5 w-3.5" />
            Send to CTO
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {QUICK_CTO_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => onQuickAskCto(chip)}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition hover:border-[var(--accent-border)] hover:text-[var(--text-primary)]"
            >
              {chip}
            </button>
          ))}
        </div>
      </section>

      {/* Main Bento Grid: Workloads Snapshot + Security & Audit Feed */}
      <section className="grid gap-6 lg:grid-cols-12">
        {/* Workloads Snapshot (7 cols) */}
        <div className="vps-card flex flex-col rounded-2xl p-5 lg:col-span-7">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                Apps &amp; Personal Agents
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                Each workload runs inside its own isolated Locked Apartment folder.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate("apps")}
              className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
            >
              View all ({apps.length})
              <ArrowRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          {apps.length === 0 ? (
            <div className="mt-5 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-inset)] px-6 py-10 text-center">
              <BoxIcon className="h-7 w-7 text-[var(--text-muted)]" />
              <p className="mt-2.5 text-sm font-medium text-[var(--text-primary)]">
                No isolated workloads deployed yet
              </p>
              <p className="mt-1 max-w-xs text-xs text-[var(--text-muted)]">
                Launch your first web app with automatic HTTPS or spin up a private personal AI agent.
              </p>
              <button
                type="button"
                onClick={onOpenDeployModal}
                className="vps-btn-primary mt-4 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Deploy First Workload
              </button>
            </div>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {apps.slice(0, 6).map((app) => {
                const running = app.status === "running";
                const errored = app.status === "error";
                return (
                  <div
                    key={app.slug}
                    className="group flex flex-col justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5 transition hover:border-[var(--border-strong)]"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                              app.kind === "personal-agent"
                                ? "border-[var(--violet-border)] bg-[var(--violet-soft)] text-[var(--violet)]"
                                : "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                            }`}
                          >
                            {app.kind === "personal-agent" ? (
                              <BotIcon className="h-4 w-4" />
                            ) : (
                              <GlobeIcon className="h-4 w-4" />
                            )}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-[var(--text-primary)]">
                              {app.name}
                            </p>
                            <p className="truncate font-mono text-[10.5px] text-[var(--text-muted)]">
                              {app.domain ?? "internal network"}
                            </p>
                          </div>
                        </div>

                        <span
                          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${
                            running
                              ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                              : errored
                                ? "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
                                : "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-muted)]"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              running
                                ? "bg-[var(--success)]"
                                : errored
                                  ? "bg-[var(--danger)]"
                                  : "bg-[var(--text-muted)]"
                            }`}
                          />
                          {app.status}
                        </span>
                      </div>

                      <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                        <span className="tabular-nums font-mono">
                          {app.cpuLimit} vCPU · {formatMbToGb(app.memoryLimitMb)}
                        </span>
                        <span>{formatRelativeTime(app.updatedAt)}</span>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-1.5 border-t border-[var(--border-subtle)] pt-2.5">
                      <button
                        type="button"
                        onClick={() => onInspectApp(app, "overview")}
                        className="vps-btn-secondary flex-1 rounded-lg px-2 py-1 text-[11px] font-medium"
                      >
                        Inspect
                      </button>
                      <button
                        type="button"
                        onClick={() => onInspectApp(app, "logs")}
                        className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-[var(--accent)]"
                      >
                        <TerminalIcon className="h-3 w-3" />
                        Logs
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Infrastructure Readiness + Recent Audit Feed (5 cols) */}
        <div className="flex flex-col gap-6 lg:col-span-5">
          {/* Security & Infrastructure Readiness */}
          <div className="vps-card rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                Platform Readiness
              </h2>
              <button
                type="button"
                onClick={() => onNavigate("settings")}
                className="text-xs font-medium text-[var(--accent)] hover:underline"
              >
                System checks →
              </button>
            </div>
            <div className="mt-3.5 space-y-2">
              {baselineChecks.length > 0 ? (
                baselineChecks.slice(0, 4).map((check) => (
                  <div
                    key={check.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-[var(--text-primary)]">
                        {check.label}
                      </p>
                      <p className="truncate text-[11px] text-[var(--text-muted)]">
                        {check.detail}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        check.status === "ok"
                          ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                          : check.status === "warn"
                            ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
                            : "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-muted)]"
                      }`}
                    >
                      {check.status}
                    </span>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-xs text-[var(--text-secondary)]">
                  <div className="flex items-center justify-between">
                    <span>Hermes CTO Gateway</span>
                    <span
                      className={`font-medium ${
                        hermesReady ? "text-[var(--success)]" : "text-[var(--text-muted)]"
                      }`}
                    >
                      {hermesReady ? "Online" : "Standby"}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Run a Baseline Scan in System &amp; Settings to verify firewall, TLS, and backup status.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Recent Activity Feed */}
          <div className="vps-card flex-1 rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <ActivityIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Recent Audit Activity
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate("activity")}
                className="text-xs font-medium text-[var(--accent)] hover:underline"
              >
                Explorer →
              </button>
            </div>

            {auditEvents.length === 0 ? (
              <p className="mt-4 text-xs text-[var(--text-muted)]">
                No audit events recorded yet.
              </p>
            ) : (
              <ul className="mt-3.5 space-y-2">
                {auditEvents.slice(0, 5).map((evt) => (
                  <li
                    key={evt.id}
                    className="flex items-start justify-between gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            evt.riskLevel === "high"
                              ? "bg-[var(--danger)]"
                              : evt.riskLevel === "medium"
                                ? "bg-[var(--warning)]"
                                : "bg-[var(--success)]"
                          }`}
                        />
                        <span className="truncate font-mono text-[11.5px] font-medium text-[var(--text-primary)]">
                          {evt.action}
                        </span>
                        {evt.targetSlug && (
                          <span className="rounded bg-[var(--bg-active)] px-1.5 py-0.2 font-mono text-[10px] text-[var(--text-secondary)]">
                            {evt.targetSlug}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                        {evt.summary}
                      </p>
                    </div>
                    <span className="tabular-nums shrink-0 text-[10.5px] text-[var(--text-muted)]">
                      {formatRelativeTime(evt.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
