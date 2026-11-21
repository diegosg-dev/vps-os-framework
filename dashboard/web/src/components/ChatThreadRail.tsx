import { useMemo, useRef, useState } from "react";
import { formatRelativeTime, providerDisplayName } from "../lib/format";
import type { ChatThreadView } from "../types";
import {
  ArchiveIcon,
  EditIcon,
  GitForkIcon,
  MessageSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "./Icons";

interface ChatThreadRailProps {
  threads: ChatThreadView[];
  activeThreadId: string | null;
  streamingThreadId: string | null;
  streaming: boolean;
  className?: string | undefined;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onRenameThread: (threadId: string, title: string) => Promise<void>;
  onTogglePin: (thread: ChatThreadView) => Promise<void>;
  onToggleArchive: (thread: ChatThreadView) => Promise<void>;
  onForkThread: (threadId: string) => Promise<void>;
  onRequestDeleteThread: (thread: ChatThreadView) => void;
}

export function ChatThreadRail({
  threads,
  activeThreadId,
  streamingThreadId,
  streaming,
  className,
  onSelectThread,
  onNewThread,
  onRenameThread,
  onTogglePin,
  onToggleArchive,
  onForkThread,
  onRequestDeleteThread,
}: ChatThreadRailProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // Guards against Enter + Blur (or StrictMode re-entry) double-committing a rename.
  const committedRef = useRef<string | null>(null);

  const archivedCount = useMemo(
    () => threads.filter((t) => Boolean(t.archived)).length,
    [threads],
  );

  const visibleThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter((t) => {
      const isArchived = Boolean(t.archived);
      if (filter === "active" && isArchived) return false;
      if (filter === "archived" && !isArchived) return false;
      if (q && !t.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [filter, search, threads]);

  const pinnedThreads = useMemo(
    () => visibleThreads.filter((t) => Boolean(t.pinned)),
    [visibleThreads],
  );
  const regularThreads = useMemo(
    () => visibleThreads.filter((t) => !t.pinned),
    [visibleThreads],
  );

  async function commitRename(threadId: string) {
    if (committedRef.current === threadId) return;
    const next = editingTitle.trim();
    setEditingId(null);
    if (!next) return;
    committedRef.current = threadId;
    try {
      await onRenameThread(threadId, next);
    } finally {
      committedRef.current = null;
    }
  }

  function renderThreadRow(thread: ChatThreadView) {
    const active = thread.id === activeThreadId;
    const isWorking = streaming && streamingThreadId === thread.id;
    const isEditing = editingId === thread.id;

    return (
      <div
        key={thread.id}
        className={`group rounded-xl px-2.5 py-2 text-left transition ${
          active
            ? "bg-[var(--bg-active)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-default)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }`}
      >
        {isEditing ? (
          <input
            type="text"
            autoFocus
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onBlur={() => void commitRename(thread.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void commitRename(thread.id);
              } else if (e.key === "Escape") {
                setEditingId(null);
              }
            }}
            className="vps-input w-full rounded-md px-2 py-1 text-xs"
          />
        ) : (
          <>
            <div className="flex items-start gap-1.5">
              <button
                type="button"
                onClick={() => onSelectThread(thread.id)}
                onDoubleClick={() => {
                  setEditingId(thread.id);
                  setEditingTitle(thread.title);
                }}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-1.5">
                  {isWorking ? (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)] animate-pulse-dot"
                      title="CTO Agent working"
                    />
                  ) : thread.parentThreadId ? (
                    <GitForkIcon className="h-3.5 w-3.5 shrink-0 text-[var(--violet)]" />
                  ) : (
                    <MessageSquareIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                  )}
                  <span className="truncate text-xs font-medium">
                    {thread.title}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 pl-5 text-[10.5px] text-[var(--text-muted)]">
                  <span>{formatRelativeTime(thread.updatedAt)}</span>
                  {thread.messageCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="tabular-nums">{thread.messageCount}m</span>
                    </>
                  )}
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
            </div>

            {/* Subtle T3-style hover action strip */}
            <div className="mt-1.5 hidden items-center justify-end gap-0.5 border-t border-[var(--border-subtle)] pt-1 group-hover:flex">
              <button
                type="button"
                onClick={() => void onTogglePin(thread)}
                className={`rounded p-1 transition hover:bg-[var(--bg-hover)] ${
                  thread.pinned
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
                title={thread.pinned ? "Unpin thread" : "Pin thread"}
                aria-label={thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
              >
                <PinIcon className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingId(thread.id);
                  setEditingTitle(thread.title);
                }}
                className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                title="Rename thread"
                aria-label={`Rename ${thread.title}`}
              >
                <EditIcon className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => void onForkThread(thread.id)}
                className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--violet)]"
                title="Fork conversation"
                aria-label={`Fork ${thread.title}`}
              >
                <GitForkIcon className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => void onToggleArchive(thread)}
                className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--warning)]"
                title={thread.archived ? "Restore thread" : "Archive thread"}
                aria-label={thread.archived ? `Restore ${thread.title}` : `Archive ${thread.title}`}
              >
                <ArchiveIcon className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => onRequestDeleteThread(thread)}
                className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
                title="Delete thread"
                aria-label={`Delete ${thread.title}`}
              >
                <TrashIcon className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <aside
      className={
        className ??
        "hidden w-64 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-rail)] md:flex"
      }
    >
      <div className="space-y-2.5 border-b border-[var(--border-subtle)] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Threads
          </span>
          <button
            type="button"
            onClick={onNewThread}
            disabled={streaming}
            className="vps-btn-secondary inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium"
            title="Start new conversation"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New
          </button>
        </div>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search threads..."
            className="vps-input w-full rounded-lg py-1.5 pr-2.5 pl-8 text-xs"
          />
        </div>

        {/* Active / Archived Segmented Filter */}
        <div className="grid grid-cols-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setFilter("active")}
            className={`rounded-md py-1 font-medium transition ${
              filter === "active"
                ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            Active ({threads.length - archivedCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter("archived")}
            className={`rounded-md py-1 font-medium transition ${
              filter === "archived"
                ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            Archived ({archivedCount})
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-2">
        {visibleThreads.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-default)] p-4 text-center text-xs text-[var(--text-muted)]">
            {filter === "archived"
              ? "No archived conversations yet."
              : threads.length === 0
                ? "Start a conversation to inspect your VPS or deploy apps."
                : "No matching threads."}
          </div>
        ) : (
          <>
            {pinnedThreads.length > 0 && (
              <div className="space-y-1">
                <p className="flex items-center gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <PinIcon className="h-2.5 w-2.5 text-[var(--accent)]" />
                  Pinned
                </p>
                {pinnedThreads.map(renderThreadRow)}
              </div>
            )}

            {regularThreads.length > 0 && (
              <div className="space-y-1">
                {pinnedThreads.length > 0 && (
                  <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Recent
                  </p>
                )}
                {regularThreads.map(renderThreadRow)}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
