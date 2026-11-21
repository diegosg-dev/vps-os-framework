import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type RuntimeBridge,
  SystemRegistryStore,
  createRuntimeBridgeFromEnv,
  redactSecrets,
} from "@vps-os/shared";
import { PlanExecutionError, executeApprovedPlan } from "./executor.js";
import { createExecutionPlan } from "./planner.js";

export * from "./executor.js";
export * from "./hermes-pack.js";
export * from "./mcp-server.js";
export * from "./planner.js";
export * from "./subagent-runtime.js";
export * from "./tools.js";

const MAX_BODY_BYTES = 64 * 1024;
const MIN_ADMIN_TOKEN_LENGTH = 16;

export interface AgentServerOptions {
  port?: number;
  dbPath?: string;
  adminToken?: string;
  allowUnauthenticated?: boolean;
  appsRoot?: string;
  templatesRoot?: string;
  runtimeBridge?: RuntimeBridge;
}

function sha256Digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return crypto.timingSafeEqual(sha256Digest(provided), sha256Digest(expected));
}

function extractToken(req: http.IncomingMessage): string | undefined {
  const headerToken = req.headers["x-vps-os-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return undefined;
}

type BodyReadResult = { ok: true; data: unknown } | { ok: false };

function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large." }));
        req.destroy();
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false });
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "JSON body must be an object." }));
          resolve({ ok: false });
          return;
        }
        resolve({ ok: true, data: parsed });
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON payload." }));
        resolve({ ok: false });
      }
    });
  });
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Creates the internal Agent Runtime HTTP server (Step 5) with fail-closed auth. */
export function createAgentHttpServer(options: AgentServerOptions = {}): {
  server: http.Server;
  registry: SystemRegistryStore;
} {
  const defaultTemplatesRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../templates",
  );
  const dbPath = options.dbPath ?? process.env.VPS_OS_REGISTRY_DB ?? ":memory:";
  const adminToken = (
    options.adminToken ?? process.env.VPS_OS_ADMIN_TOKEN
  )?.trim();

  if (!adminToken && options.allowUnauthenticated !== true) {
    throw new Error(
      "createAgentHttpServer requires a non-empty adminToken unless allowUnauthenticated is explicitly true.",
    );
  }

  const appsRoot =
    options.appsRoot ?? process.env.VPS_OS_APPS_ROOT ?? "/apps";
  const templatesRoot =
    options.templatesRoot ??
    process.env.VPS_OS_TEMPLATES_ROOT ??
    defaultTemplatesRoot;
  const runtimeBridge = options.runtimeBridge;
  const registry = new SystemRegistryStore(dbPath);

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/agent/health") {
      sendJson(res, 200, { ok: true, service: "vps-os-agent" });
      return;
    }

    if (adminToken && !tokensEqual(extractToken(req), adminToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "POST" && req.url === "/agent/plan") {
      void (async () => {
        const bodyResult = await readJsonBody(req, res);
        if (!bodyResult.ok) return;
        const parsed = bodyResult.data as { goal?: unknown };
        if (typeof parsed.goal !== "string" || !parsed.goal.trim()) {
          sendJson(res, 400, {
            error: "Field 'goal' must be a non-empty string.",
          });
          return;
        }
        const sanitizedGoal = redactSecrets(parsed.goal);
        const knownSlugs = registry.listApps().map((app) => app.slug);
        const storedPlan = registry.savePlan(
          createExecutionPlan(sanitizedGoal, knownSlugs),
        );
        sendJson(res, 200, {
          plan: storedPlan,
          registeredApps: registry.listApps().length,
        });
      })().catch((err: unknown) => {
        const msg = redactSecrets(
          err instanceof Error ? err.message : "Could not plan goal.",
        );
        sendJson(res, 500, { error: msg });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/agent/execute") {
      void (async () => {
        const bodyResult = await readJsonBody(req, res);
        if (!bodyResult.ok) return;
        const parsed = bodyResult.data as {
          planId?: unknown;
          markExecuted?: unknown;
          leaseOwnerId?: unknown;
        };
        if (typeof parsed.planId !== "string" || !parsed.planId.trim()) {
          sendJson(res, 400, {
            error: "Field 'planId' must be a non-empty string.",
          });
          return;
        }
        const planId = parsed.planId.trim();
        const plan = registry.getPlan(planId);
        if (!plan) {
          sendJson(res, 404, {
            error: `Execution plan "${planId}" not found.`,
          });
          return;
        }
        if (plan.status !== "approved") {
          sendJson(res, 409, {
            error: `Plan "${planId}" cannot execute while status is "${plan.status}".`,
          });
          return;
        }

        const callerLease =
          typeof parsed.leaseOwnerId === "string" && parsed.leaseOwnerId.trim()
            ? parsed.leaseOwnerId.trim()
            : undefined;
        let ownLeaseId: string | undefined;

        if (callerLease) {
          if (!registry.isPlanLeaseHeldBy(planId, callerLease)) {
            sendJson(res, 409, {
              error: `Plan "${planId}" is not leased to the caller.`,
            });
            return;
          }
        } else {
          ownLeaseId = `agent-http:${crypto.randomUUID()}`;
          if (!registry.claimPlanExecution(planId, ownLeaseId)) {
            sendJson(res, 409, {
              error: `Plan "${planId}" is already executing.`,
            });
            return;
          }
        }

        try {
          const result = await executeApprovedPlan(plan, {
            registry,
            appsRoot,
            templatesRoot,
            runtimeBridge,
          });
          if (ownLeaseId) {
            if (parsed.markExecuted === true) {
              if (!registry.markPlanExecuted(planId, ownLeaseId)) {
                sendJson(res, 409, {
                  error: `Plan "${planId}" was modified concurrently.`,
                });
                return;
              }
            } else {
              registry.releasePlanExecution(planId, ownLeaseId);
            }
          }
          sendJson(res, 200, {
            summary: redactSecrets(result.summary),
          });
        } catch (err) {
          if (ownLeaseId) {
            registry.releasePlanExecution(planId, ownLeaseId);
          }
          const statusCode =
            err instanceof PlanExecutionError ? err.statusCode : 500;
          const message = redactSecrets(
            err instanceof Error ? err.message : "Plan execution failed.",
          );
          sendJson(res, statusCode, { error: message });
        }
      })().catch((err: unknown) => {
        const msg = redactSecrets(
          err instanceof Error ? err.message : "Plan execution failed.",
        );
        sendJson(res, 500, { error: msg });
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.on("close", () => registry.close());
  return { server, registry };
}

/** Starts the lightweight Agent Runtime HTTP service when run directly. */
export function startAgentServer(
  options: AgentServerOptions = {},
): http.Server {
  const port = options.port ?? Number(process.env.PORT ?? 3002);
  const { server } = createAgentHttpServer(options);
  return server.listen(port);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  const token = process.env.VPS_OS_ADMIN_TOKEN?.trim();
  if (
    !token ||
    token.startsWith("replace-with-") ||
    token.length < MIN_ADMIN_TOKEN_LENGTH
  ) {
    console.error(
      `Fatal: VPS_OS_ADMIN_TOKEN must be configured with a non-placeholder secret of at least ${MIN_ADMIN_TOKEN_LENGTH} characters.`,
    );
    process.exit(1);
  }
  const runtimeBridge = createRuntimeBridgeFromEnv();
  const server = startAgentServer({
    adminToken: token,
    ...(runtimeBridge ? { runtimeBridge } : {}),
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
