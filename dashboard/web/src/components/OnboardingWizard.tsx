import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  BaselineScanView,
  DnsCheckView,
  LlmProviderId,
  OnboardingPayload,
  OnboardingStepId,
} from "../types";

interface OnboardingWizardProps {
  payload: OnboardingPayload;
  authHeaders: () => Record<string, string>;
  onTokenRotated: (newToken: string) => void;
  onRefreshState: () => Promise<void>;
  onComplete: (starterPrompt?: string) => void;
  onCancel?: (() => void) | undefined;
}

const STEPS: Array<{ id: OnboardingStepId; number: number; label: string }> = [
  { id: "domain", number: 1, label: "Domain & HTTPS" },
  { id: "provider", number: 2, label: "AI CTO Brain" },
  { id: "persona", number: 3, label: "Security & CTO" },
  { id: "scan", number: 4, label: "Baseline Scan" },
  { id: "complete", number: 5, label: "Launch" },
];

const STARTER_PROMPTS = [
  "Create a personal life agent in its own isolated folder with Telegram access",
  "Deploy a new web app in its own container and check resource limits",
  "Inspect system health, backups, and security status in plain English",
];

function statusBadgeClass(status: "ok" | "warn" | "pending"): string {
  if (status === "ok") {
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  }
  if (status === "warn") {
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  }
  return "bg-slate-800 text-slate-300 border-slate-700";
}

async function extractError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as {
      error?: string;
      issues?: Array<{ message: string }>;
    };
    if (data.issues && data.issues.length > 0) {
      return `${data.error ?? "Validation error"}: ${data.issues
        .map((i) => i.message)
        .join("; ")}`;
    }
    return data.error ?? `API returned ${res.status}`;
  } catch {
    return `API returned ${res.status}`;
  }
}

