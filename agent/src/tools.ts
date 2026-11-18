import crypto from "node:crypto";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
  AppStatusSchema,
  type RuntimeBridge,
  type SystemRegistryStore,
  WorkloadKindSchema,
  redactSecrets,
  syncAppStatuses,
  validateAppSlug,
  validateDomain,
} from "@vps-os/shared";
import { deployWorkloadWithBridge } from "./executor.js";
import { createExecutionPlan } from "./planner.js";
import { provisionIsolatedWorkspace } from "./subagent-runtime.js";

export interface AgentToolsetDeps {
  registry: SystemRegistryStore;
  appsRoot: string;
  templatesRoot: string;
  runtimeBridge?: RuntimeBridge | undefined;
}

function assertApprovedPlan(
  registry: SystemRegistryStore,
  planId: string,
) {
  const storedPlan = registry.getPlan(planId);
  if (!storedPlan) {
    throw new Error(
      `Approval required: execution plan "${planId}" does not exist.`,
    );
  }
  if (storedPlan.status !== "approved") {
    throw new Error(
      `Approval gate blocked execution: plan "${planId}" is "${storedPlan.status}" (must be "approved").`,
    );
  }
  return storedPlan;
}

/**
 * Typed toolset exposed to the Autonomous AI Agent (Step 5) via Vercel AI SDK
 * and the VPS OS MCP server. Mutating tools enforce server-side ExecutionPlan
 * approval, cross-process execution leases, and strict input validation.
 */
