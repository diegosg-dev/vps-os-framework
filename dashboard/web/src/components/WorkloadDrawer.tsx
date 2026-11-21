import { useCallback, useEffect, useMemo, useState } from "react";
import {
  classifyLogLine,
  formatMbToGb,
  formatRelativeTime,
  triggerTextDownload,
} from "../lib/format";
import type { AppCardView } from "../types";
import {
  BotIcon,
  CheckCircleIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MessageSquareIcon,
  PlayIcon,
  RefreshIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldIcon,
  SpinnerIcon,
  SquareStopIcon,
  TerminalIcon,
  XIcon,
} from "./Icons";
import { CapacityBar } from "./TelemetryCharts";

interface WorkloadDrawerProps {
  app: AppCardView | null;
  initialTab?: "overview" | "logs";
  totalHostMemoryMb: number;
  totalHostCpus: number;
  busy: boolean;
  authHeaders: () => Record<string, string>;
  onClose: () => void;
  onLifecycle: (slug: string, action: "start" | "stop" | "restart") => void;
  onAskCto: (prompt: string) => void;
  onNotify: (title: string, tone?: "success" | "info" | "warning" | "error", description?: string) => void;
}

export function WorkloadDrawer({
  app,
  initialTab = "overview",
  totalHostMemoryMb,
  totalHostCpus,
  busy,
  authHeaders,
  onClose,
  onLifecycle,
  onAskCto,
  onNotify,
}: WorkloadDrawerProps) {
  const [tab, setTab] = useState<"overview" | "logs">(initialTab);
  const [tail, setTail] = useState<number>(100);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logSearch, setLogSearch] = useState("");
  const [logLevel, setLogLevel] = useState<"all" | "error" | "warn" | "info">("all");
  const [wrapLines, setWrapLines] = useState(false);
  const [autoFollow, setAutoFollow] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);

  useEffect(() => {
    setTab(initialTab);
    setLogSearch("");
    setLogLevel("all");
    setLogsError(null);
  }, [app?.slug, initialTab]);

  useEffect(() => {
    if (!app) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [app, onClose]);

  const fetchLogs = useCallback(async () => {
    if (!app) return;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(app.slug)}/logs?tail=${tail}`,
        { headers: authHeaders() },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `API returned ${res.status}`);
      }
      const data = (await res.json()) as { lines: string[] };
      setLogs(data.lines ?? []);
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : "Could not fetch logs.");
    } finally {
      setLogsLoading(false);
    }
  }, [app, authHeaders, tail]);

  useEffect(() => {
    if (app && tab === "logs") {
      void fetchLogs();
    }
  }, [app, tab, fetchLogs]);

  useEffect(() => {
    if (!app || tab !== "logs" || !autoFollow) return;
    const id = window.setInterval(() => {
      void fetchLogs();
    }, 5_000);
    return () => window.clearInterval(id);
  }, [app, tab, autoFollow, fetchLogs]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return logs
      .map((line, index) => ({
        lineNumber: index + 1,
        text: line,
        level: classifyLogLine(line),
      }))
      .filter((entry) => {
        if (logLevel !== "all" && entry.level !== logLevel) return false;
        if (q && !entry.text.toLowerCase().includes(q)) return false;
        return true;
      });
  }, [logs, logLevel, logSearch]);

  if (!app) return null;

  const isRunning = app.status === "running";
  const isError = app.status === "error";
  const cpuNum = Number.parseFloat(app.cpuLimit) || 0.5;
  const cpuSharePct = Math.min(100, Math.round((cpuNum / Math.max(1, totalHostCpus)) * 100));
  const ramSharePct = Math.min(
    100,
    Math.round((app.memoryLimitMb / Math.max(512, totalHostMemoryMb)) * 100),
  );

  function handleCopyLogs() {
    const text = filteredLogs.map((entry) => entry.text).join("\n");
    void navigator.clipboard?.writeText(text);
    setCopiedLogs(true);
    onNotify("Copied logs to clipboard", "success");
    window.setTimeout(() => setCopiedLogs(false), 1500);
  }

  function handleDownloadLogs() {
    if (!app) return;
    const text = filteredLogs.map((entry) => entry.text).join("\n");
    triggerTextDownload(`${app.slug}-logs.log`, text || "(no log lines)");
    onNotify(`Downloaded ${app.slug}-logs.log`, "info");
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-[var(--bg-backdrop)] backdrop-blur-xs"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Inspect ${app.name}`}
        className="animate-slide-in-right flex h-full w-full max-w-2xl flex-col border-l border-[var(--border-default)] bg-[var(--bg-rail)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
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
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-semibold text-[var(--text-primary)]">
                  {app.name}
                </h2>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${
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
              <p className="mt-0.5 truncate font-mono text-xs text-[var(--text-muted)]">
                /apps/{app.slug} ·{" "}
                {app.kind === "personal-agent" ? "Personal Agent" : "Web App"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label="Close workload inspector"
          >
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Sub-nav Tabs + Quick Lifecycle */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-5 py-2.5">
          <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setTab("overview")}
              className={`rounded-md px-3 py-1 font-medium transition ${
                tab === "overview"
                  ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setTab("logs")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition ${
                tab === "logs"
                  ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              Container Logs
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {!isRunning ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onLifecycle(app.slug, "start")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                <PlayIcon className="h-3.5 w-3.5" />
                Start
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onLifecycle(app.slug, "restart")}
                  className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                >
                  <RotateCcwIcon className="h-3.5 w-3.5" />
                  Restart
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onLifecycle(app.slug, "stop")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--danger)] transition hover:opacity-90 disabled:opacity-50"
                >
                  <SquareStopIcon className="h-3 w-3" />
                  Stop
                </button>
              </>
            )}
          </div>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === "overview" ? (
            <div className="space-y-5">
              {/* Public Endpoint / Network Card */}
              <div className="vps-card rounded-xl p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Ingress &amp; Network Boundary
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-[var(--success-border)] bg-[var(--success-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--success)]">
                    <ShieldIcon className="h-3 w-3" />
                    Locked Apartment
                  </span>
                </div>

                {app.domain ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[11px] text-[var(--text-muted)]">
                        Auto-TLS HTTPS Route (Caddy)
                      </p>
                      <a
                        href={`https://${app.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex items-center gap-1.5 truncate font-mono text-sm font-medium text-[var(--accent)] hover:underline"
                      >
                        https://{app.domain}
                        <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0" />
                      </a>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(`https://${app.domain}`);
                        onNotify("Copied HTTPS URL", "success", `https://${app.domain}`);
                      }}
                      className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs"
                    >
                      <CopyIcon className="h-3.5 w-3.5" />
                      Copy URL
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2.5 text-xs text-[var(--text-secondary)]">
                    Private internal container on <code className="font-mono text-[var(--accent)]">vps-os-core</code> bridge — no public HTTP port exposed.
                  </div>
                )}
              </div>

              {/* Resource Quotas */}
              <div className="vps-card rounded-xl p-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Container Resource Caps
                </span>
                <div className="mt-3.5 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--text-secondary)]">CPU Allocation</span>
                      <span className="tabular-nums font-mono font-semibold text-[var(--text-primary)]">
                        {app.cpuLimit} vCPU
                      </span>
                    </div>
                    <div className="mt-2">
                      <CapacityBar percent={cpuSharePct} tone="accent" />
                    </div>
                    <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                      {cpuSharePct}% of {totalHostCpus} host vCPU capacity
                    </p>
                  </div>

                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--text-secondary)]">Memory Ceiling</span>
                      <span className="tabular-nums font-mono font-semibold text-[var(--text-primary)]">
                        {formatMbToGb(app.memoryLimitMb)}
                      </span>
                    </div>
                    <div className="mt-2">
                      <CapacityBar
                        percent={ramSharePct}
                        tone={app.kind === "personal-agent" ? "violet" : "success"}
                      />
                    </div>
                    <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                      {ramSharePct}% of {formatMbToGb(totalHostMemoryMb)} host RAM
                    </p>
                  </div>
                </div>
              </div>

              {/* Isolation & Metadata */}
              <div className="vps-card rounded-xl p-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Isolation &amp; Lifecycle Details
                </span>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
                    <dt className="text-[11px] text-[var(--text-muted)]">Slug Identifier</dt>
                    <dd className="mt-0.5 font-mono text-[var(--text-primary)]">{app.slug}</dd>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
                    <dt className="text-[11px] text-[var(--text-muted)]">Workload Class</dt>
                    <dd className="mt-0.5 font-medium text-[var(--text-primary)]">
                      {app.kind === "personal-agent"
                        ? "Personal AI Agent"
                        : "Isolated Web App"}
                    </dd>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
                    <dt className="text-[11px] text-[var(--text-muted)]">Created</dt>
                    <dd className="mt-0.5 text-[var(--text-primary)]">
                      {formatRelativeTime(app.createdAt)}
                    </dd>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
                    <dt className="text-[11px] text-[var(--text-muted)]">Last Updated</dt>
                    <dd className="mt-0.5 text-[var(--text-primary)]">
                      {formatRelativeTime(app.updatedAt)}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* CTO Quick Actions */}
              <div className="vps-card rounded-xl p-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Autonomous CTO Assistance
                </span>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Ask your CTO Agent to inspect logs, resize resource quotas, or troubleshoot this workload in plain English.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onAskCto(
                        `Inspect the health and recent logs for ${app.name} (${app.slug}) and tell me if anything needs attention.`,
                      );
                    }}
                    className="vps-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium"
                  >
                    <MessageSquareIcon className="h-3.5 w-3.5" />
                    Diagnose with CTO
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onAskCto(
                        `Prepare a plan to adjust resource limits or update configuration for ${app.name} (${app.slug}).`,
                      );
                    }}
                    className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium"
                  >
                    Resize / Tune Quotas
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col gap-3">
              {/* Log Viewer Controls */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[180px] flex-1">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder="Filter log lines..."
                    className="vps-input w-full rounded-lg py-1.5 pr-3 pl-8 text-xs"
                  />
                </div>

                <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-[11px]">
                  {(["all", "info", "warn", "error"] as const).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => setLogLevel(lvl)}
                      className={`rounded-md px-2 py-1 font-medium uppercase transition ${
                        logLevel === lvl
                          ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                          : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>

                <select
                  aria-label="Log tail line count"
                  value={tail}
                  onChange={(e) => setTail(Number(e.target.value))}
                  className="vps-input rounded-lg px-2 py-1.5 text-xs"
                >
                  <option value={50}>50 lines</option>
                  <option value={100}>100 lines</option>
                  <option value={250}>250 lines</option>
                  <option value={500}>500 lines</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-3 text-[11px] text-[var(--text-secondary)]">
                  <label className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={autoFollow}
                      onChange={(e) => setAutoFollow(e.target.checked)}
                      className="rounded border-[var(--border-default)]"
                    />
                    Auto-refresh (5s)
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={wrapLines}
                      onChange={(e) => setWrapLines(e.target.checked)}
                      className="rounded border-[var(--border-default)]"
                    />
                    Wrap lines
                  </label>
                  <span className="tabular-nums text-[var(--text-muted)]">
                    {filteredLogs.length} / {logs.length} lines
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={logsLoading}
                    onClick={() => void fetchLogs()}
                    className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px]"
                  >
                    {logsLoading ? (
                      <SpinnerIcon className="h-3 w-3" />
                    ) : (
                      <RefreshIcon className="h-3 w-3" />
                    )}
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyLogs}
                    className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px]"
                  >
                    {copiedLogs ? (
                      <CheckCircleIcon className="h-3 w-3 text-[var(--success)]" />
                    ) : (
                      <CopyIcon className="h-3 w-3" />
                    )}
                    {copiedLogs ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadLogs}
                    className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px]"
                  >
                    <DownloadIcon className="h-3 w-3" />
                    Export
                  </button>
                </div>
              </div>

              {logsError && (
                <div
                  role="alert"
                  className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]"
                >
                  {logsError}
                </div>
              )}

              {/* Terminal Log Stream */}
              <div className="min-h-[340px] flex-1 overflow-auto rounded-xl border border-[var(--border-default)] bg-[#07090e] p-3 font-mono text-[11.5px] leading-relaxed text-slate-200">
                {logsLoading && logs.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 py-16 text-xs text-slate-400">
                    <SpinnerIcon className="h-4 w-4 text-sky-400" />
                    Fetching redacted container logs...
                  </div>
                ) : filteredLogs.length === 0 ? (
                  <div className="py-16 text-center text-xs text-slate-500">
                    {logs.length === 0
                      ? "No log lines returned by the container runtime."
                      : "No lines match your current search or level filter."}
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {filteredLogs.map((entry) => (
                      <div
                        key={entry.lineNumber}
                        className={`flex gap-3 rounded px-1.5 py-0.5 hover:bg-white/[0.04] ${
                          entry.level === "error"
                            ? "bg-rose-500/10 text-rose-200"
                            : entry.level === "warn"
                              ? "bg-amber-500/10 text-amber-200"
                              : "text-slate-200"
                        }`}
                      >
                        <span className="tabular-nums w-7 shrink-0 select-none text-right text-slate-600">
                          {entry.lineNumber}
                        </span>
                        <span
                          className={
                            wrapLines
                              ? "min-w-0 flex-1 whitespace-pre-wrap break-all"
                              : "whitespace-pre"
                          }
                        >
                          {entry.text}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                Secrets and credentials are automatically redacted server-side before logs leave the host runtime bridge.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
