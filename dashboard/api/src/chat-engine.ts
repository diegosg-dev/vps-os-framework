import crypto from "node:crypto";
import {
  buildValidatedLlmPlan,
  classifyGoalRisk,
  createExecutionPlan,
  extractDeploySpecFromGoal,
  extractRemoveSlugsFromGoal,
  extractRouteSpecFromGoal,
  loadCtoGuidanceContext,
} from "@vps-os/agent";
import {
  type AppRecord,
  type ChatAttachment,
  type ChatMessage,
  type ChatMode,
  type ChatReasoningBlock,
  type ChatToolCall,
  LLM_PROVIDER_CATALOG,
  type LlmProvider,
  type ReasoningEffort,
  type StoredChatAttachmentRecord,
  type StoredPlan,
  type SystemMetrics,
  type SystemRegistryStore,
  isOpenCodeLocalServerUrl,
  redactSecrets,
  syncAppStatuses,
  validateHttpBaseUrl,
} from "@vps-os/shared";
import type { DiskMetrics } from "./metrics.js";
import { readOnboardingEnvValues } from "./onboarding.js";

export type ChatStreamEvent =
  | {
      type: "message_start";
      userMessage?: ChatMessage;
      assistantMessage: ChatMessage;
    }
  | {
      type: "reasoning_start";
      block: ChatReasoningBlock;
    }
  | {
      type: "reasoning_delta";
      blockId: string;
      delta: string;
    }
  | {
      type: "reasoning_done";
      block: ChatReasoningBlock;
    }
  | {
      type: "tool_start";
      toolCall: ChatToolCall;
    }
  | {
      type: "tool_done";
      toolCall: ChatToolCall;
    }
  | {
      type: "plan_created";
      plan: StoredPlan;
    }
  | {
      type: "text_delta";
      delta: string;
    }
  | {
      type: "message_done";
      assistantMessage: ChatMessage;
      plan: StoredPlan | null;
      threadTitle: string;
    }
  | {
      type: "error";
      message: string;
    };

export interface ResolvedProviderConfig {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** Built-in @mention tokens that ground the CTO agent in system tools instead of app slugs. */
const BUILT_IN_SYSTEM_MENTION_TOKENS = new Set([
  "host-metrics",
  "audit-trail",
  "pending-plans",
]);

export interface ChatEngineDeps {
  registry: SystemRegistryStore;
  getMetrics: () => SystemMetrics;
  getDisk: () => DiskMetrics | null;
  onboardingEnvPath?: string | undefined;
  syncStatuses?:
    | ((slugs: string[]) => Promise<Record<string, AppRecord["status"]>> | Record<string, AppRecord["status"]>)
    | undefined;
  getLogs?: ((slug: string, tail: number) => Promise<string[]> | string[]) | undefined;
  /** Optional plan executor used when YOLO Sandbox mode auto-executes safe plans. */
  executePlan?:
    | ((
        plan: StoredPlan,
        options: { leaseOwnerId: string },
      ) => Promise<{ summary: string }> | { summary: string })
    | undefined;
  /** Optional custom fetch override (used by tests to mock OpenCode/OpenAI streams). */
  fetchFn?: typeof fetch | undefined;
  /** Disables outbound provider calls (useful in isolated offline tests). */
  disableExternalLlm?: boolean | undefined;
}

export interface RunAgentTurnInput {
  threadId: string;
  userText: string;
  mode: ChatMode;
  effort?: ReasoningEffort | undefined;
  mentionedSlugs?: string[] | undefined;
  attachments: StoredChatAttachmentRecord[];
  history: ChatMessage[];
  overrideProvider?: LlmProvider | undefined;
  overrideModel?: string | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: (event: ChatStreamEvent) => void;
}

export interface RunAgentTurnResult {
  assistantMessage: ChatMessage;
  plan: StoredPlan | null;
  providerLabel: string;
  modelLabel: string;
}

function resolveProviderConfig(
  deps: ChatEngineDeps,
  overrideProvider?: LlmProvider,
  overrideModel?: string,
): ResolvedProviderConfig | null {
  const onboarding = deps.registry.getOnboardingState();
  const fileEnv = readOnboardingEnvValues(deps.onboardingEnvPath);

  const rawProvider = (
    overrideProvider ??
    onboarding.llmProvider ??
    fileEnv.LLM_PROVIDER ??
    process.env.LLM_PROVIDER ??
    ""
  ).trim();

  const entry = LLM_PROVIDER_CATALOG.find((item) => item.id === rawProvider);
  if (!entry) return null;

  const model = (
    overrideModel ??
    onboarding.llmModel ??
    fileEnv.LLM_MODEL ??
    process.env.LLM_MODEL ??
    entry.defaultModel
  ).trim();

  const rawBaseUrl = (
    onboarding.llmBaseUrl ??
    fileEnv.LLM_BASE_URL ??
    process.env.LLM_BASE_URL ??
    entry.defaultBaseUrl
  ).trim();

  let baseUrl: string;
  try {
    baseUrl = validateHttpBaseUrl(rawBaseUrl || entry.defaultBaseUrl);
  } catch {
    baseUrl = entry.defaultBaseUrl;
  }

  let apiKey =
    fileEnv.LLM_API_KEY ||
    process.env.LLM_API_KEY ||
    "";

  if (entry.id === "opencode") {
    if (isOpenCodeLocalServerUrl(baseUrl)) {
      apiKey =
        fileEnv.OPENCODE_SERVER_PASSWORD ||
        process.env.OPENCODE_SERVER_PASSWORD ||
        apiKey;
    } else {
      apiKey =
        fileEnv.OPENCODE_API_KEY ||
        process.env.OPENCODE_API_KEY ||
        apiKey;
    }
  }

  if (apiKey.startsWith("replace-with-")) {
    apiKey = "";
  }

  const isOpenCodeGo =
    entry.id === "opencode" && baseUrl.toLowerCase().includes("/zen/go");
  if ((entry.requiresApiKey || isOpenCodeGo) && !apiKey) {
    return null;
  }

  // Require explicit configuration via onboarding or real key/local endpoint
  if (
    !onboarding.llmConfigured &&
    !overrideProvider &&
    !apiKey &&
    entry.id !== "ollama" &&
    !(entry.id === "opencode" && isOpenCodeLocalServerUrl(baseUrl))
  ) {
    return null;
  }

  return {
    provider: entry.id,
    model: model || entry.defaultModel,
    baseUrl,
    apiKey,
  };
}

function buildSystemPrompt(
  persona: ReturnType<SystemRegistryStore["getOnboardingState"]>["persona"],
  mode: ChatMode,
  effort: ReasoningEffort,
  toolContext: string,
): string {
  const tone =
    persona.technicalLevel === "developer"
      ? "Technical/developer audience — concise, accurate architecture and Docker details welcome."
      : "Non-Linux, non-coding owner — explain clearly in plain English with calm, reassuring next steps.";
  const modeRule =
    mode === "plan"
      ? "The user is in PLAN mode: focus on verifying boundaries, risks, and clear approval steps."
      : mode === "ask"
        ? "The user is in ASK (read-only) mode: answer questions clearly using inspected telemetry and context without proposing host mutations."
        : "The user is in AGENT mode: answer directly using the inspected server telemetry and attached files; never claim to have mutated the host without an approved ExecutionPlan.";
  const effortRule =
    effort === "max"
      ? "Reasoning depth: MAX — perform exhaustive root-cause and edge-case analysis."
      : effort === "high"
        ? "Reasoning depth: HIGH — verify dependencies, rollback paths, and resource headroom thoroughly."
        : effort === "low"
          ? "Reasoning depth: LOW — respond concisely and directly."
          : "Reasoning depth: MEDIUM — balanced thoroughness and brevity.";

  const guidance = loadCtoGuidanceContext();
  const skillsBlock =
    guidance.skills.length > 0
      ? guidance.skills
          .map((s) => `- **${s.name}**: ${s.description}`)
          .join("\n")
      : "";

  return [
    "You are the VPS OS Autonomous CTO Agent managing an Ubuntu VPS with Locked Apartment Docker workloads.",
    `Owner: ${persona.ownerName || "Server Owner"}. ${tone}`,
    `Approval guardrail: ${persona.approvalMode}. ${modeRule}`,
    effortRule,
    "Never print or ask to paste raw private keys or unredacted secrets.",
    "NEUTRAL WORKLOAD STANCE: VPS OS is a general-purpose container host for websites, web applications, APIs, databases, background workers, and scheduled jobs. Keep recommendations and `vps-questions` options strictly neutral and technical — NEVER suggest, promote, or steer the user toward 'AI agents', 'chatbots', or 'personal assistants' unless the user explicitly asks to build one.",
    "Respond naturally and concisely like a technical CTO in chat — do not dump huge boilerplate tables unless telemetry was requested.",
    "Use clean Markdown formatting (short headings, bullet points, tables, fenced code blocks when helpful).",
    "NEVER claim a plan was approved, executed, or deployed unless that exact state appears in Live Inspected Server Context or executed tool results — typing 'approve' in chat does not approve or execute a pending Execution Plan card.",
    "When proposedPlan is non-null with status 'pending', direct the user to click Approve & Execute on the Execution Plan card below your message (never ask them to type 'approve').",
    "CRITICAL HONESTY RULE: When proposedPlan is null AND you do NOT append a valid ```vps-plan``` block at the end of your reply, NO Execution Plan card is attached below your reply — NEVER write 'pending below', 'card below this message', or tell the user to click Approve & Execute below!",
    "When proposedPlan is null, mode is NOT 'ask', and the user asks you to act (deploy, remove, start/stop/restart, attach/detach a domain, or follow up with 'can you do it?' / 'go ahead' / 'yes'), emit a single trailing fenced block so a real interactive Execution Plan card is created (and auto-executed in YOLO mode):\n```vps-plan\n{\"goal\":\"...\",\"summary\":\"...\",\"steps\":[{\"title\":\"...\",\"description\":\"...\",\"toolName\":\"prepare_app_workspace|control_app_lifecycle|remove_workload|route_caddy\",\"args\":{...}}]}\n```\nSupported args: prepare_app_workspace({slug,name,kind:'web-app'|'personal-agent',domain:string|null,internalPort}), control_app_lifecycle({slug,action:'start'|'stop'|'restart'}), remove_workload({slug,removeFiles:true}), route_caddy({slug,domain:string|null}). Default `kind` to `'web-app'` for websites/apps/APIs/services; only use `'personal-agent'` internally if the user explicitly requests a headless worker template. NEVER put shell, ufw, or raw host port '-p 8080:8080' steps in vps-plan — if a request asks for an unsupported host port or OS firewall edit, explain plainly what runtimeCapabilities allows (e.g. Caddy HTTPS domain routing on ports 80/443, including `<slug>.<ip-with-dashes>.sslip.io` when publicIp is set and no custom domain exists yet).",
    "When proposedPlan.status is 'executed' (auto-executed in YOLO mode), confirm that it ALREADY ran, report the live workload status, folder, port, and public/internal URL from workloads & autoExecutedSummary, and state any next step clearly.",
    "When an app has domain=null, state clearly that it is currently internal-network-only (listening on its internal port) and needs a domain/route attached via Caddy (ports 80/443) before it has a public HTTP(S) link.",
    "If key details are missing or you want the user to pick between options before acting (and neither proposedPlan nor vps-plan is attached), ask concisely with neutral technical/product options and optionally append at the very end a single fenced block:\n```vps-questions\n{\"questions\":[{\"question\":\"...\",\"options\":[\"...\",\"...\"]}]}\n```",
    ...(guidance.soul ? ["", "### CTO Operating Identity & Architecture Rules", guidance.soul] : []),
    ...(skillsBlock ? ["", "### Registered Operational Playbooks (Skills)", skillsBlock] : []),
    ...(guidance.memory ? ["", "### Curated Host Memory", guidance.memory] : []),
    "",
    "### Live Inspected Server Context",
    toolContext,
  ].join("\n");
}

function parseAndStripVpsPlanBlock(
  rawText: string,
  fallbackGoal: string,
): { cleanText: string; plan: ReturnType<typeof buildValidatedLlmPlan> } {
  const blockRegex = /```vps-plan[^\n\r]*(?:\r?\n|\s+)([\s\S]*?)```/g;
  let parsedPlan: ReturnType<typeof buildValidatedLlmPlan> = null;
  let match: RegExpExecArray | null = null;

  while ((match = blockRegex.exec(rawText)) !== null) {
    const jsonBody = match[1]?.trim().replace(/,\s*([}\]])/g, "$1");
    if (!jsonBody) continue;
    try {
      const candidate = JSON.parse(jsonBody) as unknown;
      const validated = buildValidatedLlmPlan(candidate, fallbackGoal);
      if (validated) {
        parsedPlan = validated;
      }
    } catch {
      // ignore invalid JSON block; still strip fence below
    }
  }

  const cleanText = rawText
    .replace(/```vps-plan[^\n\r]*(?:\r?\n|\s+)[\s\S]*?```\s*/g, "")
    .trimEnd();

  return { cleanText, plan: parsedPlan };
}

