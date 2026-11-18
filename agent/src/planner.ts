import crypto from "node:crypto";
import {
  type ExecutionPlan,
  ExecutionPlanSchema,
  type PlanStep,
  type RiskLevel,
} from "@vps-os/shared";

const HIGH_RISK_KEYWORDS =
  /\b(delete|remove|destroy|reset|wipe|erase|format|firewall|ufw|ssh|sudo|root|secret|token|password|key|\.env|deploy|install|create|provision|exec|shell)\b/i;
const READ_ONLY_PREFIX =
  /^\s*(check|status|list|show|inspect|get|view|health|metrics|describe|read)\b/i;
const MUTATION_KEYWORDS =
  /\b(restart|stop|start|update|upgrade|configure|route|domain|change|edit|write|modify|add|set|expose|open|enable|disable|build|run)\b/i;

function truncateExcerpt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

/**
 * Classifies the risk level of a natural-language CTO request using a
 * fail-closed policy: only explicit read-only queries are low risk.
 */
export function classifyGoalRisk(goal: string): RiskLevel {
  if (HIGH_RISK_KEYWORDS.test(goal)) {
    return "high";
  }
  if (READ_ONLY_PREFIX.test(goal) && !MUTATION_KEYWORDS.test(goal)) {
    return "low";
  }
  return "medium";
}

/**
 * Builds a structured, reviewable ExecutionPlan before any subagent or
 * container mutation is executed (Steps 2 & 5).
 */
export function createExecutionPlan(goal: string): ExecutionPlan {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new Error("Goal cannot be empty.");
  }

  const riskLevel = classifyGoalRisk(trimmedGoal);
  const requiresApproval = riskLevel !== "low";
  const excerpt = truncateExcerpt(trimmedGoal, 300);

  const steps: PlanStep[] =
    riskLevel === "low"
      ? [
          {
            id: "step-1",
            title: "Inspect system registry and service health",
            description:
              "Read current app records, container statuses, and host metrics without modifying state.",
            toolName: "inspect_apps",
            riskLevel: "low",
            requiresApproval: false,
          },
        ]
      : [
          {
            id: "step-1",
            title: "Inspect existing workloads and validate boundaries",
            description:
              "Verify target slug, scoped folder path under /apps, and domain formatting.",
            toolName: "inspect_apps",
            riskLevel: "low",
            requiresApproval: false,
          },
          {
            id: "step-2",
            title: "Provision isolated subagent workspace",
            description:
              "Create dedicated folder, isolated Compose file, and .env.example template.",
            toolName: "prepare_app_workspace",
            riskLevel,
            requiresApproval: true,
          },
          {
            id: "step-3",
            title: "Update System & App Registry",
            description:
              "Record app metadata and append an audit event without storing plaintext secrets.",
            toolName: "register_app",
            riskLevel: "medium",
            requiresApproval: true,
          },
        ];

  return ExecutionPlanSchema.parse({
    id: crypto.randomUUID(),
    goal: trimmedGoal,
    summary: requiresApproval
      ? `Planned ${steps.length} steps for "${excerpt}" (approval required before execution).`
      : `Read-only inspection plan for "${excerpt}".`,
    steps,
    requiresUserApproval: requiresApproval,
    createdAt: new Date().toISOString(),
  });
}
