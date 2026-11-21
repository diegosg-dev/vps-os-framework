import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectDiskMetrics,
  collectSystemMetrics,
  createDashboardApp,
  readStaticUiAsset,
} from "@vps-os/dashboard-api";
import { SystemRegistryStore } from "@vps-os/shared";

test("createDashboardApp fails closed when adminToken is omitted unless allowUnauthenticated is true", () => {
  const registry = new SystemRegistryStore(":memory:");
  try {
    assert.throws(() => createDashboardApp({ registry }), /requires a non-empty adminToken/);
    assert.throws(
      () => createDashboardApp({ registry, adminToken: "   " }),
      /requires a non-empty adminToken/,
    );
    const unauthApp = createDashboardApp({ registry, allowUnauthenticated: true });
    assert.ok(unauthApp);
  } finally {
    registry.close();
  }
});

test("Dashboard Control API enforces auth, security headers, approval immutability, and static UI", async () => {
  const tempWebDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-web-"));
  fs.writeFileSync(path.join(tempWebDir, "index.html"), "<html><body>VPS OS</body></html>");
  fs.mkdirSync(path.join(tempWebDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(tempWebDir, "assets/app.js"), "console.log('ok');");

  const registry = new SystemRegistryStore(":memory:");
  const app = createDashboardApp({
    registry,
    adminToken: "test-admin-token-long",
    webDistDir: tempWebDir,
    rateLimitMax: 40,
  });

  const authHeaders = { authorization: "Bearer test-admin-token-long" };
  const altHeader = { "x-vps-os-token": "test-admin-token-long" };

  try {
    // Public health + static UI work without token and carry security headers
    const healthRes = await app.request("/api/health");
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("cache-control"), "no-store");
    assert.equal(healthRes.headers.get("x-content-type-options"), "nosniff");

    const uiRes = await app.request("/");
    assert.equal(uiRes.status, 200);
    assert.match(await uiRes.text(), /VPS OS/);
    assert.equal(uiRes.headers.get("x-frame-options"), "DENY");
    assert.match(uiRes.headers.get("content-security-policy") ?? "", /default-src 'self'/);

    // Missing asset file must return 404, not SPA index.html
    const missingAssetRes = await app.request("/assets/missing.js");
    assert.equal(missingAssetRes.status, 404);

    // Unknown /api/* route must return JSON 404, never SPA index.html
    const unknownApiRes = await app.request("/api/does-not-exist", {
      headers: authHeaders,
    });
    assert.equal(unknownApiRes.status, 404);
    assert.match(unknownApiRes.headers.get("content-type") ?? "", /application\/json/);

    // Protected endpoints require valid token (both Bearer and x-vps-os-token)
    assert.equal((await app.request("/api/system/metrics")).status, 401);
    assert.equal(
      (await app.request("/api/system/metrics", { headers: { authorization: "Bearer short" } })).status,
      401,
    );

    const metricsRes = await app.request("/api/system/metrics", {
      headers: altHeader,
    });
    assert.equal(metricsRes.status, 200);
    const metricsJson = (await metricsRes.json()) as { cpuCount: number };
    assert.equal(metricsJson.cpuCount >= 1, true);

    // Malformed JSON & invalid audit query return 400
    const badJsonRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: "{not-json",
    });
    assert.equal(badJsonRes.status, 400);

    assert.equal(
      (await app.request("/api/audit?limit=2.5", { headers: authHeaders })).status,
      400,
    );
    assert.equal(
      (await app.request("/api/audit?limit=0", { headers: authHeaders })).status,
      400,
    );

    const chatRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        goal: "Deploy CRM app with API_KEY=sk-secret99999999",
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatJson = (await chatRes.json()) as {
      plan: { id: string; requiresUserApproval: boolean; goal: string; status: string };
    };
    assert.equal(chatJson.plan.requiresUserApproval, true);
    assert.equal(chatJson.plan.status, "pending");
    assert.equal(chatJson.plan.goal.includes("sk-secret99999999"), false);

    // Plan listing & retrieval endpoints restore pending plans
    const listPlansRes = await app.request("/api/chat/plans?status=pending", {
      headers: authHeaders,
    });
    assert.equal(listPlansRes.status, 200);
    const listPlansJson = (await listPlansRes.json()) as { plans: Array<{ id: string }> };
    assert.equal(listPlansJson.plans.some((p) => p.id === chatJson.plan.id), true);

    const getPlanRes = await app.request(`/api/chat/plans/${chatJson.plan.id}`, {
      headers: authHeaders,
    });
    assert.equal(getPlanRes.status, 200);

    // Unknown plan returns 404 on approve
    const missingApproveRes = await app.request("/api/chat/approve", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        planId: "non-existent",
        approved: true,
        decidedBy: "admin",
      }),
    });
    assert.equal(missingApproveRes.status, 404);

    // Approve the plan via Control API
    const approveRes = await app.request("/api/chat/approve", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        planId: chatJson.plan.id,
        approved: true,
        decidedBy: "admin",
      }),
    });
    assert.equal(approveRes.status, 200);
    const approveJson = (await approveRes.json()) as { plan: { status: string } };
    assert.equal(approveJson.plan.status, "approved");

    // Re-deciding an already decided plan is blocked with 409
    const redecideRes = await app.request("/api/chat/approve", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        planId: chatJson.plan.id,
        approved: false,
        decidedBy: "admin",
      }),
    });
    assert.equal(redecideRes.status, 409);

    const auditRes = await app.request("/api/audit?limit=10", { headers: authHeaders });
    assert.equal(auditRes.status, 200);
    const auditJson = (await auditRes.json()) as {
      events: Array<{ summary: string }>;
    };
    assert.equal(auditJson.events.length, 2);
    assert.equal(
      auditJson.events.every((e) => !e.summary.includes("sk-secret99999999")),
      true,
    );
  } finally {
    registry.close();
    fs.rmSync(tempWebDir, { recursive: true, force: true });
  }
});

