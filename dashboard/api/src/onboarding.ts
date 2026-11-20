import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type BaselineCheck,
  type BaselineScan,
  BaselineScanSchema,
  LLM_PROVIDER_CATALOG,
  type LlmProvider,
  type OnboardingState,
  OPENCODE_ZEN_BASE_URL,
  type PersonaPreferences,
  SetupClaimRecordSchema,
  type SetupClaimRecord,
  type SystemMetrics,
  hashSetupCode,
  isOpenCodeLocalServerUrl,
  normalizeSetupCode,
  redactSecrets,
  renderServerMemoryMarkdown,
  renderUserMemoryMarkdown,
  updateHermesConfigYaml,
  validateHttpBaseUrl,
} from "@vps-os/shared";
import type { DiskMetrics } from "./metrics.js";

export interface DnsVerificationResult {
  domain: string;
  resolvedIps: string[];
  expectedIp: string | null;
  matches: boolean;
  message: string;
}

export interface ProviderTestInput {
  provider: LlmProvider;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: LlmProvider;
  model: string;
  latencyMs: number;
  message: string;
  availableModels?: string[];
  serverVersion?: string;
}

export interface HermesHealthStatus {
  reachable: boolean;
  url: string | null;
  detail: string;
}

export interface HostApplyStatus {
  appliedAt?: string;
  caddyReloaded?: boolean;
  hermesRestarted?: boolean;
  hermesActive?: boolean;
  error?: string;
}

interface SessionPayload {
  sub: "admin";
  epoch: number;
  exp: number;
}

const SESSION_PREFIX = "vpsos_sess_";
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLAIM_ATTEMPTS = 5;

const ALLOWED_ENV_KEYS = new Set([
  "VPS_OS_DOMAIN",
  "VPS_OS_SITE_ADDRESS",
  "VPS_OS_ACME_EMAIL",
  "VPS_OS_PUBLIC_IP",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "OPENCODE_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
]);

/**
 * Reads whitelisted onboarding environment key/value pairs from disk (server-side only).
 * Never return the resulting map directly to clients.
 */
export function readOnboardingEnvValues(
  envFilePath: string | undefined,
): Record<string, string> {
  if (!envFilePath || !fs.existsSync(envFilePath)) {
    return {};
  }
  const values: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(envFilePath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!ALLOWED_ENV_KEYS.has(key)) continue;
      values[key] = trimmed.slice(eqIdx + 1).trim();
    }
  } catch {
    return {};
  }
  return values;
}

