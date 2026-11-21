import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  formatBytes,
  formatRelativeTime,
  providerDisplayName,
  triggerTextDownload,
} from "../lib/format";
import type {
  AppCardView,
  ApprovalMode,
  AuditEventView,
  ChatAttachmentView,
  ChatMessageView,
  ChatMode,
  ChatReasoningBlockView,
  ChatThreadView,
  ChatToolCallView,
  ExecutionPlanView,
  LlmProviderId,
  OnboardingPayload,
  QueuedChatMessage,
  ReasoningEffort,
  SystemMetricsView,
  WorkspaceView,
} from "../types";
import { ChatComposer, type SlashCommandItem } from "./ChatComposer";
import { ChatThreadRail } from "./ChatThreadRail";
import { ChatTurnItem } from "./ChatTurnItem";
import { ConfirmDialog, type ConfirmDialogState } from "./ConfirmDialog";
import {
  ArchiveIcon,
  ArrowDownIcon,
  AtSignIcon,
  DownloadIcon,
  FileTextIcon,
  GitForkIcon,
  ImageIcon,
  LayersIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PaperclipIcon,
  PinIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from "./Icons";

interface AgentChatProps {
  authHeaders: () => Record<string, string>;
  onboardingPayload: OnboardingPayload | null;
  metrics: SystemMetricsView | null;
  apps: AppCardView[];
  auditEvents: AuditEventView[];
  busyAppSlug: string | null;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  onOpenSetupWizard: () => void;
  onRefreshDashboard: () => Promise<void>;
  onLifecycle: (slug: string, action: "start" | "stop" | "restart") => void;
  onInspectApp: (app: AppCardView, tab?: "overview" | "logs") => void;
  onNavigate: (view: WorkspaceView) => void;
  showInspector: boolean;
  onToggleInspector: () => void;
  onNotify: (
    title: string,
    tone?: "success" | "info" | "warning" | "error",
    description?: string,
  ) => void;
}

interface DispatchTurnParams {
  content: string;
  mode: ChatMode;
  effort: ReasoningEffort;
  mentionedSlugs: string[];
  attachments: ChatAttachmentView[];
  truncateFromMessageId?: string | undefined;
  targetThreadId?: string | null | undefined;
}

const STARTER_CARDS = [
  {
    title: "Deploy a personal agent",
    prompt:
      "Create a personal life agent in its own isolated folder with Telegram access",
    tag: "Personal Agent",
    mode: "plan" as ChatMode,
  },
  {
    title: "Inspect server health",
    prompt:
      "Check server health, CPU/RAM headroom, running workloads, and recent audit status",
    tag: "Diagnostics",
    mode: "agent" as ChatMode,
  },
  {
    title: "Launch a web app with HTTPS",
    prompt:
      "Deploy a billing web app at billing.example.com in its own locked container",
    tag: "Auto-TLS Deploy",
    mode: "plan" as ChatMode,
  },
  {
    title: "Security & hardening review",
    prompt:
      "Analyze my server configuration and tell me if anything needs hardening or cleanup",
    tag: "Read-only Audit",
    mode: "ask" as ChatMode,
  },
];

function sortThreads(list: ChatThreadView[]): ChatThreadView[] {
  return [...list].sort((a, b) => {
    const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinDiff !== 0) return pinDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function revokeAttachmentPreviews(attachments: ChatAttachmentView[]) {
  for (const att of attachments) {
    if (att.localPreviewUrl) {
      URL.revokeObjectURL(att.localPreviewUrl);
    }
  }
}

export function AgentChat({
  authHeaders,
  onboardingPayload,
  metrics,
  apps,
  auditEvents,
  busyAppSlug,
  initialPrompt,
  onConsumeInitialPrompt,
  onOpenSetupWizard,
  onRefreshDashboard,
  onLifecycle,
  onInspectApp,
  onNavigate,
  showInspector,
  onToggleInspector,
  onNotify,
}: AgentChatProps) {
  const [threads, setThreads] = useState<ChatThreadView[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [plansById, setPlansById] = useState<Record<string, ExecutionPlanView>>({});
  const [executionNotes, setExecutionNotes] = useState<Record<string, string>>({});

  // Composer & T3-Code session controls
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("agent");
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [mentionedSlugs, setMentionedSlugs] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentView[]>(
    [],
  );
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Streaming & live timing
  const [streaming, setStreaming] = useState(false);
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [chatError, setChatError] = useState<string | null>(null);
  const [planBusyId, setPlanBusyId] = useState<string | null>(null);

  // Layout & modals
  const [showThreadsRail, setShowThreadsRail] = useState(true);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<LlmProviderId | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Refs for race-free streaming, queueing, steering & smart scroll
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const activeThreadIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const queuedMessagesRef = useRef<QueuedChatMessage[]>([]);
  const steeredItemRef = useRef<QueuedChatMessage | null>(null);
  const streamingThreadIdRef = useRef<string | null>(null);
  const manualStopRef = useRef(false);
  const streamStartedAtRef = useRef<number>(0);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  const activeQueuedMessages = useMemo(
    () => queuedMessages.filter((q) => q.threadId === activeThreadId),
    [queuedMessages, activeThreadId],
  );

  const configuredProvider = onboardingPayload?.state.llmProvider ?? null;
  const configuredModel = onboardingPayload?.state.llmModel ?? null;
  const effectiveProvider = selectedProvider ?? configuredProvider;
  const effectiveModel = selectedModel ?? configuredModel;

  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        return messages[i]!.id;
      }
    }
    return null;
  }, [messages]);

  const threadPlans = useMemo(() => {
    const seen = new Set<string>();
    const list: ExecutionPlanView[] = [];
    for (const msg of messages) {
      if (msg.planId && !seen.has(msg.planId)) {
        const plan = plansById[msg.planId];
        if (plan) {
          seen.add(msg.planId);
          list.push(plan);
        }
      }
    }
    return list;
  }, [messages, plansById]);

  const threadAttachments = useMemo(() => {
    const seen = new Set<string>();
    const list: ChatAttachmentView[] = [];
    for (const msg of messages) {
      for (const att of msg.attachments) {
        if (!seen.has(att.id)) {
          seen.add(att.id);
          list.push(att);
        }
      }
    }
    return list;
  }, [messages]);

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
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Close image lightbox on Escape
  useEffect(() => {
    if (!lightboxImage) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLightboxImage(null);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [lightboxImage]);

  // Live elapsed timer during streaming
  useEffect(() => {
    if (!streaming) {
      setElapsedMs(0);
      return;
    }
    streamStartedAtRef.current = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - streamStartedAtRef.current);
    }, 100);
    return () => window.clearInterval(id);
  }, [streaming]);

  // Smart auto-scroll: follow output only if user hasn't scrolled up to read earlier turns
  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    scrollAnchorRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, streaming]);

  function handleMessageListScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 96;
    setShowJumpToLatest(distanceFromBottom > 180);
  }

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/threads", { headers: authHeaders() });
      if (!res.ok) return;
      const data = (await res.json()) as { threads: ChatThreadView[] };
      const sorted = sortThreads(data.threads);
      setThreads(sorted);
      setActiveThreadId((current) => {
        if (current && sorted.some((t) => t.id === current)) return current;
        const firstActive = sorted.find((t) => !t.archived);
        return (firstActive ?? sorted[0])?.id ?? null;
      });
    } catch {
      // handled gracefully by top-level offline banner
    }
  }, [authHeaders]);

  const loadThreadMessages = useCallback(
    async (threadId: string) => {
      // Never re-fetch over a live stream: switching back to the streaming
      // thread must keep the in-flight messages intact.
      if (streamingRef.current && streamingThreadIdRef.current === threadId) {
        return;
      }
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
        if (activeThreadIdRef.current !== threadId) return;
        setMessages(data.messages);
        setPlansById((prev) => ({ ...prev, ...data.plansById }));
        isNearBottomRef.current = true;
        setShowJumpToLatest(false);
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

  const ensureActiveThread = useCallback(async (): Promise<string> => {
    if (activeThreadIdRef.current) return activeThreadIdRef.current;
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
    activeThreadIdRef.current = data.thread.id;
    setThreads((prev) => sortThreads([data.thread, ...prev]));
    setActiveThreadId(data.thread.id);
    return data.thread.id;
  }, [authHeaders, effectiveModel, effectiveProvider]);

  async function handleNewThread() {
    if (streaming) return;
    setChatError(null);
    setMobileThreadsOpen(false);
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
      activeThreadIdRef.current = data.thread.id;
      setThreads((prev) => sortThreads([data.thread, ...prev]));
      setActiveThreadId(data.thread.id);
      setMessages([]);
      setPendingAttachments([]);
      setMentionedSlugs([]);
      textareaRef.current?.focus();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not create thread.");
    }
  }

  async function handleRenameThread(threadId: string, title: string) {
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { thread: ChatThreadView };
      setThreads((prev) =>
        sortThreads(prev.map((t) => (t.id === threadId ? data.thread : t))),
      );
      onNotify("Renamed thread", "success");
    } catch {
      // ignore
    }
  }

  async function handleTogglePin(thread: ChatThreadView) {
    const nextPinned = !thread.pinned;
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ pinned: nextPinned }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { thread: ChatThreadView };
      setThreads((prev) =>
        sortThreads(prev.map((t) => (t.id === thread.id ? data.thread : t))),
      );
      onNotify(nextPinned ? "Pinned thread" : "Unpinned thread", "info");
    } catch {
      // ignore
    }
  }

  async function handleToggleArchive(thread: ChatThreadView) {
    const nextArchived = !thread.archived;
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ archived: nextArchived }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { thread: ChatThreadView };
      const updated = sortThreads(
        threads.map((t) => (t.id === thread.id ? data.thread : t)),
      );
      setThreads(updated);
      if (nextArchived && activeThreadId === thread.id) {
        const fallback = updated.find((t) => !t.archived && t.id !== thread.id);
        setActiveThreadId(fallback?.id ?? null);
        if (!fallback) setMessages([]);
      }
      onNotify(nextArchived ? "Thread archived" : "Thread restored", "info");
    } catch {
      // ignore
    }
  }

  async function handleForkThread(threadId: string, upToMessageId?: string) {
    if (streaming) return;
    setChatError(null);
    try {
      const res = await fetch(
        `/api/chat/threads/${encodeURIComponent(threadId)}/fork`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            ...(upToMessageId ? { upToMessageId } : {}),
          }),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Fork failed (${res.status})`);
      }
      const data = (await res.json()) as {
        thread: ChatThreadView;
        messages: ChatMessageView[];
        plansById: Record<string, ExecutionPlanView>;
      };
      activeThreadIdRef.current = data.thread.id;
      setThreads((prev) => sortThreads([data.thread, ...prev]));
      setActiveThreadId(data.thread.id);
      setMessages(data.messages);
      setPlansById((prev) => ({ ...prev, ...data.plansById }));
      setMobileThreadsOpen(false);
      onNotify(
        "Forked conversation",
        "success",
        upToMessageId
          ? "Branched into a new thread up to the selected turn."
          : "Created an independent branch of this thread.",
      );
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not fork thread.");
    }
  }

  async function handleExportThread(threadId: string) {
    try {
      const res = await fetch(
        `/api/chat/threads/${encodeURIComponent(threadId)}/export`,
        { headers: authHeaders() },
      );
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      const markdown = await res.text();
      const target = threads.find((t) => t.id === threadId);
      const slug =
        (target?.title ?? "cto-thread")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "cto-thread";
      triggerTextDownload(`${slug}.md`, markdown, "text/markdown;charset=utf-8");
      onNotify("Exported Markdown transcript", "success", `${slug}.md`);
    } catch (err) {
      onNotify(
        "Could not export thread",
        "error",
        err instanceof Error ? err.message : undefined,
      );
    }
  }

  function requestClearThread(threadId: string) {
    if (streaming || messages.length === 0) return;
    setConfirmDialog({
      title: "Clear conversation history?",
      description:
        "All messages in this thread will be cleared so you can start with a fresh context. Existing execution plans and workloads remain untouched.",
      confirmLabel: "Clear Thread",
      tone: "warning",
      onConfirm: async () => {
        setConfirmBusy(true);
        try {
          const res = await fetch(
            `/api/chat/threads/${encodeURIComponent(threadId)}/clear`,
            {
              method: "POST",
              headers: authHeaders(),
            },
          );
          if (!res.ok) throw new Error(`Clear failed (${res.status})`);
          const data = (await res.json()) as { thread?: ChatThreadView };
          revokeAttachmentPreviews(messages.flatMap((m) => m.attachments));
          const threadQueued = queuedMessages.filter(
            (q) => q.threadId === threadId,
          );
          for (const q of threadQueued) {
            revokeAttachmentPreviews(q.attachments);
          }
          const keptQueued = queuedMessages.filter(
            (q) => q.threadId !== threadId,
          );
          queuedMessagesRef.current = keptQueued;
          setMessages([]);
          setQueuedMessages(keptQueued);
          if (data.thread) {
            setThreads((prev) =>
              sortThreads(prev.map((t) => (t.id === threadId ? data.thread! : t))),
            );
          }
          setConfirmDialog(null);
          onNotify("Thread context cleared", "info");
        } catch (err) {
          onNotify(
            "Could not clear thread",
            "error",
            err instanceof Error ? err.message : undefined,
          );
        } finally {
          setConfirmBusy(false);
        }
      },
    });
  }

  function requestDeleteThread(thread: ChatThreadView) {
    if (streaming && thread.id === streamingThreadId) return;
    setConfirmDialog({
      title: `Delete "${thread.title}"?`,
      description:
        "This permanently deletes the conversation transcript from the local registry. Deployed apps and audit records are not affected.",
      confirmLabel: "Delete Thread",
      tone: "danger",
      onConfirm: async () => {
        setConfirmBusy(true);
        try {
          const res = await fetch(
            `/api/chat/threads/${encodeURIComponent(thread.id)}`,
            {
              method: "DELETE",
              headers: authHeaders(),
            },
          );
          if (!res.ok) throw new Error(`Delete failed (${res.status})`);
          const next = threads.filter((t) => t.id !== thread.id);
          setThreads(next);
          if (activeThreadId === thread.id) {
            const fallback = next.find((t) => !t.archived) ?? next[0] ?? null;
            activeThreadIdRef.current = fallback?.id ?? null;
            setActiveThreadId(fallback?.id ?? null);
            if (!fallback) setMessages([]);
          }
          setConfirmDialog(null);
          onNotify("Conversation deleted", "info");
        } catch (err) {
          onNotify(
            "Could not delete thread",
            "error",
            err instanceof Error ? err.message : undefined,
          );
        } finally {
          setConfirmBusy(false);
        }
      },
    });
  }

  async function uploadFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).slice(0, 5 - pendingAttachments.length);
    if (files.length === 0) return;

    setUploadingFiles(true);
    setChatError(null);
    const localPreviewByName = new Map<string, string>();
    try {
      const formData = new FormData();
      if (activeThreadId) {
        formData.append("threadId", activeThreadId);
      }
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
      for (const preview of localPreviewByName.values()) {
        URL.revokeObjectURL(preview);
      }
      setChatError(err instanceof Error ? err.message : "File upload failed.");
    } finally {
      setUploadingFiles(false);
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

  function addMention(slug: string) {
    setMentionedSlugs((prev) => (prev.includes(slug) ? prev : [...prev, slug]));
    textareaRef.current?.focus();
  }

  function removeMention(slug: string) {
    setMentionedSlugs((prev) => prev.filter((s) => s !== slug));
  }

  function recordPromptHistory(text: string) {
    setPromptHistory((prev) => [text, ...prev.filter((p) => p !== text)].slice(0, 30));
  }

  function handleSelectProviderModel(provider: LlmProviderId, model: string) {
    setSelectedProvider(provider);
    setSelectedModel(model);
    if (activeThreadId) {
      void fetch(`/api/chat/threads/${encodeURIComponent(activeThreadId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ provider, model }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ thread: ChatThreadView }>) : null))
        .then((data) => {
          if (data?.thread) {
            setThreads((prev) =>
              sortThreads(prev.map((t) => (t.id === data.thread.id ? data.thread : t))),
            );
          }
        })
        .catch(() => {
          // non-blocking preference update
        });
    }
  }

  const dispatchTurn = useCallback(
    async (params: DispatchTurnParams) => {
      const text = params.content.trim();
      if (!text) return;

      setChatError(null);
      setStreaming(true);
      streamingRef.current = true;
      manualStopRef.current = false;
      isNearBottomRef.current = true;

      const controller = new AbortController();
      abortRef.current = controller;

      let threadId: string | null = null;
      let activeAssistantId: string | null = null;
      let wasSteered = false;
      let turnFailed = false;

      try {
        threadId = params.targetThreadId ?? (await ensureActiveThread());
        setStreamingThreadId(threadId);
        streamingThreadIdRef.current = threadId;

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
              mode: params.mode,
              effort: params.effort,
              mentionedSlugs: params.mentionedSlugs,
              attachmentIds: params.attachments.map((a) => a.id),
              ...(params.truncateFromMessageId
                ? { truncateFromMessageId: params.truncateFromMessageId }
                : {}),
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

        const updateAssistant = (
          updater: (msg: ChatMessageView) => ChatMessageView,
        ) => {
          if (!activeAssistantId || activeThreadIdRef.current !== threadId) return;
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
                    const local = params.attachments.find((a) => a.id === att.id);
                    return local?.localPreviewUrl
                      ? { ...att, localPreviewUrl: local.localPreviewUrl }
                      : att;
                  }),
                };
                activeAssistantId = assistantMsg.id;
                if (activeThreadIdRef.current === threadId) {
                  setMessages((prev) => [...prev, mergedUserMsg, assistantMsg]);
                }
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
                  sortThreads(
                    prev.map((t) =>
                      t.id === threadId
                        ? {
                            ...t,
                            title: threadTitle || t.title,
                            provider: finalAssistant.provider,
                            model: finalAssistant.model,
                            messageCount: params.truncateFromMessageId
                              ? Math.max(2, t.messageCount)
                              : t.messageCount + 2,
                            updatedAt: finalAssistant.createdAt,
                          }
                        : t,
                    ),
                  ),
                );
                break;
              }
              case "error": {
                const errMsg = evt.message as string;
                turnFailed = true;
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
        if (params.truncateFromMessageId) {
          void loadThreads();
        }
      } catch (err) {
        const isAbort = (err as Error).name === "AbortError";
        if (isAbort) {
          wasSteered = Boolean(steeredItemRef.current);
          if (activeAssistantId && activeThreadIdRef.current === threadId) {
            const targetId = activeAssistantId;
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === targetId && msg.status === "streaming"
                  ? {
                      ...msg,
                      status: "completed",
                      content:
                        msg.content ||
                        (wasSteered
                          ? "_Interrupted to steer to follow-up._"
                          : "_Response stopped._"),
                    }
                  : msg,
              ),
            );
          }
        } else {
          turnFailed = true;
          setChatError(err instanceof Error ? err.message : "Failed to send message.");
        }
      } finally {
        abortRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
        setStreamingThreadId(null);
        streamingThreadIdRef.current = null;

        // Priority 1: Steered message takes immediate control after interrupting active turn
        const steered = steeredItemRef.current;
        if (steered) {
          steeredItemRef.current = null;
          queueMicrotask(() => {
            void dispatchTurn({
              content: steered.content,
              mode: steered.mode,
              effort: steered.effort,
              mentionedSlugs: steered.mentionedSlugs,
              attachments: steered.attachments,
              targetThreadId: steered.threadId,
            });
          });
        } else if (
          !manualStopRef.current &&
          !turnFailed &&
          queuedMessagesRef.current.length > 0
        ) {
          // Priority 2: Auto-drain the next queued message belonging to the
          // thread that just finished; paused when the turn errored.
          const nextItem = queuedMessagesRef.current.find(
            (q) => q.threadId === threadId,
          );
          if (nextItem) {
            const rest = queuedMessagesRef.current.filter(
              (q) => q.id !== nextItem.id,
            );
            queuedMessagesRef.current = rest;
            setQueuedMessages(rest);
            queueMicrotask(() => {
              void dispatchTurn({
                content: nextItem.content,
                mode: nextItem.mode,
                effort: nextItem.effort,
                mentionedSlugs: nextItem.mentionedSlugs,
                attachments: nextItem.attachments,
                targetThreadId: nextItem.threadId,
              });
            });
          }
        }
        manualStopRef.current = false;
      }
    },
    [
      authHeaders,
      ensureActiveThread,
      loadThreads,
      onRefreshDashboard,
      selectedModel,
      selectedProvider,
    ],
  );

  function dispatchUserText(rawText: string) {
    const text = rawText.trim();
    if (!text || uploadingFiles) return;

    recordPromptHistory(text);

    const payload: DispatchTurnParams = {
      content: text,
      mode,
      effort,
      mentionedSlugs: [...mentionedSlugs],
      attachments: [...pendingAttachments],
    };

    setInput("");
    setMentionedSlugs([]);
    setPendingAttachments([]);

    if (streamingRef.current) {
      const queued: QueuedChatMessage = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        threadId: activeThreadIdRef.current,
        content: payload.content,
        mode: payload.mode,
        effort: payload.effort,
        mentionedSlugs: payload.mentionedSlugs,
        attachments: payload.attachments,
        createdAt: new Date().toISOString(),
      };
      const next = [...queuedMessagesRef.current, queued];
      queuedMessagesRef.current = next;
      setQueuedMessages(next);
      return;
    }

    void dispatchTurn(payload);
  }

  function handleSendOrQueue() {
    dispatchUserText(input);
  }

  function handleStopStream() {
    manualStopRef.current = true;
    const pendingSteer = steeredItemRef.current;
    if (pendingSteer) {
      // Restore the pending steer to the front of the queue instead of losing it.
      const next = [pendingSteer, ...queuedMessagesRef.current];
      queuedMessagesRef.current = next;
      setQueuedMessages(next);
    }
    steeredItemRef.current = null;
    abortRef.current?.abort();
  }

  function handleEditQueued(id: string, newContent: string) {
    setQueuedMessages((prev) => {
      const next = prev.map((item) =>
        item.id === id ? { ...item, content: newContent } : item,
      );
      queuedMessagesRef.current = next;
      return next;
    });
  }

  function handleRemoveQueued(id: string) {
    const removed = queuedMessagesRef.current.find((item) => item.id === id);
    if (removed) {
      revokeAttachmentPreviews(removed.attachments);
    }
    const next = queuedMessagesRef.current.filter((item) => item.id !== id);
    queuedMessagesRef.current = next;
    setQueuedMessages(next);
  }

  function handleSteerQueued(id: string) {
    const target = queuedMessagesRef.current.find((item) => item.id === id);
    if (!target) return;

    let rest = queuedMessagesRef.current.filter((item) => item.id !== id);
    // If a steer is already pending mid-interrupt, push it back to the front
    // of the queue instead of silently discarding it.
    const pendingSteer = steeredItemRef.current;
    if (pendingSteer) {
      rest = [pendingSteer, ...rest];
    }
    queuedMessagesRef.current = rest;
    setQueuedMessages(rest);

    if (streamingRef.current) {
      manualStopRef.current = false;
      steeredItemRef.current = target;
      abortRef.current?.abort();
    } else {
      steeredItemRef.current = null;
      void dispatchTurn({
        content: target.content,
        mode: target.mode,
        effort: target.effort,
        mentionedSlugs: target.mentionedSlugs,
        attachments: target.attachments,
        targetThreadId: target.threadId,
      });
    }
  }

  function handleMoveQueued(id: string, dir: -1 | 1) {
    const current = queuedMessagesRef.current;
    const idx = current.findIndex((q) => q.id === id);
    if (idx === -1) return;
    const item = current[idx]!;
    // Only swap with the adjacent item queued for the same thread.
    let neighbor = -1;
    if (dir === -1) {
      for (let i = idx - 1; i >= 0; i--) {
        if (current[i]!.threadId === item.threadId) {
          neighbor = i;
          break;
        }
      }
    } else {
      for (let i = idx + 1; i < current.length; i++) {
        if (current[i]!.threadId === item.threadId) {
          neighbor = i;
          break;
        }
      }
    }
    if (neighbor === -1) return;
    const next = [...current];
    next[idx] = current[neighbor]!;
    next[neighbor] = item;
    queuedMessagesRef.current = next;
    setQueuedMessages(next);
  }

  function handleEditAndResend(messageId: string, newContent: string) {
    if (streamingRef.current) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const existing = messages[idx]!;
    // Revoke blob previews of the dropped turns, but keep the ones resent below.
    const preservedIds = new Set(existing.attachments.map((a) => a.id));
    for (const removed of messages.slice(idx + 1)) {
      revokeAttachmentPreviews(
        removed.attachments.filter((a) => !preservedIds.has(a.id)),
      );
    }
    setMessages((prev) => prev.slice(0, idx));
    recordPromptHistory(newContent);
    void dispatchTurn({
      content: newContent,
      mode,
      effort,
      mentionedSlugs: [...mentionedSlugs],
      attachments: existing.attachments,
      truncateFromMessageId: messageId,
    });
  }

  function handleRegenerate(assistantMessageId: string) {
    if (streamingRef.current) return;
    const assistantIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (assistantIdx <= 0) return;

    let prevUserIdx = -1;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        prevUserIdx = i;
        break;
      }
    }
    if (prevUserIdx === -1) return;

    const prevUser = messages[prevUserIdx]!;
    // Revoke blob previews of the dropped turns, but keep the resent user
    // message's attachments alive.
    const preservedIds = new Set(prevUser.attachments.map((a) => a.id));
    for (const removed of messages.slice(prevUserIdx + 1)) {
      revokeAttachmentPreviews(
        removed.attachments.filter((a) => !preservedIds.has(a.id)),
      );
    }
    setMessages((prev) => prev.slice(0, prevUserIdx));
    void dispatchTurn({
      content: prevUser.content,
      mode,
      effort,
      mentionedSlugs: [...mentionedSlugs],
      attachments: prevUser.attachments,
      truncateFromMessageId: prevUser.id,
    });
  }

  function handleRunSlashAction(cmd: SlashCommandItem) {
    if (cmd.action === "mode-plan") {
      setMode("plan");
      onNotify("Switched to Plan mode", "info", "Requests will generate approval-gated plans.");
      return;
    }
    if (cmd.action === "fork") {
      if (activeThreadId) {
        void handleForkThread(activeThreadId);
      }
      return;
    }
    if (cmd.action === "export") {
      if (activeThreadId) {
        void handleExportThread(activeThreadId);
      }
      return;
    }
    if (cmd.action === "clear") {
      if (activeThreadId) {
        requestClearThread(activeThreadId);
      }
    }
  }

  async function handleChangeApprovalMode(nextMode: ApprovalMode) {
    setChatError(null);
    try {
      const res = await fetch("/api/onboarding/approval-mode", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ approvalMode: nextMode }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Failed to switch approval mode (${res.status})`);
      }
      onNotify(
        nextMode === "yolo"
          ? "YOLO Sandbox mode enabled"
          : nextMode === "smart"
            ? "Smart approval mode enabled"
            : "Manual approval mode enabled",
        nextMode === "yolo" ? "warning" : "info",
        nextMode === "yolo"
          ? "Safe deploys & lifecycle actions auto-execute immediately without pausing."
          : undefined,
      );
      await onRefreshDashboard();
    } catch (err) {
      setChatError(
        err instanceof Error ? err.message : "Could not update approval mode.",
      );
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
      if (approved) {
        await handleExecutePlan(planId);
        return;
      }
      onNotify("Execution plan rejected", "info");
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
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        plan?: ExecutionPlanView;
        execution?: { summary: string };
        followUpMessage?: ChatMessageView;
      };
      if (payload.followUpMessage) {
        const followUp = payload.followUpMessage;
        setMessages((prev) =>
          prev.some((m) => m.id === followUp.id) ? prev : [...prev, followUp],
        );
        scrollToLatest("smooth");
      }
      if (!res.ok) {
        throw new Error(payload.error ?? `Execution failed (${res.status})`);
      }
      if (payload.plan) {
        setPlansById((prev) => ({ ...prev, [payload.plan!.id]: payload.plan! }));
      }
      if (payload.execution) {
        setExecutionNotes((prev) => ({ ...prev, [planId]: payload.execution!.summary }));
        onNotify("Plan executed", "success", payload.execution.summary);
      }
      void onRefreshDashboard();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not execute plan.");
    } finally {
      setPlanBusyId(null);
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

      {/* Left Threads Rail (Desktop) */}
      {showThreadsRail && (
        <ChatThreadRail
          threads={threads}
          activeThreadId={activeThreadId}
          streamingThreadId={streamingThreadId}
          streaming={streaming}
          onSelectThread={(id) => {
            setActiveThreadId(id);
            setChatError(null);
          }}
          onNewThread={() => void handleNewThread()}
          onRenameThread={handleRenameThread}
          onTogglePin={handleTogglePin}
          onToggleArchive={handleToggleArchive}
          onForkThread={(id) => handleForkThread(id)}
          onRequestDeleteThread={requestDeleteThread}
        />
      )}

      {/* Left Threads Drawer (Mobile) */}
      {mobileThreadsOpen && (
        <div
          className="fixed inset-0 z-50 flex bg-[var(--bg-backdrop)] backdrop-blur-xs md:hidden"
          onClick={() => setMobileThreadsOpen(false)}
        >
          <div
            className="flex h-full w-72 bg-[var(--bg-rail)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <ChatThreadRail
              threads={threads}
              activeThreadId={activeThreadId}
              streamingThreadId={streamingThreadId}
              streaming={streaming}
              className="flex h-full w-full flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-rail)]"
              onSelectThread={(id) => {
                setActiveThreadId(id);
                setMobileThreadsOpen(false);
                setChatError(null);
              }}
              onNewThread={() => void handleNewThread()}
              onRenameThread={handleRenameThread}
              onTogglePin={handleTogglePin}
              onToggleArchive={handleToggleArchive}
              onForkThread={(id) => handleForkThread(id)}
              onRequestDeleteThread={requestDeleteThread}
            />
          </div>
        </div>
      )}

      {/* Center Conversation Canvas */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* T3-Code Thread Sub-Toolbar (solid surface, zero sticky backdrop glitch) */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {/* Desktop rail toggle */}
            <button
              type="button"
              onClick={() => setShowThreadsRail((prev) => !prev)}
              className="hidden rounded-lg p-1.5 text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:inline-flex"
              title={showThreadsRail ? "Hide threads panel" : "Show threads panel"}
              aria-label="Toggle threads sidebar"
            >
              <PanelLeftIcon className="h-4 w-4" />
            </button>
            {/* Mobile drawer toggle */}
            <button
              type="button"
              onClick={() => setMobileThreadsOpen(true)}
              className="inline-flex rounded-lg p-1.5 text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:hidden"
              title="Open threads"
              aria-label="Open threads drawer"
            >
              <PanelLeftIcon className="h-4 w-4" />
            </button>

            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
                {activeThread?.title ?? "CTO Agent Studio"}
              </span>
              {activeThread?.parentThreadId && (
                <span className="hidden items-center gap-1 rounded-full border border-[var(--violet-border)] bg-[var(--violet-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--violet)] sm:inline-flex">
                  <GitForkIcon className="h-2.5 w-2.5" />
                  Forked
                </span>
              )}
              {activeThread?.archived && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--warning-border)] bg-[var(--warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--warning)]">
                  <ArchiveIcon className="h-2.5 w-2.5" />
                  Archived
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {activeThread && (
              <>
                <button
                  type="button"
                  onClick={() => void handleTogglePin(activeThread)}
                  className={`rounded-lg p-1.5 transition hover:bg-[var(--bg-hover)] ${
                    activeThread.pinned
                      ? "text-[var(--accent)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                  title={activeThread.pinned ? "Unpin thread" : "Pin thread"}
                  aria-label={activeThread.pinned ? "Unpin thread" : "Pin thread"}
                >
                  <PinIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={streaming}
                  onClick={() => void handleForkThread(activeThread.id)}
                  className="rounded-lg p-1.5 text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--violet)] disabled:opacity-40"
                  title="Fork thread (/fork)"
                  aria-label="Fork thread"
                >
                  <GitForkIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={messages.length === 0}
                  onClick={() => void handleExportThread(activeThread.id)}
                  className="rounded-lg p-1.5 text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                  title="Export Markdown (/export)"
                  aria-label="Export conversation as Markdown"
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={streaming || messages.length === 0}
                  onClick={() => requestClearThread(activeThread.id)}
                  className="rounded-lg p-1.5 text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] disabled:opacity-40"
                  title="Clear messages (/clear)"
                  aria-label="Clear thread messages"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </>
            )}

            <span className="mx-0.5 hidden h-4 w-px bg-[var(--border-subtle)] xl:inline-block" />

            <button
              type="button"
              onClick={onToggleInspector}
              className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition xl:inline-flex ${
                showInspector
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
              title="Toggle thread context & live server inspector"
            >
              <PanelRightIcon className="h-3.5 w-3.5" />
              Context
            </button>
          </div>
        </div>

        {/* Messages Scroll Viewport with anchored "Jump to latest" pill */}
        <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={handleMessageListScroll}
          className="h-full overflow-y-auto px-4 py-6 sm:px-6"
        >
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center sm:py-12">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)] shadow-sm">
                  <SparklesIcon className="h-6 w-6" />
                </div>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
                  Autonomous CTO Agent
                </h2>
                <p className="mt-2 max-w-lg text-sm leading-relaxed text-[var(--text-secondary)]">
                  Inspect telemetry, attach screenshots or configs, type{" "}
                  <span className="font-mono text-[var(--accent)]">@</span> to ground
                  answers in live workloads, queue follow-ups mid-turn, or switch between{" "}
                  <strong className="text-[var(--text-primary)]">Agent</strong>,{" "}
                  <strong className="text-[var(--warning)]">Plan</strong>, and{" "}
                  <strong className="text-[var(--success)]">Ask</strong> modes with{" "}
                  <kbd className="vps-kbd">Shift+Tab</kbd>.
                </p>

                {!onboardingPayload?.state.llmConfigured && (
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-soft)] px-4 py-2.5 text-xs text-[var(--warning)]">
                    <span>
                      Running built-in deterministic CTO planner. Connect OpenCode,
                      OpenAI, Claude, or Ollama for full reasoning.
                    </span>
                    <button
                      type="button"
                      onClick={onOpenSetupWizard}
                      className="rounded-lg bg-amber-500/20 px-2.5 py-1 font-semibold hover:bg-amber-500/30"
                    >
                      Configure AI
                    </button>
                  </div>
                )}

                <div className="mt-7 grid w-full gap-3 text-left sm:grid-cols-2">
                  {STARTER_CARDS.map((card) => (
                    <button
                      key={card.title}
                      type="button"
                      onClick={() => {
                        setMode(card.mode);
                        recordPromptHistory(card.prompt);
                        void dispatchTurn({
                          content: card.prompt,
                          mode: card.mode,
                          effort,
                          mentionedSlugs: [],
                          attachments: [],
                        });
                      }}
                      className="vps-card group rounded-2xl p-4 text-left transition hover:border-[var(--accent-border)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                          {card.title}
                        </span>
                        <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                          {card.tag}
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                        {card.prompt}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => {
                const linkedPlan = message.planId
                  ? plansById[message.planId] ?? null
                  : null;
                return (
                  <ChatTurnItem
                    key={message.id}
                    message={message}
                    isLatestAssistant={message.id === latestAssistantId}
                    linkedPlan={linkedPlan}
                    streaming={streaming}
                    elapsedMs={elapsedMs}
                    planBusyId={planBusyId}
                    executionSummary={
                      linkedPlan ? executionNotes[linkedPlan.id] : undefined
                    }
                    authHeaders={authHeaders}
                    onOpenLightbox={setLightboxImage}
                    onEditAndResend={handleEditAndResend}
                    onRegenerate={handleRegenerate}
                    onForkFromMessage={(msgId) => {
                      if (activeThreadId) {
                        void handleForkThread(activeThreadId, msgId);
                      }
                    }}
                    onApprovePlan={(id) => void handlePlanDecision(id, true)}
                    onRejectPlan={(id) => void handlePlanDecision(id, false)}
                    onExecutePlan={(id) => void handleExecutePlan(id)}
                    onQuickReply={(text) => dispatchUserText(text)}
                  />
                );
              })
            )}
            <div ref={scrollAnchorRef} />
          </div>
        </div>

        {/* Floating "Jump to latest" pill when scrolled up */}
        {showJumpToLatest && messages.length > 0 && (
          <div className="pointer-events-none absolute right-0 bottom-4 left-0 z-20 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToLatest("smooth")}
              className="vps-elevated pointer-events-auto inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
            >
              <ArrowDownIcon className="h-3.5 w-3.5" />
              Jump to latest
            </button>
          </div>
        )}
        </div>

        {/* Inline Error Banner */}
        {chatError && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2 sm:px-6">
            <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3.5 py-2 text-xs text-[var(--danger)]">
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
          </div>
        )}

        {/* T3-Code Composer */}
        <ChatComposer
          textareaRef={textareaRef}
          input={input}
          mode={mode}
          effort={effort}
          mentionedSlugs={mentionedSlugs}
          pendingAttachments={pendingAttachments}
          queuedMessages={activeQueuedMessages}
          uploadingFiles={uploadingFiles}
          streaming={streaming}
          elapsedMs={elapsedMs}
          apps={apps}
          onboardingPayload={onboardingPayload}
          effectiveProvider={effectiveProvider}
          effectiveModel={effectiveModel}
          promptHistory={promptHistory}
          onChangeInput={setInput}
          onChangeMode={setMode}
          onChangeEffort={setEffort}
          approvalMode={onboardingPayload?.state.persona.approvalMode ?? "manual"}
          onChangeApprovalMode={(next) => void handleChangeApprovalMode(next)}
          onAddMention={addMention}
          onRemoveMention={removeMention}
          onSelectProviderModel={handleSelectProviderModel}
          onUploadFiles={(files) => void uploadFiles(files)}
          onRemoveAttachment={removePendingAttachment}
          onSendOrQueue={handleSendOrQueue}
          onStopStream={handleStopStream}
          onRunSlashAction={handleRunSlashAction}
          onEditQueued={handleEditQueued}
          onRemoveQueued={handleRemoveQueued}
          onSteerQueued={handleSteerQueued}
          onMoveQueued={handleMoveQueued}
          onOpenSetupWizard={onOpenSetupWizard}
        />
      </div>

      {/* Right Context & Live Server Inspector (T3-Code Studio Panel) */}
      {showInspector && (
        <aside className="hidden h-full w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] p-4 xl:flex">
          {/* Active Session Summary */}
          <div className="vps-card rounded-2xl p-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <LayersIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Session Context
              </h3>
              <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-0.5 font-mono text-[10px] capitalize text-[var(--text-secondary)]">
                {mode} · {effort}
              </span>
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2">
                <p className="text-[10px] text-[var(--text-muted)]">Messages</p>
                <p className="tabular-nums mt-0.5 font-mono font-semibold text-[var(--text-primary)]">
                  {messages.length}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2">
                <p className="text-[10px] text-[var(--text-muted)]">Queued</p>
                <p className="tabular-nums mt-0.5 font-mono font-semibold text-[var(--text-primary)]">
                  {activeQueuedMessages.length}
                </p>
              </div>
            </div>

            {metrics && (
              <button
                type="button"
                onClick={() => addMention("host-metrics")}
                className="vps-btn-secondary mt-2.5 flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-[11px]"
              >
                <span className="inline-flex items-center gap-1.5 truncate">
                  <AtSignIcon className="h-3 w-3 text-[var(--accent)]" />
                  <span className="truncate font-mono">@host-metrics</span>
                </span>
                <span className="tabular-nums text-[10px] text-[var(--text-muted)]">
                  RAM {metrics.memoryUsagePercent}%
                </span>
              </button>
            )}
          </div>

          {/* Thread Execution Plans */}
          {threadPlans.length > 0 && (
            <div className="vps-card rounded-2xl p-3.5">
              <div className="flex items-center justify-between">
                <h3 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <ShieldIcon className="h-3.5 w-3.5 text-[var(--warning)]" />
                  Thread Plans ({threadPlans.length})
                </h3>
                <button
                  type="button"
                  onClick={() => onNavigate("activity")}
                  className="text-[11px] font-medium text-[var(--accent)] hover:underline"
                >
                  Approvals
                </button>
              </div>
              <ul className="mt-2.5 space-y-2">
                {threadPlans.map((plan) => (
                  <li
                    key={plan.id}
                    className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5 text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-[var(--text-primary)]">
                        {plan.goal}
                      </span>
                      <span className="shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9.5px] font-semibold capitalize text-[var(--text-secondary)]">
                        {plan.status}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10.5px] text-[var(--text-muted)]">
                      {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"} ·{" "}
                      {plan.summary}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Thread Attachments */}
          {threadAttachments.length > 0 && (
            <div className="vps-card rounded-2xl p-3.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Thread Files ({threadAttachments.length})
              </h3>
              <ul className="mt-2.5 space-y-1.5">
                {threadAttachments.map((att) => (
                  <li
                    key={att.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {att.kind === "image" ? (
                        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[var(--violet)]" />
                      ) : (
                        <FileTextIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                      )}
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {att.name}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                      {formatBytes(att.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Live Workloads with @mention, Restart & Logs */}
          <div className="vps-card rounded-2xl p-3.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Workloads ({apps.length})
              </h3>
              <button
                type="button"
                onClick={() => onNavigate("apps")}
                className="text-[11px] font-medium text-[var(--accent)] hover:underline"
              >
                Manage all
              </button>
            </div>

            {apps.length === 0 ? (
              <p className="mt-2.5 text-xs leading-relaxed text-[var(--text-muted)]">
                No isolated workloads yet. Ask the CTO Agent to deploy a web app or
                personal agent.
              </p>
            ) : (
              <div className="mt-2.5 space-y-2">
                {apps.map((app) => {
                  const running = app.status === "running";
                  const isMentioned = mentionedSlugs.includes(app.slug);
                  return (
                    <div
                      key={app.slug}
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
                          {app.name}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize ${
                            running
                              ? "bg-[var(--success-soft)] text-[var(--success)]"
                              : "bg-[var(--bg-surface)] text-[var(--text-muted)]"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              running ? "bg-[var(--success)]" : "bg-[var(--text-muted)]"
                            }`}
                          />
                          {app.status}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--text-muted)]">
                        {app.domain ?? "internal network"}
                      </p>
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            isMentioned
                              ? removeMention(app.slug)
                              : addMention(app.slug)
                          }
                          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10.5px] font-medium transition ${
                            isMentioned
                              ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                              : "vps-btn-secondary"
                          }`}
                          title="Attach this workload's live logs & status to your next message"
                        >
                          <AtSignIcon className="h-3 w-3" />
                          {isMentioned ? "Attached" : "Mention"}
                        </button>
                        <button
                          type="button"
                          disabled={busyAppSlug === app.slug}
                          onClick={() =>
                            onLifecycle(app.slug, running ? "restart" : "start")
                          }
                          className="vps-btn-secondary flex-1 rounded-lg px-2 py-1 text-[10.5px] font-medium"
                        >
                          {running ? "Restart" : "Start"}
                        </button>
                        <button
                          type="button"
                          onClick={() => onInspectApp(app, "logs")}
                          className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] font-medium text-[var(--accent)]"
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

          {/* Recent Audit Mini-Feed */}
          <div className="vps-card rounded-2xl p-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Recent Audit
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => addMention("audit-trail")}
                  className="font-mono text-[10.5px] text-[var(--accent)] hover:underline"
                  title="Attach audit trail context to next message"
                >
                  +@audit
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("activity")}
                  className="text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  All
                </button>
              </div>
            </div>
            {auditEvents.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--text-muted)]">No events yet.</p>
            ) : (
              <ul className="mt-2.5 space-y-2">
                {auditEvents.slice(0, 6).map((evt) => (
                  <li
                    key={evt.id}
                    className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-2 text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono font-medium text-[var(--text-primary)]">
                        {evt.action}
                      </span>
                      <span className="tabular-nums shrink-0 text-[10px] text-[var(--text-muted)]">
                        {formatRelativeTime(evt.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-secondary)]">
                      {evt.summary}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Active Model Footer */}
          <div className="px-1 text-[10.5px] text-[var(--text-muted)]">
            Active engine:{" "}
            <span className="font-medium text-[var(--text-secondary)]">
              {providerDisplayName(effectiveProvider)}
              {effectiveModel ? ` · ${effectiveModel}` : ""}
            </span>
          </div>
        </aside>
      )}

      {/* Safe Confirmation Dialog for Thread Delete / Clear */}
      <ConfirmDialog
        dialog={confirmDialog}
        busy={confirmBusy}
        onClose={() => setConfirmDialog(null)}
      />
    </div>
  );
}
