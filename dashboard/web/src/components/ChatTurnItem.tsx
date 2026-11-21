import { useEffect, useMemo, useState } from "react";
import {
  formatBytes,
  formatDuration,
  providerDisplayName,
} from "../lib/format";
import type {
  ChatAttachmentView,
  ChatMessageView,
  ChatReasoningBlockView,
  ChatToolCallView,
  ExecutionPlanView,
} from "../types";
import {
  BrainIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  FileTextIcon,
  GitForkIcon,
  ImageIcon,
  RotateCcwIcon,
  ShieldIcon,
  SparklesIcon,
  SpinnerIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "./Icons";
import { MarkdownContent } from "./MarkdownContent";

interface ChatTurnItemProps {
  message: ChatMessageView;
  isLatestAssistant: boolean;
  linkedPlan: ExecutionPlanView | null;
  streaming: boolean;
  elapsedMs: number;
  planBusyId: string | null;
  executionSummary?: string | undefined;
  authHeaders: () => Record<string, string>;
  onOpenLightbox: (src: string) => void;
  onEditAndResend: (messageId: string, newContent: string) => void;
  onRegenerate: (assistantMessageId: string) => void;
  onForkFromMessage: (messageId: string) => void;
  onApprovePlan: (planId: string) => void;
  onRejectPlan: (planId: string) => void;
  onExecutePlan: (planId: string) => void;
  onQuickReply?: (text: string) => void;
}

interface ClarifyingQuestion {
  question: string;
  options: string[];
}

function parseClarifyingQuestions(content: string): {
  cleanContent: string;
  questions: ClarifyingQuestion[];
} {
  const match = content.match(/```vps-questions\s*\n([\s\S]*?)\n```\s*$/);
  if (!match?.[1]) {
    return { cleanContent: content, questions: [] };
  }
  try {
    const parsed = JSON.parse(match[1]) as {
      questions?: Array<{ question?: unknown; options?: unknown }>;
    };
    const questions: ClarifyingQuestion[] = [];
    if (Array.isArray(parsed.questions)) {
      for (const item of parsed.questions.slice(0, 3)) {
        if (typeof item?.question !== "string" || !item.question.trim()) continue;
        const options = Array.isArray(item.options)
          ? item.options
              .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
              .slice(0, 5)
          : [];
        if (options.length > 0) {
          questions.push({ question: item.question.trim(), options });
        }
      }
    }
    if (questions.length === 0) {
      return { cleanContent: content, questions: [] };
    }
    return {
      cleanContent: content.slice(0, match.index).trimEnd(),
      questions,
    };
  } catch {
    return { cleanContent: content, questions: [] };
  }
}

/** Loads an authenticated attachment image via Bearer headers and caches a blob URL. */
function AuthAttachmentImage({
  attachment,
  authHeaders,
  onClick,
}: {
  attachment: ChatAttachmentView;
  authHeaders: () => Record<string, string>;
  onClick?: (src: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(attachment.localPreviewUrl ?? null);

  useEffect(() => {
    if (attachment.localPreviewUrl) {
      setSrc(attachment.localPreviewUrl);
      return;
    }
    let active = true;
    let createdUrl: string | null = null;

    void fetch(attachment.url, { headers: authHeaders() })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!active || !blob) return;
        createdUrl = URL.createObjectURL(blob);
        setSrc(createdUrl);
      })
      .catch(() => {
        // ignore preview fetch errors
      });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [attachment.localPreviewUrl, attachment.url, authHeaders]);

  if (!src) {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-muted)]">
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onClick?.(src)}
      className="group relative overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-inset)] transition hover:border-[var(--accent)]"
      title={`Preview ${attachment.name}`}
    >
      <img
        src={src}
        alt={attachment.name}
        className="h-16 w-16 object-cover"
      />
    </button>
  );
}

