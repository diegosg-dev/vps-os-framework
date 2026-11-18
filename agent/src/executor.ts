import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import {
  type AppRecord,
  type RuntimeBridge,
  RuntimeBridgeError,
  type StoredPlan,
  type SystemRegistryStore,
  WorkloadKindSchema,
  redactSecrets,
  syncAppStatuses,
  validateAppSlug,
  validateDomain,
} from "@vps-os/shared";
import { extractDeploySpecFromGoal } from "./planner.js";
import { provisionIsolatedWorkspace } from "./subagent-runtime.js";

export class PlanExecutionError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(redactSecrets(message));
    this.name = "PlanExecutionError";
    this.statusCode = statusCode;
  }
}

export interface ExecuteApprovedPlanDeps {
  registry: SystemRegistryStore;
  appsRoot: string;
  templatesRoot: string;
  runtimeBridge?: RuntimeBridge | undefined;
}

export interface DeployWorkloadInput {
  slug: string;
  name: string;
  kind: z.infer<typeof WorkloadKindSchema>;
  domain: string | null;
  internalPort?: number | undefined;
}

const DeployArgsSchema = z.object({
  slug: z.string().min(2).max(48),
  name: z.string().min(1).max(100),
  kind: WorkloadKindSchema,
  domain: z.string().nullable(),
  internalPort: z.number().int().min(1).max(65535).optional(),
});

const LifecycleArgsSchema = z.object({
  slug: z.string().min(2).max(48),
  action: z.enum(["start", "stop", "restart"]),
});

const activeSlugDeploys = new Set<string>();

/**
 * Shared deployment routine used by both plan execution and the MCP
 * `deploy_workload` tool: provisions the Locked Apartment workspace, starts the
 * Compose stack via the runtime bridge, optionally wires Caddy TLS, and rolls
 * back cleanly without deleting workspace state if container teardown fails.
 */
export async function deployWorkloadWithBridge(
  input: DeployWorkloadInput,
  deps: ExecuteApprovedPlanDeps,
): Promise<{ record: AppRecord; summary: string }> {
  const safeSlug = validateAppSlug(input.slug);
  const safeDomain = input.domain ? validateDomain(input.domain) : null;

  if (activeSlugDeploys.has(safeSlug)) {
    throw new PlanExecutionError(
      409,
      `Deployment for "${safeSlug}" is already in progress.`,
    );
  }
  if (deps.registry.getAppBySlug(safeSlug)) {
    throw new PlanExecutionError(
      409,
      `App "${safeSlug}" already exists. Choose a different app name or control the existing workload.`,
    );
  }
  if (safeDomain) {
    const conflict = deps.registry
      .listApps()
      .find((app) => app.domain?.toLowerCase() === safeDomain);
    if (conflict) {
      throw new PlanExecutionError(
        409,
        `Domain "${safeDomain}" is already assigned to app "${conflict.slug}".`,
      );
    }
  }
  if (!deps.runtimeBridge) {
    throw new PlanExecutionError(
      503,
      "Host runtime bridge is not configured; cannot start provisioned workload.",
    );
  }

  activeSlugDeploys.add(safeSlug);
  try {
    let provisioned: ReturnType<typeof provisionIsolatedWorkspace>;
    try {
      provisioned = provisionIsolatedWorkspace({
        appsRoot: deps.appsRoot,
        templatesRoot: deps.templatesRoot,
        slug: safeSlug,
        name: input.name,
        kind: input.kind,
        domain: safeDomain,
        ...(input.internalPort !== undefined
          ? { internalPort: input.internalPort }
          : {}),
        registry: deps.registry,
      });
    } catch (err) {
      throw new PlanExecutionError(
        409,
        err instanceof Error ? err.message : "Could not provision workspace.",
      );
    }

    try {
      const startResult = await deps.runtimeBridge.lifecycle(safeSlug, "start");
      if (safeDomain) {
        await deps.runtimeBridge.routeCaddy({
          slug: safeSlug,
          domain: safeDomain,
          internalPort: provisioned.record.internalPort,
        });
      }

      const now = new Date().toISOString();
      deps.registry.updateAppStatus(safeSlug, startResult.status, now);
      const updated = deps.registry.getAppBySlug(safeSlug) ?? provisioned.record;
      deps.registry.recordAudit({
        id: crypto.randomUUID(),
        actor: "agent",
        action: "app.deployed",
        targetSlug: safeSlug,
        summary: `Deployed ${updated.kind} "${safeSlug}" -> ${startResult.status}${safeDomain ? ` (${safeDomain})` : ""}`,
        riskLevel: "high",
        createdAt: now,
      });

      return {
        record: updated,
        summary: `Provisioned ${updated.kind} "${updated.name}" (${safeSlug}); container is ${startResult.status}${safeDomain ? ` and routed at https://${safeDomain}` : " (internal network only)"}.`,
      };
    } catch (deployErr) {
      const originalMsg =
        deployErr instanceof Error ? deployErr.message : "Container startup failed.";
      const originalStatus =
        deployErr instanceof RuntimeBridgeError ? deployErr.statusCode : 502;

      try {
        await deps.runtimeBridge.removeWorkload(safeSlug, { removeFiles: true });
      } catch (cleanupErr) {
        // Keep workspace and registry record in 'error' (cleanup-pending) so
        // operators do not lose the Compose file needed to stop running containers.
        const cleanupMsg =
          cleanupErr instanceof Error ? cleanupErr.message : "cleanup failed";
        deps.registry.setAppCleanupPending(safeSlug, true);
        deps.registry.updateAppStatus(safeSlug, "error", new Date().toISOString());
        deps.registry.recordAudit({
          id: crypto.randomUUID(),
          actor: "agent",
          action: "app.deploy_cleanup_pending",
          targetSlug: safeSlug,
          summary: redactSecrets(
            `Deploy failed (${originalMsg}); cleanup pending for ${safeSlug}: ${cleanupMsg}`,
          ),
          riskLevel: "high",
          createdAt: new Date().toISOString(),
        });
        throw new PlanExecutionError(
          originalStatus,
          `${originalMsg} (cleanup pending: ${cleanupMsg})`,
        );
      }

      try {
        fs.rmSync(provisioned.appDir, { recursive: true, force: true });
      } catch {
        // removeWorkload already attempted file cleanup
      }
      try {
        deps.registry.deleteApp(safeSlug);
      } catch {
        // best-effort registry row removal after runtime teardown succeeded
      }
      deps.registry.recordAudit({
        id: crypto.randomUUID(),
        actor: "agent",
        action: "app.deploy_failed",
        targetSlug: safeSlug,
        summary: redactSecrets(
          `Deployment rollback completed for ${safeSlug}: ${originalMsg}`,
        ),
        riskLevel: "high",
        createdAt: new Date().toISOString(),
      });

      throw new PlanExecutionError(originalStatus, originalMsg);
    }
  } finally {
    activeSlugDeploys.delete(safeSlug);
  }
}