test("Dashboard Control API blocks XFF spoofing, caps request body size, and bounds rate-limit buckets", async () => {
  const registry = new SystemRegistryStore(":memory:");
  const app = createDashboardApp({
    registry,
    adminToken: "token-1234567890",
    rateLimitMax: 2,
    rateLimitWindowMs: 60_000,
    maxBodyBytes: 512,
    trustProxy: false,
  });

  const bodyCapApp = createDashboardApp({
    registry,
    adminToken: "token-1234567890",
    rateLimitMax: 10,
    maxBodyBytes: 512,
  });

  const proxyApp = createDashboardApp({
    registry,
    adminToken: "token-1234567890",
    rateLimitMax: 2,
    rateLimitWindowMs: 60_000,
    maxRateLimitKeys: 2,
    trustProxy: true,
  });

  try {
    const headers = { authorization: "Bearer token-1234567890" };

    // Rotating X-Forwarded-For must NOT bypass rate limits when trustProxy is false
    assert.equal(
      (await app.request("/api/apps", { headers: { ...headers, "x-forwarded-for": "1.1.1.1" } })).status,
      200,
    );
    assert.equal(
      (await app.request("/api/apps", { headers: { ...headers, "x-forwarded-for": "2.2.2.2" } })).status,
      200,
    );
    const limited = await app.request("/api/apps", {
      headers: { ...headers, "x-forwarded-for": "3.3.3.3" },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);

    // Oversized body returns 413 (both with Content-Length and chunked stream without Content-Length)
    const hugeBody = JSON.stringify({ goal: "a".repeat(1024) });
    const tooLargeRes = await bodyCapApp.request("/api/chat/plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: hugeBody,
    });
    assert.equal(tooLargeRes.status, 413);

    const chunkedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"goal":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(700)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const streamReq = new Request("http://localhost/api/chat/plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: chunkedStream,
      duplex: "half",
    } as RequestInit);
    const streamTooLargeRes = await bodyCapApp.request(streamReq);
    assert.equal(streamTooLargeRes.status, 413);

    // When trustProxy is true, last hop IP is honored and maxRateLimitKeys bounds memory
    assert.equal(
      (await proxyApp.request("/api/apps", { headers: { ...headers, "x-forwarded-for": "9.9.9.9, 10.0.0.1" } })).status,
      200,
    );
    assert.equal(
      (await proxyApp.request("/api/apps", { headers: { ...headers, "x-forwarded-for": "8.8.8.8, 10.0.0.1" } })).status,
      200,
    );
    assert.equal(
      (await proxyApp.request("/api/apps", { headers: { ...headers, "x-forwarded-for": "7.7.7.7, 10.0.0.1" } })).status,
      429,
    );
  } finally {
    registry.close();
  }
});

