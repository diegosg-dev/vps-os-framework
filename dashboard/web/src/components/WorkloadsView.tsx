import { useMemo, useState, type FormEvent } from "react";
import { formatMbToGb, formatRelativeTime } from "../lib/format";
import type { AppCardView } from "../types";
import {
  BotIcon,
  BoxIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LayoutGridIcon,
  ListIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  SquareStopIcon,
  TerminalIcon,
  XIcon,
} from "./Icons";
import { CapacityBar } from "./TelemetryCharts";

interface WorkloadsViewProps {
  apps: AppCardView[];
  totalHostMemoryMb: number;
  totalHostCpus: number;
  busyAppSlug: string | null;
  deployModalOpen: boolean;
  onOpenDeployModal: () => void;
  onCloseDeployModal: () => void;
  onLifecycle: (slug: string, action: "start" | "stop" | "restart") => void;
  onInspectApp: (app: AppCardView, tab?: "overview" | "logs") => void;
  onCreateDeployPlan: (goal: string) => Promise<void>;
  onAskCto: (prompt: string) => void;
  onNotify: (title: string, tone?: "success" | "info" | "warning" | "error", description?: string) => void;
}

const RESOURCE_TIERS = [
  { id: "starter", label: "Starter", cpu: "0.5 vCPU", ram: "512 MB RAM", hint: "Light bots, static apps, wikis" },
  { id: "standard", label: "Standard", cpu: "1.0 vCPU", ram: "1 GB RAM", hint: "CRMs, dashboards, personal agents" },
  { id: "performance", label: "Performance", cpu: "2.0 vCPU", ram: "2 GB RAM", hint: "Heavy APIs, indexing, multi-tool agents" },
] as const;

