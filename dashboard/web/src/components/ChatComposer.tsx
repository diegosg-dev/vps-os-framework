import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { formatBytes, providerDisplayName } from "../lib/format";
import type {
  AppCardView,
  ApprovalMode,
  ChatAttachmentView,
  ChatMode,
  LlmProviderId,
  OnboardingPayload,
  QueuedChatMessage,
  ReasoningEffort,
} from "../types";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AtSignIcon,
  BotIcon,
  BrainIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  EditIcon,
  FileTextIcon,
  GlobeIcon,
  PaperclipIcon,
  ServerIcon,
  SlidersIcon,
  SpinnerIcon,
  SquareStopIcon,
  TrashIcon,
  XIcon,
  ZapIcon,
} from "./Icons";

export interface SlashCommandItem {
  command: string;
  label: string;
  hint: string;
  action: "prompt" | "mode-plan" | "fork" | "export" | "clear";
  prompt?: string;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    command: "/health",
    label: "Inspect Server Health",
    hint: "Live CPU, RAM, disk & workload summary",
    action: "prompt",
    prompt:
      "Check live CPU, RAM, disk headroom, running workloads, and summarize server health in plain English.",
  },
  {
    command: "/deploy-app",
    label: "Deploy Isolated Web App",
    hint: "Generate an Auto-HTTPS container plan",
    action: "prompt",
    prompt:
      "Prepare an execution plan to deploy a new isolated web app with automatic Caddy HTTPS.",
  },
  {
    command: "/deploy-agent",
    label: "Create Personal AI Agent",
    hint: "Locked apartment agent in its own folder",
    action: "prompt",
    prompt:
      "Prepare an execution plan to create a new Personal AI Agent inside its own locked apartment folder.",
  },
  {
    command: "/security",
    label: "Security & TLS Review",
    hint: "Audit SSH, firewall, certificates & risk events",
    action: "prompt",
    prompt:
      "Inspect my recent audit events, SSH guardrails, and TLS certificate readiness for anything that needs attention.",
  },
  {
    command: "/logs",
    label: "Diagnose Workload Logs",
    hint: "Check running container logs for warnings/errors",
    action: "prompt",
    prompt:
      "Check recent logs across my running workloads and flag any warnings or errors.",
  },
  {
    command: "/plan",
    label: "Switch to Plan Mode",
    hint: "Force approval-gated execution planning",
    action: "mode-plan",
  },
  {
    command: "/fork",
    label: "Fork This Conversation",
    hint: "Branch into a new independent thread",
    action: "fork",
  },
  {
    command: "/export",
    label: "Export Thread as Markdown",
    hint: "Download conversation transcript (.md)",
    action: "export",
  },
  {
    command: "/clear",
    label: "Clear Thread Context",
    hint: "Start fresh in this thread",
    action: "clear",
  },
];

const EFFORT_OPTIONS: Array<{
  id: ReasoningEffort;
  label: string;
  short: string;
  hint: string;
}> = [
  { id: "low", label: "Low", short: "Low", hint: "Fast, concise checks" },
  { id: "medium", label: "Medium", short: "Med", hint: "Balanced daily ops" },
  { id: "high", label: "High", short: "High", hint: "Deep troubleshooting" },
  { id: "max", label: "Max", short: "Max", hint: "Exhaustive edge-case audit" },
];

interface MentionItem {
  slug: string;
  label: string;
  detail: string;
  kind: "web-app" | "personal-agent" | "system";
}

interface ChatComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  mode: ChatMode;
  effort: ReasoningEffort;
  mentionedSlugs: string[];
  pendingAttachments: ChatAttachmentView[];
  queuedMessages: QueuedChatMessage[];
  uploadingFiles: boolean;
  streaming: boolean;
  elapsedMs: number;
  apps: AppCardView[];
  onboardingPayload: OnboardingPayload | null;
  effectiveProvider: LlmProviderId | null;
  effectiveModel: string | null;
  promptHistory: string[];
  onChangeInput: (value: string) => void;
  onChangeMode: (mode: ChatMode) => void;
  onChangeEffort: (effort: ReasoningEffort) => void;
  approvalMode: ApprovalMode;
  onChangeApprovalMode: (mode: ApprovalMode) => void;
  onAddMention: (slug: string) => void;
  onRemoveMention: (slug: string) => void;
  onSelectProviderModel: (provider: LlmProviderId, model: string) => void;
  onUploadFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSendOrQueue: () => void;
  onStopStream: () => void;
  onRunSlashAction: (cmd: SlashCommandItem) => void;
  onEditQueued: (id: string, newContent: string) => void;
  onRemoveQueued: (id: string) => void;
  onSteerQueued: (id: string) => void;
  onMoveQueued?: (id: string, dir: -1 | 1) => void;
  onOpenSetupWizard: () => void;
}

