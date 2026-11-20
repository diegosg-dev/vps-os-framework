import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  providerDisplayName,
} from "../lib/format";
import type {
  AppCardView,
  ChatAttachmentView,
  ChatMessageView,
  ChatMode,
  ChatReasoningBlockView,
  ChatThreadView,
  ChatToolCallView,
  ExecutionPlanView,
  LlmProviderId,
  OnboardingPayload,
  SystemMetricsView,
} from "../types";
import {
  ArrowUpIcon,
  BrainIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  FileTextIcon,
  ImageIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  SparklesIcon,
  SpinnerIcon,
  SquareStopIcon,
  TerminalIcon,
  TrashIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from "./Icons";
import { MarkdownContent } from "./MarkdownContent";

interface AgentChatProps {
  authHeaders: () => Record<string, string>;
  onboardingPayload: OnboardingPayload | null;
  metrics: SystemMetricsView | null;
  apps: AppCardView[];
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  onOpenSetupWizard: () => void;
  onRefreshDashboard: () => Promise<void>;
  showInspector: boolean;
  onToggleInspector: () => void;
  onNotify: (title: string, tone?: "success" | "info" | "warning" | "error", description?: string) => void;
}

const STARTER_CARDS = [
  {
    title: "Deploy a personal agent",
    prompt:
      "Create a personal life agent in its own isolated folder with Telegram access",
    tag: "Personal Agent",
  },
  {
    title: "Inspect server health",
    prompt:
      "Check server health, CPU/RAM headroom, running workloads, and recent audit status",
    tag: "Diagnostics",
  },
  {
    title: "Launch a web app with HTTPS",
    prompt:
      "Deploy a billing web app at billing.example.com in its own locked container",
    tag: "Auto-TLS Deploy",
  },
  {
    title: "Security & hardening review",
    prompt:
      "Analyze my server configuration and tell me if anything needs hardening or cleanup",
    tag: "Security",
  },
];

const SLASH_COMMANDS = [
  {
    command: "/health",
    label: "Check Server Health",
    prompt:
      "Check live CPU, RAM, disk headroom, running workloads, and summarize server health in plain English.",
  },
  {
    command: "/deploy-app",
    label: "Deploy Isolated Web App",
    prompt:
      "Prepare an execution plan to deploy a new isolated web app with automatic Caddy HTTPS.",
  },
  {
    command: "/deploy-agent",
    label: "Create Personal AI Agent",
    prompt:
      "Prepare an execution plan to create a new Personal AI Agent inside its own locked apartment folder.",
  },
  {
    command: "/security",
    label: "Audit Firewall & TLS Posture",
    prompt:
      "Inspect my recent audit events, SSH guardrails, and TLS certificate readiness for anything that needs attention.",
  },
  {
    command: "/logs",
    label: "Diagnose Workload Logs",
    prompt:
      "Check recent logs across my running workloads and flag any warnings or errors.",
  },
];

/** Loads an authenticated attachment image via Bearer headers and caches a blob URL. */
function AuthAttachmentImage({
  attachment,
  authHeaders,
  className,
  onClick,
}: {
  attachment: ChatAttachmentView;
  authHeaders: () => Record<string, string>;
  className?: string;
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
      <div
        className={`flex items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-muted)] ${
          className ?? "h-14 w-14"
        }`}
      >
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
        className={className ?? "h-16 w-16 object-cover"}
      />
    </button>
  );
}

/** Collapsible T3 Code-style reasoning trace disclosure. */
function ReasoningTraceCard({ block }: { block: ChatReasoningBlockView }) {
  const isStreaming = block.status === "streaming";
  const [expanded, setExpanded] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    }
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

/** Expandable T3 Code-style tool call row with Input/Output JSON inspector. */
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
              {busy ? "Saving..." : "Approve Plan"}
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

export function AgentChat({
  authHeaders,
  onboardingPayload,
  metrics: _metrics,
  apps: _apps,
  initialPrompt,
  onConsumeInitialPrompt,
  onOpenSetupWizard,
  onRefreshDashboard,
  showInspector,
  onToggleInspector,
  onNotify,
}: AgentChatProps) {
  const [threads, setThreads] = useState<ChatThreadView[]>([]);
  const [threadSearch, setThreadSearch] = useState("");
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [plansById, setPlansById] = useState<Record<string, ExecutionPlanView>>({});
  const [executionNotes, setExecutionNotes] = useState<Record<string, string>>({});

  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("agent");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentView[]>(
    [],
  );
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [planBusyId, setPlanBusyId] = useState<string | null>(null);
  const [showThreadsRail, setShowThreadsRail] = useState(true);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<LlmProviderId | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  const configuredProvider = onboardingPayload?.state.llmProvider ?? null;
  const configuredModel = onboardingPayload?.state.llmModel ?? null;
  const effectiveProvider = selectedProvider ?? configuredProvider;
  const effectiveModel = selectedModel ?? configuredModel;

  const activeCatalogEntry = onboardingPayload?.providerCatalog.find(
    (entry) => entry.id === effectiveProvider,
  );

  const filteredThreads = useMemo(() => {
    const q = threadSearch.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => t.title.toLowerCase().includes(q));
  }, [threadSearch, threads]);

  const matchingSlashCommands = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) return [];
    const q = input.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.command.startsWith(q));
  }, [input]);

  // Sync starter prompt coming from Overview, Workloads, or OnboardingWizard
  useEffect(() => {
    if (initialPrompt && initialPrompt.trim()) {
      setInput(initialPrompt);
      onConsumeInitialPrompt?.();
      textareaRef.current?.focus();
    }
  }, [initialPrompt, onConsumeInitialPrompt]);

  // Auto-resize composer textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  // Auto-scroll to latest message while streaming or appending
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streaming]);

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/threads", { headers: authHeaders() });
      if (!res.ok) return;
      const data = (await res.json()) as { threads: ChatThreadView[] };
      setThreads(data.threads);
      setActiveThreadId((current) => {
        if (current && data.threads.some((t) => t.id === current)) return current;
        return data.threads[0]?.id ?? null;
      });
    } catch {
      // handled gracefully by top-level offline banner
    }
  }, [authHeaders]);

  const loadThreadMessages = useCallback(
    async (threadId: string) => {
      try {
        const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
          headers: authHeaders(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          thread: ChatThreadView;
          messages: ChatMessageView[];
          plansById: Record<string, ExecutionPlanView>;
        };
        setMessages(data.messages);
        setPlansById((prev) => ({ ...prev, ...data.plansById }));
      } catch {
        // ignore transient network error
      }
    },
    [authHeaders],
  );

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (activeThreadId) {
      void loadThreadMessages(activeThreadId);
    } else {
      setMessages([]);
    }
  }, [activeThreadId, loadThreadMessages]);

  async function ensureActiveThread(): Promise<string> {
    if (activeThreadId) return activeThreadId;
    const res = await fetch("/api/chat/threads", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        title: "New Conversation",
        ...(effectiveProvider ? { provider: effectiveProvider } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Could not create conversation thread (${res.status}).`);
    }
    const data = (await res.json()) as { thread: ChatThreadView };
    setThreads((prev) => [data.thread, ...prev]);
    setActiveThreadId(data.thread.id);
    return data.thread.id;
  }

  async function handleNewThread() {
    if (streaming) return;
    setChatError(null);
    try {
      const res = await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          title: "New Conversation",
          ...(effectiveProvider ? { provider: effectiveProvider } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
        }),
      });
      if (!res.ok) throw new Error("Failed to create new thread.");
      const data = (await res.json()) as { thread: ChatThreadView };
      setThreads((prev) => [data.thread, ...prev]);
      setActiveThreadId(data.thread.id);
      setMessages([]);
      setPendingAttachments([]);
      textareaRef.current?.focus();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not create thread.");
    }
  }

  async function handleSaveThreadTitle(threadId: string) {
    const trimmed = editingTitle.trim();
    setEditingThreadId(null);
    if (!trimmed) return;
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) return;
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, title: trimmed } : t)),
      );
      onNotify("Renamed thread", "success");
    } catch {
      // ignore
    }
  }

  async function handleDeleteThread(threadId: string) {
    if (streaming && threadId === activeThreadId) return;
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) return;
      setThreads((prev) => {
        const next = prev.filter((t) => t.id !== threadId);
        if (activeThreadId === threadId) {
          setActiveThreadId(next[0]?.id ?? null);
          if (next.length === 0) setMessages([]);
        }
        return next;
      });
      onNotify("Conversation deleted", "info");
    } catch {
      // ignore
    }
  }

  async function uploadFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).slice(0, 5 - pendingAttachments.length);
    if (files.length === 0) return;

    setUploadingFiles(true);
    setChatError(null);
    try {
      const formData = new FormData();
      if (activeThreadId) {
        formData.append("threadId", activeThreadId);
      }
      const localPreviewByName = new Map<string, string>();
      for (const file of files) {
        formData.append("files", file);
        if (file.type.startsWith("image/") && file.type !== "image/svg+xml") {
          localPreviewByName.set(file.name, URL.createObjectURL(file));
        }
      }

      const res = await fetch("/api/chat/attachments", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { attachments: ChatAttachmentView[] };
      const hydrated: ChatAttachmentView[] = data.attachments.map((att) => {
        const preview = localPreviewByName.get(att.name);
        return preview ? { ...att, localPreviewUrl: preview } : att;
      });
      setPendingAttachments((prev) => [...prev, ...hydrated].slice(0, 5));
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "File upload failed.");
    } finally {
      setUploadingFiles(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      void uploadFiles(files);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer?.files?.length) {
      void uploadFiles(event.dataTransfer.files);
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.localPreviewUrl) {
        URL.revokeObjectURL(target.localPreviewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }

  function handleStopStream() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }

  async function handleSend(promptOverride?: string) {
    const text = (promptOverride ?? input).trim();
    if (!text || streaming || uploadingFiles) return;

    setChatError(null);
    setStreaming(true);

    const attachedToSend = [...pendingAttachments];
    if (!promptOverride) {
      setInput("");
    }
    setPendingAttachments([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const threadId = await ensureActiveThread();

      const res = await fetch(
        `/api/chat/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...authHeaders(),
          },
          body: JSON.stringify({
            content: text,
            mode,
            attachmentIds: attachedToSend.map((a) => a.id),
            ...(selectedProvider ? { provider: selectedProvider } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            stream: true,
          }),
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `API returned ${res.status}`);
      }

      if (!res.body) {
        throw new Error("Streaming response unavailable.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let activeAssistantId: string | null = null;

      const updateAssistant = (
        updater: (msg: ChatMessageView) => ChatMessageView,
      ) => {
        if (!activeAssistantId) return;
        const targetId = activeAssistantId;
        setMessages((prev) =>
          prev.map((msg) => (msg.id === targetId ? updater(msg) : msg)),
        );
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (!dataLine) continue;

          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }

          switch (evt.type) {
            case "message_start": {
              const userMsg = evt.userMessage as ChatMessageView;
              const assistantMsg = evt.assistantMessage as ChatMessageView;
              const mergedUserMsg: ChatMessageView = {
                ...userMsg,
                attachments: userMsg.attachments.map((att) => {
                  const local = attachedToSend.find((a) => a.id === att.id);
                  return local?.localPreviewUrl
                    ? { ...att, localPreviewUrl: local.localPreviewUrl }
                    : att;
                }),
              };
              activeAssistantId = assistantMsg.id;
              setMessages((prev) => [...prev, mergedUserMsg, assistantMsg]);
              break;
            }
            case "reasoning_start": {
              const block = evt.block as ChatReasoningBlockView;
              updateAssistant((msg) => ({
                ...msg,
                reasoning: [...msg.reasoning, block],
              }));
              break;
            }
            case "reasoning_delta": {
              const blockId = evt.blockId as string;
              const delta = evt.delta as string;
              updateAssistant((msg) => ({
                ...msg,
                reasoning: msg.reasoning.map((b) =>
                  b.id === blockId ? { ...b, content: b.content + delta } : b,
                ),
              }));
              break;
            }
            case "reasoning_done": {
              const block = evt.block as ChatReasoningBlockView;
              updateAssistant((msg) => ({
                ...msg,
                reasoning: msg.reasoning.map((b) => (b.id === block.id ? block : b)),
              }));
              break;
            }
            case "tool_start": {
              const toolCall = evt.toolCall as ChatToolCallView;
              updateAssistant((msg) => ({
                ...msg,
                toolCalls: [...msg.toolCalls, toolCall],
              }));
              break;
            }
            case "tool_done": {
              const toolCall = evt.toolCall as ChatToolCallView;
              updateAssistant((msg) => ({
                ...msg,
                toolCalls: msg.toolCalls.map((t) =>
                  t.id === toolCall.id ? toolCall : t,
                ),
              }));
              break;
            }
            case "plan_created": {
              const plan = evt.plan as ExecutionPlanView;
              setPlansById((prev) => ({ ...prev, [plan.id]: plan }));
              updateAssistant((msg) => ({ ...msg, planId: plan.id }));
              break;
            }
            case "text_delta": {
              const delta = evt.delta as string;
              updateAssistant((msg) => ({
                ...msg,
                content: msg.content + delta,
              }));
              break;
            }
            case "message_done": {
              const finalAssistant = evt.assistantMessage as ChatMessageView;
              const finalPlan = evt.plan as ExecutionPlanView | null;
              const threadTitle = evt.threadTitle as string;
              if (finalPlan) {
                setPlansById((prev) => ({ ...prev, [finalPlan.id]: finalPlan }));
              }
              updateAssistant(() => finalAssistant);
              setThreads((prev) =>
                prev.map((t) =>
                  t.id === threadId
                    ? {
                        ...t,
                        title: threadTitle || t.title,
                        provider: finalAssistant.provider,
                        model: finalAssistant.model,
                        messageCount: t.messageCount + 2,
                        updatedAt: finalAssistant.createdAt,
                      }
                    : t,
                ),
              );
              break;
            }
            case "error": {
              const errMsg = evt.message as string;
              setChatError(errMsg);
              updateAssistant((msg) => ({
                ...msg,
                status: "error",
                content: msg.content || `Error: ${errMsg}`,
              }));
              break;
            }
          }
        }
      }

      void onRefreshDashboard();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setChatError(err instanceof Error ? err.message : "Failed to send message.");
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }

  async function handlePlanDecision(planId: string, approved: boolean) {
    setPlanBusyId(planId);
    setChatError(null);
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
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Approval failed (${res.status})`);
      }
      const data = (await res.json()) as { plan: ExecutionPlanView };
      setPlansById((prev) => ({ ...prev, [data.plan.id]: data.plan }));
      onNotify(
        approved ? "Execution plan approved" : "Execution plan rejected",
        approved ? "success" : "info",
      );
      void onRefreshDashboard();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not record approval.");
    } finally {
      setPlanBusyId(null);
    }
  }

  async function handleExecutePlan(planId: string) {
    setPlanBusyId(planId);
    setChatError(null);
    try {
      const res = await fetch("/api/chat/execute", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ planId }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Execution failed (${res.status})`);
      }
      const data = (await res.json()) as {
        plan: ExecutionPlanView;
        execution: { summary: string };
      };
      setPlansById((prev) => ({ ...prev, [data.plan.id]: data.plan }));
      setExecutionNotes((prev) => ({ ...prev, [planId]: data.execution.summary }));
      onNotify("Plan executed", "success", data.execution.summary);
      void onRefreshDashboard();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not execute plan.");
    } finally {
      setPlanBusyId(null);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (matchingSlashCommands.length === 1 && input.trim() === matchingSlashCommands[0]!.command) {
        setInput(matchingSlashCommands[0]!.prompt);
        return;
      }
      void handleSend();
    }
  }

  return (
    <div
      className="relative flex h-[calc(100vh-56px)] min-h-[520px] overflow-hidden bg-[var(--bg-canvas)]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[var(--bg-backdrop)] backdrop-blur-xs">
          <div className="vps-elevated rounded-2xl border-2 border-dashed border-[var(--accent)] px-8 py-6 text-center">
            <PaperclipIcon className="mx-auto h-7 w-7 text-[var(--accent)]" />
            <p className="mt-2 text-sm font-semibold text-[var(--text-primary)]">
              Drop files to attach to your CTO prompt
            </p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Images, Dockerfiles, Compose YAML, Caddyfiles, logs, JSON, scripts (up to 5 MB)
            </p>
          </div>
        </div>
      )}

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-xs"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative max-h-[85vh] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              className="absolute -top-3 -right-3 rounded-full border border-white/15 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
              aria-label="Close preview"
            >
              <XIcon className="h-4 w-4" />
            </button>
            <img
              src={lightboxImage}
              alt="Attachment preview"
              className="max-h-[82vh] max-w-[88vw] rounded-xl border border-white/10 object-contain shadow-2xl"
            />
          </div>
        </div>
      )}

      {/* Left Threads Rail */}
      {showThreadsRail && (
        <aside className="hidden w-64 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-rail)] md:flex">
          <div className="space-y-2.5 border-b border-[var(--border-subtle)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Conversations
              </span>
              <button
                type="button"
                onClick={() => void handleNewThread()}
                disabled={streaming}
                className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                New
              </button>
            </div>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={threadSearch}
                onChange={(e) => setThreadSearch(e.target.value)}
                placeholder="Search threads..."
                className="vps-input w-full rounded-lg py-1.5 pr-2.5 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto p-2">
            {filteredThreads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-default)] p-4 text-center text-xs text-[var(--text-muted)]">
                {threads.length === 0
                  ? "Start a conversation to inspect your VPS or deploy apps."
                  : "No matching threads."}
              </div>
            ) : (
              filteredThreads.map((thread) => {
                const active = thread.id === activeThreadId;
                const isEditing = editingThreadId === thread.id;
                return (
                  <div
                    key={thread.id}
                    className={`group flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-left transition ${
                      active
                        ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {isEditing ? (
                      <input
                        type="text"
                        autoFocus
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={() => void handleSaveThreadTitle(thread.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void handleSaveThreadTitle(thread.id);
                          } else if (e.key === "Escape") {
                            setEditingThreadId(null);
                          }
                        }}
                        className="vps-input w-full rounded-md px-2 py-1 text-xs"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setActiveThreadId(thread.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-center gap-1.5">
                            <MessageSquareIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                            <span className="truncate text-xs font-medium">
                              {thread.title}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 pl-5 text-[10.5px] text-[var(--text-muted)]">
                            <span>{formatRelativeTime(thread.updatedAt)}</span>
                            {thread.provider && (
                              <>
                                <span>·</span>
                                <span className="truncate">
                                  {providerDisplayName(thread.provider)}
                                </span>
                              </>
                            )}
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingThreadId(thread.id);
                              setEditingTitle(thread.title);
                            }}
                            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                            title="Rename thread"
                            aria-label={`Rename thread ${thread.title}`}
                          >
                            <EditIcon className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteThread(thread.id)}
                            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
                            title="Delete thread"
                            aria-label={`Delete thread ${thread.title}`}
                          >
                            <TrashIcon className="h-3 w-3" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}

      {/* Center Conversation Stage */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sub-toolbar */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowThreadsRail((prev) => !prev)}
              className="hidden rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:inline-flex"
              title={showThreadsRail ? "Hide conversations" : "Show conversations"}
              aria-label="Toggle threads sidebar"
            >
              <PanelLeftIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void handleNewThread()}
              disabled={streaming}
              className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs md:hidden"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New
            </button>
            <h2 className="truncate text-xs font-semibold text-[var(--text-primary)]">
              {threads.find((t) => t.id === activeThreadId)?.title ??
                "New CTO Conversation"}
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleInspector}
              className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition xl:inline-flex ${
                showInspector
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
              title={showInspector ? "Hide live inspector" : "Show live inspector"}
              aria-label="Toggle live inspector"
            >
              <PanelRightIcon className="h-3.5 w-3.5" />
              Inspector
            </button>
          </div>
        </div>

        {/* Scrollable Message Stream */}
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 ? (
              <div className="py-10">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]">
                  <SparklesIcon className="h-5.5 w-5.5" />
                </div>
                <h3 className="mt-4 text-center text-lg font-semibold tracking-tight text-[var(--text-primary)]">
                  Autonomous VPS CTO Studio
                </h3>
                <p className="mx-auto mt-1.5 max-w-md text-center text-xs leading-relaxed text-[var(--text-secondary)]">
                  Inspect live host telemetry, analyze uploaded Dockerfiles or logs, and deploy isolated Locked Apartment apps with step-by-step reasoning, tool traces, and approval gates.
                </p>

                {!onboardingPayload?.state.llmConfigured && (
                  <div className="mx-auto mt-5 flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] px-4 py-3 text-xs">
                    <span className="text-[var(--text-primary)]">
                      Want live agentic LLM reasoning? Connect{" "}
                      <strong>OpenCode</strong> directly in Setup Wizard.
                    </span>
                    <button
                      type="button"
                      onClick={onOpenSetupWizard}
                      className="vps-btn-primary rounded-lg px-3 py-1.5 text-xs font-medium"
                    >
                      Configure OpenCode
                    </button>
                  </div>
                )}

                <div className="mt-7 grid gap-2.5 sm:grid-cols-2">
                  {STARTER_CARDS.map((card) => (
                    <button
                      key={card.title}
                      type="button"
                      onClick={() => void handleSend(card.prompt)}
                      className="vps-card-interactive group rounded-2xl p-4 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                          {card.title}
                        </span>
                        <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                          {card.tag}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">
                        {card.prompt}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.role === "user") {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="vps-card max-w-[85%] space-y-2 rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed text-[var(--text-primary)]">
                        {msg.attachments.length > 0 && (
                          <div className="flex flex-wrap gap-2 pb-1">
                            {msg.attachments.map((att) =>
                              att.kind === "image" ? (
                                <AuthAttachmentImage
                                  key={att.id}
                                  attachment={att}
                                  authHeaders={authHeaders}
                                  onClick={(src) => setLightboxImage(src)}
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
                        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                      </div>
                    </div>
                  );
                }

                const linkedPlan = msg.planId ? plansById[msg.planId] : null;

                return (
                  <div key={msg.id} className="group/turn space-y-3">
                    {/* Assistant Turn Header */}
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]">
                          <SparklesIcon className="h-3.5 w-3.5" />
                        </span>
                        <span className="font-semibold text-[var(--text-primary)]">
                          {providerDisplayName(msg.provider)}
                        </span>
                        {msg.model && (
                          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-secondary)]">
                            {msg.model}
                          </span>
                        )}
                        {msg.status === "streaming" ? (
                          <span className="inline-flex items-center gap-1 text-[var(--accent)]">
                            <SpinnerIcon className="h-3 w-3" />
                            Working
                          </span>
                        ) : (
                          <span className="tabular-nums">
                            {new Date(msg.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        )}
                      </div>

                      {msg.status === "completed" && msg.content && (
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard?.writeText(msg.content);
                            setCopiedMsgId(msg.id);
                            window.setTimeout(() => setCopiedMsgId(null), 1500);
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover/turn:opacity-100"
                        >
                          {copiedMsgId === msg.id ? (
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
                    </div>

                    <div className="space-y-2.5 pl-8">
                      {/* Reasoning Traces */}
                      {msg.reasoning.length > 0 && (
                        <div className="space-y-2">
                          {msg.reasoning.map((block) => (
                            <ReasoningTraceCard key={block.id} block={block} />
                          ))}
                        </div>
                      )}

                      {/* Tool Call Activity Stack */}
                      {msg.toolCalls.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                            <WrenchIcon className="h-3 w-3" />
                            <span>
                              {msg.toolCalls.length} tool
                              {msg.toolCalls.length === 1 ? "" : "s"} executed
                            </span>
                          </div>
                          {msg.toolCalls.map((toolCall) => (
                            <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                          ))}
                        </div>
                      )}

                      {/* Inline Execution Plan Card */}
                      {linkedPlan && (
                        <InlinePlanCard
                          plan={linkedPlan}
                          busy={planBusyId === linkedPlan.id}
                          executionSummary={executionNotes[linkedPlan.id]}
                          onApprove={(id) => void handlePlanDecision(id, true)}
                          onReject={(id) => void handlePlanDecision(id, false)}
                          onExecute={(id) => void handleExecutePlan(id)}
                        />
                      )}

                      {/* Markdown Answer Body */}
                      {msg.content && (
                        <div className="pt-0.5">
                          <MarkdownContent content={msg.content} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {chatError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-2.5 text-xs text-[var(--danger)]"
              >
                <span>{chatError}</span>
                <button
                  type="button"
                  onClick={() => setChatError(null)}
                  className="rounded p-0.5 hover:bg-[var(--bg-hover)]"
                  aria-label="Dismiss error"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div ref={scrollAnchorRef} />
          </div>
        </div>

        {/* Floating Composer */}
        <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-4 pt-3 pb-4 sm:px-6">
          <div className="relative mx-auto max-w-3xl">
            {/* Slash Command Suggestions */}
            {matchingSlashCommands.length > 0 && (
              <div className="vps-elevated animate-fade-in absolute bottom-full left-0 z-30 mb-2 w-full max-w-md overflow-hidden rounded-xl p-1.5">
                <p className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Slash Shortcuts
                </p>
                {matchingSlashCommands.map((cmd) => (
                  <button
                    key={cmd.command}
                    type="button"
                    onClick={() => {
                      setInput(cmd.prompt);
                      textareaRef.current?.focus();
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-[var(--bg-hover)]"
                  >
                    <span className="font-mono font-semibold text-[var(--accent)]">
                      {cmd.command}
                    </span>
                    <span className="truncate text-[var(--text-secondary)]">
                      {cmd.label}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="vps-card rounded-2xl transition focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent-soft)]">
              {/* Attachment Tray */}
              {(pendingAttachments.length > 0 || uploadingFiles) && (
                <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3.5 py-2.5">
                  {pendingAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="group relative flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
                    >
                      {att.kind === "image" && att.localPreviewUrl ? (
                        <img
                          src={att.localPreviewUrl}
                          alt={att.name}
                          className="h-7 w-7 rounded object-cover"
                        />
                      ) : (
                        <FileTextIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                      )}
                      <div className="min-w-0">
                        <p className="max-w-[140px] truncate text-[11.5px] font-medium">
                          {att.name}
                        </p>
                        <p className="text-[10px] text-[var(--text-muted)]">
                          {formatBytes(att.sizeBytes)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePendingAttachment(att.id)}
                        className="rounded-full p-0.5 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        aria-label={`Remove ${att.name}`}
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {uploadingFiles && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)]">
                      <SpinnerIcon className="h-3.5 w-3.5" />
                      Uploading...
                    </span>
                  )}
                </div>
              )}

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                onPaste={handlePaste}
                rows={2}
                placeholder={
                  mode === "plan"
                    ? "Describe a change to generate a risk-classified Execution Plan... (type / for shortcuts)"
                    : "Ask your Autonomous CTO anything, type / for shortcuts, or drop logs & screenshots..."
                }
                className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />

              {/* Bottom Composer Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    accept="image/*,.txt,.md,.json,.yml,.yaml,.log,.sh,.conf,.caddy,.toml,.ini,.env.example,.ts,.tsx,.js,.py,.pdf"
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        void uploadFiles(e.target.files);
                        e.target.value = "";
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingFiles || pendingAttachments.length >= 5}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                    title="Attach files or screenshots (max 5 MB each)"
                  >
                    <PaperclipIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Attach</span>
                  </button>

                  {/* Agent / Plan Mode Toggle */}
                  <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setMode("agent")}
                      className={`rounded-md px-2.5 py-1 font-medium transition ${
                        mode === "agent"
                          ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      Agent
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("plan")}
                      className={`rounded-md px-2.5 py-1 font-medium transition ${
                        mode === "plan"
                          ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      Plan
                    </button>
                  </div>

                  {/* Quick Provider / Model Selector */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowModelMenu((prev) => !prev)}
                      className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium"
                    >
                      <SlidersIcon className="h-3 w-3 text-[var(--accent)]" />
                      <span className="max-w-[160px] truncate">
                        {effectiveModel ?? providerDisplayName(effectiveProvider)}
                      </span>
                      <ChevronDownIcon className="h-3 w-3 text-[var(--text-muted)]" />
                    </button>

                    {showModelMenu && (
                      <div className="vps-elevated animate-fade-in absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl p-2">
                        <div className="flex items-center justify-between px-2 py-1">
                          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                            {effectiveProvider
                              ? providerDisplayName(effectiveProvider)
                              : "AI Provider"}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setShowModelMenu(false);
                              onOpenSetupWizard();
                            }}
                            className="text-[11px] font-medium text-[var(--accent)] hover:underline"
                          >
                            Configure
                          </button>
                        </div>

                        {activeCatalogEntry ? (
                          <div className="mt-1 space-y-0.5">
                            {activeCatalogEntry.suggestedModels.map((m) => (
                              <button
                                key={m}
                                type="button"
                                onClick={() => {
                                  setSelectedProvider(activeCatalogEntry.id);
                                  setSelectedModel(m);
                                  setShowModelMenu(false);
                                }}
                                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-[11.5px] transition ${
                                  effectiveModel === m
                                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                }`}
                              >
                                <span className="truncate">{m}</span>
                                {effectiveModel === m && (
                                  <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                                )}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="px-2 py-2 text-xs text-[var(--text-muted)]">
                            No external provider configured yet. Connect OpenCode or another provider in Setup Wizard.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="hidden text-[10.5px] text-[var(--text-muted)] sm:inline">
                    Enter to send · / commands
                  </span>
                  {streaming ? (
                    <button
                      type="button"
                      onClick={handleStopStream}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-rose-600 text-white transition hover:bg-rose-500"
                      title="Stop streaming"
                      aria-label="Stop response"
                    >
                      <SquareStopIcon className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSend()}
                      disabled={!input.trim() || uploadingFiles}
                      className="vps-btn-primary inline-flex h-8 w-8 items-center justify-center rounded-xl"
                      title="Send message"
                      aria-label="Send message"
                    >
                      <ArrowUpIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
