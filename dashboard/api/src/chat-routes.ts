import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import {
  type ChatAttachment,
  type ChatMessage,
  ChatModeSchema,
  LlmProviderSchema,
  ReasoningEffortSchema,
  type StoredPlan,
  type SystemMetrics,
  type SystemRegistryStore,
  classifyAttachmentKind,
  redactSecrets,
  sanitizeAttachmentName,
} from "@vps-os/shared";
import {
  type ChatEngineDeps,
  type ChatStreamEvent,
  runAgentChatTurn,
} from "./chat-engine.js";
import { handleBodyReadError, readJsonBody } from "./http-utils.js";
import type { DiskMetrics } from "./metrics.js";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MiB per file
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_JSON_UPLOAD_BYTES = 7 * 1024 * 1024; // ~5 MiB base64 + JSON envelope

export interface ChatRouteDeps {
  registry: SystemRegistryStore;
  maxBodyBytes: number;
  dataDir?: string | undefined;
  onboardingEnvPath?: string | undefined;
  getMetrics: () => SystemMetrics;
  getDisk: () => DiskMetrics | null;
  syncStatuses?: ChatEngineDeps["syncStatuses"];
  getLogs?: ChatEngineDeps["getLogs"];
  executePlan?: ChatEngineDeps["executePlan"];
  fetchFn?: typeof fetch | undefined;
  disableExternalLlm?: boolean | undefined;
}

const CreateThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  provider: LlmProviderSchema.nullable().optional(),
  model: z.string().trim().min(1).max(120).nullable().optional(),
});

const UpdateThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  provider: LlmProviderSchema.nullable().optional(),
  model: z.string().trim().min(1).max(120).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const ForkThreadRequestSchema = z.object({
  upToMessageId: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(160).optional(),
});

const SendMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  mode: ChatModeSchema.optional().default("agent"),
  effort: ReasoningEffortSchema.optional().default("medium"),
  mentionedSlugs: z
    .array(z.string().trim().min(1).max(64))
    .max(10)
    .optional()
    .default([]),
  truncateFromMessageId: z.string().trim().min(1).max(128).optional(),
  attachmentIds: z
    .array(z.string().trim().min(1).max(128))
    .max(MAX_ATTACHMENTS_PER_MESSAGE)
    .optional()
    .default([]),
  provider: LlmProviderSchema.optional(),
  model: z.string().trim().min(1).max(120).optional(),
  stream: z.boolean().optional(),
});

const JsonAttachmentUploadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120).optional().default("application/octet-stream"),
  dataBase64: z.string().min(1),
  threadId: z.string().trim().min(1).max(128).optional(),
});

function toPublicAttachment(record: ChatAttachment): ChatAttachment {
  return {
    id: record.id,
    threadId: record.threadId,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    kind: record.kind,
    textPreview: record.textPreview,
    url: record.url,
    createdAt: record.createdAt,
  };
}

function deriveThreadTitle(userText: string): string {
  const cleaned = redactSecrets(userText).replace(/\s+/g, " ").trim();
  if (cleaned.length <= 56) return cleaned || "New Conversation";
  return `${cleaned.slice(0, 53).trimEnd()}...`;
}

function formatSseFrame(event: ChatStreamEvent): Uint8Array {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new TextEncoder().encode(payload);
}

/**
 * Registers T3 Code-inspired Agentic Chat thread, streaming turn, and file upload routes
 * on the Dashboard Control API Hono application.
 */