export function OnboardingWizard({
  payload,
  authHeaders,
  onTokenRotated,
  onRefreshState,
  onComplete,
  onCancel,
}: OnboardingWizardProps) {
  const { state, providerCatalog, hermesStatus, passphraseConfigured } = payload;

  const [step, setStep] = useState<OnboardingStepId>(
    state.currentStep === "complete" && state.completed ? "domain" : state.currentStep,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Step 1: Domain & DNS
  const [domainMode, setDomainMode] = useState<"domain" | "ip-only">(state.domainMode);
  const [domainInput, setDomainInput] = useState(state.domain ?? "");
  const [acmeEmail, setAcmeEmail] = useState(state.acmeEmail ?? "");
  const [dnsCheck, setDnsCheck] = useState<DnsCheckView | null>(null);

  // Step 2: AI Provider
  const defaultProvider: LlmProviderId = state.llmProvider ?? "openai";
  const initialCatalog =
    providerCatalog.find((item) => item.id === defaultProvider) ?? providerCatalog[0];
  const [provider, setProvider] = useState<LlmProviderId>(defaultProvider);
  const [model, setModel] = useState(
    state.llmModel ?? initialCatalog?.defaultModel ?? "gpt-4.1",
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(state.llmBaseUrl ?? "");
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(
    Boolean(state.llmBaseUrl) || defaultProvider === "ollama",
  );
  const [providerTestResult, setProviderTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // Step 3: Security, Persona & Channels
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [ownerName, setOwnerName] = useState(state.persona.ownerName || "Server Owner");
  const [technicalLevel, setTechnicalLevel] = useState(state.persona.technicalLevel);
  const [communicationStyle, setCommunicationStyle] = useState(
    state.persona.communicationStyle,
  );
  const [approvalMode, setApprovalMode] = useState(state.persona.approvalMode);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [discordBotToken, setDiscordBotToken] = useState("");

  // Step 4: Baseline scan
  const [scanResult, setScanResult] = useState<BaselineScanView | null>(
    state.baselineScan,
  );
  const [autoScanned, setAutoScanned] = useState(false);

  const activeCatalog =
    providerCatalog.find((item) => item.id === provider) ?? providerCatalog[0];

  function selectProvider(nextProvider: LlmProviderId) {
    setProvider(nextProvider);
    setProviderTestResult(null);
    const catalog = providerCatalog.find((item) => item.id === nextProvider);
    if (catalog) {
      setModel(catalog.defaultModel);
      if (nextProvider === "ollama") {
        setBaseUrl(catalog.defaultBaseUrl);
        setShowAdvancedUrl(true);
      } else {
        setBaseUrl("");
        setShowAdvancedUrl(false);
      }
    }
  }

  const runBaselineScan = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/onboarding/baseline-scan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(await extractError(res));
      }
      const data = (await res.json()) as { scan: BaselineScanView };
      setScanResult(data.scan);
      setNotice("Server baseline scan saved to CTO memory (MEMORY.md).");
      await onRefreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run baseline scan.");
    } finally {
      setBusy(false);
    }
  }, [authHeaders, onRefreshState]);

  useEffect(() => {
    if (step === "scan" && !scanResult && !autoScanned && !busy) {
      setAutoScanned(true);
      void runBaselineScan();
    }
  }, [step, scanResult, autoScanned, busy, runBaselineScan]);

  async function handleSaveDomain(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/onboarding/domain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          mode: domainMode,
          domain: domainMode === "domain" ? domainInput.trim() : undefined,
          acmeEmail: domainMode === "domain" ? acmeEmail.trim() : undefined,
        }),
      });
      if (!res.ok) {
        throw new Error(await extractError(res));
      }
      const data = (await res.json()) as { dnsCheck: DnsCheckView | null };
      setDnsCheck(data.dnsCheck);
      await onRefreshState();
      if (domainMode === "ip-only" || data.dnsCheck?.matches) {
        setStep("provider");
      } else {
        setNotice(
          "Domain saved. Point your DNS A record to your VPS IP, then click Re-check DNS or continue for now.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save domain settings.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyDnsOnly() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/domain/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ domain: domainInput.trim() || undefined }),
      });
      if (!res.ok) {
        throw new Error(await extractError(res));
      }
      const data = (await res.json()) as { dnsCheck: DnsCheckView };
      setDnsCheck(data.dnsCheck);
      await onRefreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "DNS check failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleTestProvider() {
    setBusy(true);
    setError(null);
    setProviderTestResult(null);
    try {
      const res = await fetch("/api/onboarding/provider/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        }),
      });
      if (!res.ok) {
        throw new Error(await extractError(res));
      }
      const data = (await res.json()) as {
        result: { ok: boolean; message: string };
      };
      setProviderTestResult(data.result);
    } catch (err) {
      setProviderTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Connection test failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProvider(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/onboarding/provider", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        }),
      });
      if (!res.ok) {
        throw new Error(await extractError(res));
      }
      setApiKey("");
      await onRefreshState();
      setStep("persona");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save AI provider.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePersonaAndSecurity(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (passphrase) {
      if (passphrase.length < 10) {
        setError("Passphrase must be at least 10 characters.");
        return;
      }
      if (passphrase !== passphraseConfirm) {
        setError("Passphrases do not match.");
        return;
      }
    }

    setBusy(true);
    try {
      if (passphrase) {
        const secRes = await fetch("/api/onboarding/security", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(),
          },
          body: JSON.stringify({ passphrase }),
        });
        if (!secRes.ok) {
          throw new Error(await extractError(secRes));
        }
        const secData = (await secRes.json()) as { token?: string };
        if (secData.token) {
          onTokenRotated(secData.token);
        }
        setPassphrase("");
        setPassphraseConfirm("");
      }

      const personaRes = await fetch("/api/onboarding/persona", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          ownerName: ownerName.trim() || "Server Owner",
          technicalLevel,
          communicationStyle,
          approvalMode,
          telegramBotToken: telegramBotToken.trim() || undefined,
          discordBotToken: discordBotToken.trim() || undefined,
        }),
      });
      if (!personaRes.ok) {
        throw new Error(await extractError(personaRes));
      }
      setTelegramBotToken("");
      setDiscordBotToken("");
      await onRefreshState();
      setStep("scan");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteSetup(starterPrompt?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          allowWithoutLlm: !state.llmConfigured,
        }),
      });
      if (!res.ok) {
        throw new Error(await extractError(res));
      }
      await onRefreshState();
      onComplete(starterPrompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete onboarding.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-5">
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-sky-400">
              First-Boot Setup Wizard
            </span>
            <h2 className="mt-1 text-xl font-semibold text-slate-100">
              Configure Your Autonomous VPS OS
            </h2>
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
            >
              Back to Dashboard
            </button>
          )}
        </div>

        {/* Stepper */}
        <nav aria-label="Onboarding steps" className="mt-5 grid gap-2 sm:grid-cols-5">
          {STEPS.map((item) => {
            const active = item.id === step;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setStep(item.id);
                }}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition ${
                  active
                    ? "border-sky-500/70 bg-sky-500/15 text-sky-200"
                    : "border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    active
                      ? "bg-sky-500 text-slate-950"
                      : "bg-slate-800 text-slate-300"
                  }`}
                >
                  {item.number}
                </span>
                <span className="truncate font-medium">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200"
          >
            {error}
          </div>
        )}
        {notice && (
          <div className="mt-5 rounded-xl border border-sky-500/30 bg-sky-950/30 px-4 py-3 text-xs text-sky-200">
            {notice}
          </div>
        )}

        {/* Step 1: Domain & HTTPS */}
        {step === "domain" && (
          <form onSubmit={(e) => void handleSaveDomain(e)} className="mt-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <div>
                <p className="text-xs font-medium text-slate-300">
                  Detected Server IP Address
                </p>
                <p className="mt-0.5 font-mono text-sm text-sky-300">
                  {state.publicIp ?? "Auto-detection unavailable (local or private network)"}
                </p>
              </div>
              {state.publicIp && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(state.publicIp ?? "");
                    setNotice(`Copied ${state.publicIp} to clipboard.`);
                  }}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                >
                  Copy IP
                </button>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setDomainMode("domain")}
                className={`rounded-xl border p-4 text-left transition ${
                  domainMode === "domain"
                    ? "border-sky-500 bg-sky-500/10"
                    : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                }`}
              >
                <p className="text-sm font-medium text-slate-100">
                  Connect a Custom Domain
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Recommended. Automatically enables Let&apos;s Encrypt HTTPS via Caddy.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setDomainMode("ip-only")}
                className={`rounded-xl border p-4 text-left transition ${
                  domainMode === "ip-only"
                    ? "border-sky-500 bg-sky-500/10"
                    : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                }`}
              >
                <p className="text-sm font-medium text-slate-100">
                  Use IP Setup Mode for Now
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Skip domain setup for now and bind HTTPS later in Setup Wizard.
                </p>
              </button>
            </div>

            {domainMode === "domain" && (
              <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="wizard-domain"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Dashboard Domain
                    </label>
                    <input
                      id="wizard-domain"
                      type="text"
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      placeholder="os.yourdomain.com"
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="wizard-email"
                      className="block text-xs font-medium text-slate-300"
                    >
                      SSL Certificate Email
                    </label>
                    <input
                      id="wizard-email"
                      type="email"
                      value={acmeEmail}
                      onChange={(e) => setAcmeEmail(e.target.value)}
                      placeholder="you@yourdomain.com"
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-300">
                  <p className="font-medium text-slate-200">
                    DNS Record Required at Your Registrar (Cloudflare, Namecheap, etc.):
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-slate-400">
                    Type: <span className="text-sky-300">A</span> &nbsp;|&nbsp; Host:{" "}
                    <span className="text-sky-300">
                      {domainInput.trim() || "os.yourdomain.com"}
                    </span>{" "}
                    &nbsp;|&nbsp; Value:{" "}
                    <span className="text-sky-300">
                      {state.publicIp ?? "<YOUR_VPS_PUBLIC_IP>"}
                    </span>
                  </p>
                </div>

                {dnsCheck && (
                  <div
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      dnsCheck.matches
                        ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-200"
                        : "border-amber-500/40 bg-amber-950/30 text-amber-200"
                    }`}
                  >
                    {dnsCheck.message}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              {domainMode === "domain" ? (
                <button
                  type="button"
                  disabled={busy || !domainInput.trim()}
                  onClick={() => void handleVerifyDnsOnly()}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                >
                  Check DNS Now
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {domainMode === "domain" && dnsCheck && !dnsCheck.matches && (
                  <button
                    type="button"
                    onClick={() => setStep("provider")}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Continue While DNS Propagates
                  </button>
                )}
                <button
                  type="submit"
                  disabled={busy || (domainMode === "domain" && !domainInput.trim())}
                  className="rounded-lg bg-sky-600 px-5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {busy ? "Saving..." : "Save & Continue"}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Step 2: AI Provider */}
        {step === "provider" && (
          <form onSubmit={(e) => void handleSaveProvider(e)} className="mt-6 space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {providerCatalog.map((entry) => {
                const selected = entry.id === provider;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => selectProvider(entry.id)}
                    className={`rounded-xl border p-3.5 text-left transition ${
                      selected
                        ? "border-sky-500 bg-sky-500/10"
                        : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-100">
                        {entry.label}
                      </span>
                      {!entry.requiresApiKey && (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          Local
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {entry.description}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="wizard-model"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Model
                  </label>
                  <input
                    id="wizard-model"
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                  />
                  {activeCatalog && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {activeCatalog.suggestedModels.map((suggested) => (
                        <button
                          key={suggested}
                          type="button"
                          onClick={() => setModel(suggested)}
                          className={`rounded px-2 py-0.5 text-[11px] ${
                            model === suggested
                              ? "bg-sky-600 text-white"
                              : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                          }`}
                        >
                          {suggested}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {activeCatalog?.requiresApiKey ? (
                  <div>
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="wizard-api-key"
                        className="block text-xs font-medium text-slate-300"
                      >
                        API Key
                      </label>
                      {state.llmConfigured && state.llmProvider === provider && (
                        <span className="text-[11px] text-emerald-300">
                          Key saved securely on server
                        </span>
                      )}
                    </div>
                    <input
                      id="wizard-api-key"
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={
                        state.llmConfigured && state.llmProvider === provider
                          ? "Leave blank to keep existing key"
                          : activeCatalog.keyPlaceholder
                      }
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                    />
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      Stored with chmod 0600 on the server. Never sent back to the browser.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label
                      htmlFor="wizard-ollama-url"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Ollama Endpoint URL
                    </label>
                    <input
                      id="wizard-ollama-url"
                      type="url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="http://host.docker.internal:11434"
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                )}
              </div>

              {activeCatalog?.requiresApiKey && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvancedUrl((prev) => !prev)}
                    className="text-[11px] text-slate-400 underline hover:text-slate-200"
                  >
                    {showAdvancedUrl
                      ? "Hide custom endpoint URL"
                      : "Optional: use custom OpenAI-compatible endpoint URL"}
                  </button>
                  {showAdvancedUrl && (
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={activeCatalog.defaultBaseUrl}
                      aria-label="Custom endpoint URL"
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                    />
                  )}
                </div>
              )}

              {providerTestResult && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    providerTestResult.ok
                      ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-200"
                      : "border-rose-500/40 bg-rose-950/30 text-rose-200"
                  }`}
                >
                  {providerTestResult.message}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep("domain")}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleTestProvider()}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                >
                  Test Connection
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep("persona")}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800"
                >
                  Skip AI for Now
                </button>
                <button
                  type="submit"
                  disabled={busy || !model.trim()}
                  className="rounded-lg bg-sky-600 px-5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {busy ? "Saving..." : "Save AI Provider & Continue"}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Step 3: Security, Persona & Messaging Channels */}
        {step === "persona" && (
          <form
            onSubmit={(e) => void handleSavePersonaAndSecurity(e)}
            className="mt-6 space-y-5"
          >
            <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-100">
                  1. Dashboard Passphrase {passphraseConfigured ? "(Configured)" : "(Recommended)"}
                </h3>
                {passphraseConfigured && (
                  <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
                    Active
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Set a memorable passphrase so you can sign in anytime without copying the
                64-character Admin Token from SSH.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={
                    passphraseConfigured
                      ? "New passphrase (leave blank to keep current)"
                      : "At least 10 characters"
                  }
                  aria-label="New dashboard passphrase"
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                />
                <input
                  type="password"
                  value={passphraseConfirm}
                  onChange={(e) => setPassphraseConfirm(e.target.value)}
                  placeholder="Confirm passphrase"
                  aria-label="Confirm dashboard passphrase"
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <h3 className="text-sm font-medium text-slate-100">
                2. CTO Communication &amp; Safety Preferences (USER.md)
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="wizard-owner-name"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Your Name
                  </label>
                  <input
                    id="wizard-owner-name"
                    type="text"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="wizard-style"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Communication Style
                  </label>
                  <select
                    id="wizard-style"
                    value={communicationStyle}
                    onChange={(e) =>
                      setCommunicationStyle(
                        e.target.value as "plain-english" | "concise" | "detailed",
                      )
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                  >
                    <option value="plain-english">Plain English &amp; Reassuring</option>
                    <option value="concise">Short &amp; Direct</option>
                    <option value="detailed">Detailed Explanations</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setTechnicalLevel("non-technical")}
                  className={`rounded-lg border p-3 text-left text-xs ${
                    technicalLevel === "non-technical"
                      ? "border-sky-500 bg-sky-500/10 text-slate-100"
                      : "border-slate-800 bg-slate-950 text-slate-400"
                  }`}
                >
                  <span className="font-semibold">Non-Linux Owner (Recommended)</span>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Hide raw terminal output and explain actions in plain English.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setTechnicalLevel("developer")}
                  className={`rounded-lg border p-3 text-left text-xs ${
                    technicalLevel === "developer"
                      ? "border-sky-500 bg-sky-500/10 text-slate-100"
                      : "border-slate-800 bg-slate-950 text-slate-400"
                  }`}
                >
                  <span className="font-semibold">Developer / Technical</span>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Include Compose, container, and networking details in summaries.
                  </p>
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setApprovalMode("manual")}
                  className={`rounded-lg border p-3 text-left text-xs ${
                    approvalMode === "manual"
                      ? "border-sky-500 bg-sky-500/10 text-slate-100"
                      : "border-slate-800 bg-slate-950 text-slate-400"
                  }`}
                >
                  <span className="font-semibold">Ask Before Every Change (Safe Default)</span>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Always present an Execution Plan and wait for approval before mutations.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setApprovalMode("smart")}
                  className={`rounded-lg border p-3 text-left text-xs ${
                    approvalMode === "smart"
                      ? "border-sky-500 bg-sky-500/10 text-slate-100"
                      : "border-slate-800 bg-slate-950 text-slate-400"
                  }`}
                >
                  <span className="font-semibold">Smart Mode</span>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Auto-run read-only health checks; confirm all installs &amp; edits.
                  </p>
                </button>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <h3 className="text-sm font-medium text-slate-100">
                3. Optional Mobile Chat Channels (Telegram / Discord)
              </h3>
              <p className="text-xs text-slate-400">
                Connect a bot token if you want to chat with your CTO Agent from your phone.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="wizard-telegram" className="text-slate-300">
                      Telegram Bot Token
                    </label>
                    {state.telegramConfigured && (
                      <span className="text-[11px] text-emerald-300">Configured</span>
                    )}
                  </div>
                  <input
                    id="wizard-telegram"
                    type="password"
                    value={telegramBotToken}
                    onChange={(e) => setTelegramBotToken(e.target.value)}
                    placeholder={
                      state.telegramConfigured
                        ? "Saved (enter new token to replace)"
                        : "From @BotFather (optional)"
                    }
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="wizard-discord" className="text-slate-300">
                      Discord Bot Token
                    </label>
                    {state.discordConfigured && (
                      <span className="text-[11px] text-emerald-300">Configured</span>
                    )}
                  </div>
                  <input
                    id="wizard-discord"
                    type="password"
                    value={discordBotToken}
                    onChange={(e) => setDiscordBotToken(e.target.value)}
                    placeholder={
                      state.discordConfigured
                        ? "Saved (enter new token to replace)"
                        : "Discord Developer Portal (optional)"
                    }
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep("provider")}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-sky-600 px-5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {busy ? "Saving..." : "Save Preferences & Run Baseline Scan"}
              </button>
            </div>
          </form>
        )}

        {/* Step 4: Baseline Scan */}
        {step === "scan" && (
          <div className="mt-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-slate-100">
                  Initial Server Health &amp; Readiness Scan
                </h3>
                <p className="text-xs text-slate-400">
                  Verifies system resources, domain/TLS readiness, and seeds CTO memory (MEMORY.md).
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runBaselineScan()}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              >
                {busy ? "Scanning..." : "Re-run Scan"}
              </button>
            </div>

            {scanResult ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5">
                    <p className="text-[11px] text-slate-400">Server &amp; OS</p>
                    <p className="mt-1 truncate text-sm font-medium text-slate-100">
                      {scanResult.hostname}
                    </p>
                    <p className="text-xs text-slate-500">{scanResult.osRelease}</p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5">
                    <p className="text-[11px] text-slate-400">Compute &amp; RAM</p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {scanResult.cpuCount} vCPU
                    </p>
                    <p className="text-xs text-slate-500">
                      {scanResult.memoryUsedMb} / {scanResult.memoryTotalMb} MB RAM
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5">
                    <p className="text-[11px] text-slate-400">Disk Capacity</p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {scanResult.diskTotalGb !== null
                        ? `${scanResult.diskUsedGb} / ${scanResult.diskTotalGb} GB`
                        : "Unavailable"}
                    </p>
                    <p className="text-xs text-slate-500">Root filesystem</p>
                  </div>
                </div>

                <ul className="space-y-2">
                  {scanResult.checks.map((check) => (
                    <li
                      key={check.id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-xs"
                    >
                      <div>
                        <p className="font-medium text-slate-200">{check.label}</p>
                        <p className="mt-0.5 text-slate-400">{check.detail}</p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadgeClass(
                          check.status,
                        )}`}
                      >
                        {check.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-6 text-center text-xs text-slate-400">
                Running baseline server diagnostics...
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep("persona")}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => setStep("complete")}
                disabled={busy}
                className="rounded-lg bg-sky-600 px-5 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                Continue to Launch
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Complete */}
        {step === "complete" && (
          <div className="mt-6 space-y-5">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-5">
              <h3 className="text-base font-semibold text-emerald-200">
                Your VPS OS Environment Is Ready
              </h3>
              <p className="mt-1 text-xs text-slate-300">
                All settings are saved safely on your server. You can re-open this Setup
                Wizard anytime from the top header.
              </p>

              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <dt className="text-slate-400">Ingress &amp; Domain</dt>
                  <dd className="mt-1 font-medium text-slate-100">
                    {state.domainMode === "domain" && state.domain
                      ? `${state.domain} (${state.dnsVerified ? "DNS verified" : "DNS pending"})`
                      : "IP setup mode (:80)"}
                  </dd>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <dt className="text-slate-400">AI CTO Provider</dt>
                  <dd className="mt-1 font-medium text-slate-100">
                    {state.llmConfigured
                      ? `${state.llmProvider} (${state.llmModel})`
                      : "Not configured yet (dashboard-only mode)"}
                  </dd>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <dt className="text-slate-400">Approval Guardrail</dt>
                  <dd className="mt-1 font-medium text-slate-100">
                    {state.persona.approvalMode === "manual"
                      ? "Manual confirmation before every change"
                      : "Smart (auto-read, confirm mutations)"}
                  </dd>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <dt className="text-slate-400">Hermes CTO Gateway</dt>
                  <dd className="mt-1 font-medium text-slate-100">
                    {hermesStatus.reachable ? "Online & ready" : hermesStatus.detail}
                  </dd>
                </div>
              </dl>
            </div>

            <div>
              <p className="text-xs font-medium text-slate-300">
                Or complete setup and start immediately with a CTO request:
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={busy}
                    onClick={() => void handleCompleteSetup(prompt)}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-left text-xs text-slate-300 transition hover:border-sky-500/60 hover:text-sky-200 disabled:opacity-50"
                  >
                    &ldquo;{prompt}&rdquo;
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep("scan")}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleCompleteSetup()}
                className="rounded-lg bg-emerald-600 px-5 py-2.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? "Finishing..." : "Complete Setup & Open Dashboard"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
