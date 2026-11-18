import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
  type SystemRegistryStore,
  WorkloadKindSchema,
} from "@vps-os/shared";
import { createExecutionPlan } from "./planner.js";
import { provisionIsolatedWorkspace } from "./subagent-runtime.js";

export interface AgentToolsetDeps {
  registry: SystemRegistryStore;
  appsRoot: string;
  templatesRoot: string;
}

/**
 * Typed toolset exposed to the Autonomous AI Agent (Step 5) via Vercel AI SDK.
 * Mutating tools enforce server-side ExecutionPlan approval before running.
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

    propose_plan: tool({
      description:
        "Generate and persist a structured execution plan with risk classification for user approval.",
      inputSchema: z.object({
        goal: z.string().min(1).max(1000),
      }),
      execute: async ({ goal }) => {
        const plan = createExecutionPlan(goal);
        return deps.registry.savePlan(plan);
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
  };
}