/**
 * Formats a detailed, secret-redacted Markdown execution report for a plan
 * (shared between `POST /api/chat/execute` and YOLO Sandbox auto-execution).
 */
export function formatPlanExecutionMarkdown(
  plan: StoredPlan,
  rawSummary: string,
  registry: SystemRegistryStore,
): string {
  const safeSummary = redactSecrets(rawSummary);
  const lines: string[] = [
    "### Plan Executed",
    "",
    safeSummary,
    "",
    "**Steps completed:**",
  ];

  for (const [idx, step] of plan.steps.entries()) {
    lines.push(`${idx + 1}. ✅ **${step.title}** — ${step.description}`);
  }

  const stepWithSlug = plan.steps.find(
    (s) => s.args && typeof s.args.slug === "string" && s.args.slug.trim(),
  );
  const slug =
    stepWithSlug && typeof stepWithSlug.args?.slug === "string"
      ? stepWithSlug.args.slug.trim()
      : null;
  const app = slug ? registry.getAppBySlug(slug) : null;

  if (app) {
    lines.push("");
    lines.push("**Workload details:**");
    lines.push(`- **Slug:** \`${app.slug}\` (${app.kind})`);
    lines.push(`- **Status:** \`${app.status}\``);
    lines.push(`- **Folder:** \`${app.folderPath}\``);
    lines.push(`- **Internal Port:** \`${app.internalPort}\``);
    lines.push(
      `- **Access:** ${app.domain ? `https://${app.domain}` : "Internal network only (attach a domain to expose via HTTPS)"}`,
    );
  }

  lines.push("");
  lines.push("Open **Workloads** to inspect container health, endpoints, and live logs.");
  return lines.join("\n");
}

function buildUserContentWithAttachments(
  userText: string,
  attachments: StoredChatAttachmentRecord[],
): string {
  if (attachments.length === 0) return userText;
  const sections = [userText, "", "### Attached Files"];
  for (const att of attachments) {
    sections.push(`- **${att.name}** (${att.mimeType}, ${att.sizeBytes} bytes)`);
    if (att.textPreview) {
      sections.push("```");
      sections.push(att.textPreview.slice(0, 6000));
      sections.push("```");
    }
  }
  return sections.join("\n");
}

