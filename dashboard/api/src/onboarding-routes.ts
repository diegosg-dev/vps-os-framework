import crypto from "node:crypto";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import {
  ApprovalModeSchema,
  CommunicationStyleSchema,
  LLM_PROVIDER_CATALOG,
  LlmProviderSchema,
  OPENCODE_ZEN_BASE_URL,
  type SetupClaimRecord,
  type SystemMetrics,
  type SystemRegistryStore,
  TechnicalLevelSchema,
  hashPassphrase,
  hashSetupCode,
  isOpenCodeLocalServerUrl,
  normalizeSetupCode,
  redactSecrets,
  validateDomain,
  validateHttpBaseUrl,
  verifyPassphrase,
} from "@vps-os/shared";
import { handleBodyReadError, readJsonBody, tokensEqual } from "./http-utils.js";
import type { DiskMetrics } from "./metrics.js";
import {
  type DnsVerificationResult,
  type HermesHealthStatus,
  type ProviderModelsInput,
  type ProviderModelsResult,
  type ProviderTestInput,
  type ProviderTestResult,
  buildBaselineScan,
  checkHermesGatewayHealth,
  detectPublicIp,
  discoverLlmProviderModels,
  isSetupClaimAvailable,
  issueSessionToken,
  readHostApplyStatus,
  readOnboardingEnvValues,
  readSetupClaim,
  syncHermesOnboardingFiles,
  testLlmProviderConnection,
  updateOnboardingEnvFile,
  verifyAndConsumeSetupClaim,
  verifyDomainDns,
  writeHostApplyTrigger,
  writeSetupClaim,
} from "./onboarding.js";

export interface OnboardingRouteDeps {
  registry: SystemRegistryStore;
  trimmedToken?: string | undefined;
  maxBodyBytes: number;
  getMetrics: () => SystemMetrics;
  getDisk: () => DiskMetrics | null;
  onboardingEnvPath?: string | undefined;
  dataDir?: string | undefined;
  hermesHome?: string | undefined;
  setupClaimPath?: string | undefined;
  initialSetupCodeHash?: string | undefined;
  publicIp?: string | null | undefined;
  hermesGatewayUrl?: string | undefined;
  hermesApiServerKey?: string | undefined;
  detectPublicIp?: (() => Promise<string | null>) | undefined;
  verifyDns?:
    | ((domain: string, expectedIp: string | null) => Promise<DnsVerificationResult>)
    | undefined;
  testProviderConnection?:
    | ((input: ProviderTestInput) => Promise<ProviderTestResult>)
    | undefined;
  discoverProviderModels?:
    | ((input: ProviderModelsInput) => Promise<ProviderModelsResult>)
    | undefined;
  checkHermesHealth?: (() => Promise<HermesHealthStatus>) | undefined;
  triggerHostApply?:
    | ((reason: string) => Promise<{ queued: boolean; detail: string }> | { queued: boolean; detail: string })
    | undefined;
}

const optionalTrimmedString = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    schema.optional(),
  );

const ClaimRequestSchema = z.object({
  setupCode: z.string().trim().min(6).max(64),
});

const LoginRequestSchema = z
  .object({
    passphrase: z.string().min(1).max(256).optional(),
    token: z.string().trim().min(1).max(512).optional(),
  })
  .refine((val) => Boolean(val.passphrase || val.token), {
    message: "Provide either a passphrase or admin token.",
  });

const SecuritySetupRequestSchema = z.object({
  passphrase: z.string().min(10, "Passphrase must be at least 10 characters.").max(128),
});

const DomainSetupRequestSchema = z
  .object({
    mode: z.enum(["domain", "ip-only"]),
    domain: optionalTrimmedString(z.string().trim().max(253)),
    acmeEmail: optionalTrimmedString(
      z.string().trim().email("Provide a valid email address for HTTPS certificates.").max(254),
    ),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "domain" && !val.domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domain"],
        message: "Domain name is required when domain mode is selected.",
      });
    }
  });