/** Collapsible reasoning trace disclosure. */
function ReasoningTraceCard({ block }: { block: ChatReasoningBlockView }) {
  const isStreaming = block.status === "streaming";
  const [expanded, setExpanded] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) setExpanded(true);
  }, [isStreaming]);

  const label = isStreaming
    ? `${block.title}...`
    : block.durationMs > 0
      ? `${block.title} · ${formatDuration(block.durationMs)}`
      : block.title;

  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
      >
        {isStreaming ? (
          <span className="inline-flex h-4 w-4 items-center justify-center">
            <span className="h-2 w-2 rounded-full bg-[var(--violet)] animate-pulse-dot" />
          </span>
        ) : (
          <BrainIcon className="h-3.5 w-3.5 shrink-0 text-[var(--violet)]" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {expanded ? (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        )}
      </button>
      {expanded && block.content && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-2.5">
          <div className="border-l-2 border-[var(--violet-border)] pl-3 text-[12px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap">
            {block.content}
          </div>
        </div>
      )}
    </div>
  );
}

/** Expandable tool call row with Input/Output JSON inspector. */
function ToolCallCard({ toolCall }: { toolCall: ChatToolCallView }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const outputText =
    toolCall.output !== undefined
      ? typeof toolCall.output === "string"
        ? toolCall.output
        : JSON.stringify(toolCall.output, null, 2)
      : null;

  function copyOutput() {
    if (!outputText) return;
    void navigator.clipboard?.writeText(outputText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition hover:bg-[var(--bg-hover)]"
      >
        {toolCall.status === "running" && (
          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        )}
        {toolCall.status === "success" && (
          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
        )}
        {toolCall.status === "awaiting_approval" && (
          <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
        )}
        {toolCall.status === "error" && (
          <XCircleIcon className="h-3.5 w-3.5 shrink-0 text-[var(--danger)]" />
        )}

        <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
          {toolCall.label}
        </span>

        <span className="hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-muted)] sm:inline">
          {toolCall.toolName}
        </span>

        {toolCall.durationMs !== null && (
          <span className="tabular-nums shrink-0 font-mono text-[10.5px] text-[var(--text-muted)]">
            {formatDuration(toolCall.durationMs)}
          </span>
        )}

        {expanded ? (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-[11.5px]">
          {Object.keys(toolCall.input ?? {}).length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                Input
              </p>
              <pre className="max-h-36 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 font-mono text-[11px] text-[var(--text-primary)]">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}

          {toolCall.error && (
            <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-xs text-[var(--danger)]">
              {toolCall.error}
            </div>
          )}

          {outputText && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  Output
                </p>
                <button
                  type="button"
                  onClick={copyOutput}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <CopyIcon className="h-3 w-3" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-primary)]">
                {outputText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline Execution Plan approval & execution card embedded directly inside an agent turn. */
function InlinePlanCard({
  plan,
  busy,
  executionSummary,
  onApprove,
  onReject,
  onExecute,
}: {
  plan: ExecutionPlanView;
  busy: boolean;
  executionSummary?: string | undefined;
  onApprove: (planId: string) => void;
  onReject: (planId: string) => void;
  onExecute: (planId: string) => void;
}) {
  const statusStyles: Record<string, string> = {
    pending:
      "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]",
    approved:
      "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]",
    executed:
      "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]",
    rejected:
      "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]",
  };
  const status = plan.status ?? "pending";

  return (
    <div className="vps-card overflow-hidden rounded-2xl border-[var(--warning-border)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--warning-soft)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldIcon className="h-4 w-4 text-[var(--warning)]" />
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            Execution Plan
          </span>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold capitalize ${
            statusStyles[status] ?? statusStyles.pending
          }`}
        >
          {status}
        </span>
      </div>

      <div className="space-y-3 p-4">
        <p className="text-xs text-[var(--text-secondary)]">{plan.summary}</p>
        <ol className="space-y-2">
          {plan.steps.map((step, index) => (
            <li
              key={step.id}
              className="flex items-start gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2.5 text-xs"
            >
              <span className="tabular-nums mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] font-mono text-[10px] font-semibold text-[var(--text-secondary)]">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
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
                    {step.riskLevel}
                  </span>
                </div>
                <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
                  {step.description}
                </p>
              </div>
            </li>
          ))}
        </ol>

        {plan.requiresUserApproval && status === "pending" && (
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove(plan.id)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              <CheckCircleIcon className="h-3.5 w-3.5" />
              {busy ? "Approving & executing..." : "Approve & Execute"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReject(plan.id)}
              className="vps-btn-secondary inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-[var(--danger)]"
            >
              <XCircleIcon className="h-3.5 w-3.5" />
              Reject
            </button>
          </div>
        )}

        {status === "approved" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] p-3">
            <span className="text-[11.5px] text-[var(--text-primary)]">
              Approved and ready to execute via the host runtime bridge.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onExecute(plan.id)}
              className="vps-btn-primary inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
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

        {executionSummary && (
          <div className="rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] px-3 py-2 text-xs text-[var(--success)]">
            {executionSummary}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatTurnItem({
  message,
  isLatestAssistant,
  linkedPlan,
  streaming,
  elapsedMs,
  planBusyId,
  executionSummary,
  authHeaders,
  onOpenLightbox,
  onEditAndResend,
  onRegenerate,
  onForkFromMessage,
  onApprovePlan,
  onRejectPlan,
  onExecutePlan,
  onQuickReply,
}: ChatTurnItemProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftEdit, setDraftEdit] = useState(message.content);
  const [timelineExpanded, setTimelineExpanded] = useState(true);
  const { cleanContent, questions } = useMemo(
    () => parseClarifyingQuestions(message.content),
    [message.content],
  );

  useEffect(() => {
    if (message.status === "streaming") {
      setTimelineExpanded(true);
    }
  }, [message.status]);

  function handleCopy() {
    void navigator.clipboard?.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (message.role === "user") {
    return (
      <div className="group/user flex flex-col items-end gap-1.5">
        {editing ? (
          <div className="vps-card w-full max-w-[90%] rounded-2xl p-3">
            <textarea
              value={draftEdit}
              onChange={(e) => setDraftEdit(e.target.value)}
              rows={3}
              autoFocus
              className="vps-input w-full resize-none rounded-xl px-3 py-2 text-[13px]"
            />
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--text-muted)]">
                Re-running replaces responses after this prompt
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraftEdit(message.content);
                  }}
                  className="vps-btn-secondary rounded-lg px-2.5 py-1 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!draftEdit.trim() || streaming}
                  onClick={() => {
                    setEditing(false);
                    onEditAndResend(message.id, draftEdit.trim());
                  }}
                  className="vps-btn-primary rounded-lg px-3 py-1 text-xs font-semibold"
                >
                  Save &amp; Resend
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="vps-card max-w-[85%] space-y-2 rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed text-[var(--text-primary)]">
            {message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 pb-1">
                {message.attachments.map((att) =>
                  att.kind === "image" ? (
                    <AuthAttachmentImage
                      key={att.id}
                      attachment={att}
                      authHeaders={authHeaders}
                      onClick={onOpenLightbox}
                    />
                  ) : (
                    <div
                      key={att.id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)]"
                    >
                      <FileTextIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                      <span className="max-w-[180px] truncate font-medium">
                        {att.name}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {formatBytes(att.sizeBytes)}
                      </span>
                    </div>
                  ),
                )}
              </div>
            )}
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        )}

        {!editing && (
          <div className="flex items-center gap-1 opacity-0 transition group-hover/user:opacity-100">
            <button
              type="button"
              disabled={streaming}
              onClick={() => {
                setDraftEdit(message.content);
                setEditing(true);
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
              title="Edit prompt and rerun from here"
            >
              <EditIcon className="h-3 w-3" />
              Edit
            </button>
            <button
              type="button"
              disabled={streaming}
              onClick={() => onForkFromMessage(message.id)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--violet)] disabled:opacity-40"
              title="Fork new thread from this turn"
            >
              <GitForkIcon className="h-3 w-3" />
              Fork
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {copied ? (
                <CheckCircleIcon className="h-3 w-3 text-[var(--success)]" />
              ) : (
                <CopyIcon className="h-3 w-3" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>
    );
  }

  const totalReasoningMs = message.reasoning.reduce(
    (sum, b) => sum + (b.durationMs || 0),
    0,
  );
  const hasActivity = message.reasoning.length > 0 || message.toolCalls.length > 0;

  return (
    <div className="group/turn space-y-3">
      {/* Assistant Turn Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <SparklesIcon className="h-3.5 w-3.5" />
          </span>
          <span className="font-semibold text-[var(--text-primary)]">
            {providerDisplayName(message.provider)}
          </span>
          {message.model && (
            <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-secondary)]">
              {message.model}
            </span>
          )}
          {message.status === "streaming" ? (
            <span className="tabular-nums inline-flex items-center gap-1.5 rounded-full border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent)]">
              <SpinnerIcon className="h-3 w-3" />
              Working · {(elapsedMs / 1000).toFixed(1)}s
            </span>
          ) : (
            <span className="tabular-nums">
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>

        {/* T3-Code Per-Turn Action Controls */}
        {message.status !== "streaming" && (
          <div className="flex items-center gap-1 opacity-0 transition group-hover/turn:opacity-100">
            {message.content && (
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                title="Copy Markdown response"
              >
                {copied ? (
                  <>
                    <CheckCircleIcon className="h-3 w-3 text-[var(--success)]" />
                    Copied
                  </>
                ) : (
                  <>
                    <CopyIcon className="h-3 w-3" />
                    Copy
                  </>
                )}
              </button>
            )}
            {isLatestAssistant && (
              <button
                type="button"
                disabled={streaming}
                onClick={() => onRegenerate(message.id)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] disabled:opacity-40"
                title="Regenerate response with current model & effort"
              >
                <RotateCcwIcon className="h-3 w-3" />
                Retry
              </button>
            )}
            <button
              type="button"
              disabled={streaming}
              onClick={() => onForkFromMessage(message.id)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--violet)] disabled:opacity-40"
              title="Fork new thread from this response"
            >
              <GitForkIcon className="h-3 w-3" />
              Fork
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2.5 pl-8">
        {/* Unified Collapsible Activity Summary Bar (Reasoning + Tools) */}
        {hasActivity && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setTimelineExpanded((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <WrenchIcon className="h-3 w-3 text-[var(--accent)]" />
              <span>
                {message.reasoning.length > 0 &&
                  `Thought${totalReasoningMs > 0 ? ` ${formatDuration(totalReasoningMs)}` : ""}`}
                {message.reasoning.length > 0 && message.toolCalls.length > 0 && " · "}
                {message.toolCalls.length > 0 &&
                  `${message.toolCalls.length} tool${message.toolCalls.length === 1 ? "" : "s"}`}
              </span>
              {timelineExpanded ? (
                <ChevronDownIcon className="h-3 w-3 text-[var(--text-muted)]" />
              ) : (
                <ChevronRightIcon className="h-3 w-3 text-[var(--text-muted)]" />
              )}
            </button>

            {timelineExpanded && (
              <div className="space-y-2">
                {message.reasoning.map((block) => (
                  <ReasoningTraceCard key={block.id} block={block} />
                ))}
                {message.toolCalls.map((toolCall) => (
                  <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Markdown Answer Body */}
        {cleanContent && (
          <div className="pt-0.5">
            <MarkdownContent content={cleanContent} />
          </div>
        )}

        {/* Interactive Clarifying Questions (clickable quick replies) */}
        {questions.length > 0 && !linkedPlan && (
          <div className="vps-card space-y-2.5 rounded-2xl border-[var(--accent-border)] bg-[var(--bg-inset)] p-3.5">
            {questions.map((q) => (
              <div key={q.question} className="space-y-1.5">
                <p className="text-xs font-medium text-[var(--text-primary)]">
                  {q.question}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      disabled={streaming || !onQuickReply}
                      onClick={() => onQuickReply?.(opt)}
                      className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:opacity-40"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Inline Execution Plan Card (always at the end of the turn) */}
        {linkedPlan && (
          <InlinePlanCard
            plan={linkedPlan}
            busy={planBusyId === linkedPlan.id}
            executionSummary={executionSummary}
            onApprove={onApprovePlan}
            onReject={onRejectPlan}
            onExecute={onExecutePlan}
          />
        )}
      </div>
    </div>
  );
}
