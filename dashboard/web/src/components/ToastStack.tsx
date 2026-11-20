import type { ToastItem } from "../types";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  SparklesIcon,
  XCircleIcon,
  XIcon,
} from "./Icons";

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const TONE_STYLES: Record<
  ToastItem["tone"],
  { border: string; bg: string; iconColor: string }
> = {
  success: {
    border: "border-[var(--success-border)]",
    bg: "bg-[var(--bg-elevated)]",
    iconColor: "text-[var(--success)]",
  },
  info: {
    border: "border-[var(--accent-border)]",
    bg: "bg-[var(--bg-elevated)]",
    iconColor: "text-[var(--accent)]",
  },
  warning: {
    border: "border-[var(--warning-border)]",
    bg: "bg-[var(--bg-elevated)]",
    iconColor: "text-[var(--warning)]",
  },
  error: {
    border: "border-[var(--danger-border)]",
    bg: "bg-[var(--bg-elevated)]",
    iconColor: "text-[var(--danger)]",
  },
};

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-full max-w-sm flex-col gap-2.5 px-4 sm:px-0"
    >
      {toasts.map((toast) => {
        const style = TONE_STYLES[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            className={`animate-fade-in pointer-events-auto flex items-start gap-3 rounded-xl border px-3.5 py-3 shadow-2xl ${style.border} ${style.bg}`}
          >
            <span className={`mt-0.5 shrink-0 ${style.iconColor}`}>
              {toast.tone === "success" && <CheckCircleIcon className="h-4 w-4" />}
              {toast.tone === "info" && <SparklesIcon className="h-4 w-4" />}
              {toast.tone === "warning" && <AlertTriangleIcon className="h-4 w-4" />}
              {toast.tone === "error" && <XCircleIcon className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[var(--text-primary)]">
                {toast.title}
              </p>
              {toast.description && (
                <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="rounded-md p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              aria-label="Dismiss notification"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
