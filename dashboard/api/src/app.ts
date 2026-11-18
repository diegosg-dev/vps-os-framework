import crypto from "node:crypto";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { createExecutionPlan } from "@vps-os/agent";
import {
  ApprovalDecisionSchema,
  type AppRecord,
  type AppStatus,
  type PlanStatus,
  PlanStatusSchema,
  type StoredPlan,
  type SystemMetrics,
  type SystemRegistryStore,
  redactSecrets,
  validateAppSlug,
} from "@vps-os/shared";
import {
  type DiskMetrics,
  collectDiskMetrics,
  collectSystemMetrics,
} from "./metrics.js";
import { readStaticUiAssetAsync } from "./static.js";

export type AppLifecycleAction = "start" | "stop" | "restart";

export interface WorkloadController {
  control(
    slug: string,
    action: AppLifecycleAction,
  ): Promise<{ status: AppStatus }> | { status: AppStatus };
  getLogs(slug: string, tail: number): Promise<string[]> | string[];
}

export interface PlanExecutionResult {
  summary: string;
}

export interface DashboardAppDeps {
  registry: SystemRegistryStore;
  adminToken?: string;
  allowUnauthenticated?: boolean;
  webDistDir?: string;
  getMetrics?: () => SystemMetrics;
  getDiskMetrics?: () => DiskMetrics | null;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  maxRateLimitKeys?: number;
  trustProxy?: boolean;
  maxBodyBytes?: number;
  workloadController?: WorkloadController;
  executePlan?: (
    plan: StoredPlan,
  ) => Promise<PlanExecutionResult> | PlanExecutionResult;
}

export interface AppView {
  slug: string;
  name: string;
  kind: AppRecord["kind"];
  domain: string | null;
  status: AppRecord["status"];
  cpuLimit: string;
  memoryLimitMb: number;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_RATE_LIMIT_KEYS = 10_000;

const ChatPlanRequestSchema = z.object({
  goal: z.string().trim().min(1).max(1000),
});

const ExecutePlanRequestSchema = z.object({
  planId: z.string().trim().min(1).max(128),
});

const LifecycleRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
});

const AuditLimitQuerySchema = z.coerce.number().int().min(1).max(500);
const PlansLimitQuerySchema = z.coerce.number().int().min(1).max(100);
const LogsTailQuerySchema = z.coerce.number().int().min(1).max(500);

function toAppView(app: AppRecord): AppView {
  return {
    slug: app.slug,
    name: app.name,
    kind: app.kind,
    domain: app.domain,
    status: app.status,
    cpuLimit: app.cpuLimit,
    memoryLimitMb: app.memoryLimitMb,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

function sha256Digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return crypto.timingSafeEqual(sha256Digest(provided), sha256Digest(expected));
}

function extractRequestToken(
  authHeader: string | undefined,
  headerToken: string | undefined,
): string | undefined {
  if (headerToken?.trim()) {
    return headerToken.trim();
  }
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return token || undefined;
  }
  return undefined;
}

function resolveClientKey(c: Context, trustProxy: boolean): string {
  if (!trustProxy) {
    return "local";
  }
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const trustedHop = parts.at(-1);
    if (trustedHop) {
      return trustedHop;
    }
  }
  const realIp = c.req.header("x-real-ip")?.trim();
  return realIp || "local";
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large.");
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super("Invalid JSON body.");
  }
}