export function createAgentToolset(deps: AgentToolsetDeps): ToolSet {
  async function withApprovedPlan<T>(
    planId: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    assertApprovedPlan(deps.registry, planId);
    const ownerId = `tool:${crypto.randomUUID()}`;
    if (!deps.registry.claimPlanExecution(planId, ownerId)) {
      throw new Error(
        `Approval gate blocked execution: plan "${planId}" is already executing or no longer approved.`,
      );
    }
    try {
      const result = await fn();
      if (!deps.registry.markPlanExecuted(planId, ownerId)) {
        throw new Error(
          `Execution state conflict: plan "${planId}" was modified concurrently.`,
        );
      }
      return result;
    } catch (err) {
      deps.registry.releasePlanExecution(planId, ownerId);
      throw err;
    }
  }

  return {
    inspect_apps: tool({
      description:
        "Read-only snapshot of every registered app and personal agent: status, domain, internal port, and resource limits. Safe to call anytime. Use it before proposing any change and when summarizing the server for the owner.",
      inputSchema: z.object({}),
      execute: async () => {
        const apps = await syncAppStatuses(deps.registry, deps.runtimeBridge);
        return { apps };
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

    read_app_logs: tool({
      description:
        "Read-only tail of recent secret-redacted container logs for a registered app. Safe to call during diagnosis.",
      inputSchema: z.object({
        slug: z.string().min(2).max(48),
        tail: z.number().int().min(1).max(500).optional(),
      }),
      execute: async (input) => {
        const safeSlug = validateAppSlug(input.slug);
        const existing = deps.registry.getAppBySlug(safeSlug);
        if (!existing) {
          throw new Error(`App "${safeSlug}" is not registered.`);
        }
        if (!deps.runtimeBridge) {
          throw new Error("Host runtime bridge is not configured.");
        }
        const lines = await deps.runtimeBridge.getLogs(
          safeSlug,
          input.tail ?? 100,
        );
        return { slug: safeSlug, lines };
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
        return withApprovedPlan(input.planId, () => {
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

          return {
            appDir: result.appDir,
            composePath: result.composePath,
            envExamplePath: result.envExamplePath,
            record: result.record,
          };
        });
      },
    }),

    deploy_workload: tool({
      description:
        "Approval-gated end-to-end deployment: provisions an isolated workspace, starts its Compose container via the host runtime bridge, binds Caddy HTTPS routing when domain is set, and rolls back automatically on failure. Requires an approved planId.",
      inputSchema: z.object({
        planId: z.string().min(1),
        slug: z.string().min(2).max(48),
        name: z.string().min(1).max(100),
        kind: WorkloadKindSchema,
        domain: z.string().nullable(),
        internalPort: z.number().int().min(1).max(65535).optional(),
      }),
      execute: async (input) => {
        return withApprovedPlan(input.planId, async () => {
          const deployed = await deployWorkloadWithBridge(
            {
              slug: input.slug,
              name: input.name,
              kind: input.kind,
              domain: input.domain,
              internalPort: input.internalPort,
            },
            {
              registry: deps.registry,
              appsRoot: deps.appsRoot,
              templatesRoot: deps.templatesRoot,
              runtimeBridge: deps.runtimeBridge,
            },
          );
          return {
            app: deployed.record,
            summary: deployed.summary,
          };
        });
      },
    }),

    control_app_lifecycle: tool({
      description:
        "Approval-gated: starts, stops, or restarts an isolated app's Docker Compose stack via the host runtime bridge and records its real status.",
      inputSchema: z.object({
        planId: z.string().min(1),
        slug: z.string().min(2).max(48),
        action: z.enum(["start", "stop", "restart"]),
      }),
      execute: async (input) => {
        return withApprovedPlan(input.planId, async () => {
          const safeSlug = validateAppSlug(input.slug);
          const existing = deps.registry.getAppBySlug(safeSlug);
          if (!existing) {
            throw new Error(`App "${safeSlug}" is not registered.`);
          }
          if (!deps.runtimeBridge) {
            throw new Error("Host runtime bridge is not configured.");
          }

          const outcome = await deps.runtimeBridge.lifecycle(
            safeSlug,
            input.action,
          );
          const now = new Date().toISOString();
          deps.registry.setAppCleanupPending(safeSlug, false);
          deps.registry.updateAppStatus(safeSlug, outcome.status, now);
          deps.registry.recordAudit({
            id: crypto.randomUUID(),
            actor: "agent",
            action: `app.${input.action}`,
            targetSlug: safeSlug,
            summary: `MCP ${input.action} on ${safeSlug} -> ${outcome.status}`,
            riskLevel: input.action === "stop" ? "medium" : "low",
            createdAt: now,
          });

          return { app: deps.registry.getAppBySlug(safeSlug) };
        });
      },
    }),

    configure_app_domain: tool({
      description:
        "Approval-gated: binds or removes a Caddy Auto-TLS domain route for a running app and updates its domain in the System Registry.",
      inputSchema: z.object({
        planId: z.string().min(1),
        slug: z.string().min(2).max(48),
        domain: z.string().nullable(),
      }),
      execute: async (input) => {
        return withApprovedPlan(input.planId, async () => {
          const safeSlug = validateAppSlug(input.slug);
          const safeDomain = input.domain ? validateDomain(input.domain) : null;
          const existing = deps.registry.getAppBySlug(safeSlug);
          if (!existing) {
            throw new Error(`App "${safeSlug}" is not registered.`);
          }
          if (!deps.runtimeBridge) {
            throw new Error("Host runtime bridge is not configured.");
          }

          const routeResult = await deps.runtimeBridge.routeCaddy({
            slug: safeSlug,
            domain: safeDomain,
            internalPort: existing.internalPort,
          });

          const now = new Date().toISOString();
          const updated = deps.registry.upsertApp({
            ...existing,
            domain: safeDomain,
            updatedAt: now,
          });
          deps.registry.recordAudit({
            id: crypto.randomUUID(),
            actor: "agent",
            action: safeDomain ? "app.domain_bound" : "app.domain_unbound",
            targetSlug: safeSlug,
            summary: safeDomain
              ? `Bound Caddy HTTPS route ${safeDomain} -> ${safeSlug}`
              : `Removed Caddy HTTPS route for ${safeSlug}`,
            riskLevel: "medium",
            createdAt: now,
          });

          return { app: updated, routed: routeResult.routed };
        });
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
