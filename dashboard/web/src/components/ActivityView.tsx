import { useMemo, useState } from "react";
import {
  auditEventsToCsv,
  formatRelativeTime,
  triggerTextDownload,
} from "../lib/format";
import type { AuditEventView, ExecutionPlanView } from "../types";
import {
  ActivityIcon,
  CheckCircleIcon,
  DownloadIcon,
  SearchIcon,
  ShieldIcon,
  SpinnerIcon,
  TerminalIcon,
  XCircleIcon,
} from "./Icons";

interface ActivityViewProps {
  plans: ExecutionPlanView[];
  auditEvents: AuditEventView[];
  planBusyId: string | null;
  executionNotes: Record<string, string>;
  onApprovePlan: (planId: string) => void;
  onRejectPlan: (planId: string) => void;
  onExecutePlan: (planId: string) => void;
  onNotify: (title: string, tone?: "success" | "info" | "warning" | "error", description?: string) => void;
}

export function ActivityView({
  plans,
  auditEvents,
  planBusyId,
  executionNotes,
  onApprovePlan,
  onRejectPlan,
  onExecutePlan,
  onNotify,
}: ActivityViewProps) {
  const [section, setSection] = useState<"plans" | "audit">("plans");
  const [planFilter, setPlanFilter] = useState<
    "all" | "pending" | "approved" | "executed" | "rejected"
  >("all");

  // Audit Explorer Filters
  const [auditSearch, setAuditSearch] = useState("");
  const [actorFilter, setActorFilter] = useState<"all" | "user" | "agent" | "system">("all");
  const [riskFilter, setRiskFilter] = useState<"all" | "low" | "medium" | "high">("all");

  const planCounts = useMemo(() => {
    return {
      all: plans.length,
      pending: plans.filter((p) => p.status === "pending").length,
      approved: plans.filter((p) => p.status === "approved").length,
      executed: plans.filter((p) => p.status === "executed").length,
      rejected: plans.filter((p) => p.status === "rejected").length,
    };
  }, [plans]);

  const visiblePlans = useMemo(() => {
    if (planFilter === "all") return plans;
    return plans.filter((p) => (p.status ?? "pending") === planFilter);
  }, [planFilter, plans]);

  const filteredAudit = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    return auditEvents.filter((evt) => {
      if (actorFilter !== "all" && evt.actor !== actorFilter) return false;
      if (riskFilter !== "all" && evt.riskLevel !== riskFilter) return false;
      if (q) {
        const hay = `${evt.action} ${evt.summary} ${evt.targetSlug ?? ""} ${evt.actor}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [actorFilter, auditEvents, auditSearch, riskFilter]);

  function handleExportCsv() {
    const csv = auditEventsToCsv(filteredAudit);
    triggerTextDownload("vps-os-audit-trail.csv", csv, "text/csv;charset=utf-8");
    onNotify(
      "Exported Audit Trail CSV",
      "success",
      `${filteredAudit.length} audit event${filteredAudit.length === 1 ? "" : "s"} downloaded.`,
    );
  }

  function handleExportJson() {
    const json = JSON.stringify(filteredAudit, null, 2);
    triggerTextDownload(
      "vps-os-audit-trail.json",
      json,
      "application/json;charset=utf-8",
    );
    onNotify(
      "Exported Audit Trail JSON",
      "success",
      `${filteredAudit.length} audit event${filteredAudit.length === 1 ? "" : "s"} downloaded.`,
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
            Approvals &amp; Audit Governance
          </h1>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Every host mutation passes through an explicit approval gate and writes a secret-redacted immutable audit record.
          </p>
        </div>

        {/* Section Switcher */}
        <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1 text-xs">
          <button
            type="button"
            onClick={() => setSection("plans")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 font-medium transition ${
              section === "plans"
                ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            <ShieldIcon className="h-3.5 w-3.5 text-[var(--warning)]" />
            Execution Plans
            {planCounts.pending > 0 && (
              <span className="tabular-nums rounded-full bg-amber-500/20 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-[var(--warning)]">
                {planCounts.pending}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setSection("audit")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 font-medium transition ${
              section === "audit"
                ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            <ActivityIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
            Audit Trail
            <span className="tabular-nums rounded-full bg-[var(--bg-inset)] px-1.5 py-0.2 font-mono text-[10px] text-[var(--text-muted)]">
              {auditEvents.length}
            </span>
          </button>
        </div>
      </div>

      {/* EXECUTION PLANS QUEUE */}
      {section === "plans" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: "all", label: "All Plans", count: planCounts.all },
                { id: "pending", label: "Pending Approval", count: planCounts.pending },
                { id: "approved", label: "Ready to Execute", count: planCounts.approved },
                { id: "executed", label: "Executed", count: planCounts.executed },
                { id: "rejected", label: "Rejected", count: planCounts.rejected },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setPlanFilter(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                  planFilter === tab.id
                    ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                }`}
              >
                <span>{tab.label}</span>
                <span className="tabular-nums rounded bg-[var(--bg-inset)] px-1.5 py-0.2 font-mono text-[10px] text-[var(--text-muted)]">
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {visiblePlans.length === 0 ? (
            <div className="vps-card flex flex-col items-center justify-center rounded-2xl px-6 py-14 text-center">
              <ShieldIcon className="h-8 w-8 text-[var(--text-muted)]" />
              <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                No execution plans in this queue
              </p>
              <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">
                When you deploy a workload or ask the CTO Agent to change server state, risk-classified plans appear here for approval.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {visiblePlans.map((plan) => {
                const status = plan.status ?? "pending";
                const busy = planBusyId === plan.id;
                const badgeTone =
                  status === "pending"
                    ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
                    : status === "approved"
                      ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : status === "executed"
                        ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                        : "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]";

                return (
                  <article
                    key={plan.id}
                    className="vps-card overflow-hidden rounded-2xl"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-5 py-3.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold capitalize ${badgeTone}`}
                          >
                            {status}
                          </span>
                          <span className="font-mono text-[11px] text-[var(--text-muted)]">
                            {plan.id}
                          </span>
                          {plan.createdAt && (
                            <span className="text-[11px] text-[var(--text-muted)]">
                              · {formatRelativeTime(plan.createdAt)}
                            </span>
                          )}
                        </div>
                        <h3 className="mt-1.5 text-sm font-semibold text-[var(--text-primary)]">
                          {plan.goal}
                        </h3>
                        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                          {plan.summary}
                        </p>
                      </div>

                      {plan.decidedBy && (
                        <div className="text-right text-[11px] text-[var(--text-muted)]">
                          <p>Decided by {plan.decidedBy}</p>
                          {plan.decidedAt && (
                            <p>{formatRelativeTime(plan.decidedAt)}</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="space-y-3 p-5">
                      <ol className="space-y-2">
                        {plan.steps.map((step, idx) => (
                          <li
                            key={step.id}
                            className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-xs"
                          >
                            <span className="tabular-nums mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] font-mono text-[10.5px] font-semibold text-[var(--text-secondary)]">
                              {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-[var(--text-primary)]">
                                  {step.title}
                                </span>
                                {step.toolName && (
                                  <span className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                                    {step.toolName}
                                  </span>
                                )}
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                                    step.riskLevel === "high"
                                      ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                                      : step.riskLevel === "medium"
                                        ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                                        : "bg-[var(--success-soft)] text-[var(--success)]"
                                  }`}
                                >
                                  {step.riskLevel} risk
                                </span>
                              </div>
                              <p className="mt-1 text-[11.5px] text-[var(--text-secondary)]">
                                {step.description}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>

                      {status === "pending" && (
                        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onRejectPlan(plan.id)}
                            className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-medium text-[var(--danger)]"
                          >
                            <XCircleIcon className="h-3.5 w-3.5" />
                            Reject Plan
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onApprovePlan(plan.id)}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                          >
                            <CheckCircleIcon className="h-3.5 w-3.5" />
                            {busy ? "Approving..." : "Approve Plan"}
                          </button>
                        </div>
                      )}

                      {status === "approved" && (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] px-4 py-3">
                          <span className="text-xs text-[var(--text-primary)]">
                            Approved and ready to execute safely via the host runtime bridge.
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onExecutePlan(plan.id)}
                            className="vps-btn-primary inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold"
                          >
                            {busy ? (
                              <SpinnerIcon className="h-3.5 w-3.5" />
                            ) : (
                              <TerminalIcon className="h-3.5 w-3.5" />
                            )}
                            {busy ? "Executing..." : "Execute Approved Plan"}
                          </button>
                        </div>
                      )}

                      {executionNotes[plan.id] && (
                        <div className="rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] px-3.5 py-2.5 text-xs text-[var(--success)]">
                          {executionNotes[plan.id]}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* AUDIT TRAIL EXPLORER */}
      {section === "audit" && (
        <div className="space-y-4">
          <div className="vps-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3">
            <div className="flex min-w-[220px] flex-1 flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1 max-w-sm">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  value={auditSearch}
                  onChange={(e) => setAuditSearch(e.target.value)}
                  placeholder="Search action, workload slug, or summary..."
                  className="vps-input w-full rounded-xl py-2 pr-3 pl-8.5 text-xs"
                />
              </div>

              <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-[11.5px]">
                {(["all", "user", "agent", "system"] as const).map((actor) => (
                  <button
                    key={actor}
                    type="button"
                    onClick={() => setActorFilter(actor)}
                    className={`rounded-lg px-2.5 py-1 font-medium capitalize transition ${
                      actorFilter === actor
                        ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {actor}
                  </button>
                ))}
              </div>

              <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-[11.5px]">
                {(["all", "low", "medium", "high"] as const).map((risk) => (
                  <button
                    key={risk}
                    type="button"
                    onClick={() => setRiskFilter(risk)}
                    className={`rounded-lg px-2.5 py-1 font-medium capitalize transition ${
                      riskFilter === risk
                        ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {risk}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={filteredAudit.length === 0}
                onClick={handleExportCsv}
                className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium"
              >
                <DownloadIcon className="h-3.5 w-3.5" />
                CSV
              </button>
              <button
                type="button"
                disabled={filteredAudit.length === 0}
                onClick={handleExportJson}
                className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium"
              >
                <DownloadIcon className="h-3.5 w-3.5" />
                JSON
              </button>
            </div>
          </div>

          <div className="vps-card overflow-x-auto rounded-2xl">
            {filteredAudit.length === 0 ? (
              <div className="px-6 py-14 text-center text-xs text-[var(--text-muted)]">
                No audit events match your filters.
              </div>
            ) : (
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Actor</th>
                    <th className="px-4 py-3">Action &amp; Summary</th>
                    <th className="px-4 py-3">Target</th>
                    <th className="px-4 py-3 text-right">Risk</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {filteredAudit.map((evt) => (
                    <tr key={evt.id} className="hover:bg-[var(--bg-hover)]">
                      <td className="tabular-nums whitespace-nowrap px-4 py-3 text-[11px] text-[var(--text-muted)]">
                        <div>{formatRelativeTime(evt.createdAt)}</div>
                        <div className="font-mono text-[10px]">
                          {new Date(evt.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10.5px] font-medium capitalize ${
                            evt.actor === "agent"
                              ? "border-[var(--violet-border)] bg-[var(--violet-soft)] text-[var(--violet)]"
                              : evt.actor === "user"
                                ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                                : "border-[var(--border-default)] bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                          }`}
                        >
                          {evt.actor}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-mono text-[11.5px] font-medium text-[var(--text-primary)]">
                          {evt.action}
                        </p>
                        <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
                          {evt.summary}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {evt.targetSlug ? (
                          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                            {evt.targetSlug}
                          </span>
                        ) : (
                          <span className="text-[var(--text-muted)]">host</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            evt.riskLevel === "high"
                              ? "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
                              : evt.riskLevel === "medium"
                                ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
                                : "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                          }`}
                        >
                          {evt.riskLevel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