function buildFallbackResponse(input: {
  userText: string;
  mode: ChatMode;
  metrics: SystemMetrics;
  disk: DiskMetrics | null;
  apps: AppRecord[];
  attachments: StoredChatAttachmentRecord[];
  plan: StoredPlan | null;
  yoloExecutionSummary?: string | null;
  registry?: SystemRegistryStore;
  providerNote: string | null;
}): string {
  if (input.plan?.status === "executed" && input.yoloExecutionSummary && input.registry) {
    const base = formatPlanExecutionMarkdown(
      input.plan,
      input.yoloExecutionSummary,
      input.registry,
    );
    return input.providerNote ? `${base}\n\n> ${input.providerNote}` : base;
  }

  const lines: string[] = [];

  if (input.plan) {
    lines.push(
      `I analyzed your request and prepared a **${input.plan.steps.length}-step execution plan** for your review below.`,
    );
    lines.push("");
    if (input.plan.requiresUserApproval) {
      lines.push(
        "Because this modifies server workloads or configuration, review the steps in the plan card below and click **Approve & Execute** before execution.",
      );
    } else {
      lines.push(
        "This is a safe read-only inspection plan — you can run it immediately using **Execute Approved Plan** below.",
      );
    }
  } else {
    lines.push(
      `Here is the live snapshot of **${input.metrics.hostname}** based on the tools I just ran:`,
    );
  }

  lines.push("");
  lines.push("### Server Snapshot");
  lines.push(
    `- **Compute**: ${input.metrics.cpuCount} vCPU · 1m load \`${input.metrics.loadAverage1m}\``,
  );
  lines.push(
    `- **Memory**: ${input.metrics.memoryUsedMb} / ${input.metrics.memoryTotalMb} MB (${input.metrics.memoryUsagePercent}% used)`,
  );
  if (input.disk) {
    lines.push(
      `- **Disk**: ${Math.round(input.disk.usedMb / 1024)} / ${Math.round(input.disk.totalMb / 1024)} GB (${input.disk.usagePercent}% used)`,
    );
  }
  lines.push(
    `- **Workloads**: ${
      input.apps.length === 0
        ? "0 isolated apps provisioned yet"
        : input.apps
            .map((a) => `\`${a.slug}\` (${a.status}${a.domain ? `, ${a.domain}` : ""})`)
            .join(", ")
    }`,
  );

  if (input.attachments.length > 0) {
    lines.push("");
    lines.push("### Attached Files Inspected");
    for (const att of input.attachments) {
      const previewLines = att.textPreview
        ? att.textPreview.split(/\r?\n/).length
        : null;
      lines.push(
        `- **${att.name}** (${att.kind}, ${Math.max(1, Math.round(att.sizeBytes / 1024))} KB${
          previewLines !== null ? `, ${previewLines} lines inspected with secrets redacted` : ""
        })`,
      );
    }
  }

  if (input.providerNote) {
    lines.push("");
    lines.push(`> ${input.providerNote}`);
  }

  return lines.join("\n");
}

async function callOpenCodeLocalServer(
  cfg: ResolvedProviderConfig,
  systemPrompt: string,
  userPrompt: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  onReasoningDelta: (delta: string) => void,
  onTextDelta: (delta: string) => void,
): Promise<{ text: string; reasoning: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (cfg.apiKey) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${cfg.apiKey}`, "utf8").toString("base64")}`;
  }

  const sessionRes = await fetchFn(`${cfg.baseUrl}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "VPS OS CTO Turn" }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!sessionRes.ok) {
    throw new Error(`OpenCode server /session returned HTTP ${sessionRes.status}`);
  }
  const sessionData = (await sessionRes.json()) as { id?: string };
  if (!sessionData.id) {
    throw new Error("OpenCode server did not return a session id.");
  }

  const modelParts = cfg.model.includes("/")
    ? {
        providerID: cfg.model.split("/")[0],
        modelID: cfg.model.slice(cfg.model.indexOf("/") + 1),
      }
    : undefined;

  const msgRes = await fetchFn(
    `${cfg.baseUrl}/session/${encodeURIComponent(sessionData.id)}/message`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(modelParts ? { model: modelParts } : {}),
        system: systemPrompt,
        parts: [{ type: "text", text: userPrompt }],
      }),
      signal: signal ?? AbortSignal.timeout(45_000),
    },
  );
  if (!msgRes.ok) {
    throw new Error(`OpenCode server /session/message returned HTTP ${msgRes.status}`);
  }

  const msgJson = (await msgRes.json()) as {
    parts?: Array<{ type?: string; text?: string; reasoning?: string }>;
    content?: string;
  };

  let fullText = "";
  let fullReasoning = "";

  if (Array.isArray(msgJson.parts)) {
    for (const part of msgJson.parts) {
      if (part.type === "reasoning" && typeof (part.text ?? part.reasoning) === "string") {
        const chunk = redactSecrets(part.text ?? part.reasoning ?? "");
        if (chunk) {
          fullReasoning += chunk;
          onReasoningDelta(chunk);
        }
      } else if (part.type === "text" && typeof part.text === "string") {
        const chunk = redactSecrets(part.text);
        if (chunk) {
          fullText += chunk;
          onTextDelta(chunk);
        }
      }
    }
  } else if (typeof msgJson.content === "string") {
    const chunk = redactSecrets(msgJson.content);
    fullText = chunk;
    onTextDelta(chunk);
  }

  return { text: fullText, reasoning: fullReasoning };
}

async function callOpenAiCompatibleStream(
  cfg: ResolvedProviderConfig,
  threadId: string,
  systemPrompt: string,
  history: ChatMessage[],
  userPrompt: string,
  attachments: StoredChatAttachmentRecord[],
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  onReasoningDelta: (delta: string) => void,
  onTextDelta: (delta: string) => void,
): Promise<{ text: string; reasoning: string }> {
  const endpoint =
    cfg.provider === "ollama"
      ? `${cfg.baseUrl}/v1/chat/completions`
      : `${cfg.baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
  };

  if (cfg.provider === "opencode") {
    headers.authorization = `Bearer ${cfg.apiKey || "public"}`;
    headers["x-opencode-session"] = threadId;
  } else if (cfg.apiKey) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }

  const imageAttachments = attachments.filter(
    (att) => att.kind === "image" && att.dataBase64,
  );

  const userContent: unknown =
    imageAttachments.length > 0
      ? [
          { type: "text", text: userPrompt },
          ...imageAttachments.slice(0, 3).map((img) => ({
            type: "image_url",
            image_url: {
              url: `data:${img.mimeType};base64,${img.dataBase64}`,
            },
          })),
        ]
      : userPrompt;

  const recentHistory = history
    .slice(-8)
    .filter((msg) => typeof msg.content === "string" && msg.content.trim().length > 0)
    .map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    }));

  const postCompletion = (content: unknown) =>
    fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          ...recentHistory,
          { role: "user", content },
        ],
      }),
      signal: signal ?? AbortSignal.timeout(45_000),
    });

  let res = await postCompletion(userContent);

  // Some text-only OpenCode/OpenAI-compatible models reject multipart `image_url` payloads with HTTP 400/415/422.
  // Retry once with plain-text prompt + attachment notice so the user still gets a live CTO reply.
  if (
    !res.ok &&
    imageAttachments.length > 0 &&
    (res.status === 400 || res.status === 415 || res.status === 422)
  ) {
    const textOnlyFallback = `${userPrompt}\n\n[Note: ${imageAttachments.length} image attachment(s) omitted from binary payload because model "${cfg.model}" rejected multimodal image_url input. Ask the user to paste any relevant text/error lines if needed.]`;
    res = await postCompletion(textOnlyFallback);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const errText = redactSecrets((await res.text()).trim());
      if (errText) {
        detail = `: ${errText.slice(0, 220)}`;
      }
    } catch {
      // ignore unread error body
    }
    throw new Error(`${cfg.provider} returned HTTP ${res.status}${detail}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    const json = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
        };
      }>;
    };
    const msg = json.choices?.[0]?.message;
    const rawReasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
    const rawContent = msg?.content ?? "";
    const cleanReasoning = rawReasoning ? redactSecrets(rawReasoning) : "";
    const cleanContent = rawContent ? redactSecrets(rawContent) : "";
    if (cleanReasoning) onReasoningDelta(cleanReasoning);
    if (cleanContent) onTextDelta(cleanContent);
    return { text: cleanContent, reasoning: cleanReasoning };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let fullReasoning = "";
  let inThinkTag = false;

  const emitChunkWithThinkSplit = (chunk: string) => {
    let remaining = chunk;
    while (remaining.length > 0) {
      if (!inThinkTag) {
        const openIdx = remaining.indexOf("<think>");
        if (openIdx === -1) {
          const safe = redactSecrets(remaining);
          fullText += safe;
          onTextDelta(safe);
          return;
        }
        if (openIdx > 0) {
          const before = redactSecrets(remaining.slice(0, openIdx));
          fullText += before;
          onTextDelta(before);
        }
        inThinkTag = true;
        remaining = remaining.slice(openIdx + 7);
      } else {
        const closeIdx = remaining.indexOf("</think>");
        if (closeIdx === -1) {
          const safe = redactSecrets(remaining);
          fullReasoning += safe;
          onReasoningDelta(safe);
          return;
        }
        if (closeIdx > 0) {
          const thought = redactSecrets(remaining.slice(0, closeIdx));
          fullReasoning += thought;
          onReasoningDelta(thought);
        }
        inThinkTag = false;
        remaining = remaining.slice(closeIdx + 8);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        const chunk = JSON.parse(dataStr) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              reasoning?: string | null;
            };
          }>;
        };
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningDelta === "string" && reasoningDelta) {
          const safe = redactSecrets(reasoningDelta);
          fullReasoning += safe;
          onReasoningDelta(safe);
        }
        if (typeof delta.content === "string" && delta.content) {
          emitChunkWithThinkSplit(delta.content);
        }
      } catch {
        // Ignore keepalive or partial SSE frames
      }
    }
  }

  return { text: fullText, reasoning: fullReasoning };
}