export function ChatComposer({
  textareaRef,
  input,
  mode,
  effort,
  mentionedSlugs,
  pendingAttachments,
  queuedMessages,
  uploadingFiles,
  streaming,
  elapsedMs,
  apps,
  onboardingPayload,
  effectiveProvider,
  effectiveModel,
  promptHistory,
  onChangeInput,
  onChangeMode,
  onChangeEffort,
  approvalMode,
  onChangeApprovalMode,
  onAddMention,
  onRemoveMention,
  onSelectProviderModel,
  onUploadFiles,
  onRemoveAttachment,
  onSendOrQueue,
  onStopStream,
  onRunSlashAction,
  onEditQueued,
  onRemoveQueued,
  onSteerQueued,
  onMoveQueued,
  onOpenSetupWizard,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showEffortMenu, setShowEffortMenu] = useState(false);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [activePopoverIndex, setActivePopoverIndex] = useState(0);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [dismissedSlashInput, setDismissedSlashInput] = useState("");

  // Close menus on outside click
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(event.target as Node)
      ) {
        setShowModelMenu(false);
        setShowEffortMenu(false);
        setShowMentionPicker(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  // Build @mentionable context targets (live workloads + system resources)
  const mentionTargets = useMemo<MentionItem[]>(() => {
    const appTargets: MentionItem[] = apps.map((app) => ({
      slug: app.slug,
      label: app.name,
      detail: `${app.status} · ${app.domain ?? "internal"}`,
      kind: app.kind,
    }));
    const systemTargets: MentionItem[] = [
      {
        slug: "host-metrics",
        label: "Host Telemetry",
        detail: "Live CPU, RAM, load & disk stats",
        kind: "system",
      },
      {
        slug: "audit-trail",
        label: "Recent Audit Trail",
        detail: "Latest security & lifecycle events",
        kind: "system",
      },
      {
        slug: "pending-plans",
        label: "Execution Plans",
        detail: "Pending & approved mutation plans",
        kind: "system",
      },
    ];
    return [...appTargets, ...systemTargets];
  }, [apps]);

  // Detect active /slash command at start of input (unless dismissed via Escape)
  const matchingSlash = useMemo(() => {
    if (dismissedSlashInput && dismissedSlashInput === input) {
      return [];
    }
    if (!input.startsWith("/") || input.includes(" ") || input.includes("\n")) {
      return [];
    }
    const q = input.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.command.startsWith(q));
  }, [dismissedSlashInput, input]);

  // Detect active @mention token at end of input OR manual @ button
  const atMatch = useMemo(() => {
    const match = input.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
    return match ? (match[1] ?? "").toLowerCase() : null;
  }, [input]);

  const matchingMentions = useMemo(() => {
    if (atMatch === null && !showMentionPicker) return [];
    const q = atMatch ?? "";
    return mentionTargets.filter(
      (item) =>
        !mentionedSlugs.includes(item.slug) &&
        (item.slug.toLowerCase().includes(q) ||
          item.label.toLowerCase().includes(q)),
    );
  }, [atMatch, mentionTargets, mentionedSlugs, showMentionPicker]);

  const activePopoverKind: "slash" | "mention" | null =
    matchingSlash.length > 0
      ? "slash"
      : matchingMentions.length > 0
        ? "mention"
        : null;

  useEffect(() => {
    setActivePopoverIndex(0);
  }, [activePopoverKind, input]);

  function applyMention(item: MentionItem) {
    onAddMention(item.slug);
    if (atMatch !== null) {
      onChangeInput(input.replace(/(?:^|\s)@[a-zA-Z0-9_-]*$/, " ").trimStart());
    }
    setShowMentionPicker(false);
    textareaRef.current?.focus();
  }

  function applySlash(cmd: SlashCommandItem) {
    if (cmd.action === "prompt" && cmd.prompt) {
      setDismissedSlashInput("");
      onChangeInput(cmd.prompt);
      textareaRef.current?.focus();
      return;
    }
    setDismissedSlashInput("");
    onChangeInput("");
    onRunSlashAction(cmd);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (items) {
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        onUploadFiles(files);
        return;
      }
    }

    // T3 Code smart large-text paste → auto-convert to clean pasted-snippet attachment chip!
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const lineCount = text.split(/\r?\n/).length;
    if (
      (text.length >= 750 || lineCount >= 16) &&
      pendingAttachments.length < 5
    ) {
      event.preventDefault();
      const snippetName = `pasted-${lineCount}-lines.txt`;
      const file = new File([text], snippetName, { type: "text/plain" });
      onUploadFiles([file]);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Shift+Tab cycles interaction mode (Agent -> Plan -> Ask -> Agent), just like T3 Code!
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      const order: ChatMode[] = ["agent", "plan", "ask"];
      const next = order[(order.indexOf(mode) + 1) % order.length]!;
      onChangeMode(next);
      return;
    }

    // Escape closes menus, dismisses the slash popover, or stops streaming
    if (event.key === "Escape") {
      if (activePopoverKind === "slash") {
        event.preventDefault();
        setDismissedSlashInput(input);
        return;
      }
      if (showModelMenu || showEffortMenu || showMentionPicker) {
        event.preventDefault();
        setShowModelMenu(false);
        setShowEffortMenu(false);
        setShowMentionPicker(false);
        return;
      }
      if (streaming) {
        event.preventDefault();
        onStopStream();
        return;
      }
    }

    // Keyboard navigation inside active /slash or @mention popover
    if (activePopoverKind) {
      const count =
        activePopoverKind === "slash"
          ? matchingSlash.length
          : matchingMentions.length;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActivePopoverIndex((prev) => (prev + 1) % count);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActivePopoverIndex((prev) => (prev - 1 + count) % count);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (activePopoverKind === "slash") {
          const chosen = matchingSlash[activePopoverIndex];
          if (chosen) applySlash(chosen);
        } else {
          const chosen = matchingMentions[activePopoverIndex];
          if (chosen) applyMention(chosen);
        }
        return;
      }
    }

    // Prompt history recall: ArrowUp steps backward through history (from an
    // empty composer or from an unedited recalled entry); ArrowDown steps
    // forward again, returning to the empty composer past the newest entry.
    if (
      event.key === "ArrowUp" &&
      !event.shiftKey &&
      promptHistory.length > 0 &&
      historyCursor < promptHistory.length - 1 &&
      (!input || (historyCursor >= 0 && input === promptHistory[historyCursor]))
    ) {
      event.preventDefault();
      const nextIdx = Math.min(historyCursor + 1, promptHistory.length - 1);
      setHistoryCursor(nextIdx);
      onChangeInput(promptHistory[nextIdx] ?? "");
      return;
    }

    if (
      event.key === "ArrowDown" &&
      !event.shiftKey &&
      historyCursor >= 0 &&
      input === promptHistory[historyCursor]
    ) {
      event.preventDefault();
      if (historyCursor === 0) {
        setHistoryCursor(-1);
        onChangeInput("");
      } else {
        const nextIdx = historyCursor - 1;
        setHistoryCursor(nextIdx);
        onChangeInput(promptHistory[nextIdx] ?? "");
      }
      return;
    }

    // Enter sends (or queues while streaming)
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      setHistoryCursor(-1);
      onSendOrQueue();
    }
  }

  const catalog = useMemo(() => {
    const raw = onboardingPayload?.providerCatalog ?? [];
    const activeBaseUrl = onboardingPayload?.state.llmBaseUrl?.replace(/\/+$/, "").toLowerCase();
    return raw.map((entry) => {
      if (!entry.endpointPresets?.length) return entry;
      const preset =
        (onboardingPayload?.state.llmProvider === entry.id && activeBaseUrl
          ? entry.endpointPresets.find(
              (p) => p.baseUrl.replace(/\/+$/, "").toLowerCase() === activeBaseUrl,
            )
          : undefined) ?? entry.endpointPresets[0];
      return {
        ...entry,
        suggestedModels: preset?.suggestedModels ?? entry.suggestedModels,
      };
    });
  }, [onboardingPayload]);
  const filteredCatalog = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return catalog;
    return catalog
      .map((entry) => ({
        ...entry,
        suggestedModels: entry.suggestedModels.filter(
          (m) =>
            m.toLowerCase().includes(q) || entry.label.toLowerCase().includes(q),
        ),
      }))
      .filter(
        (entry) =>
          entry.suggestedModels.length > 0 ||
          entry.label.toLowerCase().includes(q),
      );
  }, [catalog, modelSearch]);

  const activeEffortMeta =
    EFFORT_OPTIONS.find((e) => e.id === effort) ?? EFFORT_OPTIONS[1]!;

  return (
    <div
      ref={menuContainerRef}
      className="border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-4 pt-2.5 pb-4 sm:px-6"
    >
      <div className="relative mx-auto max-w-3xl space-y-2">
        {/* T3-Code Queued Messages Tray */}
        {queuedMessages.length > 0 && (
          <div className="vps-card animate-fade-in overflow-hidden rounded-xl border-[var(--accent-border)]">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3 py-1.5 text-[11px]">
              <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--accent)]">
                <CornerDownRightIcon className="h-3 w-3" />
                {queuedMessages.length} queued message
                {queuedMessages.length === 1 ? "" : "s"} —{" "}
                {streaming ? "auto-sends next" : "Paused"}
              </span>
              {streaming ? (
                <span className="text-[10.5px] text-[var(--text-muted)]">
                  Click Steer to interrupt &amp; send now
                </span>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[10.5px] text-[var(--text-muted)]">
                    Ready to send
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const first = queuedMessages[0];
                      if (first) {
                        onSteerQueued(first.id);
                      }
                    }}
                    className="vps-btn-primary inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] font-semibold"
                    title="Resume the queue by sending the next message"
                  >
                    <ArrowUpIcon className="h-2.5 w-2.5" />
                    Send Next
                  </button>
                </div>
              )}
            </div>
            <ul className="divide-y divide-[var(--border-subtle)]">
              {queuedMessages.map((qItem, idx) => (
                <li
                  key={qItem.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                >
                  {editingQueueId === qItem.id ? (
                    <div className="flex flex-1 items-center gap-1.5">
                      <input
                        type="text"
                        autoFocus
                        value={editingQueueText}
                        onChange={(e) => setEditingQueueText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && editingQueueText.trim()) {
                            onEditQueued(qItem.id, editingQueueText.trim());
                            setEditingQueueId(null);
                          } else if (e.key === "Escape") {
                            setEditingQueueId(null);
                          }
                        }}
                        className="vps-input flex-1 rounded-lg px-2.5 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (editingQueueText.trim()) {
                            onEditQueued(qItem.id, editingQueueText.trim());
                          }
                          setEditingQueueId(null);
                        }}
                        className="vps-btn-primary rounded-lg px-2 py-1 text-[11px] font-medium"
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="tabular-nums rounded bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                          #{idx + 1}
                        </span>
                        <span className="truncate text-[var(--text-primary)]">
                          {qItem.content}
                        </span>
                        <span className="hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.2 text-[10px] capitalize text-[var(--text-muted)] sm:inline">
                          {qItem.mode} · {qItem.effort}
                        </span>
                        {qItem.attachments.length > 0 && (
                          <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1 py-0.5 text-[10px] text-[var(--text-muted)]"
                            title={`${qItem.attachments.length} attachment${qItem.attachments.length === 1 ? "" : "s"}`}
                          >
                            <PaperclipIcon className="h-2.5 w-2.5" />
                            {qItem.attachments.length}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0 || !onMoveQueued}
                          onClick={() => onMoveQueued?.(qItem.id, -1)}
                          className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
                          title="Move earlier in queue"
                          aria-label="Move queued message earlier"
                        >
                          <ArrowUpIcon className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === queuedMessages.length - 1 || !onMoveQueued}
                          onClick={() => onMoveQueued?.(qItem.id, 1)}
                          className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
                          title="Move later in queue"
                          aria-label="Move queued message later"
                        >
                          <ArrowDownIcon className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onSteerQueued(qItem.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--accent)] transition hover:opacity-90"
                          title="Interrupt current turn and steer immediately"
                        >
                          <ZapIcon className="h-2.5 w-2.5" />
                          Steer
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingQueueId(qItem.id);
                            setEditingQueueText(qItem.content);
                          }}
                          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                          title="Edit queued message"
                          aria-label="Edit queued message"
                        >
                          <EditIcon className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveQueued(qItem.id)}
                          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
                          title="Cancel queued message"
                          aria-label="Cancel queued message"
                        >
                          <TrashIcon className="h-3 w-3" />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Active /Slash Command Popover */}
        {activePopoverKind === "slash" && (
          <div className="vps-elevated animate-fade-in absolute bottom-full left-0 z-30 mb-2 w-full max-w-xl overflow-hidden rounded-xl p-1.5">
            <div className="flex items-center justify-between px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <span>Slash Commands</span>
              <span>↑↓ navigate · ↵ select</span>
            </div>
            {matchingSlash.map((cmd, idx) => (
              <button
                key={cmd.command}
                type="button"
                onMouseEnter={() => setActivePopoverIndex(idx)}
                onClick={() => applySlash(cmd)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                  idx === activePopoverIndex
                    ? "bg-[var(--accent-soft)] text-[var(--text-primary)]"
                    : "hover:bg-[var(--bg-hover)]"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 whitespace-nowrap font-mono font-semibold text-[var(--accent)]">
                    {cmd.command}
                  </span>
                  <span className="truncate font-medium text-[var(--text-primary)]">
                    {cmd.label}
                  </span>
                </div>
                <span className="hidden shrink-0 whitespace-nowrap text-[10.5px] text-[var(--text-muted)] sm:inline">
                  {cmd.hint}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Active @Context Mention Popover */}
        {activePopoverKind === "mention" && (
          <div className="vps-elevated animate-fade-in absolute bottom-full left-0 z-30 mb-2 w-full max-w-lg overflow-hidden rounded-xl p-1.5">
            <div className="flex items-center justify-between px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <span>Attach Live Server Context (@)</span>
              <span>↑↓ navigate · ↵ attach</span>
            </div>
            {matchingMentions.map((item, idx) => (
              <button
                key={item.slug}
                type="button"
                onMouseEnter={() => setActivePopoverIndex(idx)}
                onClick={() => applyMention(item)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                  idx === activePopoverIndex
                    ? "bg-[var(--accent-soft)] text-[var(--text-primary)]"
                    : "hover:bg-[var(--bg-hover)]"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {item.kind === "personal-agent" ? (
                    <BotIcon className="h-3.5 w-3.5 shrink-0 text-[var(--violet)]" />
                  ) : item.kind === "web-app" ? (
                    <GlobeIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  ) : (
                    <ServerIcon className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
                  )}
                  <span className="font-mono font-medium text-[var(--accent)]">
                    @{item.slug}
                  </span>
                  <span className="truncate text-[var(--text-primary)]">
                    {item.label}
                  </span>
                </div>
                <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">
                  {item.detail}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Main Floating Composer Shell */}
        <div
          className={`vps-card rounded-2xl transition focus-within:ring-2 ${
            mode === "plan"
              ? "border-[var(--warning-border)] focus-within:border-[var(--warning)] focus-within:ring-[var(--warning-soft)]"
              : mode === "ask"
                ? "border-[var(--success-border)] focus-within:border-[var(--success)] focus-within:ring-[var(--success-soft)]"
                : "focus-within:border-[var(--accent)] focus-within:ring-[var(--accent-soft)]"
          }`}
        >
          {/* Context Mentions + Attachments Tray */}
          {(mentionedSlugs.length > 0 ||
            pendingAttachments.length > 0 ||
            uploadingFiles) && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-3.5 py-2">
              {mentionedSlugs.map((slug) => (
                <span
                  key={slug}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2 py-1 font-mono text-[11px] font-medium text-[var(--accent)]"
                >
                  @{slug}
                  <button
                    type="button"
                    onClick={() => onRemoveMention(slug)}
                    className="rounded-full p-0.5 hover:bg-[var(--bg-hover)]"
                    aria-label={`Remove @${slug} context`}
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}

              {pendingAttachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1 text-xs text-[var(--text-primary)]"
                >
                  {att.kind === "image" && att.localPreviewUrl ? (
                    <img
                      src={att.localPreviewUrl}
                      alt={att.name}
                      className="h-6 w-6 rounded object-cover"
                    />
                  ) : (
                    <FileTextIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  )}
                  <span className="max-w-[140px] truncate text-[11px] font-medium">
                    {att.name}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {formatBytes(att.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(att.id)}
                    className="rounded-full p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    aria-label={`Remove ${att.name}`}
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </div>
              ))}

              {uploadingFiles && (
                <span className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)]">
                  <SpinnerIcon className="h-3.5 w-3.5" />
                  Attaching...
                </span>
              )}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              onChangeInput(e.target.value);
              setDismissedSlashInput("");
              setHistoryCursor(-1);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={2}
            placeholder={
              streaming
                ? "Type a follow-up to queue next (Enter to queue, Esc to stop)..."
                : mode === "plan"
                  ? "Describe a change to generate a risk-classified Execution Plan (@ to mention apps, / for commands)..."
                  : mode === "ask"
                    ? "Ask a read-only question about your server or apps (no changes will be proposed)..."
                    : "Ask your Autonomous CTO anything, type @ to attach workload context, / for commands, or paste logs..."
            }
            className="block w-full resize-none bg-transparent px-4 pt-3 pb-2 text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />

          {/* Bottom T3-Code Controls Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Attach File */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept="image/*,.txt,.md,.json,.yml,.yaml,.log,.sh,.conf,.caddy,.toml,.ini,.env.example,.ts,.tsx,.js,.py,.pdf"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    onUploadFiles(e.target.files);
                    e.target.value = "";
                  }
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingFiles || pendingAttachments.length >= 5}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                title="Attach files or screenshots (max 5 MB)"
                aria-label="Attach files"
              >
                <PaperclipIcon className="h-3.5 w-3.5" />
              </button>

              {/* @ Context Mention Trigger */}
              <button
                type="button"
                onClick={() => {
                  setShowModelMenu(false);
                  setShowEffortMenu(false);
                  setShowMentionPicker((prev) => !prev);
                }}
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition ${
                  showMentionPicker
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                }`}
                title="Mention workload or live telemetry (@)"
                aria-label="Mention server context"
              >
                <AtSignIcon className="h-3.5 w-3.5" />
              </button>

              {/* Interaction Mode Selector (Agent / Plan / Ask) */}
              <div
                className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-[11px]"
                title="Cycle mode with Shift+Tab"
              >
                {(
                  [
                    { id: "agent", label: "Agent" },
                    { id: "plan", label: "Plan" },
                    { id: "ask", label: "Ask" },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChangeMode(item.id)}
                    className={`rounded-md px-2 py-1 font-medium transition ${
                      mode === item.id
                        ? item.id === "plan"
                          ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                          : item.id === "ask"
                            ? "bg-[var(--success-soft)] text-[var(--success)]"
                            : "bg-[var(--bg-active)] text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {/* Reasoning Effort Picker */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowModelMenu(false);
                    setShowMentionPicker(false);
                    setShowEffortMenu((prev) => !prev);
                  }}
                  className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium"
                  title="Reasoning depth & effort"
                >
                  <BrainIcon className="h-3 w-3 text-[var(--violet)]" />
                  <span>{activeEffortMeta.short}</span>
                  <ChevronDownIcon className="h-3 w-3 text-[var(--text-muted)]" />
                </button>

                {showEffortMenu && (
                  <div className="vps-elevated animate-fade-in absolute bottom-full left-0 z-30 mb-2 w-52 rounded-xl p-1.5">
                    <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      Reasoning Effort
                    </p>
                    {EFFORT_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          onChangeEffort(opt.id);
                          setShowEffortMenu(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                          effort === opt.id
                            ? "bg-[var(--violet-soft)] text-[var(--violet)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <div>
                          <p className="font-semibold">{opt.label}</p>
                          <p className="text-[10.5px] text-[var(--text-muted)]">
                            {opt.hint}
                          </p>
                        </div>
                        {effort === opt.id && (
                          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* YOLO Sandbox Auto-Execute Toggle */}
              <button
                type="button"
                onClick={() =>
                  onChangeApprovalMode(approvalMode === "yolo" ? "manual" : "yolo")
                }
                title={
                  approvalMode === "yolo"
                    ? "YOLO Sandbox mode ON: safe deploys & lifecycle actions auto-execute immediately (click to restore Manual approvals)"
                    : "Enable YOLO Sandbox mode: skip approval prompts for safe container deploys & lifecycle actions"
                }
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                  approvalMode === "yolo"
                    ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                }`}
              >
                <ZapIcon className="h-3 w-3" />
                <span>{approvalMode === "yolo" ? "YOLO ON" : "YOLO"}</span>
              </button>

              {/* Multi-Provider & Model Switcher */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowEffortMenu(false);
                    setShowMentionPicker(false);
                    setModelSearch("");
                    setShowModelMenu((prev) => !prev);
                  }}
                  className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium"
                  title="Switch AI provider or model"
                >
                  <SlidersIcon className="h-3 w-3 text-[var(--accent)]" />
                  <span className="max-w-[150px] truncate">
                    {effectiveModel ?? providerDisplayName(effectiveProvider)}
                  </span>
                  <ChevronDownIcon className="h-3 w-3 text-[var(--text-muted)]" />
                </button>

                {showModelMenu && (
                  <div className="vps-elevated animate-fade-in absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl p-2">
                    <div className="flex items-center justify-between gap-2 px-1 pb-2">
                      <input
                        type="text"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder="Filter models..."
                        className="vps-input flex-1 rounded-lg px-2.5 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setShowModelMenu(false);
                          onOpenSetupWizard();
                        }}
                        className="shrink-0 text-[11px] font-medium text-[var(--accent)] hover:underline"
                      >
                        Setup
                      </button>
                    </div>

                    <div className="max-h-64 space-y-2 overflow-y-auto pr-0.5">
                      {filteredCatalog.length === 0 ? (
                        <p className="px-2 py-4 text-center text-xs text-[var(--text-muted)]">
                          No matching models.
                        </p>
                      ) : (
                        filteredCatalog.map((entry) => {
                          const isConfigured =
                            onboardingPayload?.state.llmConfigured &&
                            onboardingPayload.state.llmProvider === entry.id;
                          return (
                            <div key={entry.id}>
                              <div className="flex items-center justify-between px-2 py-0.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                                  {entry.label}
                                </span>
                                {isConfigured && (
                                  <span className="rounded-full bg-[var(--success-soft)] px-1.5 py-0.2 text-[9.5px] font-medium text-[var(--success)]">
                                    Active
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 space-y-0.5">
                                {entry.suggestedModels.map((m) => {
                                  const selected =
                                    effectiveProvider === entry.id &&
                                    effectiveModel === m;
                                  return (
                                    <button
                                      key={`${entry.id}-${m}`}
                                      type="button"
                                      onClick={() => {
                                        onSelectProviderModel(entry.id, m);
                                        setShowModelMenu(false);
                                      }}
                                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-[11px] transition ${
                                        selected
                                          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                      }`}
                                    >
                                      <span className="truncate">{m}</span>
                                      {selected && (
                                        <CheckCircleIcon className="h-3.5 w-3.5 shrink-0" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right Submit / Queue / Stop Controls */}
            <div className="flex items-center gap-2">
              {streaming ? (
                <>
                  <span className="tabular-nums hidden font-mono text-[10.5px] text-[var(--text-muted)] sm:inline">
                    {(elapsedMs / 1000).toFixed(1)}s
                  </span>
                  {input.trim() && (
                    <button
                      type="button"
                      onClick={onSendOrQueue}
                      disabled={uploadingFiles}
                      className="vps-btn-primary inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold"
                      title="Queue follow-up message (Enter)"
                    >
                      <CornerDownRightIcon className="h-3 w-3" />
                      Queue
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onStopStream}
                    className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-rose-600 px-2.5 text-xs font-semibold text-white transition hover:bg-rose-500"
                    title="Stop response (Esc)"
                    aria-label="Stop response"
                  >
                    <SquareStopIcon className="h-3 w-3" />
                    <span className="hidden sm:inline">Stop</span>
                  </button>
                </>
              ) : (
                <>
                  <span className="hidden text-[10.5px] text-[var(--text-muted)] md:inline">
                    Shift+Tab mode · @ context · / commands
                  </span>
                  <button
                    type="button"
                    onClick={onSendOrQueue}
                    disabled={!input.trim() || uploadingFiles}
                    className="vps-btn-primary inline-flex h-8 w-8 items-center justify-center rounded-xl"
                    title="Send message (Enter)"
                    aria-label="Send message"
                  >
                    <ArrowUpIcon className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
