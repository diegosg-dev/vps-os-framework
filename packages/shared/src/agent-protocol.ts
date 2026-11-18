import { z } from "zod";
import { RiskLevelSchema } from "./registry.js";

/** A single planned action produced by the CTO Agent before execution. */
export const PlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(500),
  toolName: z.string().min(1).max(80),
  riskLevel: RiskLevelSchema,
  requiresApproval: z.boolean(),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/** Structured plan preview card shown in Natural-Language CTO Chat (Step 2). */
export const ExecutionPlanSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1).max(1000),
  summary: z.string().min(1).max(500),
  steps: z.array(PlanStepSchema).min(1),
  requiresUserApproval: z.boolean(),
  createdAt: z.string(),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export const PlanStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "executed",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const StoredPlanSchema = ExecutionPlanSchema.extend({
  status: PlanStatusSchema,
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export type StoredPlan = z.infer<typeof StoredPlanSchema>;

export const ApprovalDecisionSchema = z.object({
  planId: z.string().min(1),
  approved: z.boolean(),
  decidedBy: z.string().min(1).max(100),
  note: z.string().max(300).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