async function callAnthropicStream(
  cfg: ResolvedProviderConfig,
  systemPrompt: string,
  history: ChatMessage[],
  userPrompt: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  onReasoningDelta: (delta: string) => void,
  onTextDelta: (delta: string) => void,
): Promise<{ text: string; reasoning: string }> {
  const recentHistory = history.slice(-8).map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content,
  }));

  const res = await fetchFn(`${cfg.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      stream: true,
      system: systemPrompt,
      messages: [...recentHistory, { role: "user", content: userPrompt }],
    }),
    signal: signal ?? AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    throw new Error(`Anthropic returned HTTP ${res.status}`);
  }
  if (!res.body) {
    return { text: "", reasoning: "" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let fullReasoning = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;
      try {
        const evt = JSON.parse(dataStr) as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (evt.type === "content_block_delta" && evt.delta) {
          if (evt.delta.type === "thinking_delta" && evt.delta.thinking) {
            const safe = redactSecrets(evt.delta.thinking);
            fullReasoning += safe;
            onReasoningDelta(safe);
          } else if (evt.delta.type === "text_delta" && evt.delta.text) {
            const safe = redactSecrets(evt.delta.text);
            fullText += safe;
            onTextDelta(safe);
          }
        }
      } catch {
        // ignore non-JSON SSE events
      }
    }
  }

  return { text: fullText, reasoning: fullReasoning };
}

export function formatSseFrame(event: ChatStreamEvent): Uint8Array {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new TextEncoder().encode(payload);
}

async function streamLlmWithReasoning(params: {
  providerCfg: ResolvedProviderConfig | null;
  threadId: string;
  systemPrompt: string;
  history: ChatMessage[];
  userPrompt: string;
  attachments: StoredChatAttachmentRecord[];
  fetchFn: typeof fetch;
  signal: AbortSignal | undefined;
  reasoningBlocks: ChatReasoningBlock[];
  emit: (event: ChatStreamEvent) => void;
}): Promise<{ assistantText: string; providerNote: string | null }> {
  const { providerCfg, emit } = params;
  let assistantText = "";
  let providerNote: string | null = null;

  if (!providerCfg) {
    return {
      assistantText,
      providerNote:
        "Running with the built-in VPS OS CTO planner. Connect **OpenCode** or another AI provider in Setup Wizard for full multi-turn LLM reasoning.",
    };
  }

  const llmReasoningId = crypto.randomUUID();
  const llmReasoningStarted = Date.now();
  let llmReasoningBlock: ChatReasoningBlock | null = null;

  const ensureLlmReasoningStarted = () => {
    if (!llmReasoningBlock) {
      llmReasoningBlock = {
        id: llmReasoningId,
        title: `${providerCfg.provider === "opencode" ? "OpenCode" : providerCfg.provider} reasoning`,
        content: "",
        durationMs: 0,
        status: "streaming",
      };
      params.reasoningBlocks.push(llmReasoningBlock);
      emit({ type: "reasoning_start", block: { ...llmReasoningBlock } });
    }
  };

  const onLlmReasoningDelta = (delta: string) => {
    ensureLlmReasoningStarted();
    if (llmReasoningBlock) {
      llmReasoningBlock.content += delta;
      emit({ type: "reasoning_delta", blockId: llmReasoningId, delta });
    }
  };

  const onLlmTextDelta = (delta: string) => {
    assistantText += delta;
    emit({ type: "text_delta", delta });
  };

  try {
    if (
      providerCfg.provider === "opencode" &&
      isOpenCodeLocalServerUrl(providerCfg.baseUrl)
    ) {
      await callOpenCodeLocalServer(
        providerCfg,
        params.systemPrompt,
        params.userPrompt,
        params.fetchFn,
        params.signal,
        onLlmReasoningDelta,
        onLlmTextDelta,
      );
    } else if (providerCfg.provider === "anthropic") {
      await callAnthropicStream(
        providerCfg,
        params.systemPrompt,
        params.history,
        params.userPrompt,
        params.fetchFn,
        params.signal,
        onLlmReasoningDelta,
        onLlmTextDelta,
      );
    } else {
      await callOpenAiCompatibleStream(
        providerCfg,
        params.threadId,
        params.systemPrompt,
        params.history,
        params.userPrompt,
        params.attachments,
        params.fetchFn,
        params.signal,
        onLlmReasoningDelta,
        onLlmTextDelta,
      );
    }

    if (llmReasoningBlock) {
      const finishedBlock: ChatReasoningBlock = llmReasoningBlock;
      finishedBlock.durationMs = Math.max(1, Date.now() - llmReasoningStarted);
      finishedBlock.status = "done";
      emit({ type: "reasoning_done", block: { ...finishedBlock } });
    }
  } catch (err) {
    const safeErr = redactSecrets(
      err instanceof Error ? err.message : "Provider request failed.",
    );
    providerNote = `Live provider (${providerCfg.provider} · ${providerCfg.model}) could not be reached (${safeErr}). Showing built-in CTO inspection summary.`;
    if (llmReasoningBlock) {
      const finishedBlock: ChatReasoningBlock = llmReasoningBlock;
      finishedBlock.durationMs = Math.max(1, Date.now() - llmReasoningStarted);
      finishedBlock.status = "done";
      emit({ type: "reasoning_done", block: { ...finishedBlock } });
    }
  }

  return { assistantText, providerNote };
}

/**
 * Executes a full agentic CTO turn:
 * 1. Runs grounded, read-only VPS inspection tools & attachment analysis
 * 2. Generates a risk-classified, approval-gated ExecutionPlan when needed
 * 3. Streams reasoning traces and Markdown response from OpenCode / configured LLM (or built-in CTO fallback)
 */
export async function runAgentChatTurn(
  deps: ChatEngineDeps,
  input: RunAgentTurnInput,
): Promise<RunAgentTurnResult> {
  const emit = input.onEvent ?? (() => {});
  const fetchFn = deps.fetchFn ?? fetch;
  const sanitizedGoal = redactSecrets(input.userText.trim());
  const onboarding = deps.registry.getOnboardingState();
  const providerCfg = deps.disableExternalLlm
    ? null
    : resolveProviderConfig(deps, input.overrideProvider, input.overrideModel);

  const providerLabel = providerCfg?.provider ?? "vps-os-cto";
  const modelLabel = providerCfg?.model ?? "deterministic-planner";

  const reasoningBlocks: ChatReasoningBlock[] = [];
  const toolCalls: ChatToolCall[] = [];
  let createdPlan: StoredPlan | null = null;

  // 1. Start initial planning/inspection reasoning trace
  const initialReasoningId = crypto.randomUUID();
  const initialReasoningStarted = Date.now();
  const initialReasoning: ChatReasoningBlock = {
    id: initialReasoningId,
    title: "Analyzing request & server state",
    content: "",
    durationMs: 0,
    status: "streaming",
  };
  reasoningBlocks.push(initialReasoning);
  emit({ type: "reasoning_start", block: { ...initialReasoning } });

  const appendInitialThought = (line: string) => {
    const delta = (initialReasoning.content ? "\n" : "") + redactSecrets(line);
    initialReasoning.content += delta;
    emit({ type: "reasoning_delta", blockId: initialReasoningId, delta });
  };

  const effort: ReasoningEffort = input.effort ?? "medium";
  const mentionedSlugs = (input.mentionedSlugs ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const riskLevel = classifyGoalRisk(sanitizedGoal);
  const isQuestionAnswerReply = /^[-*]\s+\*\*[^*]+\*\*/m.test(sanitizedGoal);
  const isHostSafetyGoal =
    !isQuestionAnswerReply &&
    /\b(firewall|ufw|ssh|sudo|root|wipe|erase|format)\b/i.test(sanitizedGoal);
  const hasLifecycleIntent =
    !isQuestionAnswerReply &&
    /^\s*(start|stop|restart)\s+(?:the\s+)?(?:app\s+|container\s+|workload\s+)?[a-z0-9][a-z0-9-]{1,47}/i.test(
      sanitizedGoal,
    );
  const hasDeployIntent =
    !isQuestionAnswerReply && extractDeploySpecFromGoal(sanitizedGoal) !== null;
  const mayMutateWorkloads =
    !isQuestionAnswerReply &&
    (hasDeployIntent ||
      hasLifecycleIntent ||
      /\b(remove|delete|uninstall|teardown|tear\s+down|destroy|route|attach|bind|map|point|deploy|install|create|provision|launch|restart|stop|start)\b/i.test(
        sanitizedGoal,
      ));

  appendInitialThought(
    `Classified request risk as **${riskLevel}** in \`${input.mode}\` mode (effort: \`${effort}\`)${
      mentionedSlugs.length > 0
        ? ` referencing ${mentionedSlugs.map((s) => `@${s}`).join(", ")}`
        : ""
    }${
      input.attachments.length > 0
        ? ` with ${input.attachments.length} attached file(s)`
        : ""
    }.`,
  );

  // Helper to run and emit a traced tool call
  async function runTool<T>(
    toolName: string,
    label: string,
    toolInput: Record<string, unknown>,
    fn: () => Promise<T> | T,
    overrideStatus?: ChatToolCall["status"],
  ): Promise<T | null> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const call: ChatToolCall = {
      id: crypto.randomUUID(),
      toolName,
      label,
      status: "running",
      input: toolInput,
      output: undefined,
      error: null,
      durationMs: null,
      startedAt,
      completedAt: null,
    };
    toolCalls.push(call);
    emit({ type: "tool_start", toolCall: { ...call } });

    try {
      const output = await fn();
      call.status = overrideStatus ?? "success";
      call.output = output;
      call.durationMs = Math.max(1, Date.now() - startMs);
      call.completedAt = new Date().toISOString();
      emit({ type: "tool_done", toolCall: { ...call } });
      return output;
    } catch (err) {
      call.status = "error";
      call.error = redactSecrets(err instanceof Error ? err.message : "Tool failed.");
      call.durationMs = Math.max(1, Date.now() - startMs);
      call.completedAt = new Date().toISOString();
      emit({ type: "tool_done", toolCall: { ...call } });
      return null;
    }
  }

  const dashboardUrl = onboarding.domain
    ? `https://${onboarding.domain}`
    : onboarding.publicIp
      ? `http://${onboarding.publicIp}`
      : null;

  const collectTelemetry = () => {
    const metricsSnapshot = deps.getMetrics();
    const diskSnapshot = deps.getDisk();
    return {
      hostname: metricsSnapshot.hostname,
      publicIp: onboarding.publicIp,
      dashboardDomain: onboarding.domain,
      dashboardUrl,
      cpuCount: metricsSnapshot.cpuCount,
      loadAverage1m: metricsSnapshot.loadAverage1m,
      memoryUsedMb: metricsSnapshot.memoryUsedMb,
      memoryTotalMb: metricsSnapshot.memoryTotalMb,
      memoryUsagePercent: metricsSnapshot.memoryUsagePercent,
      uptimeSeconds: metricsSnapshot.uptimeSeconds,
      ...(diskSnapshot ? { disk: diskSnapshot } : {}),
    };
  };

  const collectAppsSummary = async () => {
    const synced = await syncAppStatuses(deps.registry, deps.syncStatuses);
    return {
      count: synced.length,
      apps: synced.map((app) => ({
        slug: app.slug,
        name: app.name,
        kind: app.kind,
        status: app.status,
        domain: app.domain,
        url: app.domain ? `https://${app.domain}` : null,
        internalPort: app.internalPort,
        folderPath: app.folderPath,
        cpuLimit: app.cpuLimit,
        memoryLimitMb: app.memoryLimitMb,
      })),
    };
  };

  const shouldTraceMetrics =
    input.mode === "plan" ||
    hasDeployIntent ||
    isHostSafetyGoal ||
    mentionedSlugs.includes("host-metrics") ||
    /\b(cpu|ram|memory|disk|load|uptime|metric|health|status|server|host|vps|link|url|domain|ip|port|headroom)\b/i.test(
      sanitizedGoal,
    );
  const shouldTraceApps =
    input.mode === "plan" ||
    mayMutateWorkloads ||
    isHostSafetyGoal ||
    mentionedSlugs.length > 0 ||
    /\b(app|apps|container|workload|link|url|domain|ip|port|error|log|crash|broken|status|health|list)\b/i.test(
      sanitizedGoal,
    );

  // Tool 1: Inspect live host metrics (traced only when relevant, silent context otherwise)
  const telemetry = shouldTraceMetrics
    ? await runTool(
        "inspect_system_metrics",
        "Inspect live host CPU, RAM & disk",
        {},
        collectTelemetry,
      )
    : collectTelemetry();
  const metrics = deps.getMetrics();
  const disk = deps.getDisk();

  // Tool 2: Inspect registered apps (traced only when relevant, silent context otherwise)
  let appsResult = shouldTraceApps
    ? await runTool(
        "inspect_apps",
        "Inspect isolated workloads & statuses",
        {},
        collectAppsSummary,
      )
    : await collectAppsSummary();
  let apps = deps.registry.listApps();

  // Surface @mentions that resolve neither to a registered app slug nor a
  // built-in system token so users immediately spot typos without failing the turn.
  const registeredSlugs = new Set(apps.map((app) => app.slug.toLowerCase()));
  const unresolvedMentions = mentionedSlugs.filter(
    (slug) =>
      !BUILT_IN_SYSTEM_MENTION_TOKENS.has(slug) && !registeredSlugs.has(slug),
  );
  if (unresolvedMentions.length > 0) {
    appendInitialThought(
      `Unrecognized @mentions ignored: ${unresolvedMentions
        .map((s) => `@${s}`)
        .join(", ")}.`,
    );
  }

  // Tool 3: Inspect attached files if any
  if (input.attachments.length > 0) {
    await runTool(
      "inspect_attachments",
      `Read ${input.attachments.length} attached file${input.attachments.length === 1 ? "" : "s"}`,
      { files: input.attachments.map((a) => a.name) },
      () => ({
        attachments: input.attachments.map((att) => ({
          id: att.id,
          name: att.name,
          kind: att.kind,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          previewLines: att.textPreview ? att.textPreview.split(/\r?\n/).length : 0,
        })),
      }),
    );
    appendInitialThought(
      `Inspected attached files: ${input.attachments.map((a) => a.name).join(", ")}.`,
    );
  }

  // Tool 4: Inspect app logs if user asks for logs/errors or @mentions a registered app
  let inspectedLogs: { slug: string; lines: string[] } | null = null;
  if (deps.getLogs) {
    const mentionedApp = apps.find((app) =>
      mentionedSlugs.includes(app.slug.toLowerCase()),
    );
    const goalMatchedApp = /\b(log|logs|error|crash|fail|debug|troubleshoot|diagnos)\b/i.test(
      sanitizedGoal,
    )
      ? apps.find((app) =>
          sanitizedGoal.toLowerCase().includes(app.slug.toLowerCase()),
        )
      : undefined;
    const matchedApp = mentionedApp ?? goalMatchedApp;
    if (matchedApp) {
      inspectedLogs = await runTool(
        "read_app_logs",
        `Tail redacted logs for ${matchedApp.slug}`,
        { slug: matchedApp.slug, tail: 40 },
        async () => {
          const rawLines = await deps.getLogs!(matchedApp.slug, 40);
          return {
            slug: matchedApp.slug,
            lines: rawLines.slice(-40).map((line) => redactSecrets(line)),
          };
        },
      );
    }
  }

  // Tool 5: Check recent audit events when asking about history/changes/security or @audit-trail
  let auditSnapshot: unknown = null;
  if (
    mentionedSlugs.includes("audit-trail") ||
    /\b(audit|history|recent|changed|security|backup|status|health)\b/i.test(sanitizedGoal)
  ) {
    auditSnapshot = await runTool(
      "list_audit_events",
      "Check recent redacted audit trail",
      { limit: 8 },
      () => ({
        events: deps.registry.listAuditEvents(8).map((evt) => ({
          action: evt.action,
          actor: evt.actor,
          targetSlug: evt.targetSlug,
          summary: evt.summary,
          riskLevel: evt.riskLevel,
          createdAt: evt.createdAt,
        })),
      }),
    );
  }

  // Tool 6: Propose approval-gated ExecutionPlan when requested or unambiguously actionable
  let yoloExecutionSummary: string | null = null;
  let yoloExecutionError: string | null = null;

  const knownAppSlugs = apps.map((app) => app.slug);
  const removeSlugs = isQuestionAnswerReply
    ? []
    : extractRemoveSlugsFromGoal(sanitizedGoal, knownAppSlugs);
  const routeSpec = isQuestionAnswerReply
    ? null
    : extractRouteSpecFromGoal(sanitizedGoal, knownAppSlugs);
  const isConversationalQuestion =
    isQuestionAnswerReply ||
    /^(what|whats|what's|how|why|when|where|which|who|can|could|would|should|do|does|is|are|explain|tell)\b/i.test(
      sanitizedGoal,
    ) ||
    sanitizedGoal.endsWith("?");

  const pendingThreadPlans: StoredPlan[] = [];
  const seenPlanIds = new Set<string>();
  for (const msg of input.history) {
    if (!msg.planId || seenPlanIds.has(msg.planId)) continue;
    seenPlanIds.add(msg.planId);
    const existingPlan = deps.registry.getPlan(msg.planId);
    if (
      existingPlan &&
      (existingPlan.status === "pending" || existingPlan.status === "approved")
    ) {
      pendingThreadPlans.push(existingPlan);
    }
  }

  const autoExecuteYoloPlan = async (targetPlan: StoredPlan): Promise<StoredPlan> => {
    let activePlan = targetPlan;
    const canYoloAutoExecute =
      onboarding.persona.approvalMode === "yolo" &&
      input.mode === "agent" &&
      Boolean(deps.executePlan) &&
      !activePlan.steps.some((step) => step.toolName === "manual_review");

    if (!canYoloAutoExecute || !deps.executePlan) {
      appendInitialThought(
        `Generated ${activePlan.steps.length}-step plan (${activePlan.status}) with approval gate ${
          activePlan.requiresUserApproval ? "enabled" : "auto-approved (read-only)"
        }.`,
      );
      return activePlan;
    }

    if (activePlan.status === "pending") {
      activePlan = deps.registry.recordApproval({
        planId: activePlan.id,
        approved: true,
        decidedBy: "yolo-mode",
      });
    }
    const proposeTool = [...toolCalls]
      .reverse()
      .find((tc) => tc.toolName === "propose_plan");
    if (proposeTool && proposeTool.status === "awaiting_approval") {
      proposeTool.status = "success";
      emit({ type: "tool_done", toolCall: { ...proposeTool } });
    }
    appendInitialThought(
      `YOLO Sandbox mode active: auto-approved ${activePlan.steps.length}-step plan and executing immediately.`,
    );

    const leaseOwnerId = `yolo:${crypto.randomUUID()}`;
    if (deps.registry.claimPlanExecution(activePlan.id, leaseOwnerId)) {
      const execRes = await runTool(
        "execute_plan",
        "Auto-execute plan (YOLO Sandbox mode)",
        { planId: activePlan.id, steps: activePlan.steps.map((s) => s.title) },
        async () => {
          try {
            const outcome = await deps.executePlan!(activePlan, { leaseOwnerId });
            deps.registry.markPlanExecuted(activePlan.id, leaseOwnerId);
            const safeSummary = redactSecrets(outcome.summary);
            deps.registry.recordAudit({
              id: crypto.randomUUID(),
              actor: "agent",
              action: "chat.plan_executed",
              targetSlug: null,
              summary: redactSecrets(
                `YOLO executed plan ${activePlan.id}: ${safeSummary}`,
              ),
              riskLevel: "medium",
              createdAt: new Date().toISOString(),
            });
            activePlan = deps.registry.getPlan(activePlan.id) ?? activePlan;
            yoloExecutionSummary = safeSummary;
            return { summary: safeSummary };
          } catch (err) {
            deps.registry.releasePlanExecution(activePlan.id, leaseOwnerId);
            const errMsg = redactSecrets(
              err instanceof Error ? err.message : "YOLO execution failed.",
            );
            yoloExecutionError = errMsg;
            throw new Error(errMsg);
          }
        },
      );
      if (execRes) {
        appendInitialThought(`YOLO execution succeeded: ${execRes.summary}`);
        appsResult = await runTool(
          "inspect_apps",
          "Refresh workload statuses after execution",
          {},
          collectAppsSummary,
        ) ?? (await collectAppsSummary());
        apps = deps.registry.listApps();
      }
    }
    return activePlan;
  };

  const shouldProposePlan =
    input.mode !== "ask" &&
    (input.mode === "plan" ||
      hasDeployIntent ||
      hasLifecycleIntent ||
      removeSlugs.length > 0 ||
      routeSpec !== null ||
      (isHostSafetyGoal && !isConversationalQuestion) ||
      (riskLevel === "high" &&
        /\b(firewall|ufw|ssh|sudo|root|wipe|erase|format)\b/i.test(sanitizedGoal)));

  const isConfirmationFollowUp =
    !shouldProposePlan &&
    !isQuestionAnswerReply &&
    /^\s*(?:can you do it|do it|go ahead|yes(?:,?\s*(?:please|do it|go ahead))?|please do|run it|execute it|approve(?:\s+and\s+execute)?)\s*[.!?]?\s*$/i.test(
      sanitizedGoal,
    );

  if (shouldProposePlan) {
    const planOutcome = await runTool(
      "propose_plan",
      "Build risk-classified execution plan",
      { goal: sanitizedGoal, mode: input.mode },
      () => {
        const stored = deps.registry.savePlan(
          createExecutionPlan(sanitizedGoal, knownAppSlugs),
        );
        deps.registry.recordAudit({
          id: crypto.randomUUID(),
          actor: "user",
          action: "chat.plan_requested",
          targetSlug: null,
          summary: `Planned goal: ${sanitizedGoal.slice(0, 120)}`,
          riskLevel: stored.requiresUserApproval ? "medium" : "low",
          createdAt: new Date().toISOString(),
        });
        return stored;
      },
      "awaiting_approval",
    );
    if (planOutcome) {
      createdPlan = planOutcome;
      if (!createdPlan.requiresUserApproval) {
        const lastTool = toolCalls.at(-1);
        if (lastTool) {
          lastTool.status = "success";
          emit({ type: "tool_done", toolCall: { ...lastTool } });
        }
      }
      createdPlan = await autoExecuteYoloPlan(createdPlan);
      emit({ type: "plan_created", plan: createdPlan });
    }
  } else if (
    isConfirmationFollowUp &&
    onboarding.persona.approvalMode === "yolo" &&
    input.mode === "agent" &&
    deps.executePlan
  ) {
    const latestSafePending = [...pendingThreadPlans]
      .reverse()
      .find((p) => !p.steps.some((step) => step.toolName === "manual_review"));
    if (latestSafePending) {
      createdPlan = await autoExecuteYoloPlan(latestSafePending);
      emit({ type: "plan_created", plan: createdPlan });
    }
  }

  initialReasoning.durationMs = Math.max(1, Date.now() - initialReasoningStarted);
  initialReasoning.status = "done";
  emit({ type: "reasoning_done", block: { ...initialReasoning } });

  // 2. Compose final response via OpenCode / configured LLM or built-in CTO fallback
  let assistantText = "";
  let providerNote: string | null = null;
  let postStreamYoloAppended = false;

  if (providerCfg) {
    const contextPayload = JSON.stringify(
      {
        telemetry,
        workloads: appsResult,
        ...(inspectedLogs ? { logs: inspectedLogs } : {}),
        ...(auditSnapshot ? { recentAudit: auditSnapshot } : {}),
        runtimeCapabilities: {
          executableTools: [
            "prepare_app_workspace",
            "control_app_lifecycle",
            "remove_workload",
            "route_caddy",
            "inspect_apps",
          ],
          defaultWorkloadTemplate: "web-app (HTTP/static/API/full-stack service on port 8080)",
          ingressModel:
            "Apps run on private container port 8080 inside app_net. Public access uses Caddy TLS on ports 80/443 via route_caddy (including <slug>.<ip-with-dashes>.sslip.io when publicIp is known and no custom domain exists). Direct host port publishing (-p 8080:8080) and host UFW/SSH commands are NOT supported.",
        },
        pendingThreadPlans: pendingThreadPlans.slice(-3).map((p) => ({
          id: p.id,
          status: p.status,
          goal: p.goal,
          summary: p.summary,
          executable: !p.steps.some((s) => s.toolName === "manual_review"),
        })),
        proposedPlan: createdPlan
          ? {
              id: createdPlan.id,
              status: createdPlan.status,
              requiresUserApproval: createdPlan.requiresUserApproval,
              summary: createdPlan.summary,
              ...(yoloExecutionSummary
                ? { autoExecutedSummary: yoloExecutionSummary }
                : {}),
              ...(yoloExecutionError
                ? { autoExecutionError: yoloExecutionError }
                : {}),
              steps: createdPlan.steps.map((s) => ({
                title: s.title,
                toolName: s.toolName,
                riskLevel: s.riskLevel,
              })),
            }
          : null,
      },
      null,
      2,
    );

    const systemPrompt = buildSystemPrompt(
      onboarding.persona,
      input.mode,
      effort,
      contextPayload,
    );
    const userPrompt = buildUserContentWithAttachments(
      sanitizedGoal,
      input.attachments,
    );

    const streamed = await streamLlmWithReasoning({
      providerCfg,
      threadId: input.threadId,
      systemPrompt,
      history: input.history,
      userPrompt,
      attachments: input.attachments,
      fetchFn,
      signal: input.signal,
      reasoningBlocks,
      emit,
    });
    assistantText = streamed.assistantText;
    providerNote = streamed.providerNote;

    // Parse optional LLM-emitted ```vps-plan``` block when no pre-turn plan was attached
    const extracted = parseAndStripVpsPlanBlock(assistantText, sanitizedGoal);
    assistantText = extracted.cleanText;

    if (!createdPlan && extracted.plan && input.mode !== "ask") {
      const llmPlan = extracted.plan;
      const storedPlan = await runTool(
        "propose_plan",
        "Build risk-classified execution plan",
        { goal: llmPlan.goal, mode: input.mode, source: "llm" },
        () => {
          const saved = deps.registry.savePlan(llmPlan);
          deps.registry.recordAudit({
            id: crypto.randomUUID(),
            actor: "agent",
            action: "chat.plan_requested",
            targetSlug: null,
            summary: redactSecrets(`LLM planned goal: ${llmPlan.goal.slice(0, 120)}`),
            riskLevel: saved.requiresUserApproval ? "medium" : "low",
            createdAt: new Date().toISOString(),
          });
          return saved;
        },
        "awaiting_approval",
      );
      if (storedPlan) {
        createdPlan = storedPlan;
        if (!createdPlan.requiresUserApproval) {
          const lastTool = toolCalls.at(-1);
          if (lastTool) {
            lastTool.status = "success";
            emit({ type: "tool_done", toolCall: { ...lastTool } });
          }
        }
        createdPlan = await autoExecuteYoloPlan(createdPlan);
        emit({ type: "plan_created", plan: createdPlan });
        if (createdPlan.status === "executed" && yoloExecutionSummary) {
          const stepDetails = formatPlanExecutionMarkdown(
            createdPlan,
            yoloExecutionSummary,
            deps.registry,
          );
          const addition = `\n\n${stepDetails}`;
          assistantText += addition;
          postStreamYoloAppended = true;
          emit({ type: "text_delta", delta: addition });
        }
      }
    }
  } else {
    providerNote =
      "Running with the built-in VPS OS CTO planner. Connect **OpenCode** or another AI provider in Setup Wizard for full multi-turn LLM reasoning.";
  }

  if (!assistantText.trim()) {
    assistantText = buildFallbackResponse({
      userText: sanitizedGoal,
      mode: input.mode,
      metrics,
      disk,
      apps,
      attachments: input.attachments,
      plan: createdPlan,
      yoloExecutionSummary,
      registry: deps.registry,
      providerNote,
    });
    emit({ type: "text_delta", delta: assistantText });
  } else if (
    !postStreamYoloAppended &&
    createdPlan?.status === "executed" &&
    yoloExecutionSummary &&
    !assistantText.includes("Workloads")
  ) {
    // Ensure YOLO turns always include concrete workload details if the LLM omitted them.
    const stepDetails = formatPlanExecutionMarkdown(
      createdPlan,
      yoloExecutionSummary,
      deps.registry,
    );
    const addition = `\n\n${stepDetails}`;
    assistantText += addition;
    emit({ type: "text_delta", delta: addition });
  }

  const publicAttachments: ChatAttachment[] = [];
  const assistantMessage: ChatMessage = {
    id: crypto.randomUUID(),
    threadId: input.threadId,
    role: "assistant",
    content: redactSecrets(assistantText),
    attachments: publicAttachments,
    reasoning: reasoningBlocks,
    toolCalls,
    planId: createdPlan?.id ?? null,
    provider: providerLabel,
    model: modelLabel,
    status: "completed",
    createdAt: new Date().toISOString(),
  };

  return {
    assistantMessage,
    plan: createdPlan,
    providerLabel,
    modelLabel,
  };
}