function signPayload(encodedPayload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

/** Issues an HMAC-SHA256 signed session token scoped to the current session epoch. */
export function issueSessionToken(
  adminToken: string,
  epoch: number,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): { token: string; expiresAt: string } {
  const exp = Date.now() + Math.max(60_000, ttlMs);
  const payload: SessionPayload = { sub: "admin", epoch, exp };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const sig = signPayload(encodedPayload, adminToken);
  return {
    token: `${SESSION_PREFIX}${encodedPayload}.${sig}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

/** Verifies a `vpsos_sess_...` token against the admin signing secret and current epoch. */
export function verifySessionToken(
  provided: string | undefined,
  adminToken: string,
  currentEpoch: number,
): boolean {
  if (!provided || !provided.startsWith(SESSION_PREFIX)) {
    return false;
  }
  const rest = provided.slice(SESSION_PREFIX.length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex <= 0) {
    return false;
  }
  const encodedPayload = rest.slice(0, dotIndex);
  const providedSig = rest.slice(dotIndex + 1);
  if (!encodedPayload || !providedSig) {
    return false;
  }

  const expectedSig = signPayload(encodedPayload, adminToken);
  const a = Buffer.from(providedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;
    if (
      parsed.sub !== "admin" ||
      typeof parsed.epoch !== "number" ||
      parsed.epoch !== currentEpoch ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= Date.now()
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function readSetupClaim(
  setupClaimPath: string | undefined,
): SetupClaimRecord | null {
  if (!setupClaimPath || !fs.existsSync(setupClaimPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(setupClaimPath, "utf8"));
    return SetupClaimRecordSchema.parse(raw);
  } catch {
    return null;
  }
}

export function writeSetupClaim(
  setupClaimPath: string,
  record: SetupClaimRecord,
): void {
  fs.mkdirSync(path.dirname(path.resolve(setupClaimPath)), { recursive: true });
  fs.writeFileSync(setupClaimPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function isSetupClaimAvailable(record: SetupClaimRecord | null): boolean {
  if (!record) return false;
  if (record.consumedAt !== null) return false;
  if (record.failedAttempts >= MAX_CLAIM_ATTEMPTS) return false;
  const expiresMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return false;
  }
  return true;
}

export function verifyAndConsumeSetupClaim(
  setupClaimPath: string | undefined,
  setupCode: string,
): { ok: true } | { ok: false; status: 401 | 429; reason: string } {
  if (!setupClaimPath) {
    return { ok: false, status: 401, reason: "Setup claim is not enabled." };
  }
  const record = readSetupClaim(setupClaimPath);
  if (!record) {
    return { ok: false, status: 401, reason: "No active setup code found." };
  }
  if (record.consumedAt !== null) {
    return { ok: false, status: 401, reason: "Setup code has already been used." };
  }
  if (record.failedAttempts >= MAX_CLAIM_ATTEMPTS) {
    return {
      ok: false,
      status: 429,
      reason: "Setup code locked after too many failed attempts. Use Admin Token.",
    };
  }
  const expiresMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return {
      ok: false,
      status: 401,
      reason: "Setup code has expired. Use Admin Token from /vps-os/.env.",
    };
  }

  const normalized = normalizeSetupCode(setupCode);
  if (normalized.length < 8) {
    return { ok: false, status: 401, reason: "Invalid setup code." };
  }

  const candidateHash = hashSetupCode(normalized);
  const expectedBuf = Buffer.from(record.codeHash.toLowerCase(), "utf8");
  const candidateBuf = Buffer.from(candidateHash.toLowerCase(), "utf8");
  const matches =
    expectedBuf.length === candidateBuf.length &&
    crypto.timingSafeEqual(expectedBuf, candidateBuf);

  if (!matches) {
    const nextAttempts = record.failedAttempts + 1;
    writeSetupClaim(setupClaimPath, {
      ...record,
      failedAttempts: nextAttempts,
    });
    return {
      ok: false,
      status: nextAttempts >= MAX_CLAIM_ATTEMPTS ? 429 : 401,
      reason:
        nextAttempts >= MAX_CLAIM_ATTEMPTS
          ? "Setup code locked after too many failed attempts. Use Admin Token."
          : "Invalid setup code.",
    };
  }

  writeSetupClaim(setupClaimPath, {
    ...record,
    consumedAt: new Date().toISOString(),
  });
  return { ok: true };
}

function sanitizeEnvValue(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Environment value contains disallowed control characters.");
  }
  return value.trim();
}

/**
 * Safely merges whitelisted runtime configuration keys into a `0600` `.env` file
 * without executing shell interpolation or exposing secrets.
 */
export function updateOnboardingEnvFile(
  envFilePath: string,
  updates: Record<string, string | null | undefined>,
): void {
  fs.mkdirSync(path.dirname(path.resolve(envFilePath)), { recursive: true });
  const existingMap = new Map<string, string>();
  const keyOrder: string[] = [];

  if (fs.existsSync(envFilePath)) {
    const lines = fs.readFileSync(envFilePath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1);
      if (!ALLOWED_ENV_KEYS.has(key)) continue;
      if (!existingMap.has(key)) {
        keyOrder.push(key);
      }
      existingMap.set(key, val);
    }
  }

  for (const [key, rawVal] of Object.entries(updates)) {
    if (!ALLOWED_ENV_KEYS.has(key)) {
      throw new Error(`Disallowed onboarding env key "${key}".`);
    }
    if (rawVal === undefined) continue;
    if (rawVal === null || rawVal === "") {
      existingMap.delete(key);
      continue;
    }
    const cleanVal = sanitizeEnvValue(rawVal);
    if (!existingMap.has(key)) {
      keyOrder.push(key);
    }
    existingMap.set(key, cleanVal);
  }

  const outputLines = [
    "# Managed by VPS OS Dashboard Onboarding",
    ...keyOrder
      .filter((key) => existingMap.has(key))
      .map((key) => `${key}=${existingMap.get(key) ?? ""}`),
    "",
  ];
  fs.writeFileSync(envFilePath, outputLines.join("\n"), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(envFilePath, 0o600);
  } catch {
    // Windows filesystems may ignore POSIX chmod bits.
  }
}

/**
 * Writes bounded Hermes `USER.md`, `MEMORY.md`, and config override files
 * either directly into `hermesHome` or into `<dataDir>/hermes-staging` for host sync.
 */
export function syncHermesOnboardingFiles(options: {
  hermesHome?: string | undefined;
  dataDir?: string | undefined;
  persona?: PersonaPreferences | undefined;
  scan?: BaselineScan | undefined;
  domain?: string | null | undefined;
  provider?: LlmProvider | null | undefined;
  model?: string | null | undefined;
}): void {
  const targets: string[] = [];
  if (options.hermesHome) {
    targets.push(path.resolve(options.hermesHome));
  }
  if (options.dataDir) {
    targets.push(path.join(path.resolve(options.dataDir), "hermes-staging"));
  }

  for (const baseDir of targets) {
    const memoriesDir = path.join(baseDir, "memories");
    fs.mkdirSync(memoriesDir, { recursive: true });

    if (options.persona) {
      fs.writeFileSync(
        path.join(memoriesDir, "USER.md"),
        renderUserMemoryMarkdown(options.persona),
        "utf8",
      );
    }

    if (options.scan) {
      const memPath = path.join(memoriesDir, "MEMORY.md");
      const existingMem = fs.existsSync(memPath)
        ? fs.readFileSync(memPath, "utf8")
        : "";
      fs.writeFileSync(
        memPath,
        renderServerMemoryMarkdown(
          existingMem,
          options.scan,
          options.domain ?? null,
        ),
        "utf8",
      );
    }

    const configPath = path.join(baseDir, "config.yaml");
    if (
      fs.existsSync(configPath) &&
      (options.provider || options.model || options.persona?.approvalMode)
    ) {
      const existingCfg = fs.readFileSync(configPath, "utf8");
      const nextCfg = updateHermesConfigYaml(existingCfg, {
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.persona?.approvalMode
          ? { approvalMode: options.persona.approvalMode }
          : {}),
      });
      fs.writeFileSync(configPath, nextCfg, "utf8");
    }

    if (baseDir.endsWith("hermes-staging")) {
      const overrides = {
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.persona?.approvalMode
          ? { approvalMode: options.persona.approvalMode }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(baseDir, "config-overrides.json"),
        JSON.stringify(overrides, null, 2),
        "utf8",
      );
    }
  }
}

export function writeHostApplyTrigger(
  dataDir: string | undefined,
  reason: string,
): { queued: boolean; detail: string } {
  if (!dataDir) {
    return {
      queued: false,
      detail: "No host data directory configured; saved settings locally.",
    };
  }
  const resolvedDir = path.resolve(dataDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const triggerPath = path.join(resolvedDir, "onboarding-apply.trigger");
  fs.writeFileSync(
    triggerPath,
    JSON.stringify({ reason, requestedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return {
    queued: true,
    detail: "Queued host configuration sync for Caddy & Hermes CTO.",
  };
}

export function readHostApplyStatus(
  dataDir: string | undefined,
): HostApplyStatus | null {
  if (!dataDir) return null;
  const statusPath = path.join(path.resolve(dataDir), "onboarding-apply-status.json");
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")) as HostApplyStatus;
  } catch {
    return null;
  }
}

export async function detectPublicIp(): Promise<string | null> {
  const configured = process.env.VPS_OS_PUBLIC_IP?.trim();
  if (configured && net.isIP(configured) !== 0) {
    return configured;
  }
  for (const probeUrl of [
    "https://api.ipify.org",
    "https://ipv4.icanhazip.com",
  ]) {
    try {
      const res = await fetch(probeUrl, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) continue;
      const candidate = (await res.text()).trim();
      if (net.isIP(candidate) !== 0) {
        return candidate;
      }
    } catch {
      // Try next IP probe or return null cleanly
    }
  }
  return null;
}

export async function verifyDomainDns(
  domain: string,
  expectedIp: string | null,
): Promise<DnsVerificationResult> {
  let resolvedIps: string[] = [];
  try {
    resolvedIps = await dns.resolve4(domain);
  } catch {
    try {
      const entries = await dns.lookup(domain, { all: true });
      resolvedIps = entries.map((entry) => entry.address);
    } catch {
      resolvedIps = [];
    }
  }

  if (resolvedIps.length === 0) {
    return {
      domain,
      resolvedIps: [],
      expectedIp,
      matches: false,
      message: expectedIp
        ? `No DNS A record found yet for ${domain}. Point an A record to ${expectedIp} and re-check.`
        : `No DNS A record found yet for ${domain}. Update your DNS provider and re-check.`,
    };
  }

  if (!expectedIp) {
    return {
      domain,
      resolvedIps,
      expectedIp: null,
      matches: true,
      message: `${domain} resolves to ${resolvedIps.join(", ")}.`,
    };
  }

  const matches = resolvedIps.includes(expectedIp);
  return {
    domain,
    resolvedIps,
    expectedIp,
    matches,
    message: matches
      ? `DNS verified: ${domain} points directly to this server (${expectedIp}).`
      : `${domain} currently resolves to ${resolvedIps.join(", ")}, expected ${expectedIp}. Update your A record before enabling public HTTPS.`,
  };
}

function extractModelIdsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const collected: string[] = [];

  if (Array.isArray(obj.data)) {
    for (const item of obj.data) {
      if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        collected.push((item as { id: string }).id);
      }
    }
  } else if (Array.isArray(obj.models)) {
    for (const item of obj.models) {
      if (typeof item === "string") {
        collected.push(item);
      } else if (item && typeof item === "object") {
        const candidate =
          typeof (item as { name?: unknown }).name === "string"
            ? (item as { name: string }).name
            : typeof (item as { id?: unknown }).id === "string"
              ? (item as { id: string }).id
              : null;
        if (candidate) collected.push(candidate);
      }
    }
  }

  return Array.from(new Set(collected)).slice(0, 25);
}

export async function testLlmProviderConnection(
  input: ProviderTestInput,
): Promise<ProviderTestResult> {
  const entry = LLM_PROVIDER_CATALOG.find((item) => item.id === input.provider);
  const rawBaseUrl = input.baseUrl?.trim() || entry?.defaultBaseUrl;
  if (!rawBaseUrl) {
    return {
      ok: false,
      provider: input.provider,
      model: input.model,
      latencyMs: 0,
      message: `Unsupported provider "${input.provider}".`,
    };
  }

  let baseUrl: string;
  try {
    baseUrl = validateHttpBaseUrl(rawBaseUrl);
  } catch (err) {
    return {
      ok: false,
      provider: input.provider,
      model: input.model,
      latencyMs: 0,
      message: err instanceof Error ? err.message : "Invalid provider URL.",
    };
  }

  const trimmedKey = input.apiKey?.trim() ?? "";
  const isOpenCodeGo =
    input.provider === "opencode" &&
    baseUrl.toLowerCase().includes("/zen/go");
  if ((entry?.requiresApiKey || isOpenCodeGo) && !trimmedKey) {
    return {
      ok: false,
      provider: input.provider,
      model: input.model,
      latencyMs: 0,
      message: isOpenCodeGo
        ? "An OpenCode API key (from opencode.ai/auth) is required for OpenCode Go."
        : `An API key is required for ${entry?.label ?? input.provider}.`,
    };
  }

  const started = Date.now();
  try {
    if (input.provider === "opencode" && isOpenCodeLocalServerUrl(baseUrl)) {
      const headers: Record<string, string> = {};
      if (trimmedKey) {
        headers.authorization = `Basic ${Buffer.from(`opencode:${trimmedKey}`, "utf8").toString("base64")}`;
      }

      const healthRes = await fetch(`${baseUrl}/global/health`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(6000),
      });
      const latencyMs = Date.now() - started;

      if (healthRes.ok) {
        let serverVersion: string | undefined;
        try {
          const healthJson = (await healthRes.json()) as {
            healthy?: boolean;
            version?: string;
          };
          if (typeof healthJson.version === "string" && healthJson.version.trim()) {
            serverVersion = healthJson.version.trim();
          }
        } catch {
          // non-JSON health response still ok
        }

        let availableModels: string[] | undefined;
        try {
          const modelsRes = await fetch(`${baseUrl}/models`, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(3000),
          });
          if (modelsRes.ok) {
            const discovered = extractModelIdsFromPayload(await modelsRes.json());
            if (discovered.length > 0) availableModels = discovered;
          }
        } catch {
          // optional model discovery
        }

        return {
          ok: true,
          provider: input.provider,
          model: input.model,
          latencyMs,
          ...(serverVersion ? { serverVersion } : {}),
          ...(availableModels ? { availableModels } : {}),
          message: `Connected to OpenCode Server${serverVersion ? ` v${serverVersion}` : ""} (${input.model}) in ${latencyMs}ms.`,
        };
      }

      if (healthRes.status !== 404) {
        return {
          ok: false,
          provider: input.provider,
          model: input.model,
          latencyMs,
          message: `OpenCode Server returned HTTP ${healthRes.status}. Verify OPENCODE_SERVER_PASSWORD or that \`opencode serve\` is reachable.`,
        };
      }
      // Fall through to OpenAI-compatible /models probe if endpoint returned 404 on /global/health
    }

    let targetUrl = `${baseUrl}/models`;
    const headers: Record<string, string> = {};

    if (input.provider === "ollama") {
      targetUrl = `${baseUrl}/api/tags`;
    } else if (input.provider === "anthropic") {
      headers["x-api-key"] = trimmedKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (input.provider === "opencode") {
      headers.authorization = `Bearer ${trimmedKey || "public"}`;
    } else {
      headers.authorization = `Bearer ${trimmedKey}`;
    }

    const res = await fetch(targetUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(6000),
    });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      return {
        ok: false,
        provider: input.provider,
        model: input.model,
        latencyMs,
        message: `${entry?.label ?? input.provider} returned HTTP ${res.status}. Verify your API key or endpoint URL.`,
      };
    }

    let availableModels: string[] | undefined;
    try {
      const discovered = extractModelIdsFromPayload(await res.json());
      if (discovered.length > 0) {
        availableModels = discovered;
      }
    } catch {
      // Ignore non-JSON bodies
    }

    return {
      ok: true,
      provider: input.provider,
      model: input.model,
      latencyMs,
      ...(availableModels ? { availableModels } : {}),
      message: `Connected to ${entry?.label ?? input.provider} (${input.model}) in ${latencyMs}ms.${
        availableModels ? ` Found ${availableModels.length} models.` : ""
      }`,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const safeMsg = redactSecrets(
      err instanceof Error ? err.message : "Connection failed.",
    );
    return {
      ok: false,
      provider: input.provider,
      model: input.model,
      latencyMs,
      message: `Could not reach ${entry?.label ?? input.provider}: ${safeMsg}`,
    };
  }
}

