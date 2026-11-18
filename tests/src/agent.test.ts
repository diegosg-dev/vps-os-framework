import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentHttpServer,
  createAgentToolset,
  createExecutionPlan,
  provisionIsolatedWorkspace,
} from "@vps-os/agent";
import { SystemRegistryStore } from "@vps-os/shared";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const TEMPLATES_ROOT = path.join(REPO_ROOT, "templates");

test("createExecutionPlan handles 1000-char goals and fails closed on unknown actions", () => {
  const readPlan = createExecutionPlan("Check current app health");
  assert.equal(readPlan.requiresUserApproval, false);
  assert.equal(readPlan.steps.length, 1);

  const ambiguousPlan = createExecutionPlan("Do something unexpected");
  assert.equal(ambiguousPlan.requiresUserApproval, true);

  const wipePlan = createExecutionPlan("Wipe the disk cleanly");
  assert.equal(wipePlan.requiresUserApproval, true);

  const longGoal = `Deploy CRM app ${"x".repeat(980)}`;
  assert.equal(longGoal.length <= 1000, true);
  const longPlan = createExecutionPlan(longGoal);
  assert.equal(longPlan.summary.length <= 500, true);
});

test("provisionIsolatedWorkspace creates .env, syncs port, and prevents duplicates", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-apps-"));
  const registry = new SystemRegistryStore(":memory:");

  try {
    const agentRes = provisionIsolatedWorkspace({
      appsRoot: tempRoot,
      templatesRoot: TEMPLATES_ROOT,
      slug: "my-life-agent",
      name: "My Life Agent",
      kind: "personal-agent",
      domain: null,
      registry,
    });

    assert.equal(fs.existsSync(agentRes.composePath), true);
    assert.equal(fs.existsSync(agentRes.envExamplePath), true);
    assert.equal(fs.existsSync(agentRes.envPath), true);
    assert.equal(fs.existsSync(path.join(agentRes.appDir, "workspace")), true);
    assert.match(
      fs.readFileSync(agentRes.envPath, "utf8"),
      /^APP_SLUG=my-life-agent$/m,
    );

    const webRes = provisionIsolatedWorkspace({
      appsRoot: tempRoot,
      templatesRoot: TEMPLATES_ROOT,
      slug: "client-portal",
      name: "Client Portal",
      kind: "web-app",
      domain: "portal.example.com",
      internalPort: 8080,
      registry,
    });

    assert.equal(fs.existsSync(path.join(webRes.appDir, "data")), true);
    assert.match(
      fs.readFileSync(webRes.envPath, "utf8"),
      /^APP_PORT=8080$/m,
    );

    assert.throws(
      () =>
        provisionIsolatedWorkspace({
          appsRoot: tempRoot,
          templatesRoot: TEMPLATES_ROOT,
          slug: "client-portal",
          name: "Duplicate",
          kind: "web-app",
          domain: null,
          registry,
        }),
      /already exists/,
    );
  } finally {
    registry.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("agent toolset enforces server-side ExecutionPlan approval before provisioning", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-tools-"));
  const registry = new SystemRegistryStore(":memory:");

  try {
    const tools = createAgentToolset({
      registry,
      appsRoot: tempRoot,
      templatesRoot: TEMPLATES_ROOT,
    });

    const proposeExec = tools.propose_plan?.execute;
    const prepareExec = tools.prepare_app_workspace?.execute;
    assert.ok(proposeExec && prepareExec);

    const pendingPlan = (await proposeExec(
      { goal: "Deploy CRM app" },
      { toolCallId: "tc-1", messages: [], context: {} },
    )) as { id: string; status: string };
    assert.equal(pendingPlan.status, "pending");

    // Must block execution while plan is pending
    await assert.rejects(
      () =>
        prepareExec(
          {
            planId: pendingPlan.id,
            slug: "crm-app",
            name: "CRM",
            kind: "web-app",
            domain: "crm.example.com",
          },
          { toolCallId: "tc-2", messages: [], context: {} },
        ),
      /Approval gate blocked/,
    );

    // Approve plan, then execution succeeds once and blocks replay
    registry.recordApproval({
      planId: pendingPlan.id,
      approved: true,
      decidedBy: "tester",
    });

    const result = (await prepareExec(
      {
        planId: pendingPlan.id,
        slug: "crm-app",
        name: "CRM",
        kind: "web-app",
        domain: "crm.example.com",
      },
      { toolCallId: "tc-3", messages: [], context: {} },
    )) as { record: { slug: string } };
    assert.equal(result.record.slug, "crm-app");

    await assert.rejects(
      () =>
        prepareExec(
          {
            planId: pendingPlan.id,
            slug: "crm-app-2",
            name: "CRM 2",
            kind: "web-app",
            domain: null,
          },
          { toolCallId: "tc-4", messages: [], context: {} },
        ),
      /Approval gate blocked/,
    );
  } finally {
    registry.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Agent HTTP server enforces auth, secret redaction, and body size cap", async () => {
  const { server } = createAgentHttpServer({ adminToken: "agent-secret-token" });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/agent/health`);
    assert.equal(healthRes.status, 200);

    const unauthRes = await fetch(`${baseUrl}/agent/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Check status" }),
    });
    assert.equal(unauthRes.status, 401);

    const okRes = await fetch(`${baseUrl}/agent/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer agent-secret-token",
      },
      body: JSON.stringify({ goal: "Deploy app with password=mysecret" }),
    });
    assert.equal(okRes.status, 200);
    const okJson = (await okRes.json()) as { plan: { goal: string } };
    assert.equal(okJson.plan.goal.includes("mysecret"), false);

    const bigRes = await fetch(`${baseUrl}/agent/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer agent-secret-token",
      },
      body: JSON.stringify({ goal: "a".repeat(70 * 1024) }),
    });
    assert.equal(bigRes.status, 413);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