export interface RunPlanExecutionTurnInput {
  threadId: string;
  plan: StoredPlan;
  leaseOwnerId: string;
  executePlan: (
    plan: StoredPlan,
    options: { leaseOwnerId: string },
  ) => Promise<{ summary: string }> | { summary: string };
  messageId?: string | undefined;
  overrideProvider?: LlmProvider | undefined;
  overrideModel?: string | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: (event: ChatStreamEvent) => void;
}

export interface RunPlanExecutionTurnResult {
  ok: boolean;
  plan: StoredPlan;
  summary: string;
  errorMessage?: string;
  assistantMessage: ChatMessage;
  providerLabel: string;
  modelLabel: string;
}

/**
 * Executes an approved ExecutionPlan as a full traced CTO chat turn with live
 * reasoning, `execute_plan` + `inspect_apps` tool calls, and a streamed LLM
 * confirmation (or deterministic fallback report).
 */
export async function runPlanExecutionChatTurn(
  deps: ChatEngineDeps,
  input: RunPlanExecutionTurnInput,
): Promise<RunPlanExecutionTurnResult> {
  const emit = input.onEvent ?? (() => {});
  const fetchFn = deps.fetchFn ?? fetch;
  const onboarding = deps.registry.getOnboardingState();
  const providerCfg = deps.disableExternalLlm
    ? null
    : resolveProviderConfig(deps, input.overrideProvider, input.overrideModel);
  const providerLabel = providerCfg?.provider ?? "vps-os-cto";
  const modelLabel = providerCfg?.model ?? "deterministic-planner";

  const reasoningBlocks: ChatReasoningBlock[] = [];
  const toolCalls: ChatToolCall[] = [];

  const execReasoningId = crypto.randomUUID();
  const execReasoningStarted = Date.now();
  const execReasoning: ChatReasoningBlock = {
    id: execReasoningId,
    title: "Executing approved plan",
    content: `Running ${input.plan.steps.length}-step approved plan for "${redactSecrets(input.plan.goal)}".`,
    durationMs: 0,
    status: "streaming",
  };
  reasoningBlocks.push(execReasoning);
  emit({ type: "reasoning_start", block: { ...execReasoning } });

  const appendThought = (line: string) => {
    const delta = `\n${redactSecrets(line)}`;
    execReasoning.content += delta;
    emit({ type: "reasoning_delta", blockId: execReasoningId, delta });
  };

  let executionSummary = "";
  let executionError: string | null = null;
  let finalPlan = input.plan;

  const execTool: ChatToolCall = {
    id: crypto.randomUUID(),
    toolName: "execute_plan",
    label: `Execute ${input.plan.steps.length}-step approved plan`,
    status: "running",
    input: {
      planId: input.plan.id,
      steps: input.plan.steps.map((s) => s.title),
    },
    output: undefined,
    error: null,
    durationMs: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  toolCalls.push(execTool);
  emit({ type: "tool_start", toolCall: { ...execTool } });

  const execStartMs = Date.now();
  try {
    const outcome = await input.executePlan(input.plan, {
      leaseOwnerId: input.leaseOwnerId,
    });
    const transitioned = deps.registry.markPlanExecuted(
      input.plan.id,
      input.leaseOwnerId,
    );
    if (!transitioned) {
      throw new Error(`Plan "${input.plan.id}" was already executed or modified.`);
    }
    executionSummary = redactSecrets(outcome.summary);
    execTool.status = "success";
    execTool.output = { summary: executionSummary };
    execTool.durationMs = Math.max(1, Date.now() - execStartMs);
    execTool.completedAt = new Date().toISOString();
    emit({ type: "tool_done", toolCall: { ...execTool } });
    appendThought(`Execution succeeded: ${executionSummary}`);

    finalPlan = deps.registry.getPlan(input.plan.id) ?? {
      ...input.plan,
      status: "executed",
    };
    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "chat.plan_executed",
      targetSlug: null,
      summary: redactSecrets(`Executed plan ${input.plan.id}: ${executionSummary}`),
      riskLevel: input.plan.requiresUserApproval ? "medium" : "low",
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    deps.registry.releasePlanExecution(input.plan.id, input.leaseOwnerId);
    executionError = redactSecrets(
      err instanceof Error ? err.message : `Could not execute plan "${input.plan.id}".`,
    );
    execTool.status = "error";
    execTool.error = executionError;
    execTool.durationMs = Math.max(1, Date.now() - execStartMs);
    execTool.completedAt = new Date().toISOString();
    emit({ type: "tool_done", toolCall: { ...execTool } });
    appendThought(`Execution failed: ${executionError}`);
  }

  // Verify live workloads after execution
  const inspectTool: ChatToolCall = {
    id: crypto.randomUUID(),
    toolName: "inspect_apps",
    label: "Verify live workloads & endpoints",
    status: "running",
    input: {},
    output: undefined,
    error: null,
    durationMs: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  toolCalls.push(inspectTool);
  emit({ type: "tool_start", toolCall: { ...inspectTool } });

  const inspectStartMs = Date.now();
  let appsSnapshot: Array<Record<string, unknown>> = [];
  try {
    const synced = await syncAppStatuses(deps.registry, deps.syncStatuses);
    appsSnapshot = synced.map((app) => ({
      slug: app.slug,
      name: app.name,
      kind: app.kind,
      status: app.status,
      domain: app.domain,
      url: app.domain ? `https://${app.domain}` : null,
      internalPort: app.internalPort,
      folderPath: app.folderPath,
    }));
    inspectTool.status = "success";
    inspectTool.output = { count: appsSnapshot.length, apps: appsSnapshot };
  } catch (err) {
    inspectTool.status = "error";
    inspectTool.error = redactSecrets(
      err instanceof Error ? err.message : "Failed to inspect workloads.",
    );
  }
  inspectTool.durationMs = Math.max(1, Date.now() - inspectStartMs);
  inspectTool.completedAt = new Date().toISOString();
  emit({ type: "tool_done", toolCall: { ...inspectTool } });

  execReasoning.durationMs = Math.max(1, Date.now() - execReasoningStarted);
  execReasoning.status = "done";
  emit({ type: "reasoning_done", block: { ...execReasoning } });

  const dashboardUrl = onboarding.domain
    ? `https://${onboarding.domain}`
    : onboarding.publicIp
      ? `http://${onboarding.publicIp}`
      : null;

  let assistantText = "";
  if (providerCfg) {
    const history = deps.registry.listChatMessages(input.threadId);
    const contextPayload = JSON.stringify(
      {
        telemetry: {
          hostname: deps.getMetrics().hostname,
          publicIp: onboarding.publicIp,
          dashboardDomain: onboarding.domain,
          dashboardUrl,
        },
        executedPlan: {
          id: finalPlan.id,
          goal: finalPlan.goal,
          status: executionError ? "error" : finalPlan.status,
          summary: executionError ? executionError : executionSummary,
          steps: finalPlan.steps.map((s) => ({
            title: s.title,
            description: s.description,
            toolName: s.toolName,
          })),
        },
        workloads: appsSnapshot,
      },
      null,
      2,
    );

    const systemPrompt = buildSystemPrompt(
      onboarding.persona,
      "agent",
      "medium",
      contextPayload,
    );
    const prompt = executionError
      ? `The approved plan "${finalPlan.goal}" failed to execute with error: ${executionError}. Explain clearly what failed and the safest next step.`
      : `The approved plan "${finalPlan.goal}" just finished executing (${executionSummary}). Summarize concisely what was done, the live workload status, folder, port, and exact URL/domain (or explain clearly if internal-network-only).`;

    const streamed = await streamLlmWithReasoning({
      providerCfg,
      threadId: input.threadId,
      systemPrompt,
      history,
      userPrompt: prompt,
      attachments: [],
      fetchFn,
      signal: input.signal,
      reasoningBlocks,
      emit,
    });
    assistantText = streamed.assistantText;
  }

  if (!assistantText.trim()) {
    assistantText = executionError
      ? `### Plan Execution Failed\n\n${executionError}`
      : formatPlanExecutionMarkdown(finalPlan, executionSummary, deps.registry);
    emit({ type: "text_delta", delta: assistantText });
  }

  const assistantMessage: ChatMessage = {
    id: input.messageId ?? crypto.randomUUID(),
    threadId: input.threadId,
    role: "assistant",
    content: redactSecrets(assistantText),
    attachments: [],
    reasoning: reasoningBlocks,
    toolCalls,
    planId: null,
    provider: providerLabel,
    model: modelLabel,
    status: executionError ? "error" : "completed",
    createdAt: new Date().toISOString(),
  };

  return {
    ok: !executionError,
    plan: finalPlan,
    summary: executionError ? executionError : executionSummary,
    ...(executionError ? { errorMessage: executionError } : {}),
    assistantMessage,
    providerLabel,
    modelLabel,
  };
}
