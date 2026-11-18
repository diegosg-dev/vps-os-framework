import {
  type ExecuteApprovedPlanDeps,
  PlanExecutionError,
  executeApprovedPlan,
} from "@vps-os/agent";
import {
  type AppStatus,
  type RuntimeBridge,
  type StoredPlan,
  redactSecrets,
  validateHttpBaseUrl,
} from "@vps-os/shared";
import type {
  AppLifecycleAction,
  PlanExecutionContext,
  PlanExecutionResult,
  WorkloadController,
} from "./app.js";

export class DashboardRuntimeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(redactSecrets(message));
    this.name = "DashboardRuntimeError";
    this.statusCode = statusCode;
  }
}

export interface AgentPlanExecutorOptions {
  agentUrl?: string | undefined;
  adminToken?: string | undefined;
  localDeps?: ExecuteApprovedPlanDeps | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_AGENT_EXEC_TIMEOUT_MS = 250_000;
const MAX_AGENT_RESPONSE_BYTES = 1024 * 1024;

export type PlanExecutor = (
  plan: StoredPlan,
  context?: PlanExecutionContext,
) => Promise<PlanExecutionResult>;

/**
 * Adapts the host `RuntimeBridge` client to the Dashboard Control API's
 * `WorkloadController` contract for lifecycle control, log tailing, and live status sync.
 */
export function createRuntimeWorkloadController(
  bridge: RuntimeBridge,
): WorkloadController {
  return {
    async control(
      slug: string,
      action: AppLifecycleAction,
    ): Promise<{ status: AppStatus }> {
      const result = await bridge.lifecycle(slug, action);
      return { status: result.status };
    },

    async getLogs(slug: string, tail: number): Promise<string[]> {
      return bridge.getLogs(slug, tail);
    },

    async syncStatuses(slugs: string[]): Promise<Record<string, AppStatus>> {
      return bridge.getStatuses(slugs);
    },
  };
}

export function createAgentPlanExecutor(
  options: AgentPlanExecutorOptions & { agentUrl: string },
): PlanExecutor;
export function createAgentPlanExecutor(
  options: AgentPlanExecutorOptions & { localDeps: ExecuteApprovedPlanDeps },
): PlanExecutor;
export function createAgentPlanExecutor(
  options: AgentPlanExecutorOptions,
): PlanExecutor | undefined;
/**
 * Builds the `executePlan` handler for `createDashboardApp`.
 * Delegates to the isolated `vps-os-agent` HTTP service when `agentUrl` is
 * configured (standard Docker core stack) or executes locally via `localDeps`.
 */
export function createAgentPlanExecutor(
  options: AgentPlanExecutorOptions,
): PlanExecutor | undefined {
  const rawAgentUrl = options.agentUrl?.trim();
  const timeoutMs = Math.max(
    1000,
    options.timeoutMs ?? DEFAULT_AGENT_EXEC_TIMEOUT_MS,
  );

  if (rawAgentUrl) {
    const baseUrl = validateHttpBaseUrl(rawAgentUrl);
    const adminToken = options.adminToken?.trim();

    return async (
      plan: StoredPlan,
      context?: PlanExecutionContext,
    ): Promise<PlanExecutionResult> => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (adminToken) {
        headers.authorization = `Bearer ${adminToken}`;
      }

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/agent/execute`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            planId: plan.id,
            markExecuted: false,
            ...(context?.leaseOwnerId
              ? { leaseOwnerId: context.leaseOwnerId }
              : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError")
        ) {
          throw new DashboardRuntimeError(
            504,
            `Agent execution timed out after ${timeoutMs}ms.`,
          );
        }
        throw new DashboardRuntimeError(
          503,
          `Agent runtime service is unreachable: ${err instanceof Error ? err.message : "connection failed"}`,
        );
      }

      const rawText = await res.text();
      if (Buffer.byteLength(rawText, "utf8") > MAX_AGENT_RESPONSE_BYTES) {
        throw new DashboardRuntimeError(
          502,
          "Agent service response exceeded maximum allowed size.",
        );
      }

      let parsed: unknown = null;
      if (rawText.trim()) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
      }

      if (!res.ok) {
        const message =
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof (parsed as { error: unknown }).error === "string"
            ? (parsed as { error: string }).error
            : `Agent execution failed with HTTP ${res.status}.`;
        throw new DashboardRuntimeError(res.status, message);
      }

      const summary =
        typeof parsed === "object" &&
        parsed !== null &&
        "summary" in parsed &&
        typeof (parsed as { summary: unknown }).summary === "string"
          ? (parsed as { summary: string }).summary
          : "";

      if (!summary) {
        throw new DashboardRuntimeError(
          502,
          "Agent service returned an empty execution summary.",
        );
      }

      return { summary: redactSecrets(summary) };
    };
  }

  if (options.localDeps) {
    const localDeps = options.localDeps;
    return async (plan: StoredPlan): Promise<PlanExecutionResult> => {
      try {
        return await executeApprovedPlan(plan, localDeps);
      } catch (err) {
        if (err instanceof PlanExecutionError) {
          throw new DashboardRuntimeError(err.statusCode, err.message);
        }
        throw err;
      }
    };
  }

  return undefined;
}