export function WorkloadsView({
  apps,
  totalHostMemoryMb,
  totalHostCpus,
  busyAppSlug,
  deployModalOpen,
  onOpenDeployModal,
  onCloseDeployModal,
  onLifecycle,
  onInspectApp,
  onCreateDeployPlan,
  onAskCto,
  onNotify,
}: WorkloadsViewProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "web-app" | "personal-agent">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "stopped" | "error">("all");
  const [layout, setLayout] = useState<"grid" | "list">("grid");

  // Quick Deploy Modal state
  const [deployKind, setDeployKind] = useState<"web-app" | "personal-agent">("web-app");
  const [deployName, setDeployName] = useState("");
  const [deployDomain, setDeployDomain] = useState("");
  const [deployTier, setDeployTier] = useState<(typeof RESOURCE_TIERS)[number]["id"]>("standard");
  const [deployNotes, setDeployNotes] = useState("");
  const [deploySubmitting, setDeploySubmitting] = useState(false);

  const stats = useMemo(() => {
    const running = apps.filter((a) => a.status === "running").length;
    const stopped = apps.filter((a) => a.status === "stopped").length;
    const webApps = apps.filter((a) => a.kind === "web-app").length;
    const agents = apps.filter((a) => a.kind === "personal-agent").length;
    const allocatedRamMb = apps.reduce((sum, a) => sum + a.memoryLimitMb, 0);
    return { running, stopped, webApps, agents, allocatedRamMb };
  }, [apps]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return apps.filter((app) => {
      if (kindFilter !== "all" && app.kind !== kindFilter) return false;
      if (statusFilter !== "all" && app.status !== statusFilter) return false;
      if (q) {
        const hay = `${app.name} ${app.slug} ${app.domain ?? ""} ${app.kind}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [apps, kindFilter, search, statusFilter]);

  function buildGoalText(): string {
    const tier = RESOURCE_TIERS.find((t) => t.id === deployTier) ?? RESOURCE_TIERS[1];
    const cleanName = deployName.trim() || (deployKind === "web-app" ? "new-web-app" : "personal-agent");
    if (deployKind === "web-app") {
      const domainPart = deployDomain.trim() ? ` at ${deployDomain.trim()} with automatic HTTPS` : " on the internal network";
      const extra = deployNotes.trim() ? ` (${deployNotes.trim()})` : "";
      return `Deploy isolated web app "${cleanName}"${domainPart} with ${tier.cpu} and ${tier.ram}${extra}`;
    }
    const extra = deployNotes.trim() ? ` with ${deployNotes.trim()}` : "";
    return `Create personal AI agent "${cleanName}" in its own isolated folder with ${tier.cpu} and ${tier.ram}${extra}`;
  }

  async function handleSubmitDeployPlan(event: FormEvent) {
    event.preventDefault();
    if (!deployName.trim() || deploySubmitting) return;
    setDeploySubmitting(true);
    try {
      await onCreateDeployPlan(buildGoalText());
      setDeployName("");
      setDeployDomain("");
      setDeployNotes("");
      onCloseDeployModal();
    } finally {
      setDeploySubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header Row */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
            Workloads &amp; Personal Agents
          </h1>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Every workload runs in its own isolated container with strict CPU, memory, and network boundaries.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenDeployModal}
          className="vps-btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Deploy Workload
        </button>
      </div>

      {/* Compact Summary Strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="vps-card rounded-xl px-4 py-3">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">Running Now</p>
          <p className="tabular-nums mt-1 text-xl font-semibold text-[var(--success)]">
            {stats.running}
            <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">
              of {apps.length} total
            </span>
          </p>
        </div>
        <div className="vps-card rounded-xl px-4 py-3">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">Web Apps</p>
          <p className="tabular-nums mt-1 text-xl font-semibold text-[var(--accent)]">
            {stats.webApps}
            <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">
              HTTP / Auto-TLS
            </span>
          </p>
        </div>
        <div className="vps-card rounded-xl px-4 py-3">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">Personal Agents</p>
          <p className="tabular-nums mt-1 text-xl font-semibold text-[var(--violet)]">
            {stats.agents}
            <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">
              Locked folders
            </span>
          </p>
        </div>
        <div className="vps-card rounded-xl px-4 py-3">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">Allocated Memory Caps</p>
          <p className="tabular-nums mt-1 text-xl font-semibold text-[var(--text-primary)]">
            {formatMbToGb(stats.allocatedRamMb)}
            <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">
              / {formatMbToGb(totalHostMemoryMb)} host
            </span>
          </p>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="vps-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3">
        <div className="flex min-w-[220px] flex-1 items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, slug, or domain..."
              className="vps-input w-full rounded-xl py-2 pr-3 pl-8.5 text-xs"
            />
          </div>

          <div className="hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-xs sm:inline-flex">
            {(
              [
                { id: "all", label: "All Types" },
                { id: "web-app", label: "Web Apps" },
                { id: "personal-agent", label: "Personal Agents" },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setKindFilter(item.id)}
                className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition ${
                  kindFilter === item.id
                    ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-[11.5px]">
            {(["all", "running", "stopped", "error"] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-lg px-2.5 py-1 font-medium capitalize transition ${
                  statusFilter === st
                    ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5">
            <button
              type="button"
              onClick={() => setLayout("grid")}
              className={`rounded-lg p-1.5 transition ${
                layout === "grid"
                  ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
              title="Grid view"
              aria-label="Grid view"
            >
              <LayoutGridIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setLayout("list")}
              className={`rounded-lg p-1.5 transition ${
                layout === "list"
                  ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
              title="List view"
              aria-label="List view"
            >
              <ListIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Workload Cards or Table */}
      {filtered.length === 0 ? (
        <div className="vps-card flex flex-col items-center justify-center rounded-2xl px-6 py-16 text-center">
          <BoxIcon className="h-9 w-9 text-[var(--text-muted)]" />
          <h3 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
            {apps.length === 0
              ? "No workloads provisioned yet"
              : "No workloads match your filters"}
          </h3>
          <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">
            {apps.length === 0
              ? "Use the Deploy Workload launcher or ask the CTO Agent to spin up your first isolated container."
              : "Try clearing your search term or switching status/type filters."}
          </p>
          {apps.length === 0 ? (
            <button
              type="button"
              onClick={onOpenDeployModal}
              className="vps-btn-primary mt-4 inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Deploy First Workload
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setKindFilter("all");
                setStatusFilter("all");
              }}
              className="vps-btn-secondary mt-4 rounded-lg px-3 py-1.5 text-xs font-medium"
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : layout === "grid" ? (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((app) => {
            const isRunning = app.status === "running";
            const isError = app.status === "error";
            const busy = busyAppSlug === app.slug;
            const cpuNum = Number.parseFloat(app.cpuLimit) || 0.5;
            const cpuPct = Math.min(100, Math.round((cpuNum / Math.max(1, totalHostCpus)) * 100));
            const ramPct = Math.min(
              100,
              Math.round((app.memoryLimitMb / Math.max(512, totalHostMemoryMb)) * 100),
            );

            return (
              <article
                key={app.slug}
                className="vps-card-interactive flex flex-col justify-between rounded-2xl p-5"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                          app.kind === "personal-agent"
                            ? "border-[var(--violet-border)] bg-[var(--violet-soft)] text-[var(--violet)]"
                            : "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                        }`}
                      >
                        {app.kind === "personal-agent" ? (
                          <BotIcon className="h-5 w-5" />
                        ) : (
                          <GlobeIcon className="h-5 w-5" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">
                          {app.name}
                        </h3>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                          <span className="font-mono">{app.slug}</span>
                          <span>·</span>
                          <span>
                            {app.kind === "personal-agent"
                              ? "Personal Agent"
                              : "Web App"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <span
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize ${
                        isRunning
                          ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                          : isError
                            ? "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
                            : "border-[var(--border-default)] bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isRunning
                            ? "bg-[var(--success)] animate-pulse-dot"
                            : isError
                              ? "bg-[var(--danger)]"
                              : "bg-[var(--text-muted)]"
                        }`}
                      />
                      {app.status}
                    </span>
                  </div>

                  {/* Endpoint Bar */}
                  <div className="mt-4 flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-xs">
                    {app.domain ? (
                      <>
                        <a
                          href={`https://${app.domain}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-w-0 items-center gap-1.5 truncate font-mono text-[11.5px] font-medium text-[var(--accent)] hover:underline"
                        >
                          <span className="truncate">https://{app.domain}</span>
                          <ExternalLinkIcon className="h-3 w-3 shrink-0" />
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard?.writeText(`https://${app.domain}`);
                            onNotify("Copied URL", "success", `https://${app.domain}`);
                          }}
                          className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                          title="Copy HTTPS URL"
                          aria-label={`Copy URL for ${app.name}`}
                        >
                          <CopyIcon className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
                        <ShieldIcon className="h-3.5 w-3.5 text-[var(--violet)]" />
                        Internal network only (private apartment)
                      </span>
                    )}
                  </div>

                  {/* Quota Bars */}
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-[var(--text-muted)]">CPU Cap</span>
                        <span className="tabular-nums font-mono font-medium text-[var(--text-secondary)]">
                          {app.cpuLimit} vCPU
                        </span>
                      </div>
                      <div className="mt-1.5">
                        <CapacityBar percent={cpuPct} tone="accent" />
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-[var(--text-muted)]">RAM Cap</span>
                        <span className="tabular-nums font-mono font-medium text-[var(--text-secondary)]">
                          {formatMbToGb(app.memoryLimitMb)}
                        </span>
                      </div>
                      <div className="mt-1.5">
                        <CapacityBar
                          percent={ramPct}
                          tone={app.kind === "personal-agent" ? "violet" : "success"}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action Footer */}
                <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3.5">
                  <div className="flex items-center gap-1.5">
                    {!isRunning ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onLifecycle(app.slug, "start")}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11.5px] font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                      >
                        <PlayIcon className="h-3 w-3" />
                        Start
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onLifecycle(app.slug, "restart")}
                          className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium"
                        >
                          <RotateCcwIcon className="h-3 w-3" />
                          Restart
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onLifecycle(app.slug, "stop")}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--danger)] transition hover:opacity-90 disabled:opacity-50"
                        >
                          <SquareStopIcon className="h-3 w-3" />
                          Stop
                        </button>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onInspectApp(app, "logs")}
                      className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--accent)]"
                    >
                      <TerminalIcon className="h-3.5 w-3.5" />
                      Logs
                    </button>
                    <button
                      type="button"
                      onClick={() => onInspectApp(app, "overview")}
                      className="vps-btn-secondary rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium"
                    >
                      Inspect
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="vps-card overflow-x-auto rounded-2xl">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <th className="px-4 py-3">Workload</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Endpoint</th>
                <th className="px-4 py-3">Quotas</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3 text-right">Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {filtered.map((app) => {
                const isRunning = app.status === "running";
                const busy = busyAppSlug === app.slug;
                return (
                  <tr key={app.slug} className="hover:bg-[var(--bg-hover)]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex h-7 w-7 items-center justify-center rounded-lg border ${
                            app.kind === "personal-agent"
                              ? "border-[var(--violet-border)] bg-[var(--violet-soft)] text-[var(--violet)]"
                              : "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                          }`}
                        >
                          {app.kind === "personal-agent" ? (
                            <BotIcon className="h-3.5 w-3.5" />
                          ) : (
                            <GlobeIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                        <div>
                          <p className="font-semibold text-[var(--text-primary)]">{app.name}</p>
                          <p className="font-mono text-[10.5px] text-[var(--text-muted)]">
                            {app.slug}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium capitalize ${
                          isRunning
                            ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                            : "border-[var(--border-default)] bg-[var(--bg-inset)] text-[var(--text-muted)]"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            isRunning ? "bg-[var(--success)]" : "bg-[var(--text-muted)]"
                          }`}
                        />
                        {app.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[var(--text-secondary)]">
                      {app.domain ?? "internal only"}
                    </td>
                    <td className="tabular-nums px-4 py-3 font-mono text-[11px] text-[var(--text-secondary)]">
                      {app.cpuLimit}c · {formatMbToGb(app.memoryLimitMb)}
                    </td>
                    <td className="px-4 py-3 text-[11px] text-[var(--text-muted)]">
                      {formatRelativeTime(app.updatedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            onLifecycle(app.slug, isRunning ? "restart" : "start")
                          }
                          className="vps-btn-secondary rounded-lg px-2 py-1 text-[11px]"
                        >
                          {isRunning ? "Restart" : "Start"}
                        </button>
                        <button
                          type="button"
                          onClick={() => onInspectApp(app, "logs")}
                          className="vps-btn-secondary rounded-lg px-2 py-1 text-[11px] text-[var(--accent)]"
                        >
                          Logs
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Guided Deploy Workload Modal */}
      {deployModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-backdrop)] p-4 backdrop-blur-xs"
          onClick={onCloseDeployModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="deploy-modal-title"
            className="vps-elevated animate-fade-in w-full max-w-xl overflow-hidden rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
              <div>
                <h2
                  id="deploy-modal-title"
                  className="text-base font-semibold text-[var(--text-primary)]"
                >
                  Deploy Isolated Workload
                </h2>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  Generates a safe, approval-gated Execution Plan before anything touches your server.
                </p>
              </div>
              <button
                type="button"
                onClick={onCloseDeployModal}
                className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                aria-label="Close deploy dialog"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSubmitDeployPlan(e)} className="space-y-4 p-5">
              {/* Template Type Selector */}
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setDeployKind("web-app")}
                  className={`rounded-xl border p-3.5 text-left transition ${
                    deployKind === "web-app"
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <GlobeIcon className="h-4 w-4 text-[var(--accent)]" />
                    <span className="text-xs font-semibold text-[var(--text-primary)]">
                      Web App (Auto-HTTPS)
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    Isolated web service with optional Caddy Let&apos;s Encrypt domain routing.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setDeployKind("personal-agent")}
                  className={`rounded-xl border p-3.5 text-left transition ${
                    deployKind === "personal-agent"
                      ? "border-[var(--violet)] bg-[var(--violet-soft)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <BotIcon className="h-4 w-4 text-[var(--violet)]" />
                    <span className="text-xs font-semibold text-[var(--text-primary)]">
                      Personal AI Agent
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    Locked Apartment sandbox with dedicated folder, tools, and private network.
                  </p>
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="deploy-name"
                    className="block text-xs font-medium text-[var(--text-secondary)]"
                  >
                    Workload Name
                  </label>
                  <input
                    id="deploy-name"
                    type="text"
                    required
                    value={deployName}
                    onChange={(e) => setDeployName(e.target.value)}
                    placeholder={
                      deployKind === "web-app" ? "Company Wiki" : "Research Assistant"
                    }
                    className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 text-xs"
                  />
                </div>

                {deployKind === "web-app" && (
                  <div>
                    <label
                      htmlFor="deploy-domain"
                      className="block text-xs font-medium text-[var(--text-secondary)]"
                    >
                      Domain (optional)
                    </label>
                    <input
                      id="deploy-domain"
                      type="text"
                      value={deployDomain}
                      onChange={(e) => setDeployDomain(e.target.value)}
                      placeholder="wiki.yourdomain.com"
                      className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 font-mono text-xs"
                    />
                  </div>
                )}
              </div>

              {/* Resource Tier */}
              <div>
                <span className="block text-xs font-medium text-[var(--text-secondary)]">
                  Resource Cap Tier
                </span>
                <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                  {RESOURCE_TIERS.map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      onClick={() => setDeployTier(tier.id)}
                      className={`rounded-xl border p-2.5 text-left transition ${
                        deployTier === tier.id
                          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
                      }`}
                    >
                      <p className="text-xs font-semibold text-[var(--text-primary)]">
                        {tier.label}
                      </p>
                      <p className="mt-0.5 font-mono text-[10.5px] text-[var(--accent)]">
                        {tier.cpu} · {tier.ram}
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                        {tier.hint}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="deploy-notes"
                  className="block text-xs font-medium text-[var(--text-secondary)]"
                >
                  Additional Details (optional)
                </label>
                <input
                  id="deploy-notes"
                  type="text"
                  value={deployNotes}
                  onChange={(e) => setDeployNotes(e.target.value)}
                  placeholder="e.g. connect Telegram bot, attach persistent Postgres volume..."
                  className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-4">
                <button
                  type="button"
                  disabled={!deployName.trim()}
                  onClick={() => {
                    const goal = buildGoalText();
                    onCloseDeployModal();
                    onAskCto(goal);
                  }}
                  className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium"
                >
                  <SparklesIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                  Discuss in CTO Chat
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onCloseDeployModal}
                    className="vps-btn-secondary rounded-xl px-3.5 py-2 text-xs font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!deployName.trim() || deploySubmitting}
                    className="vps-btn-primary rounded-xl px-4 py-2 text-xs font-semibold"
                  >
                    {deploySubmitting ? "Creating Plan..." : "Generate Approval Plan"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