export async function checkHermesGatewayHealth(
  gatewayUrl: string | undefined,
  apiServerKey: string | undefined,
): Promise<HermesHealthStatus> {
  if (!gatewayUrl) {
    return {
      reachable: false,
      url: null,
      detail: "Hermes gateway URL is not configured.",
    };
  }

  let safeBase: string;
  try {
    safeBase = validateHttpBaseUrl(gatewayUrl);
  } catch {
    return {
      reachable: false,
      url: null,
      detail: "Invalid Hermes gateway URL.",
    };
  }

  try {
    const headers: Record<string, string> = {};
    if (apiServerKey?.trim()) {
      headers.authorization = `Bearer ${apiServerKey.trim()}`;
    }
    const res = await fetch(`${safeBase}/health`, {
      headers,
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      return {
        reachable: true,
        url: safeBase,
        detail: "Hermes CTO Gateway is active and responding.",
      };
    }
    return {
      reachable: false,
      url: safeBase,
      detail: `Hermes Gateway responded with HTTP ${res.status}.`,
    };
  } catch {
    return {
      reachable: false,
      url: safeBase,
      detail: "Hermes CTO Gateway is waiting for activation or host sync.",
    };
  }
}

export function detectOsReleaseLabel(): string {
  if (process.platform === "linux" && fs.existsSync("/etc/os-release")) {
    try {
      const content = fs.readFileSync("/etc/os-release", "utf8");
      const match = content.match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/m);
      const label = (match?.[1] ?? match?.[2] ?? "").trim();
      if (label) return label;
    } catch {
      // Fall back to Node os metadata
    }
  }
  return `${os.type()} ${os.release()}`;
}

