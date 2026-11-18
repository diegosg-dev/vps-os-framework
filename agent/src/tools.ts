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
        "List all registered applications and personal agents with status and resource limits.",
      inputSchema: z.object({}),
      execute: async () => {
        return { apps: deps.registry.listApps() };
      },
    }),

    list_audit_events: tool({
      description:
        "Read the most recent immutable VPS OS audit events (redacted of secrets).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ limit }) => {
        return { events: deps.registry.listAuditEvents(limit ?? 20) };
      },
    }),

    propose_plan: tool({
      description:
        "Generate and persist a structured execution plan with risk classification for user approval.",
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
        "Check the current approval and execution status of a stored ExecutionPlan by ID.",
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
        "Provision an isolated Locked Apartment workspace folder, Compose template, and .env under /apps/<slug>. Requires an approved planId.",
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
        "Update a registered app's lifecycle status ('provisioning', 'running', 'stopped', 'error') and record an audit event.",
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
