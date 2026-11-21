import { useEffect, useState, type FormEvent } from "react";
import type { OnboardingBootStatus } from "../types";
import {
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  ShieldIcon,
  SpinnerIcon,
  VpsOsLogo,
} from "./Icons";

type AuthMode = "claim" | "passphrase" | "token";

interface AuthGateProps {
  bootStatus: OnboardingBootStatus;
  error: string | null;
  busy: boolean;
  onClaimCode: (setupCode: string, remember: boolean) => Promise<void>;
  onLoginPassphrase: (passphrase: string, remember: boolean) => Promise<void>;
  onUnlockToken: (token: string, remember: boolean) => Promise<void>;
}

function getDefaultMode(status: OnboardingBootStatus): AuthMode {
  if (!status.onboardingCompleted && status.claimAvailable) {
    return "claim";
  }
  if (status.passphraseConfigured) {
    return "passphrase";
  }
  return "token";
}

export function AuthGate({
  bootStatus,
  error,
  busy,
  onClaimCode,
  onLoginPassphrase,
  onUnlockToken,
}: AuthGateProps) {
  const [mode, setMode] = useState<AuthMode>(() => getDefaultMode(bootStatus));
  const [setupCode, setSetupCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    setMode((current) => {
      if (current === "claim" && !bootStatus.claimAvailable) {
        return bootStatus.passphraseConfigured ? "passphrase" : "token";
      }
      if (
        current === "token" &&
        !bootStatus.onboardingCompleted &&
        bootStatus.claimAvailable
      ) {
        return "claim";
      }
      return current;
    });
  }, [bootStatus]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (mode === "claim") {
      await onClaimCode(setupCode, remember);
    } else if (mode === "passphrase") {
      await onLoginPassphrase(passphrase, remember);
    } else {
      await onUnlockToken(adminToken, remember);
    }
  }

  return (
    <div className="vps-aura flex min-h-[calc(100vh-56px)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="vps-elevated rounded-2xl p-6 sm:p-7">
          <div className="flex items-center gap-3">
            <VpsOsLogo className="h-10 w-10 shrink-0" />
            <div>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                <ShieldIcon className="h-3 w-3" />
                {bootStatus.onboardingCompleted
                  ? "Owner Sign In"
                  : "First-Boot Pairing"}
              </span>
              <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
                {mode === "claim"
                  ? "Claim Your New VPS OS"
                  : "Unlock Control Plane"}
              </h1>
            </div>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            {mode === "claim"
              ? "Enter the one-time setup code shown at the end of server installation to launch the guided setup wizard."
              : mode === "passphrase"
                ? "Sign in with the admin passphrase you configured during onboarding."
                : "Paste your VPS OS Admin Token (stored in /vps-os/.env) to connect."}
          </p>

          <div className="mt-5 flex gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-1">
            {!bootStatus.onboardingCompleted && bootStatus.claimAvailable && (
              <button
                type="button"
                onClick={() => {
                  setMode("claim");
                  setShowSecret(false);
                }}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  mode === "claim"
                    ? "bg-[var(--bg-active)] text-[var(--text-primary)] shadow-xs"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                Setup Code
              </button>
            )}
            {bootStatus.passphraseConfigured && (
              <button
                type="button"
                onClick={() => {
                  setMode("passphrase");
                  setShowSecret(false);
                }}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  mode === "passphrase"
                    ? "bg-[var(--bg-active)] text-[var(--text-primary)] shadow-xs"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                Passphrase
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMode("token");
                setShowSecret(false);
              }}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                mode === "token"
                  ? "bg-[var(--bg-active)] text-[var(--text-primary)] shadow-xs"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              Admin Token
            </button>
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
            {mode === "claim" && (
              <div>
                <label
                  htmlFor="setup-code-input"
                  className="block text-xs font-medium text-[var(--text-secondary)]"
                >
                  One-Time Setup Code
                </label>
                <input
                  id="setup-code-input"
                  type="text"
                  autoComplete="one-time-code"
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value)}
                  placeholder="ABCD-EFGH-JKLM"
                  className="vps-input mt-1.5 w-full rounded-xl px-3.5 py-2.5 font-mono text-sm tracking-wider"
                />
                <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                  Single-use pairing code printed when you ran bootstrap/install.sh.
                </p>
              </div>
            )}

            {mode === "passphrase" && (
              <div>
                <label
                  htmlFor="passphrase-input"
                  className="block text-xs font-medium text-[var(--text-secondary)]"
                >
                  Admin Passphrase
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="passphrase-input"
                    type={showSecret ? "text" : "password"}
                    autoComplete="current-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Enter your dashboard passphrase"
                    className="vps-input w-full rounded-xl py-2.5 pr-10 pl-3.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((prev) => !prev)}
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    aria-label={showSecret ? "Hide passphrase" : "Show passphrase"}
                  >
                    {showSecret ? (
                      <EyeOffIcon className="h-4 w-4" />
                    ) : (
                      <EyeIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {mode === "token" && (
              <div>
                <label
                  htmlFor="admin-token-input"
                  className="block text-xs font-medium text-[var(--text-secondary)]"
                >
                  VPS OS Admin Token
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="admin-token-input"
                    type={showSecret ? "text" : "password"}
                    autoComplete="current-password"
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value)}
                    placeholder="Paste VPS_OS_ADMIN_TOKEN"
                    className="vps-input w-full rounded-xl py-2.5 pr-10 pl-3.5 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((prev) => !prev)}
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    aria-label={showSecret ? "Hide token" : "Show token"}
                  >
                    {showSecret ? (
                      <EyeOffIcon className="h-4 w-4" />
                    ) : (
                      <EyeIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="rounded border-[var(--border-default)]"
              />
              Keep me signed in on this browser
            </label>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3.5 py-2.5 text-xs text-[var(--danger)]"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={
                busy ||
                (mode === "claim" && !setupCode.trim()) ||
                (mode === "passphrase" && !passphrase) ||
                (mode === "token" && !adminToken.trim())
              }
              className="vps-btn-primary inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
            >
              {busy ? (
                <>
                  <SpinnerIcon className="h-4 w-4" />
                  Verifying...
                </>
              ) : (
                <>
                  <LockIcon className="h-4 w-4" />
                  {mode === "claim" ? "Claim & Launch Setup" : "Sign In"}
                </>
              )}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-[11px] text-[var(--text-muted)]">
          Protected by constant-time bearer auth, rate limiting, and fail-closed isolation.
        </p>
      </div>
    </div>
  );
}
