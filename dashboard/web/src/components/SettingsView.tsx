import { useState } from "react";
import { formatRelativeTime, providerDisplayName } from "../lib/format";
import type {
  ApprovalMode,
  DnsCheckView,
  OnboardingPayload,
  ThemeMode,
} from "../types";
import {
  CheckCircleIcon,
  CopyIcon,
  GlobeIcon,
  LockIcon,
  MoonIcon,
  RefreshIcon,
  ShieldIcon,
  SlidersIcon,
  SparklesIcon,
  SpinnerIcon,
  SunIcon,
} from "./Icons";

interface SettingsViewProps {
  onboardingPayload: OnboardingPayload | null;
  theme: ThemeMode;
  pollIntervalMs: number;
  canLock: boolean;
  authHeaders: () => Record<string, string>;
  onChangeTheme: (theme: ThemeMode) => void;
  onChangePollInterval: (ms: number) => void;
  onOpenSetupWizard: () => void;
  onRefreshState: () => Promise<void>;
  onLock: () => void;
  onNotify: (title: string, tone?: "success" | "info" | "warning" | "error", description?: string) => void;
}

export function SettingsView({
  onboardingPayload,
  theme,
  pollIntervalMs,
  canLock,
  authHeaders,
  onChangeTheme,
  onChangePollInterval,
  onOpenSetupWizard,
  onRefreshState,
  onLock,
  onNotify,
}: SettingsViewProps) {
  const [scanning, setScanning] = useState(false);
  const [verifyingDns, setVerifyingDns] = useState(false);
  const [savingApproval, setSavingApproval] = useState(false);
  const [dnsMessage, setDnsMessage] = useState<string | null>(null);

  async function handleChangeApprovalMode(nextMode: ApprovalMode) {
    setSavingApproval(true);
    try {
      const res = await fetch("/api/onboarding/approval-mode", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ approvalMode: nextMode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await onRefreshState();
      onNotify(
        nextMode === "yolo"
          ? "YOLO Sandbox mode enabled"
          : `Approval mode set to ${nextMode}`,
        nextMode === "yolo" ? "warning" : "success",
      );
    } catch (err) {
      onNotify(
        "Failed to update approval mode",
        "error",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSavingApproval(false);
    }
  }

  const state = onboardingPayload?.state;
  const hermes = onboardingPayload?.hermesStatus;
  const baseline = state?.baselineScan;

  async function handleRunBaselineScan() {
    setScanning(true);
    try {
      const res = await fetch("/api/onboarding/baseline-scan", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Scan failed (${res.status})`);
      }
      await onRefreshState();
      onNotify(
        "Baseline health scan completed",
        "success",
        "Refreshed server checks and synced Hermes MEMORY.md.",
      );
    } catch (err) {
      onNotify(
        "Baseline scan failed",
        "error",
        err instanceof Error ? err.message : "Could not run server scan.",
      );
    } finally {
      setScanning(false);
    }
  }

  async function handleVerifyDns() {
    if (!state?.domain) return;
    setVerifyingDns(true);
    setDnsMessage(null);
    try {
      const res = await fetch("/api/onboarding/domain/verify", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ domain: state.domain }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `DNS verification failed (${res.status})`);
      }
      const data = (await res.json()) as { dnsCheck: DnsCheckView };
      setDnsMessage(data.dnsCheck.message);
      await onRefreshState();
      onNotify(
        data.dnsCheck.matches ? "DNS verified" : "DNS propagation pending",
        data.dnsCheck.matches ? "success" : "warning",
        data.dnsCheck.message,
      );
    } catch (err) {
      onNotify(
        "DNS check failed",
        "error",
        err instanceof Error ? err.message : "Could not query DNS.",
      );
    } finally {
      setVerifyingDns(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
            System Health &amp; Settings
          </h1>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Manage server baseline diagnostics, Caddy Auto-TLS ingress, Autonomous CTO brain configuration, and workspace preferences.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenSetupWizard}
          className="vps-btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold"
        >
          <SlidersIcon className="h-3.5 w-3.5" />
          Open Full Setup Wizard
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Baseline Health Scan (7 cols) */}
        <section className="vps-card rounded-2xl p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]">
                <ShieldIcon className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Server Readiness &amp; Security Baseline
                </h2>
                <p className="text-[11.5px] text-[var(--text-muted)]">
                  {baseline
                    ? `Last scanned ${formatRelativeTime(baseline.scannedAt)} · ${baseline.osRelease}`
                    : "No baseline scan recorded yet"}
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={scanning}
              onClick={() => void handleRunBaselineScan()}
              className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium"
            >
              {scanning ? (
                <SpinnerIcon className="h-3.5 w-3.5" />
              ) : (
                <RefreshIcon className="h-3.5 w-3.5" />
              )}
              {scanning ? "Scanning..." : "Run Fresh Scan"}
            </button>
          </div>

          {baseline ? (
            <div className="mt-4 space-y-2.5">
              {baseline.checks.map((check) => (
                <div
                  key={check.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-4 py-3 text-xs"
                >
                  <div>
                    <p className="font-semibold text-[var(--text-primary)]">
                      {check.label}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
                      {check.detail}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase ${
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
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-inset)] p-6 text-center text-xs text-[var(--text-muted)]">
              Run a fresh baseline scan to verify firewall rules, Docker isolation, TLS certificates, and seed Hermes CTO memory.
            </div>
          )}
        </section>

        {/* Ingress & Domain + AI Brain (5 cols) */}
        <div className="space-y-6 lg:col-span-5">
          {/* Domain & Ingress Card */}
          <section className="vps-card rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <GlobeIcon className="h-4 w-4 text-[var(--accent)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Ingress, Domain &amp; Auto-TLS
                </h2>
              </div>
              <button
                type="button"
                onClick={onOpenSetupWizard}
                className="text-xs font-medium text-[var(--accent)] hover:underline"
              >
                Edit
              </button>
            </div>

            <dl className="mt-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5">
                <dt className="text-[var(--text-muted)]">Dashboard Domain</dt>
                <dd className="flex items-center gap-1.5 font-mono font-medium text-[var(--text-primary)]">
                  {state?.domain ?? "IP Setup Mode (:80)"}
                  {state?.dnsVerified && (
                    <CheckCircleIcon className="h-3.5 w-3.5 text-[var(--success)]" />
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5">
                <dt className="text-[var(--text-muted)]">Server Public IP</dt>
                <dd className="flex items-center gap-1.5 font-mono text-[var(--text-primary)]">
                  <span>{state?.publicIp ?? "Local / Private"}</span>
                  {state?.publicIp && (
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(state.publicIp ?? "");
                        onNotify("Copied server IP", "success", state.publicIp ?? undefined);
                      }}
                      className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      aria-label="Copy public IP"
                    >
                      <CopyIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5">
                <dt className="text-[var(--text-muted)]">Let&apos;s Encrypt Email</dt>
                <dd className="truncate text-[var(--text-secondary)]">
                  {state?.acmeEmail ?? "Not set"}
                </dd>
              </div>
            </dl>

            {dnsMessage && (
              <p className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-[11.5px] text-[var(--text-secondary)]">
                {dnsMessage}
              </p>
            )}

            {state?.domain && (
              <button
                type="button"
                disabled={verifyingDns}
                onClick={() => void handleVerifyDns()}
                className="vps-btn-secondary mt-3.5 w-full rounded-xl py-2 text-xs font-medium"
              >
                {verifyingDns ? "Verifying DNS..." : "Re-verify DNS A Record"}
              </button>
            )}
          </section>

          {/* AI CTO Brain & Mobile Channels */}
          <section className="vps-card rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <SparklesIcon className="h-4 w-4 text-[var(--violet)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Autonomous CTO Brain
                </h2>
              </div>
              <button
                type="button"
                onClick={onOpenSetupWizard}
                className="text-xs font-medium text-[var(--accent)] hover:underline"
              >
                Configure
              </button>
            </div>

            <dl className="mt-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5">
                <dt className="text-[var(--text-muted)]">Provider &amp; Model</dt>
                <dd className="truncate font-mono font-medium text-[var(--text-primary)]">
                  {state?.llmConfigured
                    ? `${providerDisplayName(state.llmProvider)} · ${state.llmModel}`
                    : "Not connected"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5">
                <dt className="text-[var(--text-muted)]">Hermes Gateway</dt>
                <dd
                  className={`font-medium ${
                    hermes?.reachable ? "text-[var(--success)]" : "text-[var(--text-muted)]"
                  }`}
                >
                  {hermes?.reachable ? "Online & Connected" : hermes?.detail ?? "Standby"}
                </dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5">
                <dt className="text-[var(--text-muted)]">Approval Guardrail</dt>
                <dd className="flex items-center gap-1">
                  {(
                    [
                      { id: "manual", label: "Manual" },
                      { id: "smart", label: "Smart" },
                      { id: "yolo", label: "YOLO" },
                    ] as const
                  ).map((opt) => {
                    const active = (state?.persona.approvalMode ?? "manual") === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={savingApproval}
                        onClick={() => void handleChangeApprovalMode(opt.id)}
                        className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition ${
                          active
                            ? opt.id === "yolo"
                              ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
                              : "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                            : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5">
                <dt className="text-[var(--text-muted)]">Mobile Channels</dt>
                <dd className="flex items-center gap-1.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                      state?.telegramConfigured
                        ? "bg-[var(--success-soft)] text-[var(--success)]"
                        : "bg-[var(--bg-surface)] text-[var(--text-muted)]"
                    }`}
                  >
                    Telegram {state?.telegramConfigured ? "On" : "Off"}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                      state?.discordConfigured
                        ? "bg-[var(--success-soft)] text-[var(--success)]"
                        : "bg-[var(--bg-surface)] text-[var(--text-muted)]"
                    }`}
                  >
                    Discord {state?.discordConfigured ? "On" : "Off"}
                  </span>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      {/* Workspace Appearance, Telemetry Cadence & Security */}
      <section className="grid gap-6 md:grid-cols-2">
        <div className="vps-card rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Dashboard Appearance
          </h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Choose your preferred workspace contrast mode. Saved automatically in this browser.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => onChangeTheme("dark")}
              className={`flex flex-col gap-2 rounded-xl border p-3.5 text-left transition ${
                theme === "dark"
                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                  : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="flex items-center justify-between">
                <MoonIcon className="h-4 w-4 text-[var(--accent)]" />
                {theme === "dark" && (
                  <CheckCircleIcon className="h-4 w-4 text-[var(--accent)]" />
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text-primary)]">
                  Obsidian Studio
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Low-glare dark operations surface
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onChangeTheme("light")}
              className={`flex flex-col gap-2 rounded-xl border p-3.5 text-left transition ${
                theme === "light"
                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                  : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="flex items-center justify-between">
                <SunIcon className="h-4 w-4 text-[var(--warning)]" />
                {theme === "light" && (
                  <CheckCircleIcon className="h-4 w-4 text-[var(--accent)]" />
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-[var(--text-primary)]">
                  Porcelain Cloud
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Crisp daylight architectural mode
                </p>
              </div>
            </button>
          </div>
        </div>

        <div className="vps-card flex flex-col justify-between rounded-2xl p-5">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Live Telemetry &amp; Session Controls
            </h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Adjust how often live CPU, memory, disk, and workload state sync from the Control API.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {[
                { ms: 5_000, label: "Live (5s)" },
                { ms: 15_000, label: "Balanced (15s)" },
                { ms: 30_000, label: "Relaxed (30s)" },
                { ms: 0, label: "Manual Only" },
              ].map((opt) => (
                <button
                  key={opt.ms}
                  type="button"
                  onClick={() => onChangePollInterval(opt.ms)}
                  className={`rounded-xl border px-3 py-2 text-xs font-medium transition ${
                    pollIntervalMs === opt.ms
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4 text-xs">
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <span>Command Palette:</span>
              <kbd className="vps-kbd">Ctrl</kbd>
              <span>+</span>
              <kbd className="vps-kbd">K</kbd>
            </div>
            {canLock && (
              <button
                type="button"
                onClick={onLock}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3.5 py-1.5 text-xs font-medium text-[var(--danger)] transition hover:opacity-90"
              >
                <LockIcon className="h-3.5 w-3.5" />
                Lock Dashboard Session
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
