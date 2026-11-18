import { useEffect, useState, type FormEvent } from "react";
import type { OnboardingBootStatus } from "../types";

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
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    setMode((current) => {
      if (current === "claim" && !bootStatus.claimAvailable) {
        return bootStatus.passphraseConfigured ? "passphrase" : "token";
      }
      if (current === "token" && !bootStatus.onboardingCompleted && bootStatus.claimAvailable) {
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
    <div className="mx-auto max-w-md px-6 py-14">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-sky-400" />
          <span className="text-xs font-medium uppercase tracking-wider text-sky-400">
            {bootStatus.onboardingCompleted ? "Owner Sign In" : "First-Boot Setup"}
          </span>
        </div>

        <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-100">
          {mode === "claim"
            ? "Claim Your New VPS OS"
            : "Unlock Server Control Panel"}
        </h2>
        <p className="mt-1.5 text-sm text-slate-400">
          {mode === "claim"
            ? "Enter the one-time setup code shown at the end of server installation to launch the browser setup wizard."
            : mode === "passphrase"
              ? "Sign in with the dashboard passphrase you created during onboarding."
              : "Paste your VPS OS Admin Token (found in /vps-os/.env) to connect."}
        </p>

        <div className="mt-5 flex flex-wrap gap-1.5 rounded-xl border border-slate-800 bg-slate-950 p-1">
          {!bootStatus.onboardingCompleted && bootStatus.claimAvailable && (
            <button
              type="button"
              onClick={() => setMode("claim")}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                mode === "claim"
                  ? "bg-sky-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Setup Code
            </button>
          )}
          {bootStatus.passphraseConfigured && (
            <button
              type="button"
              onClick={() => setMode("passphrase")}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                mode === "passphrase"
                  ? "bg-sky-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Passphrase
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("token")}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              mode === "token"
                ? "bg-sky-600 text-white"
                : "text-slate-400 hover:text-slate-200"
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
                className="block text-xs font-medium text-slate-300"
              >
                One-Time Setup Code
              </label>
              <input
                id="setup-code-input"
                type="text"
                autoComplete="one-time-code"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                placeholder="e.g. ABCD-EFGH-JKLM"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm tracking-wider text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
              />
              <p className="mt-1.5 text-[11px] text-slate-500">
                Single-use pairing code printed when you ran bootstrap/install.sh.
              </p>
            </div>
          )}

          {mode === "passphrase" && (
            <div>
              <label
                htmlFor="passphrase-input"
                className="block text-xs font-medium text-slate-300"
              >
                Admin Passphrase
              </label>
              <input
                id="passphrase-input"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Enter your dashboard passphrase"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
              />
            </div>
          )}

          {mode === "token" && (
            <div>
              <label
                htmlFor="admin-token-input"
                className="block text-xs font-medium text-slate-300"
              >
                VPS OS Admin Token
              </label>
              <input
                id="admin-token-input"
                type="password"
                autoComplete="current-password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="Paste VPS_OS_ADMIN_TOKEN"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
              />
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="rounded border-slate-700 bg-slate-950 text-sky-500 focus:ring-sky-500"
            />
            Keep me signed in on this browser
          </label>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200"
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
            className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
          >
            {busy
              ? "Verifying..."
              : mode === "claim"
                ? "Claim & Start Setup Wizard"
                : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