export function buildBaselineScan(input: {
  metrics: SystemMetrics;
  disk: DiskMetrics | null;
  state: OnboardingState;
  appsCount: number;
  hermes: HermesHealthStatus;
}): BaselineScan {
  const diskTotalGb = input.disk
    ? Math.round((input.disk.totalMb / 1024) * 10) / 10
    : null;
  const diskUsedGb = input.disk
    ? Math.round((input.disk.usedMb / 1024) * 10) / 10
    : null;

  const memoryHealthy = input.metrics.memoryUsagePercent < 90;
  const diskHealthy = input.disk ? input.disk.usagePercent < 90 : true;

  const checks: BaselineCheck[] = [
    {
      id: "core-api",
      label: "Core Control API & SQLite Registry",
      status: "ok",
      detail: `Healthy on ${input.metrics.hostname} (${input.appsCount} apps registered).`,
    },
    {
      id: "capacity",
      label: "CPU, Memory & Disk Headroom",
      status: memoryHealthy && diskHealthy ? "ok" : "warn",
      detail: `${input.metrics.cpuCount} vCPU · ${input.metrics.memoryUsedMb}/${input.metrics.memoryTotalMb} MB RAM (${input.metrics.memoryUsagePercent}%)${
        input.disk ? ` · ${diskUsedGb}/${diskTotalGb} GB disk` : ""
      }.`,
    },
    {
      id: "domain-tls",
      label: "Domain & Automatic HTTPS",
      status:
        input.state.domainMode === "domain" && input.state.dnsVerified
          ? "ok"
          : input.state.domainMode === "domain"
            ? "warn"
            : "pending",
      detail:
        input.state.domainMode === "domain"
          ? input.state.dnsVerified
            ? `DNS verified for ${input.state.domain}; HTTPS ready.`
            : `Domain ${input.state.domain} saved; DNS propagation pending.`
          : "Running in IP setup mode over HTTP until a domain is bound.",
    },
    {
      id: "llm-provider",
      label: "Autonomous CTO AI Provider",
      status: input.state.llmConfigured ? "ok" : "warn",
      detail: input.state.llmConfigured
        ? `${input.state.llmProvider} (${input.state.llmModel}) configured securely.`
        : "No AI provider key saved yet; chat planning requires configuring a provider.",
    },
    {
      id: "hermes-gateway",
      label: "Hermes CTO Gateway Service",
      status: input.hermes.reachable
        ? "ok"
        : input.state.llmConfigured
          ? "pending"
          : "warn",
      detail: input.hermes.detail,
    },
  ];

  const summary = input.state.llmConfigured
    ? `Baseline scan complete on ${input.metrics.hostname}: ${input.metrics.cpuCount} vCPU, ${input.metrics.memoryTotalMb} MB RAM, and ${input.state.llmProvider} CTO ready.`
    : `Baseline scan complete on ${input.metrics.hostname}: core system healthy; connect an LLM provider to activate the CTO agent.`;

  return BaselineScanSchema.parse({
    scannedAt: new Date().toISOString(),
    hostname: input.metrics.hostname,
    osRelease: detectOsReleaseLabel(),
    cpuCount: input.metrics.cpuCount,
    memoryTotalMb: input.metrics.memoryTotalMb,
    memoryUsedMb: input.metrics.memoryUsedMb,
    diskTotalGb,
    diskUsedGb,
    checks,
    summary,
  });
}

