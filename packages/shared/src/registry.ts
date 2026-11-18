import { z } from "zod";

/**
 * Workload isolation categories supported by VPS OS.
 * - `web-app`: Isolated application container serving HTTP traffic or background services.
 * - `personal-agent`: Locked-apartment container with full terminal tools scoped to its workspace.
 */
export const WorkloadKindSchema = z.enum(["web-app", "personal-agent"]);
export type WorkloadKind = z.infer<typeof WorkloadKindSchema>;

/** Lifecycle states tracked in the System & App Registry (Step 8). */
export const AppStatusSchema = z.enum([
  "provisioning",
  "running",
  "stopped",
  "error",
]);
export type AppStatus = z.infer<typeof AppStatusSchema>;

/** Metadata stored in the System & App Registry (never holds plaintext secrets). */
export const AppRecordSchema = z.object({
  slug: z.string().min(2).max(48),
  name: z.string().min(1).max(100),
  kind: WorkloadKindSchema,
  domain: z.string().min(1).max(253).nullable(),
  folderPath: z.string().min(1),
  internalPort: z.number().int().min(1).max(65535),
  status: AppStatusSchema,
  cpuLimit: z.string().min(1).max(16),
  memoryLimitMb: z.number().int().min(64).max(131072),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AppRecord = z.infer<typeof AppRecordSchema>;

export const ActorSchema = z.enum(["user", "agent", "system"]);
export type Actor = z.infer<typeof ActorSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/** Immutable audit trail entry for actions performed on the VPS OS. */
export const AuditEventSchema = z.object({
  id: z.string().min(1),
  actor: ActorSchema,
  action: z.string().min(1).max(100),
  targetSlug: z.string().nullable(),
  summary: z.string().min(1).max(500),
  riskLevel: RiskLevelSchema,
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Sanitized host telemetry snapshot exposed to the Management Web UI. */
export const SystemMetricsSchema = z.object({
  hostname: z.string(),
  platform: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  cpuCount: z.number().int().positive(),
  loadAverage1m: z.number().nonnegative(),
  memoryTotalMb: z.number().nonnegative(),
  memoryUsedMb: z.number().nonnegative(),
  memoryUsagePercent: z.number().min(0).max(100),
  collectedAt: z.string(),
});
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;
