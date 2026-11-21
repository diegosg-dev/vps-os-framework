import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  BaselineScanView,
  DnsCheckView,
  LlmProviderId,
  OnboardingPayload,
  OnboardingStepId,
} from "../types";
import { CheckCircleIcon, CopyIcon, VpsOsLogo } from "./Icons";

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
    return "bg-[var(--success-soft)] text-[var(--success)] border-[var(--success-border)]";
  }
  if (status === "warn") {
    return "bg-[var(--warning-soft)] text-[var(--warning)] border-[var(--warning-border)]";
  }
  return "bg-[var(--bg-inset)] text-[var(--text-secondary)] border-[var(--border-default)]";
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
  const defaultProvider: LlmProviderId = state.llmProvider ?? "opencode";
  const initialCatalog =
    providerCatalog.find((item) => item.id === defaultProvider) ?? providerCatalog[0];
  const [provider, setProvider] = useState<LlmProviderId>(defaultProvider);
  const [model, setModel] = useState(
    state.llmModel ?? initialCatalog?.defaultModel ?? "glm-5.3",
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(
    state.llmBaseUrl ??
      (defaultProvider === "opencode" || defaultProvider === "ollama"
        ? initialCatalog?.defaultBaseUrl ?? ""
        : ""),
  );
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(
    Boolean(state.llmBaseUrl) ||
      defaultProvider === "ollama" ||
      defaultProvider === "opencode",
  );
  const [providerTestResult, setProviderTestResult] = useState<{
    ok: boolean;
    message: string;
    availableModels?: string[];
  } | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelsSource, setModelsSource] = useState<"live" | "fallback" | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

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

  const activePreset = activeCatalog?.endpointPresets?.find(
    (preset) =>
      preset.baseUrl.replace(/\/+$/, "").toLowerCase() ===
      (baseUrl.trim() || activeCatalog.defaultBaseUrl).replace(/\/+$/, "").toLowerCase(),
  );

  function selectProvider(nextProvider: LlmProviderId) {
    setProvider(nextProvider);
    setProviderTestResult(null);
    setDiscoveredModels([]);
    setModelsSource(null);
    const catalog = providerCatalog.find((item) => item.id === nextProvider);
    if (catalog) {
      setModel(catalog.defaultModel);
      if (nextProvider === "ollama" || nextProvider === "opencode") {
        setBaseUrl(catalog.defaultBaseUrl);
        setShowAdvancedUrl(true);
      } else {
        setBaseUrl("");
        setShowAdvancedUrl(false);
      }
    }
  }

  const refreshProviderModels = useCallback(
    async (
      targetProvider: LlmProviderId,
      targetBaseUrl: string,
      targetApiKey: string,
      signal?: AbortSignal,
    ) => {
      setLoadingModels(true);
      try {
        const res = await fetch("/api/onboarding/provider/models", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(),
          },
          body: JSON.stringify({
            provider: targetProvider,
            baseUrl: targetBaseUrl.trim() || undefined,
            apiKey: targetApiKey.trim() || undefined,
          }),
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          models?: string[];
          source?: "live" | "fallback";
        };
        if (signal?.aborted) return;
        if (Array.isArray(data.models) && data.models.length > 0) {
          setDiscoveredModels(data.models);
          setModelsSource(data.source ?? "fallback");
        }
      } catch {
        // Keep static preset suggestions if discovery fails or is aborted
      } finally {
        if (!signal?.aborted) {
          setLoadingModels(false);
        }
      }
    },
    [authHeaders],
  );

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

  useEffect(() => {
    if (step !== "provider" || provider !== "opencode") {
      return;
    }
    // Skip live discovery for local serve until the user clicks Test or Refresh
    if (activePreset?.id === "local") {
      return;
    }
    const controller = new AbortController();
    void refreshProviderModels(provider, baseUrl, apiKey, controller.signal);
    return () => controller.abort();
  }, [step, provider, baseUrl, activePreset?.id, refreshProviderModels]);

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
          "Domain saved. Point your DNS A record to your VPS IP, then click Check DNS Now or continue for now.",
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
        result: { ok: boolean; message: string; availableModels?: string[] };
      };
      setProviderTestResult(data.result);
      if (data.result.availableModels && data.result.availableModels.length > 0) {
        setDiscoveredModels(data.result.availableModels);
        setModelsSource("live");
      }
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

  const currentStepIdx = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="vps-elevated rounded-2xl p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-5">
          <div className="flex items-center gap-3">
            <VpsOsLogo className="h-9 w-9 shrink-0" />
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                VPS OS Setup Wizard
              </span>
              <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)] sm:text-xl">
                Configure Your Autonomous Personal Cloud
              </h2>
            </div>
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="vps-btn-secondary rounded-xl px-3.5 py-1.5 text-xs font-medium"
            >
              Back to Workspace
            </button>
          )}
        </div>

        {/* Stepper */}
        <nav aria-label="Onboarding steps" className="mt-5 grid gap-2 sm:grid-cols-5">
          {STEPS.map((item, idx) => {
            const active = item.id === step;
            const completed = idx < currentStepIdx || state.completed;
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
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold ${
                    active
                      ? "bg-[var(--accent)] text-[var(--text-inverse)]"
                      : completed
                        ? "bg-[var(--success-soft)] text-[var(--success)]"
                        : "bg-[var(--bg-active)] text-[var(--text-secondary)]"
                  }`}
                >
                  {completed && !active ? (
                    <CheckCircleIcon className="h-3.5 w-3.5" />
                  ) : (
                    item.number
                  )}
                </span>
                <span className="truncate font-medium">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-xs text-[var(--danger)]"
          >
            {error}
          </div>
        )}
        {notice && (
          <div className="mt-5 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] px-4 py-3 text-xs text-[var(--text-primary)]">
            {notice}
          </div>
        )}

        {/* Step 1: Domain & HTTPS */}
        {step === "domain" && (
          <form onSubmit={(e) => void handleSaveDomain(e)} className="mt-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4">
              <div>
                <p className="text-xs font-medium text-[var(--text-secondary)]">
                  Detected Server IP Address
                </p>
                <p className="mt-0.5 font-mono text-sm font-medium text-[var(--accent)]">
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
                  className="vps-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
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
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
                }`}
              >
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  Connect a Custom Domain
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Recommended. Automatically enables Let&apos;s Encrypt HTTPS via Caddy.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setDomainMode("ip-only")}
                className={`rounded-xl border p-4 text-left transition ${
                  domainMode === "ip-only"
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
                }`}
              >
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  Use IP Setup Mode for Now
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Skip domain setup for now and bind HTTPS later in System Settings.
                </p>
              </button>
            </div>

            {domainMode === "domain" && (
              <div className="space-y-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="wizard-domain"
                      className="block text-xs font-medium text-[var(--text-secondary)]"
                    >
                      Dashboard Domain
                    </label>
                    <input
                      id="wizard-domain"
                      type="text"
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      placeholder="os.yourdomain.com"
                      className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="wizard-email"
                      className="block text-xs font-medium text-[var(--text-secondary)]"
                    >
                      SSL Certificate Email
                    </label>
                    <input
                      id="wizard-email"
                      type="email"
                      value={acmeEmail}
                      onChange={(e) => setAcmeEmail(e.target.value)}
                      placeholder="you@yourdomain.com"
                      className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs text-[var(--text-secondary)]">
                  <p className="font-medium text-[var(--text-primary)]">
                    DNS Record Required at Your Registrar (Cloudflare, Namecheap, etc.):
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">
                    Type: <span className="text-[var(--accent)]">A</span> &nbsp;|&nbsp; Host:{" "}
                    <span className="text-[var(--accent)]">
                      {domainInput.trim() || "os.yourdomain.com"}
                    </span>{" "}
                    &nbsp;|&nbsp; Value:{" "}
                    <span className="text-[var(--accent)]">
                      {state.publicIp ?? "<YOUR_VPS_PUBLIC_IP>"}
                    </span>
                  </p>
                </div>

                {dnsCheck && (
                  <div
                    className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                      dnsCheck.matches
                        ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                        : "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
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
                  className="vps-btn-secondary rounded-xl px-4 py-2 text-xs font-medium"
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
                    className="vps-btn-secondary rounded-xl px-4 py-2 text-xs font-medium"
                  >
                    Continue While DNS Propagates
                  </button>
                )}
                <button
                  type="submit"
                  disabled={busy || (domainMode === "domain" && !domainInput.trim())}
                  className="vps-btn-primary rounded-xl px-5 py-2 text-xs font-semibold"
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
                const badgeText =
                  entry.badge ?? (!entry.requiresApiKey ? "Local" : undefined);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => selectProvider(entry.id)}
                    className={`rounded-xl border p-3.5 text-left transition ${
                      selected
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {entry.label}
                      </span>
                      {badgeText && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            entry.id === "opencode"
                              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                              : "bg-[var(--success-soft)] text-[var(--success)]"
                          }`}
                        >
                          {badgeText}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                      {entry.description}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="space-y-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4">
              {activeCatalog?.endpointPresets && activeCatalog.endpointPresets.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-[var(--text-secondary)]">
                    {activeCatalog.label} Connection Mode
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    {activeCatalog.endpointPresets.map((preset) => {
                      const presetSelected = activePreset?.id === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            const prevModels = new Set<string>([
                              ...(activeCatalog.suggestedModels ?? []),
                              activeCatalog.defaultModel,
                              ...(activePreset?.suggestedModels ?? []),
                              ...(activePreset?.defaultModel ? [activePreset.defaultModel] : []),
                              ...discoveredModels,
                            ]);
                            setBaseUrl(preset.baseUrl);
                            setProviderTestResult(null);
                            setDiscoveredModels([]);
                            setModelsSource(null);
                            if (!model.trim() || prevModels.has(model.trim())) {
                              setModel(preset.defaultModel ?? activeCatalog.defaultModel);
                            }
                          }}
                          className={`rounded-xl border p-2.5 text-left transition ${
                            presetSelected
                              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                              : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="text-xs font-semibold">{preset.label}</span>
                            {!preset.requiresApiKey && (
                              <span className="rounded bg-[var(--success-soft)] px-1.5 py-0.5 text-[9px] text-[var(--success)]">
                                Optional key
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-[10.5px] leading-snug text-[var(--text-muted)]">
                            {preset.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="wizard-model"
                      className="block text-xs font-medium text-[var(--text-secondary)]"
                    >
                      Model
                    </label>
                    <button
                      type="button"
                      disabled={loadingModels}
                      onClick={() => void refreshProviderModels(provider, baseUrl, apiKey)}
                      className="text-[11px] text-[var(--accent)] hover:underline disabled:opacity-50"
                    >
                      {loadingModels
                        ? "Loading models…"
                        : modelsSource === "live"
                          ? "Live catalog · Refresh"
                          : "Refresh models"}
                    </button>
                  </div>
                  <input
                    id="wizard-model"
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
                  />
                  {activeCatalog && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(discoveredModels.length > 0
                        ? discoveredModels.slice(0, 12)
                        : (activePreset?.suggestedModels ?? activeCatalog.suggestedModels)
                      ).map((suggested) => (
                        <button
                          key={suggested}
                          type="button"
                          onClick={() => setModel(suggested)}
                          className={`rounded-lg border px-2 py-0.5 font-mono text-[11px] transition ${
                            model === suggested
                              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--text-inverse)] font-medium"
                              : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                          }`}
                        >
                          {suggested}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {provider === "ollama" ? (
                  <div>
                    <label
                      htmlFor="wizard-ollama-url"
                      className="block text-xs font-medium text-[var(--text-secondary)]"
                    >
                      Ollama Endpoint URL
                    </label>
                    <input
                      id="wizard-ollama-url"
                      type="url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="http://host.docker.internal:11434"
                      className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 font-mono text-sm"
                    />
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="wizard-api-key"
                        className="block text-xs font-medium text-[var(--text-secondary)]"
                      >
                        {activePreset?.keyLabel ??
                          (provider === "opencode"
                            ? "OpenCode API Key / Password"
                            : "API Key")}
                      </label>
                      {state.llmConfigured && state.llmProvider === provider && (
                        <span className="text-[11px] font-medium text-[var(--success)]">
                          Key saved securely
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
                          : (activePreset?.keyPlaceholder ??
                            activeCatalog?.keyPlaceholder ??
                            "Enter API key")
                      }
                      className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 font-mono text-sm"
                    />
                    <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                      Stored with chmod 0600 on the server. Never sent back to the browser.
                    </p>
                  </div>
                )}
              </div>

              {provider !== "ollama" && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvancedUrl((prev) => !prev)}
                    className="text-[11px] text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
                  >
                    {showAdvancedUrl
                      ? "Hide endpoint URL"
                      : "Optional: use custom OpenAI-compatible endpoint URL"}
                  </button>
                  {showAdvancedUrl && (
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={activeCatalog?.defaultBaseUrl}
                      aria-label="Provider endpoint URL"
                      className="vps-input mt-2 w-full rounded-xl px-3 py-2 font-mono text-xs"
                    />
                  )}
                </div>
              )}

              {activeCatalog?.setupHint && (
                <p className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
                  {activeCatalog.setupHint}
                </p>
              )}

              {providerTestResult && (
                <div
                  className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                    providerTestResult.ok
                      ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
                      : "border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger)]"
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
                  className="vps-btn-secondary rounded-xl px-3.5 py-2 text-xs font-medium"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleTestProvider()}
                  className="vps-btn-secondary rounded-xl px-4 py-2 text-xs font-medium"
                >
                  Test Connection
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep("persona")}
                  className="vps-btn-secondary rounded-xl px-3.5 py-2 text-xs font-medium text-[var(--text-muted)]"
                >
                  Skip AI for Now
                </button>
                <button
                  type="submit"
                  disabled={busy || !model.trim()}
                  className="vps-btn-primary rounded-xl px-5 py-2 text-xs font-semibold"
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
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  1. Dashboard Passphrase{" "}
                  {passphraseConfigured ? "(Configured)" : "(Recommended)"}
                </h3>
                {passphraseConfigured && (
                  <span className="rounded-full bg-[var(--success-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--success)]">
                    Active
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Set a memorable passphrase so you can sign in anytime without copying the 64-character Admin Token from SSH.
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
                  className="vps-input rounded-xl px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  value={passphraseConfirm}
                  onChange={(e) => setPassphraseConfirm(e.target.value)}
                  placeholder="Confirm passphrase"
                  aria-label="Confirm dashboard passphrase"
                  className="vps-input rounded-xl px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                2. CTO Communication &amp; Safety Preferences (USER.md)
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="wizard-owner-name"
                    className="block text-xs font-medium text-[var(--text-secondary)]"
                  >
                    Your Name
                  </label>
                  <input
                    id="wizard-owner-name"
                    type="text"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label
                    htmlFor="wizard-style"
                    className="block text-xs font-medium text-[var(--text-secondary)]"
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
                    className="vps-input mt-1.5 w-full rounded-xl px-3 py-2 text-sm"
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
                  className={`rounded-xl border p-3 text-left text-xs transition ${
                    technicalLevel === "non-technical"
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="font-semibold">Non-Linux Owner (Recommended)</span>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Hide raw terminal output and explain actions in plain English.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setTechnicalLevel("developer")}
                  className={`rounded-xl border p-3 text-left text-xs transition ${
                    technicalLevel === "developer"
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="font-semibold">Developer / Technical</span>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Include Compose, container, and networking details in summaries.
                  </p>
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setApprovalMode("manual")}
                  className={`rounded-xl border p-3 text-left text-xs transition ${
                    approvalMode === "manual"
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="font-semibold">Ask Before Every Change (Safe Default)</span>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Always present an Execution Plan and wait for approval before mutations.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setApprovalMode("smart")}
                  className={`rounded-xl border p-3 text-left text-xs transition ${
                    approvalMode === "smart"
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="font-semibold">Smart Mode</span>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Auto-run read-only health checks; confirm all installs &amp; edits.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setApprovalMode("yolo")}
                  className={`rounded-xl border p-3 text-left text-xs transition ${
                    approvalMode === "yolo"
                      ? "border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="font-semibold">YOLO (Sandbox)</span>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Auto-execute safe container deploys &amp; restarts without pausing.
                  </p>
                </button>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                3. Optional Mobile Chat Channels (Telegram / Discord)
              </h3>
              <p className="text-xs text-[var(--text-secondary)]">
                Connect a bot token if you want to chat with your CTO Agent from your phone.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="wizard-telegram" className="text-[var(--text-secondary)]">
                      Telegram Bot Token
                    </label>
                    {state.telegramConfigured && (
                      <span className="text-[11px] font-medium text-[var(--success)]">
                        Configured
                      </span>
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
                    className="vps-input mt-1 w-full rounded-xl px-3 py-2 font-mono text-xs"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="wizard-discord" className="text-[var(--text-secondary)]">
                      Discord Bot Token
                    </label>
                    {state.discordConfigured && (
                      <span className="text-[11px] font-medium text-[var(--success)]">
                        Configured
                      </span>
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
                    className="vps-input mt-1 w-full rounded-xl px-3 py-2 font-mono text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep("provider")}
                className="vps-btn-secondary rounded-xl px-3.5 py-2 text-xs font-medium"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={busy}
                className="vps-btn-primary rounded-xl px-5 py-2 text-xs font-semibold"
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
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Initial Server Health &amp; Readiness Scan
                </h3>
                <p className="text-xs text-[var(--text-secondary)]">
                  Verifies system resources, domain/TLS readiness, and seeds CTO memory (MEMORY.md).
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runBaselineScan()}
                className="vps-btn-secondary rounded-xl px-3.5 py-1.5 text-xs font-medium"
              >
                {busy ? "Scanning..." : "Re-run Scan"}
              </button>
            </div>

            {scanResult ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5">
                    <p className="text-[11px] text-[var(--text-muted)]">Server &amp; OS</p>
                    <p className="mt-1 truncate text-sm font-semibold text-[var(--text-primary)]">
                      {scanResult.hostname}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">{scanResult.osRelease}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5">
                    <p className="text-[11px] text-[var(--text-muted)]">Compute &amp; RAM</p>
                    <p className="tabular-nums mt-1 text-sm font-semibold text-[var(--text-primary)]">
                      {scanResult.cpuCount} vCPU
                    </p>
                    <p className="tabular-nums text-xs text-[var(--text-muted)]">
                      {scanResult.memoryUsedMb} / {scanResult.memoryTotalMb} MB RAM
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5">
                    <p className="text-[11px] text-[var(--text-muted)]">Disk Capacity</p>
                    <p className="tabular-nums mt-1 text-sm font-semibold text-[var(--text-primary)]">
                      {scanResult.diskTotalGb !== null
                        ? `${scanResult.diskUsedGb} / ${scanResult.diskTotalGb} GB`
                        : "Unavailable"}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">Root filesystem</p>
                  </div>
                </div>

                <ul className="space-y-2">
                  {scanResult.checks.map((check) => (
                    <li
                      key={check.id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-4 py-3 text-xs"
                    >
                      <div>
                        <p className="font-semibold text-[var(--text-primary)]">{check.label}</p>
                        <p className="mt-0.5 text-[var(--text-secondary)]">{check.detail}</p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase ${statusBadgeClass(
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
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-6 text-center text-xs text-[var(--text-muted)]">
                Running baseline server diagnostics...
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep("persona")}
                className="vps-btn-secondary rounded-xl px-3.5 py-2 text-xs font-medium"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => setStep("complete")}
                disabled={busy}
                className="vps-btn-primary rounded-xl px-5 py-2 text-xs font-semibold"
              >
                Continue to Launch
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Complete */}
        {step === "complete" && (
          <div className="mt-6 space-y-5">
            <div className="rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] p-5">
              <h3 className="text-base font-semibold text-[var(--text-primary)]">
                Your VPS OS Environment Is Ready
              </h3>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                All settings are saved safely on your server. You can re-open this Setup Wizard anytime from System Settings.
              </p>

              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                  <dt className="text-[var(--text-muted)]">Ingress &amp; Domain</dt>
                  <dd className="mt-1 font-semibold text-[var(--text-primary)]">
                    {state.domainMode === "domain" && state.domain
                      ? `${state.domain} (${state.dnsVerified ? "DNS verified" : "DNS pending"})`
                      : "IP setup mode (:80)"}
                  </dd>
                </div>
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                  <dt className="text-[var(--text-muted)]">AI CTO Provider</dt>
                  <dd className="mt-1 font-semibold text-[var(--text-primary)]">
                    {state.llmConfigured
                      ? `${state.llmProvider} (${state.llmModel})`
                      : "Not configured yet (dashboard-only mode)"}
                  </dd>
                </div>
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                  <dt className="text-[var(--text-muted)]">Approval Guardrail</dt>
                  <dd className="mt-1 font-semibold text-[var(--text-primary)]">
                    {state.persona.approvalMode === "yolo"
                      ? "YOLO (auto-execute safe container deploys)"
                      : state.persona.approvalMode === "manual"
                        ? "Manual confirmation before every change"
                        : "Smart (auto-read, confirm mutations)"}
                  </dd>
                </div>
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                  <dt className="text-[var(--text-muted)]">Hermes CTO Gateway</dt>
                  <dd className="mt-1 font-semibold text-[var(--text-primary)]">
                    {hermesStatus.reachable ? "Online & ready" : hermesStatus.detail}
                  </dd>
                </div>
              </dl>
            </div>

            <div>
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                Or complete setup and start immediately with a CTO request:
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={busy}
                    onClick={() => void handleCompleteSetup(prompt)}
                    className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-left text-xs text-[var(--text-secondary)] transition hover:border-[var(--accent)] hover:text-[var(--text-primary)] disabled:opacity-50"
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
                className="vps-btn-secondary rounded-xl px-3.5 py-2 text-xs font-medium"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleCompleteSetup()}
                className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
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