export function registerChatRoutes(app: Hono, deps: ChatRouteDeps): void {
  const engineDeps: ChatEngineDeps = {
    registry: deps.registry,
    getMetrics: deps.getMetrics,
    getDisk: deps.getDisk,
    onboardingEnvPath: deps.onboardingEnvPath,
    syncStatuses: deps.syncStatuses,
    getLogs: deps.getLogs,
    executePlan: deps.executePlan,
    fetchFn: deps.fetchFn,
    disableExternalLlm: deps.disableExternalLlm,
  };

  function persistUploadedFile(input: {
    rawName: string;
    mimeType: string;
    bytes: Buffer;
    threadId?: string | undefined;
  }): ChatAttachment {
    const id = crypto.randomUUID();
    const safeName = sanitizeAttachmentName(input.rawName);
    const mimeType = (input.mimeType || "application/octet-stream")
      .split(";")[0]!
      .trim()
      .toLowerCase()
      .slice(0, 120);
    const kind = classifyAttachmentKind(mimeType, safeName);

    let textPreview: string | null = null;
    if (kind === "text") {
      const decoded = input.bytes.toString("utf8");
      if (!decoded.includes("\u0000")) {
        textPreview = redactSecrets(decoded).slice(0, 16_000);
      }
    }

    let storagePath: string | null = null;
    let dataBase64: string | null = null;

    if (deps.dataDir) {
      const uploadsDir = path.join(path.resolve(deps.dataDir), "chat-uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const target = path.join(uploadsDir, id);
      fs.writeFileSync(target, input.bytes, { mode: 0o600 });
      storagePath = target;
      // Keep small image base64 in memory/DB only when needed for multimodal LLM calls
      if (kind === "image" && input.bytes.length <= 1024 * 1024) {
        dataBase64 = input.bytes.toString("base64");
      }
    } else {
      dataBase64 = input.bytes.toString("base64");
    }

    const saved = deps.registry.saveChatAttachment({
      id,
      threadId: input.threadId ?? null,
      name: safeName,
      mimeType,
      sizeBytes: input.bytes.length,
      kind,
      textPreview,
      storagePath,
      dataBase64,
    });

    return toPublicAttachment(saved);
  }

  // --- Threads CRUD ---

  app.get("/api/chat/threads", (c) => {
    const threads = deps.registry.listChatThreads(50);
    return c.json({ threads });
  });

  app.post("/api/chat/threads", async (c) => {
    let body: unknown = {};
    try {
      body = (await readJsonBody(c, deps.maxBodyBytes, { allowEmpty: true })) ?? {};
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = CreateThreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const onboarding = deps.registry.getOnboardingState();
    const thread = deps.registry.createChatThread({
      id: crypto.randomUUID(),
      title: parsed.data.title ?? "New Conversation",
      provider:
        parsed.data.provider !== undefined
          ? parsed.data.provider
          : onboarding.llmProvider,
      model:
        parsed.data.model !== undefined
          ? parsed.data.model
          : onboarding.llmModel,
    });

    return c.json({ thread }, 201);
  });

  app.get("/api/chat/threads/:id", (c) => {
    const threadId = c.req.param("id").trim();
    const thread = deps.registry.getChatThread(threadId);
    if (!thread) {
      return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
    }
    const messages = deps.registry.listChatMessages(threadId);
    const plansById: Record<string, StoredPlan> = {};
    for (const msg of messages) {
      if (msg.planId && !plansById[msg.planId]) {
        const plan = deps.registry.getPlan(msg.planId);
        if (plan) {
          plansById[plan.id] = plan;
        }
      }
    }
    return c.json({ thread, messages, plansById });
  });

  app.patch("/api/chat/threads/:id", async (c) => {
    const threadId = c.req.param("id").trim();
    const existing = deps.registry.getChatThread(threadId);
    if (!existing) {
      return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
    }

    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = UpdateThreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const updated = deps.registry.updateChatThread(threadId, {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
      ...(parsed.data.archived !== undefined ? { archived: parsed.data.archived } : {}),
    });

    return c.json({ thread: updated });
  });

  app.post("/api/chat/threads/:id/fork", async (c) => {
    const threadId = c.req.param("id").trim();
    const existing = deps.registry.getChatThread(threadId);
    if (!existing) {
      return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
    }

    let body: unknown = {};
    try {
      body = (await readJsonBody(c, deps.maxBodyBytes, { allowEmpty: true })) ?? {};
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ForkThreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const forked = deps.registry.forkChatThread(threadId, crypto.randomUUID(), {
      upToMessageId: parsed.data.upToMessageId,
      title: parsed.data.title,
    });
    if (!forked) {
      return c.json(
        { error: "Could not fork thread from the specified message." },
        404,
      );
    }

    const plansById: Record<string, StoredPlan> = {};
    for (const msg of forked.messages) {
      if (msg.planId && !plansById[msg.planId]) {
        const plan = deps.registry.getPlan(msg.planId);
        if (plan) {
          plansById[plan.id] = plan;
        }
      }
    }

    return c.json(
      { thread: forked.thread, messages: forked.messages, plansById },
      201,
    );
  });

  app.post("/api/chat/threads/:id/clear", (c) => {
    const threadId = c.req.param("id").trim();
    const existing = deps.registry.getChatThread(threadId);
    if (!existing) {
      return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
    }
    const cleared = deps.registry.clearChatMessages(threadId);
    const updated = deps.registry.getChatThread(threadId);
    return c.json({ ok: true, cleared, thread: updated });
  });

  app.get("/api/chat/threads/:id/export", (c) => {
    const threadId = c.req.param("id").trim();
    const thread = deps.registry.getChatThread(threadId);
    if (!thread) {
      return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
    }
    const messages = deps.registry.listChatMessages(threadId, 500);
    const lines: string[] = [
      `# ${thread.title}`,
      "",
      `- Thread ID: \`${thread.id}\``,
      `- Provider: \`${thread.provider ?? "vps-os-cto"}\` · Model: \`${thread.model ?? "default"}\``,
      `- Exported: ${new Date().toISOString()}`,
      "",
      "---",
      "",
    ];
    for (const msg of messages) {
      const heading =
        msg.role === "user"
          ? `## Owner (${msg.createdAt})`
          : `## ${msg.provider ?? "CTO Agent"}${msg.model ? ` · ${msg.model}` : ""} (${msg.createdAt})`;
      lines.push(heading, "");
      if (msg.attachments.length > 0) {
        lines.push(
          `**Attachments:** ${msg.attachments.map((a) => `\`${a.name}\``).join(", ")}`,
          "",
        );
      }
      if (msg.toolCalls.length > 0) {
        lines.push(
          `**Tools executed:** ${msg.toolCalls.map((t) => `\`${t.toolName}\` (${t.status})`).join(", ")}`,
          "",
        );
      }
      lines.push(redactSecrets(msg.content), "", "---", "");
    }

    const safeSlug = thread.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "cto-thread";

    return new Response(lines.join("\n"), {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${safeSlug}.md"`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.delete("/api/chat/threads/:id", (c) => {
    const threadId = c.req.param("id").trim();
    const deleted = deps.registry.deleteChatThread(threadId);
    if (!deleted) {
      return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
    }
    return c.json({ ok: true, id: threadId });
  });

  // --- File Uploads / Attachments ---

  app.post("/api/chat/attachments", async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();

    if (contentType.includes("multipart/form-data")) {
      let formData: FormData;
      try {
        formData = await c.req.formData();
      } catch {
        return c.json({ error: "Invalid multipart form upload." }, 400);
      }

      const threadIdRaw = formData.get("threadId");
      const threadId =
        typeof threadIdRaw === "string" && threadIdRaw.trim()
          ? threadIdRaw.trim()
          : undefined;
      if (threadId && !deps.registry.getChatThread(threadId)) {
        return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
      }

      const fileEntries = formData
        .getAll("files")
        .concat(formData.getAll("file"))
        .filter((entry): entry is File => entry instanceof File);

      if (fileEntries.length === 0) {
        return c.json({ error: "No files were uploaded." }, 400);
      }
      if (fileEntries.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return c.json(
          { error: `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} files per upload.` },
          400,
        );
      }

      const uploaded: ChatAttachment[] = [];
      for (const file of fileEntries) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          return c.json(
            {
              error: `File "${sanitizeAttachmentName(file.name)}" exceeds the 5 MB limit.`,
            },
            413,
          );
        }
        const bytes = Buffer.from(await file.arrayBuffer());
        if (bytes.length > MAX_ATTACHMENT_BYTES) {
          return c.json(
            {
              error: `File "${sanitizeAttachmentName(file.name)}" exceeds the 5 MB limit.`,
            },
            413,
          );
        }
        uploaded.push(
          persistUploadedFile({
            rawName: file.name || "attachment",
            mimeType: file.type || "application/octet-stream",
            bytes,
            threadId,
          }),
        );
      }

      return c.json({ attachments: uploaded, attachment: uploaded[0] }, 201);
    }

    // JSON base64 upload fallback (also super clean for API clients & tests)
    let body: unknown;
    try {
      body = await readJsonBody(c, MAX_JSON_UPLOAD_BYTES);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = JsonAttachmentUploadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    if (parsed.data.threadId && !deps.registry.getChatThread(parsed.data.threadId)) {
      return c.json(
        { error: `Chat thread "${parsed.data.threadId}" not found.` },
        404,
      );
    }

    const cleanedB64 = parsed.data.dataBase64.replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(cleanedB64, "base64");
    if (bytes.length === 0) {
      return c.json({ error: "Uploaded file payload is empty." }, 400);
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: "Uploaded file exceeds the 5 MB limit." }, 413);
    }

    const attachment = persistUploadedFile({
      rawName: parsed.data.name,
      mimeType: parsed.data.mimeType,
      bytes,
      threadId: parsed.data.threadId,
    });

    return c.json({ attachment, attachments: [attachment] }, 201);
  });

  app.get("/api/chat/attachments/:id", (c) => {
    const id = c.req.param("id").trim();
    const record = deps.registry.getChatAttachment(id);
    if (!record) {
      return c.json({ error: "Attachment not found." }, 404);
    }

    let bytes: Buffer | null = null;
    if (record.storagePath && fs.existsSync(record.storagePath)) {
      bytes = fs.readFileSync(record.storagePath);
    } else if (record.dataBase64) {
      bytes = Buffer.from(record.dataBase64, "base64");
    }

    if (!bytes) {
      return c.json({ error: "Attachment payload unavailable." }, 404);
    }

    const safeContentType =
      record.kind === "image" ? record.mimeType : "application/octet-stream";
    const disposition =
      record.kind === "image"
        ? "inline"
        : `attachment; filename="${record.name.replace(/"/g, "")}"`;

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": safeContentType,
        "content-disposition": disposition,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // --- Send Agentic Message (Streaming SSE or JSON) ---

  app.post("/api/chat/threads/:id/messages", async (c) => {
    const threadId = c.req.param("id").trim();
    const thread = deps.registry.getChatThread(threadId);
    if (!thread) {
      return c.json({ error: `Chat thread "${threadId}" not found.` }, 404);
    }

    let body: unknown;
    try {
      body = await readJsonBody(c, deps.maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = SendMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    if (parsed.data.truncateFromMessageId) {
      deps.registry.truncateChatMessagesFrom(
        threadId,
        parsed.data.truncateFromMessageId,
      );
    }

    const history = deps.registry.listChatMessages(threadId);
    const attachedRecords = deps.registry.getChatAttachmentsByIds(
      parsed.data.attachmentIds,
      threadId,
    );

    const userMessage: ChatMessage = deps.registry.appendChatMessage({
      id: crypto.randomUUID(),
      threadId,
      role: "user",
      content: parsed.data.content,
      attachments: attachedRecords.map(toPublicAttachment),
      reasoning: [],
      toolCalls: [],
      planId: null,
      provider: null,
      model: null,
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    const isFirstMessage = history.length === 0 || thread.title === "New Conversation";
    const nextTitle = isFirstMessage
      ? deriveThreadTitle(parsed.data.content)
      : thread.title;

    const wantsStream =
      parsed.data.stream === true ||
      (parsed.data.stream !== false &&
        (c.req.header("accept") ?? "").includes("text/event-stream"));

    if (!wantsStream) {
      const result = await runAgentChatTurn(engineDeps, {
        threadId,
        userText: parsed.data.content,
        mode: parsed.data.mode,
        effort: parsed.data.effort,
        mentionedSlugs: parsed.data.mentionedSlugs,
        attachments: attachedRecords,
        history,
        overrideProvider: parsed.data.provider,
        overrideModel: parsed.data.model,
        signal: c.req.raw.signal,
      });

      const savedAssistant = deps.registry.appendChatMessage(result.assistantMessage);
      const updatedThread = deps.registry.updateChatThread(threadId, {
        title: nextTitle,
        provider: result.providerLabel,
        model: result.modelLabel,
        updatedAt: savedAssistant.createdAt,
      });

      return c.json({
        thread: updatedThread,
        userMessage,
        assistantMessage: savedAssistant,
        plan: result.plan,
      });
    }

    const placeholderAssistant: ChatMessage = {
      id: crypto.randomUUID(),
      threadId,
      role: "assistant",
      content: "",
      attachments: [],
      reasoning: [],
      toolCalls: [],
      planId: null,
      provider: parsed.data.provider ?? thread.provider,
      model: parsed.data.model ?? thread.model,
      status: "streaming",
      createdAt: new Date().toISOString(),
    };

    const requestSignal = c.req.raw.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: ChatStreamEvent) => {
          try {
            controller.enqueue(formatSseFrame(event));
          } catch {
            // Stream closed by client
          }
        };

        send({
          type: "message_start",
          userMessage,
          assistantMessage: placeholderAssistant,
        });

        try {
          const result = await runAgentChatTurn(engineDeps, {
            threadId,
            userText: parsed.data.content,
            mode: parsed.data.mode,
            effort: parsed.data.effort,
            mentionedSlugs: parsed.data.mentionedSlugs,
            attachments: attachedRecords,
            history,
            overrideProvider: parsed.data.provider,
            overrideModel: parsed.data.model,
            signal: requestSignal,
            onEvent: send,
          });

          const finalAssistant = deps.registry.appendChatMessage({
            ...result.assistantMessage,
            id: placeholderAssistant.id,
          });

          deps.registry.updateChatThread(threadId, {
            title: nextTitle,
            provider: result.providerLabel,
            model: result.modelLabel,
            updatedAt: finalAssistant.createdAt,
          });

          send({
            type: "message_done",
            assistantMessage: finalAssistant,
            plan: result.plan,
            threadTitle: nextTitle,
          });
        } catch (err) {
          if (requestSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
            return;
          }
          const safeMsg = redactSecrets(
            err instanceof Error ? err.message : "Agent turn failed.",
          );
          deps.registry.appendChatMessage({
            ...placeholderAssistant,
            content: `Error: ${safeMsg}`,
            status: "error",
          });
          send({ type: "error", message: safeMsg });
        } finally {
          try {
            controller.close();
          } catch {
            // ignore double close
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
