import { z } from "zod";

export const ChatModeSchema = z.enum(["agent", "plan"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

export const ChatAttachmentKindSchema = z.enum(["image", "text", "file"]);
export type ChatAttachmentKind = z.infer<typeof ChatAttachmentKindSchema>;

export const ChatAttachmentSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().nullable().default(null),
  name: z.string().min(1).max(160),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().nonnegative(),
  kind: ChatAttachmentKindSchema,
  textPreview: z.string().nullable().default(null),
  url: z.string().min(1),
  createdAt: z.string(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatReasoningBlockSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  content: z.string(),
  durationMs: z.number().nonnegative().default(0),
  status: z.enum(["streaming", "done"]).default("done"),
});
export type ChatReasoningBlock = z.infer<typeof ChatReasoningBlockSchema>;

export const ChatToolCallStatusSchema = z.enum([
  "running",
  "success",
  "error",
  "awaiting_approval",
]);
export type ChatToolCallStatus = z.infer<typeof ChatToolCallStatusSchema>;

export const ChatToolCallSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1).max(80),
  label: z.string().min(1).max(180),
  status: ChatToolCallStatusSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.unknown().optional(),
  error: z.string().nullable().default(null),
  durationMs: z.number().nonnegative().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
});
export type ChatToolCall = z.infer<typeof ChatToolCallSchema>;

export const ChatMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

export const ChatMessageStatusSchema = z.enum([
  "streaming",
  "completed",
  "error",
]);
export type ChatMessageStatus = z.infer<typeof ChatMessageStatusSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: ChatMessageRoleSchema,
  content: z.string(),
  attachments: z.array(ChatAttachmentSchema).default([]),
  reasoning: z.array(ChatReasoningBlockSchema).default([]),
  toolCalls: z.array(ChatToolCallSchema).default([]),
  planId: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  status: ChatMessageStatusSchema.default("completed"),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  messageCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;

/** Sanitizes an uploaded filename for safe display and storage. */
export function sanitizeAttachmentName(rawName: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? "attachment";
  const cleaned = base
    .replace(/[\r\n\0<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "attachment").slice(0, 160);
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "caddy",
  "env",
  "example",
  "sh",
  "bash",
  "zsh",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "html",
  "xml",
  "svg",
  "sql",
  "log",
  "csv",
  "dockerfile",
  "gitignore",
]);

/** Classifies an uploaded attachment into image, text (inspectable by the agent), or binary file. */
export function classifyAttachmentKind(
  mimeType: string,
  fileName: string,
): ChatAttachmentKind {
  const lowerMime = mimeType.toLowerCase().trim();
  if (
    lowerMime.startsWith("image/") &&
    lowerMime !== "image/svg+xml"
  ) {
    return "image";
  }
  if (
    lowerMime.startsWith("text/") ||
    lowerMime === "application/json" ||
    lowerMime === "application/x-yaml" ||
    lowerMime === "application/yaml" ||
    lowerMime === "application/xml" ||
    lowerMime === "application/javascript" ||
    lowerMime === "application/typescript" ||
    lowerMime === "application/x-sh" ||
    lowerMime === "image/svg+xml"
  ) {
    return "text";
  }
  const lowerName = fileName.toLowerCase();
  if (
    lowerName === "dockerfile" ||
    lowerName === "caddyfile" ||
    lowerName === "makefile" ||
    lowerName.endsWith(".env.example")
  ) {
    return "text";
  }
  const ext = lowerName.includes(".") ? lowerName.split(".").pop() ?? "" : "";
  if (ext && TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }
  return "file";
}