const DomainVerifyRequestSchema = z.object({
  domain: optionalTrimmedString(z.string().trim().max(253)),
});

const ProviderModelsRequestSchema = z.object({
  provider: LlmProviderSchema,
  apiKey: optionalTrimmedString(
    z
      .string()
      .trim()
      .max(512)
      .refine((val) => !/[\r\n\0]/.test(val), "Invalid characters in API key."),
  ),
  baseUrl: optionalTrimmedString(z.string().trim().max(300)),
});

const ProviderConfigRequestSchema = z.object({
  provider: LlmProviderSchema,
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((val) => !/[\r\n\0]/.test(val), "Invalid characters in model name."),
  apiKey: optionalTrimmedString(
    z
      .string()
      .trim()
      .max(512)
      .refine((val) => !/[\r\n\0]/.test(val), "Invalid characters in API key."),
  ),
  baseUrl: optionalTrimmedString(z.string().trim().max(300)),
});

const PersonaSetupRequestSchema = z.object({
  ownerName: z.string().trim().min(1).max(80).default("Server Owner"),
  technicalLevel: TechnicalLevelSchema,
  communicationStyle: CommunicationStyleSchema,
  approvalMode: ApprovalModeSchema,
  telegramBotToken: optionalTrimmedString(
    z
      .string()
      .trim()
      .max(256)
      .refine((val) => !/[\r\n\0\s]/.test(val), "Invalid Telegram bot token format."),
  ),
  discordBotToken: optionalTrimmedString(
    z
      .string()
      .trim()
      .max(256)
      .refine((val) => !/[\r\n\0\s]/.test(val), "Invalid Discord bot token format."),
  ),
});

const CompleteOnboardingRequestSchema = z
  .object({
    allowWithoutLlm: z.boolean().optional(),
  })
  .optional();

function createClaimManager(
  setupClaimPath: string | undefined,
  initialSetupCodeHash: string | undefined,
) {
  let memoryClaim: SetupClaimRecord | null = initialSetupCodeHash
    ? {
        codeHash: initialSetupCodeHash.toLowerCase(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        consumedAt: null,
        failedAttempts: 0,
      }
    : null;

  if (setupClaimPath && initialSetupCodeHash && !readSetupClaim(setupClaimPath)) {
    writeSetupClaim(setupClaimPath, memoryClaim!);
  }

  return {
    isAvailable(onboardingCompleted: boolean): boolean {
      if (onboardingCompleted) return false;
      if (setupClaimPath) {
        return isSetupClaimAvailable(readSetupClaim(setupClaimPath));
      }
      return isSetupClaimAvailable(memoryClaim);
    },
    consume(code: string): { ok: true } | { ok: false; status: 401 | 429; reason: string } {
      if (setupClaimPath) {
        return verifyAndConsumeSetupClaim(setupClaimPath, code);
      }
      if (!memoryClaim) {
        return { ok: false, status: 401, reason: "Setup claim is not enabled." };
      }
      if (memoryClaim.consumedAt !== null) {
        return { ok: false, status: 401, reason: "Setup code has already been used." };
      }
      if (memoryClaim.failedAttempts >= 5) {
        return {
          ok: false,
          status: 429,
          reason: "Setup code locked after too many failed attempts. Use Admin Token.",
        };
      }
      const normalized = normalizeSetupCode(code);
      if (normalized.length < 8) {
        return { ok: false, status: 401, reason: "Invalid setup code." };
      }
      const candidateHash = hashSetupCode(normalized);
      const a = Buffer.from(candidateHash.toLowerCase(), "utf8");
      const b = Buffer.from(memoryClaim.codeHash.toLowerCase(), "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        memoryClaim = {
          ...memoryClaim,
          failedAttempts: memoryClaim.failedAttempts + 1,
        };
        return {
          ok: false,
          status: memoryClaim.failedAttempts >= 5 ? 429 : 401,
          reason:
            memoryClaim.failedAttempts >= 5
              ? "Setup code locked after too many failed attempts. Use Admin Token."
              : "Invalid setup code.",
        };
      }
      memoryClaim = {
        ...memoryClaim,
        consumedAt: new Date().toISOString(),
      };
      return { ok: true };
    },
    invalidateOnComplete(): void {
      if (memoryClaim && !memoryClaim.consumedAt) {
        memoryClaim = { ...memoryClaim, consumedAt: new Date().toISOString() };
      }
      if (setupClaimPath) {
        const diskClaim = readSetupClaim(setupClaimPath);
        if (diskClaim && !diskClaim.consumedAt) {
          writeSetupClaim(setupClaimPath, {
            ...diskClaim,
            consumedAt: new Date().toISOString(),
          });
        }
      }
    },
  };
}

