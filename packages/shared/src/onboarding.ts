import crypto from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "./safety.js";

/** Curated Hermes memory character bounds matching `agent/src/hermes-pack.ts`. */
const HERMES_MEMORY_LIMIT = 2200;
const HERMES_USER_LIMIT = 1375;

export const LlmProviderSchema = z.enum([
  "opencode",
  "openai",
  "anthropic",
  "openrouter",
  "nous",
  "ollama",
]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export interface ProviderEndpointPreset {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  requiresApiKey: boolean;
  keyLabel?: string;
  keyPlaceholder?: string;
  defaultModel?: string;
  suggestedModels?: string[];
}

export interface LlmProviderCatalogEntry {
  id: LlmProvider;
  label: string;
  badge?: string;
  description: string;
  defaultModel: string;
  suggestedModels: string[];
  requiresApiKey: boolean;
  keyPlaceholder: string;
  defaultBaseUrl: string;
  endpointPresets?: readonly ProviderEndpointPreset[];
  setupHint?: string;
}

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_LOCAL_BASE_URL = "http://host.docker.internal:4096";

/**
 * Resolves the endpoint preset for a provider catalog entry matching `baseUrl`.
 */
export function findProviderEndpointPreset(
  entry: LlmProviderCatalogEntry | undefined,
  baseUrl: string | null | undefined,
): ProviderEndpointPreset | undefined {
  if (!entry?.endpointPresets?.length) return undefined;
  const normalizedTarget = (baseUrl?.trim() || entry.defaultBaseUrl)
    .replace(/\/+$/, "")
    .toLowerCase();
  return entry.endpointPresets.find(
    (preset) => preset.baseUrl.replace(/\/+$/, "").toLowerCase() === normalizedTarget,
  );
}

/**
 * Returns true when an OpenCode base URL points to a self-hosted `opencode serve`
 * daemon rather than the hosted OpenCode Zen / OpenCode Go OpenAI-compatible API.
 */
export function isOpenCodeLocalServerUrl(baseUrl: string | null | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
      return false;
    }
    if (pathname.endsWith("/v1")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const LLM_PROVIDER_CATALOG: readonly LlmProviderCatalogEntry[] = [
  {
    id: "opencode",
    label: "OpenCode",
    badge: "Direct",
    description:
      "Connect directly to OpenCode Zen, OpenCode Go, or a local opencode serve daemon with agentic coding & reasoning models.",
    defaultModel: "glm-5.3",
    suggestedModels: [
      "glm-5.3",
      "kimi-k3",
      "deepseek-v4-pro",
      "deepseek-v4.1-flash-free",
      "mimo-v2.6-flash-free",
    ],
    requiresApiKey: false,
    keyPlaceholder: "opencode-... (from opencode.ai/auth or optional for local serve)",
    defaultBaseUrl: OPENCODE_ZEN_BASE_URL,
    endpointPresets: [
      {
        id: "zen",
        label: "OpenCode Zen",
        description: "Pay-as-you-go curated frontier & free models via opencode.ai/zen/v1.",
        baseUrl: OPENCODE_ZEN_BASE_URL,
        requiresApiKey: false,
        keyLabel: "OpenCode API Key (OPENCODE_API_KEY)",
        keyPlaceholder: "sk-... (from opencode.ai/auth; optional for free models)",
        defaultModel: "glm-5.3",
        suggestedModels: [
          "glm-5.3",
          "kimi-k3",
          "deepseek-v4-pro",
          "deepseek-v4.1-flash-free",
          "mimo-v2.6-flash-free",
        ],
      },
      {
        id: "go",
        label: "OpenCode Go",
        description: "Subscription open-model tier via opencode.ai/zen/go/v1.",
        baseUrl: OPENCODE_GO_BASE_URL,
        requiresApiKey: true,
        keyLabel: "OpenCode API Key (OPENCODE_API_KEY)",
        keyPlaceholder: "sk-... (from opencode.ai/auth)",
        defaultModel: "glm-5.3",
        suggestedModels: [
          "glm-5.3",
          "kimi-k3.1-pro",
          "deepseek-v4-pro",
          "deepseek-v4.1-flash",
          "mimo-v2.6-pro",
          "minimax-m3.1-flash",
        ],
      },
      {
        id: "local",
        label: "Local OpenCode Server",
        description: "Self-hosted `opencode serve --port 4096` running directly on this VPS.",
        baseUrl: OPENCODE_LOCAL_BASE_URL,
        requiresApiKey: false,
        keyLabel: "Server Password (optional)",
        keyPlaceholder: "OPENCODE_SERVER_PASSWORD (leave blank if unauthenticated)",
        defaultModel: "glm-5.3",
        suggestedModels: [
          "glm-5.3",
          "kimi-k3.1-pro",
          "deepseek-v4-pro",
          "claude-sonnet-4-5",
          "gpt-5.2",
        ],
      },
    ],
    setupHint:
      "Get an API key at opencode.ai/auth (or run `opencode serve --port 4096 --hostname 0.0.0.0` on your VPS for direct local sessions).",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Reliable general-purpose reasoning with GPT-4.1 and o-series models.",
    defaultModel: "gpt-4.1",
    suggestedModels: ["gpt-4.1", "gpt-4o", "o4-mini"],
    requiresApiKey: true,
    keyPlaceholder: "sk-proj-...",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    description: "Strong coding, troubleshooting, and plain-English planning.",
    defaultModel: "claude-sonnet-4-20250514",
    suggestedModels: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"],
    requiresApiKey: true,
    keyPlaceholder: "sk-ant-...",
    defaultBaseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Single API key routing across Claude, GPT, Llama, and Hermes models.",
    defaultModel: "anthropic/claude-sonnet-4",
    suggestedModels: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1",
      "nousresearch/hermes-3-llama-3.1-70b",
    ],
    requiresApiKey: true,
    keyPlaceholder: "sk-or-v1-...",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "nous",
    label: "Nous Research",
    description: "Direct Hermes-native model inference from Nous Research.",
    defaultModel: "Hermes-3-Llama-3.1-70B",
    suggestedModels: ["Hermes-3-Llama-3.1-70B", "Hermes-3-Llama-3.1-8B"],
    requiresApiKey: true,
    keyPlaceholder: "nous-...",
    defaultBaseUrl: "https://inference-api.nousresearch.com/v1",
  },
  {
    id: "ollama",
    label: "Local Ollama",
    badge: "Local",
    description: "Self-hosted private models running locally without an external API key.",
    defaultModel: "llama3.3",
    suggestedModels: ["llama3.3", "qwen2.5-coder:14b", "mistral"],
    requiresApiKey: false,
    keyPlaceholder: "(no API key needed)",
    defaultBaseUrl: "http://host.docker.internal:11434",
  },
];

export const OnboardingStepSchema = z.enum([
  "domain",
  "provider",
  "persona",
  "scan",
  "complete",
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const TechnicalLevelSchema = z.enum(["non-technical", "developer"]);
export type TechnicalLevel = z.infer<typeof TechnicalLevelSchema>;

export const CommunicationStyleSchema = z.enum([
  "plain-english",
  "concise",
  "detailed",
]);
export type CommunicationStyle = z.infer<typeof CommunicationStyleSchema>;

export const ApprovalModeSchema = z.enum(["manual", "smart", "yolo"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const PersonaPreferencesSchema = z.object({
  ownerName: z.string().trim().max(80).default("Server Owner"),
  technicalLevel: TechnicalLevelSchema.default("non-technical"),
  communicationStyle: CommunicationStyleSchema.default("plain-english"),
  approvalMode: ApprovalModeSchema.default("manual"),
});
export type PersonaPreferences = z.infer<typeof PersonaPreferencesSchema>;

export const BaselineCheckStatusSchema = z.enum(["ok", "warn", "pending"]);
export type BaselineCheckStatus = z.infer<typeof BaselineCheckStatusSchema>;

export const BaselineCheckSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  status: BaselineCheckStatusSchema,
  detail: z.string().min(1).max(300),
});
export type BaselineCheck = z.infer<typeof BaselineCheckSchema>;

export const BaselineScanSchema = z.object({
  scannedAt: z.string(),
  hostname: z.string(),
  osRelease: z.string(),
  cpuCount: z.number().int().positive(),
  memoryTotalMb: z.number().nonnegative(),
  memoryUsedMb: z.number().nonnegative(),
  diskTotalGb: z.number().nonnegative().nullable(),
  diskUsedGb: z.number().nonnegative().nullable(),
  checks: z.array(BaselineCheckSchema),
  summary: z.string().min(1).max(500),
});
export type BaselineScan = z.infer<typeof BaselineScanSchema>;

/** Sanitized onboarding state persisted in SQLite (never stores plaintext secrets). */
export const OnboardingStateSchema = z.object({
  completed: z.boolean(),
  completedAt: z.string().nullable(),
  currentStep: OnboardingStepSchema,
  domainMode: z.enum(["domain", "ip-only"]),
  domain: z.string().nullable(),
  acmeEmail: z.string().nullable(),
  publicIp: z.string().nullable(),
  dnsVerified: z.boolean(),
  llmProvider: LlmProviderSchema.nullable(),
  llmModel: z.string().nullable(),
  llmBaseUrl: z.string().nullable(),
  llmConfigured: z.boolean(),
  telegramConfigured: z.boolean(),
  discordConfigured: z.boolean(),
  persona: PersonaPreferencesSchema,
  baselineScan: BaselineScanSchema.nullable(),
  updatedAt: z.string(),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const SetupClaimRecordSchema = z.object({
  codeHash: z.string().regex(/^[a-f0-9]{64}$/i),
  createdAt: z.string(),
  expiresAt: z.string(),
  consumedAt: z.string().nullable().default(null),
  failedAttempts: z.number().int().min(0).default(0),
});
export type SetupClaimRecord = z.infer<typeof SetupClaimRecordSchema>;

export function createDefaultOnboardingState(
  overrides: Partial<OnboardingState> = {},
): OnboardingState {
  return OnboardingStateSchema.parse({
    completed: false,
    completedAt: null,
    currentStep: "domain",
    domainMode: "ip-only",
    domain: null,
    acmeEmail: null,
    publicIp: null,
    dnsVerified: false,
    llmProvider: null,
    llmModel: null,
    llmBaseUrl: null,
    llmConfigured: false,
    telegramConfigured: false,
    discordConfigured: false,
    persona: {
      ownerName: "Server Owner",
      technicalLevel: "non-technical",
      communicationStyle: "plain-english",
      approvalMode: "manual",
    },
    baselineScan: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

/** Normalizes a one-time setup pairing code by stripping hyphens/spaces and uppercasing. */
export function normalizeSetupCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Computes the SHA-256 hex digest of a normalized one-time setup pairing code. */
export function hashSetupCode(code: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeSetupCode(code), "utf8")
    .digest("hex");
}

/** Hashes an admin passphrase using a random 16-byte salt and `crypto.scryptSync`. */
export function hashPassphrase(passphrase: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(passphrase, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

/** Verifies an admin passphrase against a stored `scrypt:<salt>:<hash>` record. */
export function verifyPassphrase(passphrase: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const salt = parts[1];
  const expectedHex = parts[2];
  if (!salt || !expectedHex) {
    return false;
  }
  try {
    const expectedBuf = Buffer.from(expectedHex, "hex");
    const actualBuf = crypto.scryptSync(passphrase, salt, expectedBuf.length);
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Renders bounded Hermes `memories/USER.md` content (`<= 1375` chars) from onboarding
 * persona and approval preferences.
 */
export function renderUserMemoryMarkdown(persona: PersonaPreferences): string {
  const cleanName = redactSecrets(persona.ownerName || "Server Owner").slice(0, 80);
  const techLine =
    persona.technicalLevel === "developer"
      ? "Developer / technical owner (comfortable with architecture details when relevant, still prefer clean summaries)."
      : "Non-Linux, non-coding user. Prefer plain-English summaries, clear status outcomes, and avoid raw terminal output unless asked.";
  const styleLine =
    persona.communicationStyle === "detailed"
      ? "Detailed explanations of why each change helps and what was verified."
      : persona.communicationStyle === "concise"
        ? "Short, direct status updates with actionable next steps."
        : "Calm, plain-English, reassuring summaries with clear next actions.";
  const approvalLine =
    persona.approvalMode === "yolo"
      ? "YOLO Sandbox Mode: auto-approve and execute safe container deploys & lifecycle actions immediately (destructive host actions still blocked)."
      : persona.approvalMode === "manual"
        ? "Manual confirmation for every server or app change; explain risk clearly and wait for explicit approval."
        : "Smart approvals: run read-only diagnostics automatically, always confirm before installing, modifying, or removing workloads.";

  const content = [
    "# Server Owner Profile",
    "",
    `- Owner name: ${cleanName}`,
    `- Technical level: ${techLine}`,
    `- Approval preference: ${approvalLine}`,
    `- Communication style: ${styleLine}`,
    "",
  ].join("\n");

  return content.length <= HERMES_USER_LIMIT
    ? content
    : content.slice(0, HERMES_USER_LIMIT);
}

/**
 * Updates the `## Baseline Checklist` section of Hermes `memories/MEMORY.md`
 * while preserving core platform layout facts and respecting the `2200`-char cap.
 */
export function renderServerMemoryMarkdown(
  existingMemory: string,
  scan: BaselineScan,
  domain: string | null,
): string {
  const marker = "## Baseline Checklist";
  const markerIndex = existingMemory.indexOf(marker);
  const headerPart =
    markerIndex >= 0
      ? existingMemory.slice(0, markerIndex).trimEnd()
      : [
          "# Server Memory (VPS OS CTO)",
          "",
          "## Platform Layout",
          "- Core platform root: `/vps-os` (`docker-compose.yml`, `.env`, `data/registry.db`, `Caddyfile`, `caddy/apps.d/*.caddy`)",
          "- Hermes CTO home: `/vps-os/hermes` (`SOUL.md`, `memories/`, `skills/`, `state.db`)",
          "- Isolated workloads root: `/apps/<slug>` (`docker-compose.yml`, `.env`, `.env.example`, `data/` or `workspace/`)",
          "- Core Docker bridge network: `vps-os-core`",
          "- Ingress: Caddy 2 handles automatic HTTPS (`80`/`443`) and imports `/etc/caddy/apps.d/*.caddy`.",
        ].join("\n");

  const diskLine =
    scan.diskTotalGb !== null && scan.diskUsedGb !== null
      ? `${scan.diskUsedGb} / ${scan.diskTotalGb} GB used`
      : "disk metrics pending";

  const checkLines = scan.checks
    .slice(0, 6)
    .map((check) => `- ${check.label}: [${check.status.toUpperCase()}] ${redactSecrets(check.detail)}`);

  const checklistSection = [
    `## Baseline Checklist (Scanned ${scan.scannedAt})`,
    `- Host: ${redactSecrets(scan.hostname)} (${redactSecrets(scan.osRelease)})`,
    `- Capacity: ${scan.cpuCount} vCPU, ${scan.memoryUsedMb}/${scan.memoryTotalMb} MB RAM, ${diskLine}`,
    `- Dashboard domain: ${domain ?? "IP setup mode (no public domain bound yet)"}`,
    ...checkLines,
    "",
  ].join("\n");

  const combined = `${headerPart}\n\n${checklistSection}`;
  return combined.length <= HERMES_MEMORY_LIMIT
    ? combined
    : combined.slice(0, HERMES_MEMORY_LIMIT);
}

/**
 * Updates `model.provider`, `model.name`, and `approvals.mode` in Hermes `config.yaml`
 * while preserving MCP server definitions and memory limits.
 */
export function updateHermesConfigYaml(
  existingYaml: string,
  updates: {
    provider?: LlmProvider | null;
    model?: string | null;
    approvalMode?: ApprovalMode;
  },
): string {
  const lines = existingYaml.split(/\r?\n/);
  let currentSection = "";

  const sanitizedModel = updates.model?.replace(/["\r\n]/g, "").trim();

  const updated = lines.map((line) => {
    const topMatch = line.match(/^([A-Za-z0-9_]+):\s*$/);
    if (topMatch?.[1]) {
      currentSection = topMatch[1];
      return line;
    }
    if (currentSection === "model") {
      if (updates.provider && /^\s+provider:\s*/.test(line)) {
        return `  provider: "${updates.provider}"`;
      }
      if (sanitizedModel && /^\s+name:\s*/.test(line)) {
        return `  name: "${sanitizedModel}"`;
      }
    }
    if (currentSection === "approvals" && updates.approvalMode && /^\s+mode:\s*/.test(line)) {
      return `  mode: ${updates.approvalMode}`;
    }
    return line;
  });

  return updated.join("\n");
}