export function seedInitialOnboardingStateFromEnv(
  existing: OnboardingState,
  env: NodeJS.ProcessEnv,
): Partial<OnboardingState> | null {
  if (existing.completed || existing.llmConfigured || existing.domain) {
    return null;
  }

  const patch: Partial<OnboardingState> = {};
  const rawDomain = env.VPS_OS_DOMAIN?.trim();
  const rawEmail = env.VPS_OS_ACME_EMAIL?.trim();
  const rawPublicIp = env.VPS_OS_PUBLIC_IP?.trim();
  const rawProvider = env.LLM_PROVIDER?.trim();
  const rawModel = env.LLM_MODEL?.trim();
  const rawBaseUrl = env.LLM_BASE_URL?.trim();
  const rawKey =
    env.LLM_API_KEY?.trim() ||
    env.OPENCODE_API_KEY?.trim() ||
    env.OPENCODE_SERVER_PASSWORD?.trim();

  if (
    rawDomain &&
    rawDomain !== "localhost" &&
    rawDomain !== "os.example.com" &&
    rawDomain !== ":80"
  ) {
    patch.domainMode = "domain";
    patch.domain = rawDomain;
  }
  if (rawEmail && rawEmail !== "admin@example.com") {
    patch.acmeEmail = rawEmail;
  }
  if (rawPublicIp && net.isIP(rawPublicIp) !== 0) {
    patch.publicIp = rawPublicIp;
  }

  const validProvider = LLM_PROVIDER_CATALOG.find((p) => p.id === rawProvider)?.id;
  const hasRealKey = Boolean(rawKey && !rawKey.startsWith("replace-with-"));
  const isOpenCodeLocal =
    validProvider === "opencode" &&
    Boolean(rawBaseUrl && isOpenCodeLocalServerUrl(rawBaseUrl));
  if (
    validProvider &&
    (hasRealKey || validProvider === "ollama" || isOpenCodeLocal)
  ) {
    patch.llmProvider = validProvider;
    patch.llmModel =
      rawModel ||
      LLM_PROVIDER_CATALOG.find((p) => p.id === validProvider)?.defaultModel ||
      null;
    if (rawBaseUrl) {
      try {
        patch.llmBaseUrl = validateHttpBaseUrl(rawBaseUrl);
      } catch {
        patch.llmBaseUrl =
          validProvider === "opencode" ? OPENCODE_ZEN_BASE_URL : null;
      }
    } else if (validProvider === "opencode") {
      patch.llmBaseUrl = OPENCODE_ZEN_BASE_URL;
    }
    patch.llmConfigured = true;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