/**
 * Registers public boot-status/auth-claim routes and authenticated Phase 2
 * onboarding wizard endpoints on the Control API Hono router.
 */
export function registerOnboardingRoutes(app: Hono, deps: OnboardingRouteDeps): void {
  const claimPath =
    deps.setupClaimPath ??
    (deps.dataDir ? path.join(deps.dataDir, "setup-claim.json") : undefined);
  const claimManager = createClaimManager(claimPath, deps.initialSetupCodeHash);

  const resolvePublicIpFn =
    deps.detectPublicIp ??
    (async () => (deps.publicIp !== undefined ? deps.publicIp : detectPublicIp()));
  const verifyDnsFn = deps.verifyDns ?? verifyDomainDns;
  const testProviderFn = deps.testProviderConnection ?? testLlmProviderConnection;
  const discoverModelsFn = deps.discoverProviderModels ?? discoverLlmProviderModels;
  const checkHermesFn =
    deps.checkHermesHealth ??
    (() => checkHermesGatewayHealth(deps.hermesGatewayUrl, deps.hermesApiServerKey));
  const triggerHostApplyFn =
    deps.triggerHostApply ??
    ((reason: string) => writeHostApplyTrigger(deps.dataDir, reason));

  // Public non-secret boot status so the UI can pick Claim vs. Login vs. Wizard cleanly.
  app.get("/api/onboarding/status", (c) => {
    const state = deps.registry.getOnboardingState();
    return c.json({
      onboardingCompleted: state.completed,
      currentStep: state.currentStep,
      claimAvailable: claimManager.isAvailable(state.completed),
      passphraseConfigured: deps.registry.getPassphraseHash() !== null,
      authRequired: Boolean(deps.trimmedToken),
    });
  });

  app.post("/api/auth/claim", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ClaimRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const state = deps.registry.getOnboardingState();
    if (state.completed) {
      return c.json(
        { error: "Initial onboarding is already complete. Sign in instead." },
        409,
      );
    }

    const result = claimManager.consume(parsed.data.setupCode);
    if (!result.ok) {
      return c.json({ error: result.reason }, result.status);
    }

    const now = new Date().toISOString();
    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "auth.setup_claimed",
      targetSlug: null,
      summary: "One-time bootstrap setup code claimed in browser.",
      riskLevel: "medium",
      createdAt: now,
    });

    if (!deps.trimmedToken) {
      return c.json({ ok: true, token: "", expiresAt: null });
    }

    const epoch = deps.registry.getSessionEpoch();
    const session = issueSessionToken(deps.trimmedToken, epoch);
    return c.json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  app.post("/api/auth/login", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    if (!deps.trimmedToken) {
      return c.json({ ok: true, token: "", expiresAt: null });
    }

    let authenticated = false;
    if (parsed.data.token) {
      authenticated = tokensEqual(parsed.data.token, deps.trimmedToken);
    } else if (parsed.data.passphrase) {
      const storedHash = deps.registry.getPassphraseHash();
      if (storedHash) {
        authenticated = verifyPassphrase(parsed.data.passphrase, storedHash);
      }
    }

    if (!authenticated) {
      return c.json({ error: "Invalid credentials." }, 401);
    }

    const epoch = deps.registry.getSessionEpoch();
    const session = issueSessionToken(deps.trimmedToken, epoch);
    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "auth.login",
      targetSlug: null,
      summary: "Dashboard session authenticated.",
      riskLevel: "low",
      createdAt: new Date().toISOString(),
    });

    return c.json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  // --- Authenticated Wizard Endpoints ---

  app.get("/api/onboarding/state", async (c) => {
    let state = deps.registry.getOnboardingState();
    if (!state.publicIp) {
      const detectedIp = await resolvePublicIpFn();
      if (detectedIp) {
        state = deps.registry.saveOnboardingState({ publicIp: detectedIp });
      }
    }

    const hermesStatus = await checkHermesFn();
    const hostApplyStatus = readHostApplyStatus(deps.dataDir);

    return c.json({
      state,
      providerCatalog: LLM_PROVIDER_CATALOG,
      hermesStatus,
      hostApplyStatus,
      passphraseConfigured: deps.registry.getPassphraseHash() !== null,
    });
  });

  app.post("/api/onboarding/security", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = SecuritySetupRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const hash = hashPassphrase(parsed.data.passphrase);
    deps.registry.setPassphraseHash(hash);
    const nextEpoch = deps.registry.bumpSessionEpoch();

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "onboarding.passphrase_configured",
      targetSlug: null,
      summary: "Configured dashboard admin passphrase and rotated active sessions.",
      riskLevel: "medium",
      createdAt: new Date().toISOString(),
    });

    const session = deps.trimmedToken
      ? issueSessionToken(deps.trimmedToken, nextEpoch)
      : null;

    return c.json({
      ok: true,
      passphraseConfigured: true,
      ...(session ? { token: session.token, expiresAt: session.expiresAt } : {}),
    });
  });

  app.post("/api/onboarding/domain", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = DomainSetupRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    let state = deps.registry.getOnboardingState();
    if (!state.publicIp) {
      const detectedIp = await resolvePublicIpFn();
      if (detectedIp) {
        state = deps.registry.saveOnboardingState({ publicIp: detectedIp });
      }
    }

    if (parsed.data.mode === "ip-only") {
      if (deps.onboardingEnvPath) {
        updateOnboardingEnvFile(deps.onboardingEnvPath, {
          VPS_OS_DOMAIN: "localhost",
          VPS_OS_SITE_ADDRESS: ":80",
        });
      }
      const hostApply = await triggerHostApplyFn("domain-ip-only");
      const updated = deps.registry.saveOnboardingState({
        domainMode: "ip-only",
        domain: null,
        acmeEmail: null,
        dnsVerified: false,
        currentStep: state.completed ? state.currentStep : "provider",
      });
      deps.registry.recordAudit({
        id: crypto.randomUUID(),
        actor: "user",
        action: "onboarding.domain_ip_mode",
        targetSlug: null,
        summary: "Configured dashboard ingress in IP setup mode (:80).",
        riskLevel: "low",
        createdAt: new Date().toISOString(),
      });
      return c.json({ state: updated, dnsCheck: null, hostApply });
    }

    let safeDomain: string;
    try {
      safeDomain = validateDomain(parsed.data.domain ?? "");
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid domain name." },
        400,
      );
    }

    if (safeDomain === "os.example.com") {
      return c.json(
        { error: "Replace placeholder 'os.example.com' with your real domain name." },
        400,
      );
    }

    const dnsCheck = await verifyDnsFn(safeDomain, state.publicIp);
    const acmeEmail = parsed.data.acmeEmail?.trim() || state.acmeEmail || null;

    if (deps.onboardingEnvPath) {
      updateOnboardingEnvFile(deps.onboardingEnvPath, {
        VPS_OS_DOMAIN: safeDomain,
        VPS_OS_SITE_ADDRESS: safeDomain,
        ...(acmeEmail ? { VPS_OS_ACME_EMAIL: acmeEmail } : {}),
      });
    }

    const hostApply = await triggerHostApplyFn("domain-updated");
    const updated = deps.registry.saveOnboardingState({
      domainMode: "domain",
      domain: safeDomain,
      acmeEmail,
      dnsVerified: dnsCheck.matches,
      currentStep: state.completed ? state.currentStep : "provider",
    });

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "onboarding.domain_configured",
      targetSlug: null,
      summary: `Bound domain ${safeDomain} (DNS ${dnsCheck.matches ? "verified" : "pending"}).`,
      riskLevel: "medium",
      createdAt: new Date().toISOString(),
    });

    return c.json({ state: updated, dnsCheck, hostApply });
  });

  app.post("/api/onboarding/domain/verify", async (c) => {
    let body: unknown;
    try {
      body = (await readJsonBody(c, deps.maxBodyBytes, { allowEmpty: true })) ?? {};
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = DomainVerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    let state = deps.registry.getOnboardingState();
    if (!state.publicIp) {
      const detectedIp = await resolvePublicIpFn();
      if (detectedIp) {
        state = deps.registry.saveOnboardingState({ publicIp: detectedIp });
      }
    }

    const targetRaw = parsed.data.domain || state.domain;
    if (!targetRaw) {
      return c.json({ error: "No domain is configured to verify." }, 400);
    }

    let safeDomain: string;
    try {
      safeDomain = validateDomain(targetRaw);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid domain name." },
        400,
      );
    }

    const dnsCheck = await verifyDnsFn(safeDomain, state.publicIp);
    const updated = deps.registry.saveOnboardingState({
      domain: safeDomain,
      domainMode: "domain",
      dnsVerified: dnsCheck.matches,
    });

    return c.json({ state: updated, dnsCheck });
  });

  const resolveStoredProviderApiKey = (
    provider: z.infer<typeof LlmProviderSchema>,
    providedKey?: string,
  ): string | undefined => {
    if (providedKey || !deps.onboardingEnvPath) return providedKey;
    const existing = deps.registry.getOnboardingState();
    if (existing.llmConfigured && existing.llmProvider === provider) {
      const savedEnv = readOnboardingEnvValues(deps.onboardingEnvPath);
      return (
        savedEnv.LLM_API_KEY ||
        savedEnv.OPENCODE_API_KEY ||
        savedEnv.OPENCODE_SERVER_PASSWORD ||
        undefined
      );
    }
    return undefined;
  };

  app.post("/api/onboarding/provider/models", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ProviderModelsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    if (parsed.data.baseUrl) {
      try {
        validateHttpBaseUrl(parsed.data.baseUrl);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Invalid base URL." },
          400,
        );
      }
    }

    const effectiveApiKey = resolveStoredProviderApiKey(
      parsed.data.provider,
      parsed.data.apiKey,
    );

    const discovered = await discoverModelsFn({
      provider: parsed.data.provider,
      apiKey: effectiveApiKey,
      baseUrl: parsed.data.baseUrl,
    });

    return c.json({
      models: discovered.models,
      source: discovered.source,
      ...(discovered.message ? { message: redactSecrets(discovered.message) } : {}),
    });
  });

  app.post("/api/onboarding/provider/test", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ProviderConfigRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    if (parsed.data.baseUrl) {
      try {
        validateHttpBaseUrl(parsed.data.baseUrl);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Invalid base URL." },
          400,
        );
      }
    }

    const effectiveApiKey = resolveStoredProviderApiKey(
      parsed.data.provider,
      parsed.data.apiKey,
    );

    const result = await testProviderFn({
      provider: parsed.data.provider,
      model: parsed.data.model,
      apiKey: effectiveApiKey,
      baseUrl: parsed.data.baseUrl,
    });

    return c.json({
      result: {
        ...result,
        message: redactSecrets(result.message),
      },
    });
  });

  app.post("/api/onboarding/provider", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ProviderConfigRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const existing = deps.registry.getOnboardingState();
    const catalogEntry = LLM_PROVIDER_CATALOG.find(
      (item) => item.id === parsed.data.provider,
    );
    const hasExistingKeyForProvider =
      existing.llmConfigured && existing.llmProvider === parsed.data.provider;

    let safeBaseUrl: string | null = null;
    if (parsed.data.baseUrl?.trim()) {
      try {
        safeBaseUrl = validateHttpBaseUrl(parsed.data.baseUrl);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Invalid base URL." },
          400,
        );
      }
    } else if (parsed.data.provider === "opencode") {
      safeBaseUrl = OPENCODE_ZEN_BASE_URL;
    }

    const isOpenCodeGo =
      parsed.data.provider === "opencode" &&
      Boolean(safeBaseUrl?.toLowerCase().includes("/zen/go"));

    if (
      (catalogEntry?.requiresApiKey || isOpenCodeGo) &&
      !parsed.data.apiKey?.trim() &&
      !hasExistingKeyForProvider
    ) {
      return c.json(
        {
          error: isOpenCodeGo
            ? "An OpenCode API key (from opencode.ai/auth) is required for OpenCode Go."
            : `An API key is required for ${catalogEntry?.label ?? parsed.data.provider}.`,
        },
        400,
      );
    }

    if (deps.onboardingEnvPath) {
      const trimmedKey = parsed.data.apiKey?.trim();
      const envUpdates: Record<string, string | null | undefined> = {
        LLM_PROVIDER: parsed.data.provider,
        LLM_MODEL: parsed.data.model,
        ...(trimmedKey ? { LLM_API_KEY: trimmedKey } : {}),
        ...(safeBaseUrl ? { LLM_BASE_URL: safeBaseUrl } : { LLM_BASE_URL: null }),
      };

      if (parsed.data.provider === "opencode") {
        if (isOpenCodeLocalServerUrl(safeBaseUrl)) {
          if (trimmedKey) {
            envUpdates.OPENCODE_SERVER_PASSWORD = trimmedKey;
          }
          envUpdates.OPENCODE_API_KEY = null;
        } else {
          if (trimmedKey) {
            envUpdates.OPENCODE_API_KEY = trimmedKey;
          }
          envUpdates.OPENCODE_SERVER_PASSWORD = null;
        }
      } else {
        envUpdates.OPENCODE_API_KEY = null;
        envUpdates.OPENCODE_SERVER_PASSWORD = null;
      }

      updateOnboardingEnvFile(deps.onboardingEnvPath, envUpdates);
    }

    syncHermesOnboardingFiles({
      hermesHome: deps.hermesHome,
      dataDir: deps.dataDir,
      provider: parsed.data.provider,
      model: parsed.data.model,
    });

    const hostApply = await triggerHostApplyFn("provider-updated");
    const updated = deps.registry.saveOnboardingState({
      llmProvider: parsed.data.provider,
      llmModel: parsed.data.model,
      llmBaseUrl: safeBaseUrl,
      llmConfigured: true,
      currentStep: existing.completed ? existing.currentStep : "persona",
    });

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "onboarding.provider_configured",
      targetSlug: null,
      summary: `Configured CTO LLM provider ${parsed.data.provider} (${parsed.data.model}).`,
      riskLevel: "medium",
      createdAt: new Date().toISOString(),
    });

    return c.json({ state: updated, hostApply });
  });

  app.post("/api/onboarding/persona", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = PersonaSetupRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const existing = deps.registry.getOnboardingState();
    const persona = {
      ownerName: parsed.data.ownerName,
      technicalLevel: parsed.data.technicalLevel,
      communicationStyle: parsed.data.communicationStyle,
      approvalMode: parsed.data.approvalMode,
    };

    const hasNewTelegram = Boolean(parsed.data.telegramBotToken?.trim());
    const hasNewDiscord = Boolean(parsed.data.discordBotToken?.trim());

    if (deps.onboardingEnvPath && (hasNewTelegram || hasNewDiscord)) {
      updateOnboardingEnvFile(deps.onboardingEnvPath, {
        ...(hasNewTelegram
          ? { TELEGRAM_BOT_TOKEN: parsed.data.telegramBotToken!.trim() }
          : {}),
        ...(hasNewDiscord
          ? { DISCORD_BOT_TOKEN: parsed.data.discordBotToken!.trim() }
          : {}),
      });
    }

    syncHermesOnboardingFiles({
      hermesHome: deps.hermesHome,
      dataDir: deps.dataDir,
      persona,
    });

    const hostApply = await triggerHostApplyFn("persona-updated");
    const updated = deps.registry.saveOnboardingState({
      persona,
      telegramConfigured: existing.telegramConfigured || hasNewTelegram,
      discordConfigured: existing.discordConfigured || hasNewDiscord,
      currentStep: existing.completed ? existing.currentStep : "scan",
    });

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "onboarding.persona_configured",
      targetSlug: null,
      summary: `Updated CTO persona (${persona.technicalLevel}, ${persona.approvalMode} approvals).`,
      riskLevel: "low",
      createdAt: new Date().toISOString(),
    });

    return c.json({ state: updated, hostApply });
  });

  app.post("/api/onboarding/approval-mode", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = z
      .object({ approvalMode: ApprovalModeSchema })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const existing = deps.registry.getOnboardingState();
    const persona = {
      ...existing.persona,
      approvalMode: parsed.data.approvalMode,
    };

    syncHermesOnboardingFiles({
      hermesHome: deps.hermesHome,
      dataDir: deps.dataDir,
      persona,
      domain: existing.domain,
    });

    const updated = deps.registry.saveOnboardingState({ persona });
    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "onboarding.approval_mode_updated",
      targetSlug: null,
      summary: `Switched approval guardrail mode to ${persona.approvalMode}.`,
      riskLevel: "low",
      createdAt: new Date().toISOString(),
    });

    return c.json({ state: updated, approvalMode: persona.approvalMode });
  });

  app.post("/api/onboarding/baseline-scan", async (c) => {
    const existing = deps.registry.getOnboardingState();
    const metrics = deps.getMetrics();
    const disk = deps.getDisk();
    const appsCount = deps.registry.listApps().length;
    const hermes = await checkHermesFn();

    const scan = buildBaselineScan({
      metrics,
      disk,
      state: existing,
      appsCount,
      hermes,
    });

    syncHermesOnboardingFiles({
      hermesHome: deps.hermesHome,
      dataDir: deps.dataDir,
      scan,
      domain: existing.domain,
    });

    const hostApply = await triggerHostApplyFn("baseline-scan");
    const updated = deps.registry.saveOnboardingState({
      baselineScan: scan,
      currentStep: existing.completed ? existing.currentStep : "complete",
    });

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "system",
      action: "onboarding.baseline_scan",
      targetSlug: null,
      summary: redactSecrets(scan.summary),
      riskLevel: "low",
      createdAt: scan.scannedAt,
    });

    return c.json({ scan, state: updated, hostApply });
  });

  app.post("/api/onboarding/complete", async (c) => {
    let rawOpt: unknown;
    try {
      rawOpt = await readJsonBody(c, deps.maxBodyBytes, { allowEmpty: true });
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = CompleteOnboardingRequestSchema.safeParse(rawOpt);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const existing = deps.registry.getOnboardingState();
    if (!existing.llmConfigured && parsed.data?.allowWithoutLlm !== true) {
      return c.json(
        {
          error:
            "Configure an AI provider first, or explicitly complete in dashboard-only mode.",
        },
        400,
      );
    }

    claimManager.invalidateOnComplete();
    const hostApply = await triggerHostApplyFn("onboarding-completed");
    const updated = deps.registry.saveOnboardingState({
      completed: true,
      completedAt: new Date().toISOString(),
      currentStep: "complete",
    });

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "onboarding.completed",
      targetSlug: null,
      summary: updated.llmConfigured
        ? `Onboarding completed with ${updated.llmProvider} CTO (${updated.domain ?? "IP mode"}).`
        : "Onboarding completed in dashboard-only mode.",
      riskLevel: "low",
      createdAt: new Date().toISOString(),
    });

    return c.json({ state: updated, hostApply });
  });

  app.post("/api/onboarding/reopen", (c) => {
    const updated = deps.registry.saveOnboardingState({
      completed: false,
      currentStep: "domain",
    });
    return c.json({ state: updated });
  });
}