/**
 * Executes an approved ExecutionPlan server-side using the isolated subagent
 * workspace provisioner and host runtime bridge. Never marks the plan as
 * `executed` itself, allowing callers to coordinate atomic lease & status transitions.
 */
export async function executeApprovedPlan(
  plan: StoredPlan,
  deps: ExecuteApprovedPlanDeps,
): Promise<{ summary: string }> {
  if (plan.status !== "approved") {
    throw new PlanExecutionError(
      409,
      `Plan "${plan.id}" cannot execute while status is "${plan.status}".`,
    );
  }

  if (plan.steps.some((step) => step.toolName === "manual_review")) {
    throw new PlanExecutionError(
      422,
      "This plan requires manual review or a more specific app request; automated execution does not run destructive host actions or ambiguous goals.",
    );
  }

  const lifecycleStep = plan.steps.find(
    (step) => step.toolName === "control_app_lifecycle",
  );
  if (lifecycleStep) {
    const parsed = LifecycleArgsSchema.safeParse(lifecycleStep.args ?? {});
    if (!parsed.success) {
      throw new PlanExecutionError(
        400,
        "Lifecycle step is missing valid slug or action arguments.",
      );
    }
    const safeSlug = validateAppSlug(parsed.data.slug);
    const existing = deps.registry.getAppBySlug(safeSlug);
    if (!existing) {
      throw new PlanExecutionError(404, `App "${safeSlug}" is not registered.`);
    }
    if (!deps.runtimeBridge) {
      throw new PlanExecutionError(
        503,
        "Host runtime bridge is not configured; cannot control workload container.",
      );
    }

    try {
      const outcome = await deps.runtimeBridge.lifecycle(
        safeSlug,
        parsed.data.action,
      );
      const now = new Date().toISOString();
      deps.registry.setAppCleanupPending(safeSlug, false);
      deps.registry.updateAppStatus(safeSlug, outcome.status, now);
      deps.registry.recordAudit({
        id: crypto.randomUUID(),
        actor: "agent",
        action: `app.${parsed.data.action}`,
        targetSlug: safeSlug,
        summary: `Executed plan ${plan.id}: ${parsed.data.action} ${safeSlug} -> ${outcome.status}`,
        riskLevel: parsed.data.action === "stop" ? "medium" : "low",
        createdAt: now,
      });
      return {
        summary: `Executed ${parsed.data.action} on "${safeSlug}"; container status is now ${outcome.status}.`,
      };
    } catch (err) {
      if (err instanceof RuntimeBridgeError) {
        throw new PlanExecutionError(err.statusCode, err.message);
      }
      throw new PlanExecutionError(
        502,
        err instanceof Error ? err.message : "Workload lifecycle failed.",
      );
    }
  }

  const provisionStep = plan.steps.find(
    (step) => step.toolName === "prepare_app_workspace",
  );
  if (provisionStep) {
    const rawArgs =
      provisionStep.args ?? extractDeploySpecFromGoal(plan.goal) ?? null;
    const parsed = DeployArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      throw new PlanExecutionError(
        422,
        "Could not determine target app slug and workload kind from this plan. Specify a workload name (e.g., 'Deploy billing web app at billing.example.com').",
      );
    }

    const deployed = await deployWorkloadWithBridge(
      {
        slug: parsed.data.slug,
        name: parsed.data.name,
        kind: parsed.data.kind,
        domain: parsed.data.domain,
        internalPort: parsed.data.internalPort,
      },
      deps,
    );
    return { summary: deployed.summary };
  }

  // Read-only inspection plan (`inspect_apps`)
  const updatedApps = await syncAppStatuses(deps.registry, deps.runtimeBridge);
  const statusSummary =
    updatedApps.length === 0
      ? "Inspected system registry: 0 isolated workloads registered yet."
      : `Inspected ${updatedApps.length} workload(s): ${updatedApps
          .map((app) => `${app.slug} (${app.status})`)
          .join(", ")}.`;

  deps.registry.recordAudit({
    id: crypto.randomUUID(),
    actor: "agent",
    action: "plan.inspected",
    targetSlug: null,
    summary: statusSummary,
    riskLevel: "low",
    createdAt: new Date().toISOString(),
  });

  return { summary: statusSummary };
}