test("Dashboard Control API supports app detail, lifecycle, redacted logs, and plan execution", async () => {
  const registry = new SystemRegistryStore(":memory:");
  const now = new Date().toISOString();
  registry.upsertApp({
    slug: "crm-portal",
    name: "CRM Portal",
    kind: "web-app",
    domain: "crm.example.com",
    folderPath: "/apps/crm-portal",
    internalPort: 8080,
    status: "stopped",
    cpuLimit: "1.0",
    memoryLimitMb: 1024,
    createdAt: now,
    updatedAt: now,
  });

  const app = createDashboardApp({
    registry,
    adminToken: "control-api-secret-token",
    workloadController: {
      control: (_slug, action) => ({
        status: action === "stop" ? "stopped" : "running",
      }),
      getLogs: () => [
        "Listening on :8080",
        "Connected with API_KEY=sk-secret1234567890",
      ],
    },
    executePlan: async (plan) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        summary: `Executed ${plan.steps.length} steps for ${plan.id}`,
      };
    },
  });

  const headers = { authorization: "Bearer control-api-secret-token" };

  try {
    // Sanitized app view omits folderPath and internalPort
    const detailRes = await app.request("/api/apps/crm-portal", { headers });
    assert.equal(detailRes.status, 200);
    const detailJson = (await detailRes.json()) as { app: Record<string, unknown> };
    assert.equal("folderPath" in detailJson.app, false);
    assert.equal("internalPort" in detailJson.app, false);

    assert.equal((await app.request("/api/apps/Bad_Slug", { headers })).status, 400);
    assert.equal((await app.request("/api/apps/missing-app", { headers })).status, 404);

    const startRes = await app.request("/api/apps/crm-portal/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(startRes.status, 200);
    const startJson = (await startRes.json()) as { app: { status: string } };
    assert.equal(startJson.app.status, "running");

    const logsRes = await app.request("/api/apps/crm-portal/logs?tail=10", { headers });
    assert.equal(logsRes.status, 200);
    const logsJson = (await logsRes.json()) as { lines: string[] };
    assert.equal(
      logsJson.lines.some((line) => line.includes("sk-secret1234567890")),
      false,
    );

    // Plan -> Approve -> Execute -> Replay blocked
    const planRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ goal: "Deploy billing app" }),
    });
    const { plan } = (await planRes.json()) as { plan: { id: string } };

    const chatThread = registry.createChatThread({
      id: "plan-followup-thread",
      title: "Plan Followup",
      provider: "opencode",
      model: "glm-5.3",
      createdAt: new Date().toISOString(),
    });
    registry.appendChatMessage({
      id: "plan-origin-msg",
      threadId: chatThread.id,
      role: "assistant",
      content: "Review the plan below.",
      attachments: [],
      reasoning: [],
      toolCalls: [],
      planId: plan.id,
      provider: "opencode",
      model: "glm-5.3",
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    // Cannot execute while pending
    const earlyExec = await app.request("/api/chat/execute", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ planId: plan.id }),
    });
    assert.equal(earlyExec.status, 409);

    await app.request("/api/chat/approve", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ planId: plan.id, approved: true, decidedBy: "admin" }),
    });

    const [execResA, execResB] = await Promise.all([
      app.request("/api/chat/execute", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ planId: plan.id }),
      }),
      app.request("/api/chat/execute", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ planId: plan.id }),
      }),
    ]);
    const execStatuses = [execResA.status, execResB.status].sort();
    assert.deepEqual(execStatuses, [200, 409]);

    const okExec = execResA.status === 200 ? execResA : execResB;
    const execJson = (await okExec.json()) as {
      plan: { status: string };
      followUpMessage?: {
        id: string;
        threadId: string;
        role: string;
        content: string;
        reasoning: Array<{ title: string }>;
        toolCalls: Array<{ toolName: string; status: string }>;
      };
    };
    assert.equal(execJson.plan.status, "executed");
    assert.equal(execJson.followUpMessage?.threadId, chatThread.id);
    assert.equal(execJson.followUpMessage?.role, "assistant");
    assert.ok((execJson.followUpMessage?.reasoning.length ?? 0) >= 1);
    assert.ok(
      execJson.followUpMessage?.toolCalls.some(
        (tc) => tc.toolName === "execute_plan" && tc.status === "success",
      ),
    );
    assert.ok(
      execJson.followUpMessage?.toolCalls.some(
        (tc) => tc.toolName === "inspect_apps" && tc.status === "success",
      ),
    );
    assert.match(execJson.followUpMessage?.content ?? "", /Plan Executed/);
    assert.match(execJson.followUpMessage?.content ?? "", /Steps completed:/);
    const threadMsgs = registry.listChatMessages(chatThread.id);
    assert.equal(threadMsgs.length, 2);
    assert.equal(threadMsgs[1]?.id, execJson.followUpMessage?.id);

    // Replay blocked
    const replayExec = await app.request("/api/chat/execute", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ planId: plan.id }),
    });
    assert.equal(replayExec.status, 409);
  } finally {
    registry.close();
  }
});

