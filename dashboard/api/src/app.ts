import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { createExecutionPlan } from "@vps-os/agent";
import {
  ApprovalDecisionSchema,
  type SystemMetrics,
  type SystemRegistryStore,
  redactSecrets,
} from "@vps-os/shared";
import { collectSystemMetrics } from "./metrics.js";
import { readStaticUiAsset } from "./static.js";

export interface DashboardAppDeps {
  registry: SystemRegistryStore;
  adminToken?: string;
  webDistDir?: string;
  getMetrics?: () => SystemMetrics;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

const ChatPlanRequestSchema = z.object({
  goal: z.string().trim().min(1).max(1000),
});

function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractRequestToken(
  authHeader: string | undefined,
  headerToken: string | undefined,
): string | undefined {
  if (headerToken?.trim()) {
    return headerToken.trim();
  }
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return undefined;
}

/**
 * Creates the Dashboard Control API (Step 4) Hono application.
 * Enforces bearer-token auth, sliding-window rate limits, and optional static UI delivery.
 */
export function createDashboardApp(deps: DashboardAppDeps): Hono {
  const app = new Hono();
  const getMetrics = deps.getMetrics ?? collectSystemMetrics;
  const maxRequests = deps.rateLimitMax ?? 120;
  const windowMs = deps.rateLimitWindowMs ?? 60_000;
  const requestBuckets = new Map<string, { count: number; resetAt: number }>();

  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      service: "vps-os-dashboard-api",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") {
      await next();
      return;
    }

    const now = Date.now();
    const clientKey =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const bucket = requestBuckets.get(clientKey);
    if (!bucket || now >= bucket.resetAt) {
      requestBuckets.set(clientKey, { count: 1, resetAt: now + windowMs });
    } else {
      bucket.count += 1;
      if (bucket.count > maxRequests) {
        return c.json({ error: "Rate limit exceeded." }, 429);
      }
    }

    if (deps.adminToken) {
      const provided = extractRequestToken(
        c.req.header("authorization"),
        c.req.header("x-vps-os-token"),
      );
      if (!tokensEqual(provided, deps.adminToken)) {
        return c.json({ error: "Unauthorized." }, 401);
      }
    }

    await next();
  });

  app.get("/api/system/metrics", (c) => {
    return c.json(getMetrics());
  });

  app.get("/api/apps", (c) => {
    return c.json({ apps: deps.registry.listApps() });
  });

  app.get("/api/audit", (c) => {
    const rawLimit = Number(c.req.query("limit") ?? "25");
    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    return c.json({ events: deps.registry.listAuditEvents(limit) });
  });

  app.post("/api/chat/plan", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
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
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
    }

    const parsed = ApprovalDecisionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed.", issues: parsed.error.issues },
        400,
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
      const status = message.includes("not found") ? 404 : 409;
      return c.json({ error: message }, status);
    }
  });

  if (deps.webDistDir) {
    const webDir = deps.webDistDir;
    app.get("*", (c) => {
      const asset = readStaticUiAsset(webDir, c.req.path);
      if (!asset) {
        return c.json({ error: "Not found" }, 404);
      }
      return new Response(new Uint8Array(asset.body), {
        status: 200,
        headers: { "content-type": asset.contentType },
      });
    });
  }

  return app;
}
