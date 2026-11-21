import { useEffect } from "react";
import { AlertTriangleIcon, ShieldIcon, XIcon } from "./Icons";

export interface ConfirmDialogState {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "primary";
  onConfirm: () => void | Promise<void>;
}

interface ConfirmDialogProps {
  dialog: ConfirmDialogState | null;
  busy?: boolean;
  onClose: () => void;
}

export function ConfirmDialog({ dialog, busy = false, onClose }: ConfirmDialogProps) {
  useEffect(() => {
    if (!dialog) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [dialog, busy, onClose]);

  if (!dialog) return null;

  const tone = dialog.tone ?? "warning";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-backdrop)] p-4 backdrop-blur-xs"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="vps-elevated animate-fade-in w-full max-w-md rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
              tone === "danger"
                ? "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
                : tone === "warning"
                  ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
                  : "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
            }`}
          >
            {tone === "primary" ? (
              <ShieldIcon className="h-4.5 w-4.5" />
            ) : (
              <AlertTriangleIcon className="h-4.5 w-4.5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3
              id="confirm-dialog-title"
              className="text-sm font-semibold text-[var(--text-primary)]"
            >
              {dialog.title}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              {dialog.description}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label="Close confirmation dialog"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="vps-btn-secondary rounded-lg px-3.5 py-2 text-xs font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void dialog.onConfirm()}
            className={`rounded-lg px-4 py-2 text-xs font-semibold text-white transition disabled:opacity-50 ${
              tone === "danger"
                ? "bg-rose-600 hover:bg-rose-500"
                : tone === "warning"
                  ? "bg-amber-600 hover:bg-amber-500"
                  : "vps-btn-primary"
            }`}
          >
            {busy ? "Working..." : dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