async function readJsonBody(c: Context, maxBodyBytes: number): Promise<unknown> {
  const declaredLen = c.req.header("content-length");
  if (declaredLen !== undefined) {
    const parsedLen = Number(declaredLen);
    if (Number.isFinite(parsedLen) && parsedLen > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
  }

  let rawText: string;
  const bodyStream = c.req.raw.body;
  if (bodyStream) {
    const reader = bodyStream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBodyBytes) {
            await reader.cancel().catch(() => undefined);
            throw new PayloadTooLargeError();
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    rawText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8",
    );
  } else {
    rawText = await c.req.text();
    if (Buffer.byteLength(rawText, "utf8") > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

function handleBodyReadError(c: Context, err: unknown): Response {
  if (err instanceof PayloadTooLargeError) {
    return c.json({ error: err.message }, 413);
  }
  if (err instanceof InvalidJsonError) {
    return c.json({ error: err.message }, 400);
  }
  return c.json({ error: "Invalid request body." }, 400);
}

/**
 * Creates the Dashboard Control API (Step 4) Hono application.
 * Enforces fail-closed bearer-token auth, sliding-window rate limits,
 * request body size caps, security headers, and safe static UI delivery.
 */
export function createDashboardApp(deps: DashboardAppDeps): Hono {
  const trimmedToken = deps.adminToken?.trim();
  if (!trimmedToken && deps.allowUnauthenticated !== true) {
    throw new Error(
      "createDashboardApp requires a non-empty adminToken unless allowUnauthenticated is explicitly true.",
    );
  }

  const app = new Hono();
  const getMetrics = deps.getMetrics ?? collectSystemMetrics;
  const getDisk = deps.getDiskMetrics ?? collectDiskMetrics;
  const maxRequests = Math.max(1, deps.rateLimitMax ?? 120);
  const windowMs = Math.max(100, deps.rateLimitWindowMs ?? 60_000);
  const maxRateLimitKeys = Math.max(
    1,
    deps.maxRateLimitKeys ?? DEFAULT_MAX_RATE_LIMIT_KEYS,
  );
  const maxBodyBytes = Math.max(256, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const trustProxy = deps.trustProxy ?? false;

  // Sliding-window timestamp queues keyed by client identifier.
  const requestBuckets = new Map<string, number[]>();
  const inFlightExecutions = new Set<string>();

  function pruneExpiredBuckets(now: number): void {
    const cutoff = now - windowMs;
    for (const [key, timestamps] of requestBuckets) {
      const fresh = timestamps.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        requestBuckets.delete(key);
      } else if (fresh.length !== timestamps.length) {
        requestBuckets.set(key, fresh);
      }
    }
  }

  app.onError((err, c) => {
    const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err));
    console.error(`[dashboard-api] Unhandled error: ${safeMsg}`);
    return c.json({ error: "Internal server error." }, 500);
  });

  app.notFound((c) => {
    return c.json({ error: "Not found." }, 404);
  });

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");

    if (c.req.path === "/api/health") {
      await next();
      return;
    }

    const now = Date.now();
    const cutoff = now - windowMs;
    const clientKey = resolveClientKey(c, trustProxy);

    if (!requestBuckets.has(clientKey) && requestBuckets.size >= maxRateLimitKeys) {
      pruneExpiredBuckets(now);
      while (requestBuckets.size >= maxRateLimitKeys) {
        const oldestKey = requestBuckets.keys().next().value;
        if (oldestKey === undefined) break;
        requestBuckets.delete(oldestKey);
      }
    }

    const existing = requestBuckets.get(clientKey) ?? [];
    const active = existing.filter((ts) => ts > cutoff);

    if (active.length >= maxRequests) {
      const oldestActive = active[0] ?? now;
      const retryAfterSec = Math.max(
        1,
        Math.ceil((oldestActive + windowMs - now) / 1000),
      );
      requestBuckets.set(clientKey, active);
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: "Rate limit exceeded." }, 429);
    }

    active.push(now);
    requestBuckets.delete(clientKey);
    requestBuckets.set(clientKey, active);

    if (trimmedToken) {
      const provided = extractRequestToken(
        c.req.header("authorization"),
        c.req.header("x-vps-os-token"),
      );
      if (!tokensEqual(provided, trimmedToken)) {
        return c.json({ error: "Unauthorized." }, 401);
      }
    }

    await next();
  });

  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      service: "vps-os-dashboard-api",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/system/metrics", (c) => {
    const metrics = getMetrics();
    const disk = getDisk();
    return c.json(disk ? { ...metrics, disk } : metrics);
  });

  app.get("/api/apps", (c) => {
    return c.json({ apps: deps.registry.listApps().map(toAppView) });
  });

  app.get("/api/apps/:slug", (c) => {
    let safeSlug: string;
    try {
      safeSlug = validateAppSlug(c.req.param("slug"));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid app slug." },
        400,
      );
    }
    const appRecord = deps.registry.getAppBySlug(safeSlug);
    if (!appRecord) {
      return c.json({ error: `App "${safeSlug}" not found.` }, 404);
    }
    return c.json({ app: toAppView(appRecord) });
  });

  app.post("/api/apps/:slug/lifecycle", async (c) => {
    let safeSlug: string;
    try {
      safeSlug = validateAppSlug(c.req.param("slug"));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid app slug." },
        400,
      );
    }

    let body: unknown;
    try {
      body = await readJsonBody(c, maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = LifecycleRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const existing = deps.registry.getAppBySlug(safeSlug);
    if (!existing) {
      return c.json({ error: `App "${safeSlug}" not found.` }, 404);
    }

    if (!deps.workloadController) {
      return c.json(
        { error: "Workload runtime controller is not configured." },
        501,
      );
    }

    const outcome = await deps.workloadController.control(
      safeSlug,
      parsed.data.action,
    );
    const updatedAt = new Date().toISOString();
    deps.registry.updateAppStatus(safeSlug, outcome.status, updatedAt);

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: `app.${parsed.data.action}`,
      targetSlug: safeSlug,
      summary: `${parsed.data.action} requested on ${safeSlug} -> ${outcome.status}`,
      riskLevel: parsed.data.action === "stop" ? "medium" : "low",
      createdAt: updatedAt,
    });

    const refreshed = deps.registry.getAppBySlug(safeSlug);
    return c.json({ app: refreshed ? toAppView(refreshed) : null });
  });

  app.get("/api/apps/:slug/logs", async (c) => {
    let safeSlug: string;
    try {
      safeSlug = validateAppSlug(c.req.param("slug"));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid app slug." },
        400,
      );
    }

    const rawTail = c.req.query("tail");
    let tail = 100;
    if (rawTail !== undefined) {
      const parsedTail = LogsTailQuerySchema.safeParse(rawTail);
      if (!parsedTail.success) {
        return c.json(
          { error: "Query 'tail' must be an integer between 1 and 500." },
          400,
        );
      }
      tail = parsedTail.data;
    }

    const existing = deps.registry.getAppBySlug(safeSlug);
    if (!existing) {
      return c.json({ error: `App "${safeSlug}" not found.` }, 404);
    }

    if (!deps.workloadController) {
      return c.json(
        { error: "Workload runtime controller is not configured." },
        501,
      );
    }

    const rawLines = await deps.workloadController.getLogs(safeSlug, tail);
    const lines = rawLines.slice(-tail).map((line) => redactSecrets(line));
    return c.json({ slug: safeSlug, lines });
  });

  app.get("/api/audit", (c) => {
    const rawLimit = c.req.query("limit");
    let limit = 25;
    if (rawLimit !== undefined) {
      const parsedLimit = AuditLimitQuerySchema.safeParse(rawLimit);
      if (!parsedLimit.success) {
        return c.json(
          { error: "Query 'limit' must be an integer between 1 and 500." },
          400,
        );
      }
      limit = parsedLimit.data;
    }
    return c.json({ events: deps.registry.listAuditEvents(limit) });
  });

  app.get("/api/chat/plans", (c) => {
    const rawStatus = c.req.query("status");
    let status: PlanStatus | undefined;
    if (rawStatus !== undefined) {
      const parsedStatus = PlanStatusSchema.safeParse(rawStatus);
      if (!parsedStatus.success) {
        return c.json({ error: "Invalid 'status' filter." }, 400);
      }
      status = parsedStatus.data;
    }

    const rawLimit = c.req.query("limit");
    let limit = 20;
    if (rawLimit !== undefined) {
      const parsedLimit = PlansLimitQuerySchema.safeParse(rawLimit);
      if (!parsedLimit.success) {
        return c.json(
          { error: "Query 'limit' must be an integer between 1 and 100." },
          400,
        );
      }
      limit = parsedLimit.data;
    }

    return c.json({
      plans: deps.registry.listPlans({
        ...(status ? { status } : {}),
        limit,
      }),
    });
  });

  app.get("/api/chat/plans/:id", (c) => {
    const planId = c.req.param("id").trim();
    if (!planId) {
      return c.json({ error: "Plan ID is required." }, 400);
    }
    const plan = deps.registry.getPlan(planId);
    if (!plan) {
      return c.json({ error: `Execution plan "${planId}" not found.` }, 404);
    }
    return c.json({ plan });
  });

  app.post("/api/chat/plan", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ChatPlanRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const sanitizedGoal = redactSecrets(parsed.data.goal);
    const storedPlan = deps.registry.savePlan(createExecutionPlan(sanitizedGoal));

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "chat.plan_requested",
      targetSlug: null,
      summary: `Planned goal: ${sanitizedGoal.slice(0, 120)}`,
      riskLevel: storedPlan.requiresUserApproval ? "medium" : "low",
      createdAt: new Date().toISOString(),
    });

    return c.json({ plan: storedPlan });
  });

  app.post("/api/chat/approve", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ApprovalDecisionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const existing = deps.registry.getPlan(parsed.data.planId);
    if (!existing) {
      return c.json(
        { error: `Execution plan "${parsed.data.planId}" not found.` },
        404,
      );
    }
    if (existing.status !== "pending") {
      return c.json(
        {
          error: `Execution plan "${parsed.data.planId}" is already "${existing.status}" and cannot be re-decided.`,
        },
        409,
      );
    }

    try {
      const updatedPlan = deps.registry.recordApproval(parsed.data);
      deps.registry.recordAudit({
        id: crypto.randomUUID(),
        actor: "user",
        action: parsed.data.approved ? "chat.plan_approved" : "chat.plan_rejected",
        targetSlug: null,
        summary: `${parsed.data.approved ? "Approved" : "Rejected"} plan ${parsed.data.planId}`,
        riskLevel: "medium",
        createdAt: new Date().toISOString(),
      });
      return c.json({ plan: updatedPlan });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not record approval.";
      return c.json({ error: message }, 409);
    }
  });

  app.post("/api/chat/execute", async (c) => {
    let body: unknown;
    try {
      body = await readJsonBody(c, maxBodyBytes);
    } catch (err) {
      return handleBodyReadError(c, err);
    }

    const parsed = ExecutePlanRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
      );
    }

    const existing = deps.registry.getPlan(parsed.data.planId);
    if (!existing) {
      return c.json(
        { error: `Execution plan "${parsed.data.planId}" not found.` },
        404,
      );
    }
    if (existing.status !== "approved") {
      return c.json(
        {
          error: `Plan "${existing.id}" cannot execute while status is "${existing.status}".`,
        },
        409,
      );
    }

    if (!deps.executePlan) {
      return c.json({ error: "Plan execution runtime is not configured." }, 501);
    }

    if (inFlightExecutions.has(existing.id)) {
      return c.json(
        { error: `Plan "${existing.id}" is already executing.` },
        409,
      );
    }

    inFlightExecutions.add(existing.id);
    let execution: PlanExecutionResult;
    try {
      execution = await deps.executePlan(existing);
    } finally {
      inFlightExecutions.delete(existing.id);
    }

    const transitioned = deps.registry.markPlanExecuted(existing.id);
    if (!transitioned) {
      return c.json(
        { error: `Plan "${existing.id}" was already executed or modified.` },
        409,
      );
    }

    deps.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "user",
      action: "chat.plan_executed",
      targetSlug: null,
      summary: redactSecrets(`Executed plan ${existing.id}: ${execution.summary}`),
      riskLevel: existing.requiresUserApproval ? "medium" : "low",
      createdAt: new Date().toISOString(),
    });

    return c.json({
      plan: deps.registry.getPlan(existing.id),
      execution: {
        summary: redactSecrets(execution.summary),
      },
    });
  });

  // Ensure unknown /api/* paths always return JSON 404 rather than SPA index.html.
  app.all("/api/*", (c) => {
    return c.json({ error: "API endpoint not found." }, 404);
  });

  if (deps.webDistDir) {
    const webDir = deps.webDistDir;
    app.get("*", async (c) => {
      const asset = await readStaticUiAssetAsync(webDir, c.req.path);
      if (!asset) {
        return c.json({ error: "Not found" }, 404);
      }
      return new Response(new Uint8Array(asset.body), {
        status: 200,
        headers: {
          "content-type": asset.contentType,
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        },
      });
    });
  }

  return app;
}