test("readStaticUiAsset blocks traversal and symlinks, and metrics helpers succeed", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-static-"));
  const distDir = path.join(tempRoot, "dist");
  const outsideDir = path.join(tempRoot, "outside");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<html>ok</html>");
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top-secret");

  try {
    assert.equal(readStaticUiAsset(distDir, "/../../etc/passwd"), null);
    assert.equal(readStaticUiAsset(distDir, "/%2e%2e/outside/secret.txt"), null);
    assert.equal(readStaticUiAsset(distDir, "/missing.js"), null);
    assert.ok(readStaticUiAsset(distDir, "/apps/crm-portal"));

    const symlinkPath = path.join(distDir, "escape.txt");
    try {
      fs.symlinkSync(path.join(outsideDir, "secret.txt"), symlinkPath);
      assert.equal(readStaticUiAsset(distDir, "/escape.txt"), null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") {
        throw err;
      }
    }

    const metrics = collectSystemMetrics();
    assert.equal(metrics.cpuCount >= 1, true);
    const disk = collectDiskMetrics();
    assert.ok(disk === null || disk.totalMb >= 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Dashboard Control API exposes bounded telemetry history with auth and limit validation", async () => {
  const registry = new SystemRegistryStore(":memory:");
  let tick = 0;
  const app = createDashboardApp({
    registry,
    adminToken: "metrics-history-token-1234",
    getMetrics: () => {
      tick++;
      return {
        hostname: "prod-01",
        platform: "linux",
        uptimeSeconds: 1000 + tick * 15,
        cpuCount: 4,
        loadAverage1m: 0.4 + tick * 0.1,
        memoryTotalMb: 8192,
        memoryUsedMb: 2048 + tick * 128,
        memoryUsagePercent: 25 + tick * 1.5,
        collectedAt: new Date(Date.UTC(2026, 10, 20, 12, 0, tick * 10)).toISOString(),
      };
    },
    getDiskMetrics: () => ({
      mountPath: "/",
      totalMb: 102400,
      usedMb: 30720,
      usagePercent: 30,
    }),
  });

  const headers = { authorization: "Bearer metrics-history-token-1234" };

  try {
    // Requires auth
    assert.equal((await app.request("/api/system/metrics/history")).status, 401);

    // Invalid limit rejected with 400
    assert.equal(
      (await app.request("/api/system/metrics/history?limit=0", { headers })).status,
      400,
    );
    assert.equal(
      (await app.request("/api/system/metrics/history?limit=120", { headers })).status,
      400,
    );

    // Polling /api/system/metrics populates bounded history
    assert.equal((await app.request("/api/system/metrics", { headers })).status, 200);
    assert.equal((await app.request("/api/system/metrics", { headers })).status, 200);
    assert.equal((await app.request("/api/system/metrics", { headers })).status, 200);

    const histRes = await app.request("/api/system/metrics/history?limit=2", { headers });
    assert.equal(histRes.status, 200);
    const histJson = (await histRes.json()) as {
      samples: Array<{ cpuLoadPercent: number; memoryUsagePercent: number; diskUsagePercent: number | null }>;
    };
    assert.equal(histJson.samples.length, 2);
    assert.equal(histJson.samples[1]!.diskUsagePercent, 30);
    assert.equal(histJson.samples[1]!.memoryUsagePercent > histJson.samples[0]!.memoryUsagePercent, true);
  } finally {
    registry.close();
  }
});
