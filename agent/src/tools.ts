import crypto from "node:crypto";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
  AppStatusSchema,
  type SystemRegistryStore,
  WorkloadKindSchema,
  redactSecrets,
  validateAppSlug,
} from "@vps-os/shared";
import { createExecutionPlan } from "./planner.js";
import { provisionIsolatedWorkspace } from "./subagent-runtime.js";

export interface AgentToolsetDeps {
  registry: SystemRegistryStore;
  appsRoot: string;
  templatesRoot: string;
}

/**
 * Typed toolset exposed to the Autonomous AI Agent (Step 5) via Vercel AI SDK
 * and the VPS OS MCP server. Mutating tools enforce server-side ExecutionPlan
 * approval and strict input validation before running.
 */
export function createAgentToolset(deps: AgentToolsetDeps): ToolSet {
  return {
    inspect_apps: tool({
      description:
        "Read-only snapshot of every registered app and personal agent: status, domain, internal port, and resource limits. Safe to call anytime. Use it before proposing any change and when summarizing the server for the owner.",
      inputSchema: z.object({}),
      execute: async () => {
        return { apps: deps.registry.listApps() };
      },
    }),

    list_audit_events: tool({
      description:
        "Read-only view of the most recent immutable VPS OS audit events, already redacted of secrets. Use it to tell the owner what changed on their server, when, and by whom.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ limit }) => {
        return { events: deps.registry.listAuditEvents(limit ?? 20) };
      },
    }),

    propose_plan: tool({
      description:
        "Turn an owner goal into a structured, risk-classified ExecutionPlan stored for approval. Secrets in the goal are redacted before storage. No mutation may proceed until the plan is approved.",
      inputSchema: z.object({
        goal: z.string().min(1).max(1000),
      }),
      execute: async ({ goal }) => {
        const plan = createExecutionPlan(redactSecrets(goal));
        return deps.registry.savePlan(plan);
      },
    }),

    get_plan_status: tool({
      description:
        "Read-only check of a stored ExecutionPlan's current approval and execution status by ID. Check this before every mutation step; never assume the owner has approved.",
      inputSchema: z.object({
        planId: z.string().min(1),
      }),
      execute: async ({ planId }) => {
        const plan = deps.registry.getPlan(planId);
        return { found: plan !== null, plan };
      },
    }),

    prepare_app_workspace: tool({
      description:
        "Approval-gated: provisions the isolated Locked Apartment workspace for one app (/apps/<slug> with its own Compose file and 0600-scoped .env, resource caps, no Docker socket). Requires a planId whose status is 'approved'; each approved plan executes exactly once.",
      inputSchema: z.object({
        planId: z.string().min(1),
        slug: z.string().min(2).max(48),
        name: z.string().min(1).max(100),
        kind: WorkloadKindSchema,
        domain: z.string().nullable(),
        internalPort: z.number().int().min(1).max(65535).optional(),
      }),
      execute: async (input) => {
        const storedPlan = deps.registry.getPlan(input.planId);
        if (!storedPlan) {
          throw new Error(
            `Approval required: execution plan "${input.planId}" does not exist.`,
          );
        }
        if (storedPlan.status !== "approved") {
          throw new Error(
            `Approval gate blocked execution: plan "${input.planId}" is "${storedPlan.status}" (must be "approved").`,
          );
        }

        const result = provisionIsolatedWorkspace({
          appsRoot: deps.appsRoot,
          templatesRoot: deps.templatesRoot,
          slug: input.slug,
          name: input.name,
          kind: input.kind,
          domain: input.domain,
          ...(input.internalPort !== undefined
            ? { internalPort: input.internalPort }
            : {}),
          registry: deps.registry,
        });

        deps.registry.markPlanExecuted(input.planId);

        return {
          appDir: result.appDir,
          composePath: result.composePath,
          envExamplePath: result.envExamplePath,
          record: result.record,
        };
      },
    }),

    update_app_status: tool({
      description:
        "Record an app's real lifecycle status ('provisioning', 'running', 'stopped', 'error') plus a redacted audit event. Call it only after verifying the app yourself, so the dashboard always matches reality.",
      inputSchema: z.object({
        slug: z.string().min(2).max(48),
        status: AppStatusSchema,
        summary: z.string().min(1).max(300).optional(),
      }),
      execute: async (input) => {
        const safeSlug = validateAppSlug(input.slug);
        const existing = deps.registry.getAppBySlug(safeSlug);
        if (!existing) {
          throw new Error(`App "${safeSlug}" is not registered.`);
        }

        const now = new Date().toISOString();
        deps.registry.updateAppStatus(safeSlug, input.status, now);
        deps.registry.recordAudit({
          id: crypto.randomUUID(),
          actor: "agent",
          action: "app.status_updated",
          targetSlug: safeSlug,
          summary: redactSecrets(
            input.summary ?? `Updated ${safeSlug} status to ${input.status}`,
          ),
          riskLevel: input.status === "error" ? "medium" : "low",
          createdAt: now,
        });

        return { app: deps.registry.getAppBySlug(safeSlug) };
      },
    }),
  };
}
