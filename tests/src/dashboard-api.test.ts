import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "@vps-os/dashboard-api";
import { SystemRegistryStore } from "@vps-os/shared";

test("Dashboard Control API enforces auth, rate limits, approval flow, and static UI", async () => {
  const tempWebDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-web-"));
  fs.writeFileSync(path.join(tempWebDir, "index.html"), "<html><body>VPS OS</body></html>");

  const registry = new SystemRegistryStore(":memory:");
  const app = createDashboardApp({
    registry,
    adminToken: "test-admin-token",
    webDistDir: tempWebDir,
    rateLimitMax: 20,
  });

  const authHeaders = { authorization: "Bearer test-admin-token" };

  try {
    // Public health + static UI work without token
    const healthRes = await app.request("/api/health");
    assert.equal(healthRes.status, 200);

    const uiRes = await app.request("/");
    assert.equal(uiRes.status, 200);
    assert.match(await uiRes.text(), /VPS OS/);

    // Protected endpoints require valid token
    const unauthMetrics = await app.request("/api/system/metrics");
    assert.equal(unauthMetrics.status, 401);

    const metricsRes = await app.request("/api/system/metrics", {
      headers: authHeaders,
    });
    assert.equal(metricsRes.status, 200);
    const metricsJson = (await metricsRes.json()) as { cpuCount: number };
    assert.equal(metricsJson.cpuCount >= 1, true);

    const appsRes = await app.request("/api/apps", { headers: authHeaders });
    assert.equal(appsRes.status, 200);
    assert.deepEqual(await appsRes.json(), { apps: [] });

    const badChatRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ goal: "   " }),
    });
    assert.equal(badChatRes.status, 400);

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

    const auditRes = await app.request("/api/audit", { headers: authHeaders });
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

test("Dashboard Control API enforces sliding-window rate limiting", async () => {
  const registry = new SystemRegistryStore(":memory:");
  const app = createDashboardApp({
    registry,
    adminToken: "token",
    rateLimitMax: 2,
    rateLimitWindowMs: 60_000,
  });

  try {
    const headers = { authorization: "Bearer token" };
    assert.equal((await app.request("/api/apps", { headers })).status, 200);
    assert.equal((await app.request("/api/apps", { headers })).status, 200);
    assert.equal((await app.request("/api/apps", { headers })).status, 429);
  } finally {
    registry.close();
  }
});
