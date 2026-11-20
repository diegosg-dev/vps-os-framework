import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
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
  FileTextIcon,
  ImageIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PaperclipIcon,
  PlusIcon,
  ServerIcon,
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
}

const STARTER_CARDS = [
  {
    title: "Deploy a personal agent",
    prompt: "Create a personal life agent in its own isolated folder with Telegram access",
    tag: "Workload",
  },
  {
    title: "Inspect server health",
    prompt: "Check server health, CPU/RAM headroom, running workloads, and recent audit status",
    tag: "Diagnostics",
  },
  {
    title: "Launch a web app with HTTPS",
    prompt: "Deploy a billing web app at billing.example.com in its own locked container",
    tag: "Deploy",
  },
  {
    title: "Review config or logs",
    prompt: "Analyze my server configuration and tell me if anything needs hardening or cleanup",
    tag: "Security",
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function providerDisplayName(provider: string | null | undefined): string {
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
    case "vps-os-cto":
      return "VPS OS CTO";
    default:
      return provider || "VPS OS CTO";
  }
}

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
        className={`flex items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-500 ${
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
      className="group relative overflow-hidden rounded-lg border border-white/[0.1] bg-black/40 transition hover:border-sky-400/50"
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
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-400 transition hover:text-slate-200"
      >
        {isStreaming ? (
          <span className="inline-flex h-4 w-4 items-center justify-center">
            <span className="h-2 w-2 rounded-full bg-violet-400 animate-pulse-dot" />
          </span>
        ) : (
          <BrainIcon className="h-3.5 w-3.5 shrink-0 text-violet-400/80" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {expanded ? (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        )}
      </button>
      {expanded && block.content && (
        <div className="border-t border-white/[0.05] px-3 py-2.5">
          <div className="border-l-2 border-violet-500/35 pl-3 text-[12px] leading-relaxed text-slate-400 whitespace-pre-wrap">
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
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#0e1118]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition hover:bg-white/[0.025]"
      >
        {toolCall.status === "running" && (
          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-sky-400" />
        )}
        {toolCall.status === "success" && (
          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        )}
        {toolCall.status === "awaiting_approval" && (
          <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        )}
        {toolCall.status === "error" && (
          <XCircleIcon className="h-3.5 w-3.5 shrink-0 text-rose-400" />
        )}

        <span className="min-w-0 flex-1 truncate font-medium text-slate-200">
          {toolCall.label}
        </span>

        <span className="hidden rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10.5px] text-slate-400 sm:inline">
          {toolCall.toolName}
        </span>

        {toolCall.durationMs !== null && (
          <span className="shrink-0 font-mono text-[10.5px] text-slate-500">
            {formatDuration(toolCall.durationMs)}
          </span>
        )}

        {expanded ? (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2.5 border-t border-white/[0.06] bg-[#090b10] p-3 text-[11.5px]">
          {Object.keys(toolCall.input ?? {}).length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                Input
              </p>
              <pre className="max-h-36 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-2 font-mono text-[11px] text-slate-300">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}

          {toolCall.error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-2.5 py-1.5 text-xs text-rose-200">
              {toolCall.error}
            </div>
          )}

          {outputText && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  Output
                </p>
                <button
                  type="button"
                  onClick={copyOutput}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                >
                  <CopyIcon className="h-3 w-3" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
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
    pending: "border-amber-500/35 bg-amber-500/15 text-amber-200",
    approved: "border-sky-500/35 bg-sky-500/15 text-sky-200",
    executed: "border-emerald-500/35 bg-emerald-500/15 text-emerald-200",
    rejected: "border-rose-500/35 bg-rose-500/15 text-rose-200",
  };
  const status = plan.status ?? "pending";

  return (
    <div className="overflow-hidden rounded-xl border border-amber-500/25 bg-[#11141d]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] bg-amber-500/[0.05] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldIcon className="h-4 w-4 text-amber-400" />
          <span className="text-xs font-semibold text-slate-100">
            Execution Plan
          </span>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium capitalize ${
            statusStyles[status] ?? statusStyles.pending
          }`}
        >
          {status}
        </span>
      </div>

      <div className="space-y-3 p-3.5">
        <p className="text-xs text-slate-300">{plan.summary}</p>
        <ol className="space-y-2">
          {plan.steps.map((step, index) => (
            <li
              key={step.id}
              className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2 text-xs"
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/[0.07] font-mono text-[10px] text-slate-300">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-slate-100">{step.title}</span>
                  {step.toolName && (
                    <span className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                      {step.toolName}
                    </span>
                  )}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                      step.riskLevel === "high"
                        ? "bg-rose-500/15 text-rose-300"
                        : step.riskLevel === "medium"
                          ? "bg-amber-500/15 text-amber-300"
                          : "bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    {step.riskLevel}
                  </span>
                </div>
                <p className="mt-0.5 text-[11.5px] text-slate-400">
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
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              <CheckCircleIcon className="h-3.5 w-3.5" />
              {busy ? "Saving..." : "Approve Plan"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReject(plan.id)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/[0.08] disabled:opacity-50"
            >
              <XCircleIcon className="h-3.5 w-3.5" />
              Reject
            </button>
          </div>
        )}

        {status === "approved" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/25 bg-sky-500/[0.06] p-2.5">
            <span className="text-[11.5px] text-sky-200">
              Approved and ready to execute via the host runtime bridge.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onExecute(plan.id)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
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
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/35 px-3 py-2 text-xs text-emerald-200">
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
  metrics,
  apps,
  initialPrompt,
  onConsumeInitialPrompt,
  onOpenSetupWizard,
  onRefreshDashboard,
  showInspector,
  onToggleInspector,
}: AgentChatProps) {
  const [threads, setThreads] = useState<ChatThreadView[]>([]);
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

  // Sync starter prompt coming from OnboardingWizard
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
              // Preserve localPreviewUrl on user attachments for instant thumbnail render
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
          decidedBy: "dashboard-admin",
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Approval failed (${res.status})`);
      }
      const data = (await res.json()) as { plan: ExecutionPlanView };
      setPlansById((prev) => ({ ...prev, [data.plan.id]: data.plan }));
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
      void handleSend();
    }
  }

  return (
    <div
      className="relative flex h-[calc(100vh-53px)] min-h-[540px] overflow-hidden bg-[#090a0e]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-sky-950/50 backdrop-blur-xs">
          <div className="rounded-2xl border-2 border-dashed border-sky-400/70 bg-[#0d111a]/95 px-8 py-6 text-center shadow-2xl">
            <PaperclipIcon className="mx-auto h-7 w-7 text-sky-400" />
            <p className="mt-2 text-sm font-semibold text-slate-100">
              Drop files to attach to your CTO prompt
            </p>
            <p className="mt-1 text-xs text-slate-400">
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
        <aside className="hidden w-64 shrink-0 flex-col border-r border-white/[0.07] bg-[#0d0f15] md:flex">
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] p-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Threads
            </span>
            <button
              type="button"
              onClick={() => void handleNewThread()}
              disabled={streaming}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-white/[0.08] disabled:opacity-50"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New
            </button>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto p-2">
            {threads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/[0.07] p-4 text-center text-xs text-slate-500">
                Start a conversation below to inspect your VPS or deploy apps.
              </div>
            ) : (
              threads.map((thread) => {
                const active = thread.id === activeThreadId;
                return (
                  <div
                    key={thread.id}
                    className={`group flex items-center gap-2 rounded-xl px-2.5 py-2 text-left transition ${
                      active
                        ? "bg-white/[0.08] text-slate-100"
                        : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveThreadId(thread.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <MessageSquareIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        <span className="truncate text-xs font-medium">
                          {thread.title}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 pl-5 text-[10.5px] text-slate-500">
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
                    <button
                      type="button"
                      onClick={() => void handleDeleteThread(thread.id)}
                      className="rounded p-1 text-slate-500 opacity-0 transition hover:bg-white/[0.08] hover:text-rose-300 group-hover:opacity-100"
                      title="Delete thread"
                      aria-label={`Delete thread ${thread.title}`}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Pinned Host Telemetry Mini-Card */}
          <div className="border-t border-white/[0.06] p-3">
            <div className="rounded-xl border border-white/[0.07] bg-[#12151d] p-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="inline-flex items-center gap-1.5 font-medium text-slate-300">
                  <ServerIcon className="h-3.5 w-3.5 text-sky-400" />
                  {metrics?.hostname ?? "VPS Host"}
                </span>
                <span className="font-mono text-[10px] text-slate-500">
                  {apps.length} app{apps.length === 1 ? "" : "s"}
                </span>
              </div>
              {metrics && (
                <div className="mt-2.5 space-y-2">
                  <div>
                    <div className="flex justify-between text-[10.5px] text-slate-400">
                      <span>RAM</span>
                      <span className="font-mono">{metrics.memoryUsagePercent}%</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className="h-full rounded-full bg-sky-400"
                        style={{
                          width: `${Math.min(100, metrics.memoryUsagePercent)}%`,
                        }}
                      />
                    </div>
                  </div>
                  {metrics.disk && (
                    <div>
                      <div className="flex justify-between text-[10.5px] text-slate-400">
                        <span>Disk</span>
                        <span className="font-mono">{metrics.disk.usagePercent}%</span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                        <div
                          className="h-full rounded-full bg-emerald-400"
                          style={{
                            width: `${Math.min(100, metrics.disk.usagePercent)}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </aside>
      )}

      {/* Center Conversation Stage */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sub-toolbar */}
        <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[#0b0d13]/80 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowThreadsRail((prev) => !prev)}
              className="hidden rounded-lg p-1.5 text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-200 md:inline-flex"
              title={showThreadsRail ? "Hide threads" : "Show threads"}
              aria-label="Toggle threads sidebar"
            >
              <PanelLeftIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void handleNewThread()}
              disabled={streaming}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-xs text-slate-300 hover:bg-white/[0.07] md:hidden"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New
            </button>
            <h2 className="truncate text-xs font-medium text-slate-200">
              {threads.find((t) => t.id === activeThreadId)?.title ??
                "New CTO Conversation"}
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenSetupWizard}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.09] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-sky-500/40 hover:text-sky-200"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  onboardingPayload?.state.llmConfigured
                    ? "bg-emerald-400"
                    : "bg-amber-400"
                }`}
              />
              <span>
                {effectiveProvider
                  ? `${providerDisplayName(effectiveProvider)}${
                      effectiveModel ? ` · ${effectiveModel}` : ""
                    }`
                  : "Connect OpenCode / AI Provider"}
              </span>
            </button>
            <button
              type="button"
              onClick={onToggleInspector}
              className={`hidden rounded-lg p-1.5 transition lg:inline-flex ${
                showInspector
                  ? "bg-white/[0.08] text-sky-300"
                  : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
              }`}
              title={showInspector ? "Hide server inspector" : "Show server inspector"}
              aria-label="Toggle server inspector"
            >
              <PanelRightIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Message Stream */}
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 ? (
              <div className="py-10">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-500/25 bg-sky-500/10 text-sky-300">
                  <SparklesIcon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-center text-lg font-semibold tracking-tight text-slate-100">
                  Autonomous VPS CTO
                </h3>
                <p className="mx-auto mt-1.5 max-w-md text-center text-xs leading-relaxed text-slate-400">
                  Inspect live host telemetry, analyze uploaded Dockerfiles or logs,
                  and deploy isolated Locked Apartment apps with step-by-step
                  reasoning, tool traces, and approval gates.
                </p>

                {!onboardingPayload?.state.llmConfigured && (
                  <div className="mx-auto mt-5 flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.06] px-4 py-3 text-xs">
                    <span className="text-slate-300">
                      Want live agentic LLM reasoning? Connect{" "}
                      <strong className="text-sky-300">OpenCode</strong> directly in
                      Setup Wizard.
                    </span>
                    <button
                      type="button"
                      onClick={onOpenSetupWizard}
                      className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
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
                      className="group rounded-xl border border-white/[0.08] bg-[#11141c] p-3.5 text-left transition hover:border-sky-500/40 hover:bg-[#151924]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-100 group-hover:text-sky-200">
                          {card.title}
                        </span>
                        <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-slate-400">
                          {card.tag}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11.5px] leading-snug text-slate-400">
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
                      <div className="max-w-[85%] space-y-2 rounded-2xl border border-white/[0.09] bg-[#161a24] px-4 py-3 text-[13.5px] leading-relaxed text-slate-100 shadow-sm">
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
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.09] bg-black/30 px-2.5 py-1.5 text-[11.5px] text-slate-300"
                                >
                                  <FileTextIcon className="h-3.5 w-3.5 text-sky-400" />
                                  <span className="max-w-[180px] truncate font-medium">
                                    {att.name}
                                  </span>
                                  <span className="text-[10px] text-slate-500">
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
                  <div key={msg.id} className="space-y-3">
                    {/* Assistant Turn Header */}
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-300">
                        <SparklesIcon className="h-3.5 w-3.5" />
                      </span>
                      <span className="font-semibold text-slate-200">
                        {providerDisplayName(msg.provider)}
                      </span>
                      {msg.model && (
                        <span className="rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10.5px] text-slate-400">
                          {msg.model}
                        </span>
                      )}
                      {msg.status === "streaming" ? (
                        <span className="inline-flex items-center gap-1 text-sky-300">
                          <SpinnerIcon className="h-3 w-3" />
                          Working
                        </span>
                      ) : (
                        <span className="text-slate-600">
                          {new Date(msg.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
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
                          <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-slate-500">
                            <WrenchIcon className="h-3 w-3" />
                            <span>
                              {msg.toolCalls.length} tool
                              {msg.toolCalls.length === 1 ? "" : "s"} called
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
                className="flex items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-950/35 px-4 py-2.5 text-xs text-rose-200"
              >
                <span>{chatError}</span>
                <button
                  type="button"
                  onClick={() => setChatError(null)}
                  className="rounded p-0.5 hover:bg-rose-500/20"
                  aria-label="Dismiss error"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div ref={scrollAnchorRef} />
          </div>
        </div>

        {/* Floating T3 Code-Style Composer */}
        <div className="border-t border-white/[0.06] bg-[#090a0e]/95 px-4 pt-3 pb-4 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-2xl border border-white/[0.1] bg-[#12151e] shadow-xl transition focus-within:border-sky-500/50 focus-within:ring-1 focus-within:ring-sky-500/25">
              {/* Attachment Tray */}
              {(pendingAttachments.length > 0 || uploadingFiles) && (
                <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3.5 py-2.5">
                  {pendingAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="group relative flex items-center gap-2 rounded-xl border border-white/[0.09] bg-[#181c28] px-2.5 py-1.5 text-xs text-slate-200"
                    >
                      {att.kind === "image" && att.localPreviewUrl ? (
                        <img
                          src={att.localPreviewUrl}
                          alt={att.name}
                          className="h-7 w-7 rounded object-cover"
                        />
                      ) : (
                        <FileTextIcon className="h-4 w-4 shrink-0 text-sky-400" />
                      )}
                      <div className="min-w-0">
                        <p className="max-w-[140px] truncate text-[11.5px] font-medium">
                          {att.name}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          {formatBytes(att.sizeBytes)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePendingAttachment(att.id)}
                        className="rounded-full p-0.5 text-slate-400 transition hover:bg-white/[0.1] hover:text-slate-100"
                        aria-label={`Remove ${att.name}`}
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {uploadingFiles && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-sky-300">
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
                    ? "Describe a change to generate a risk-classified Execution Plan..."
                    : "Ask your Autonomous CTO anything, drop logs/Dockerfiles, or paste a screenshot..."
                }
                className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[13.5px] text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />

              {/* Bottom Composer Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* File Picker */}
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
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-200 disabled:opacity-40"
                    title="Attach files or screenshots (max 5 MB each)"
                  >
                    <PaperclipIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Attach</span>
                  </button>

                  {/* Agent / Plan Mode Toggle */}
                  <div className="inline-flex rounded-lg border border-white/[0.08] bg-black/30 p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setMode("agent")}
                      className={`rounded-md px-2 py-1 font-medium transition ${
                        mode === "agent"
                          ? "bg-white/[0.1] text-slate-100"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Agent
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("plan")}
                      className={`rounded-md px-2 py-1 font-medium transition ${
                        mode === "plan"
                          ? "bg-amber-500/20 text-amber-200"
                          : "text-slate-400 hover:text-slate-200"
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
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/[0.07]"
                    >
                      <SlidersIcon className="h-3 w-3 text-sky-400" />
                      <span className="max-w-[160px] truncate">
                        {effectiveModel ?? providerDisplayName(effectiveProvider)}
                      </span>
                      <ChevronDownIcon className="h-3 w-3 text-slate-500" />
                    </button>

                    {showModelMenu && (
                      <div className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl border border-white/[0.1] bg-[#151924] p-2 shadow-2xl">
                        <div className="flex items-center justify-between px-2 py-1">
                          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
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
                            className="text-[11px] text-sky-400 hover:text-sky-300"
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
                                    ? "bg-sky-500/15 text-sky-200"
                                    : "text-slate-300 hover:bg-white/[0.05]"
                                }`}
                              >
                                <span className="truncate">{m}</span>
                                {effectiveModel === m && (
                                  <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                                )}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="px-2 py-2 text-xs text-slate-400">
                            No external provider configured yet. Connect OpenCode or
                            another provider in Setup Wizard.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="hidden text-[10.5px] text-slate-500 sm:inline">
                    Enter to send · Shift+Enter newline
                  </span>
                  {streaming ? (
                    <button
                      type="button"
                      onClick={handleStopStream}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-rose-600/90 text-white transition hover:bg-rose-500"
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
                      className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500 text-slate-950 transition hover:bg-sky-400 disabled:bg-white/[0.08] disabled:text-slate-500"
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
