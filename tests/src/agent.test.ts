import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HERMES_PACK_DIR,
  HERMES_MEMORY_MAX_CHARS,
  HERMES_USER_MAX_CHARS,
  createAgentHttpServer,
  createAgentToolset,
  createExecutionPlan,
  createMcpRequestHandler,
  provisionHermesHome,
  provisionIsolatedWorkspace,
  validateHermesPack,
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
  assert.equal(wipePlan.steps[0]?.toolName, "manual_review");

  const deployPlan = createExecutionPlan("Deploy billing app at billing.example.com");
  assert.equal(deployPlan.requiresUserApproval, true);
  assert.equal(deployPlan.steps[1]?.toolName, "prepare_app_workspace");
  assert.deepEqual(deployPlan.steps[1]?.args, {
    slug: "billing",
    name: "Billing",
    kind: "web-app",
    domain: "billing.example.com",
    internalPort: 8080,
  });

  const personalPlan = createExecutionPlan(
    "Create a personal life agent in its own isolated folder with Telegram access",
  );
  assert.equal(personalPlan.requiresUserApproval, true);
  assert.equal(personalPlan.steps[1]?.args?.kind, "personal-agent");
  assert.equal(personalPlan.steps[1]?.args?.slug, "personal-life-agent");

  const filenamePlan = createExecutionPlan(
    "Deploy static app serving index.html named My Portal at portal.example.com on port 8080",
  );
  assert.equal(filenamePlan.steps[1]?.args?.slug, "my-portal");
  assert.equal(filenamePlan.steps[1]?.args?.domain, "portal.example.com");
  assert.equal(filenamePlan.steps[1]?.args?.internalPort, 8080);
  assert.equal(filenamePlan.steps[2]?.toolName, "update_app_status");

  const genericSubdomainPlan = createExecutionPlan(
    "Deploy my-app at app.example.com",
  );
  assert.equal(genericSubdomainPlan.steps[1]?.args?.slug, "my-app");
  assert.equal(genericSubdomainPlan.steps[1]?.args?.domain, "app.example.com");

  const lifecyclePlan = createExecutionPlan("Restart crm-portal");
  assert.equal(lifecyclePlan.requiresUserApproval, true);
  assert.equal(lifecyclePlan.steps[1]?.toolName, "control_app_lifecycle");
  assert.deepEqual(lifecyclePlan.steps[1]?.args, {
    slug: "crm-portal",
    action: "restart",
  });

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

test("Agent HTTP server fails closed without adminToken and enforces auth, secret redaction, and body size cap", async () => {
  assert.throws(
    () => createAgentHttpServer({ adminToken: "" }),
    /requires a non-empty adminToken/,
  );
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

test("Hermes CTO pack validates limits, frontmatter, and idempotent provisioning", () => {
  const result = validateHermesPack(DEFAULT_HERMES_PACK_DIR);
  assert.equal(result.valid, true);
  assert.equal(result.memoryChars <= HERMES_MEMORY_MAX_CHARS, true);
  assert.equal(result.userChars <= HERMES_USER_MAX_CHARS, true);
  assert.deepEqual(result.skillNames, [
    "vps-os-backup-cron",
    "vps-os-deploy-app",
    "vps-os-diagnose-and-recover",
    "vps-os-domain-tls",
    "vps-os-secrets-hygiene",
  ]);

  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-hermes-"));
  try {
    const first = provisionHermesHome({
      hermesHome,
      mcpCommand: "node",
      mcpEntry: "/srv/vps-os/agent/dist/mcp-server.js",
    });
    assert.equal(first.syncedSkills.length, 5);
    assert.equal(fs.existsSync(path.join(hermesHome, "SOUL.md")), true);
    const renderedConfig = fs.readFileSync(
      path.join(hermesHome, "config.yaml"),
      "utf8",
    );
    assert.match(renderedConfig, /command: "node"/);
    assert.equal(renderedConfig.includes("__VPS_OS_MCP_"), false);

    // Simulate server-owned runtime state that must survive upgrades
    const customMemPath = path.join(hermesHome, "memories", "MEMORY.md");
    fs.writeFileSync(customMemPath, "Custom learned server facts", "utf8");
    const learnedSkillDir = path.join(hermesHome, "skills", "learned-postgres");
    fs.mkdirSync(learnedSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(learnedSkillDir, "SKILL.md"),
      "---\nname: learned-postgres\ndescription: Custom learned skill\n---\n",
      "utf8",
    );

    const second = provisionHermesHome({ hermesHome });
    assert.equal(second.preservedFiles.includes(customMemPath), true);
    assert.equal(fs.readFileSync(customMemPath, "utf8"), "Custom learned server facts");
    assert.equal(fs.existsSync(path.join(learnedSkillDir, "SKILL.md")), true);
  } finally {
    fs.rmSync(hermesHome, { recursive: true, force: true });
  }
});

test("MCP JSON-RPC handler exposes CTO tools, enforces approval gate, and updates app status", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-mcp-"));
  const registry = new SystemRegistryStore(":memory:");

  try {
    const handle = createMcpRequestHandler({
      registry,
      appsRoot: tempRoot,
      templatesRoot: TEMPLATES_ROOT,
    });

    const initRes = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    assert.equal(
      (initRes?.result as { serverInfo: { name: string } }).serverInfo.name,
      "vps-os-mcp",
    );

    // Notifications must produce no response
    const notifRes = await handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notifRes, null);

    const listRes = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (listRes?.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("inspect_apps"));
    assert.ok(names.includes("propose_plan"));
    assert.ok(names.includes("get_plan_status"));
    assert.ok(names.includes("prepare_app_workspace"));
    assert.ok(names.includes("deploy_workload"));
    assert.ok(names.includes("control_app_lifecycle"));
    assert.ok(names.includes("configure_app_domain"));
    assert.ok(names.includes("read_app_logs"));
    assert.ok(names.includes("update_app_status"));
    assert.ok(names.includes("list_audit_events"));

    const proposeRes = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "propose_plan",
        arguments: { goal: "Deploy analytics app with password=supersecret" },
      },
    });
    const proposePayload = JSON.parse(
      (proposeRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { id: string; goal: string; status: string };
    assert.equal(proposePayload.status, "pending");
    assert.equal(proposePayload.goal.includes("supersecret"), false);

    // Blocked while pending
    const blockedRes = await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "prepare_app_workspace",
        arguments: {
          planId: proposePayload.id,
          slug: "analytics",
          name: "Analytics",
          kind: "web-app",
          domain: "analytics.example.com",
        },
      },
    });
    assert.equal((blockedRes?.result as { isError: boolean }).isError, true);

    // Approve and execute via MCP
    registry.recordApproval({
      planId: proposePayload.id,
      approved: true,
      decidedBy: "owner",
    });

    const planStatusRes = await handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_plan_status",
        arguments: { planId: proposePayload.id },
      },
    });
    const statusPayload = JSON.parse(
      (planStatusRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { found: boolean; plan: { status: string } };
    assert.equal(statusPayload.found, true);
    assert.equal(statusPayload.plan.status, "approved");

    const prepRes = await handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "prepare_app_workspace",
        arguments: {
          planId: proposePayload.id,
          slug: "analytics",
          name: "Analytics",
          kind: "web-app",
          domain: "analytics.example.com",
        },
      },
    });
    assert.equal((prepRes?.result as { isError: boolean }).isError, false);

    const updateStatusRes = await handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "update_app_status",
        arguments: {
          slug: "analytics",
          status: "running",
          summary: "Container healthy with API_KEY=sk-1234567890abcdef",
        },
      },
    });
    const updatedPayload = JSON.parse(
      (updateStatusRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { app: { status: string } };
    assert.equal(updatedPayload.app.status, "running");

    const auditRes = await handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "list_audit_events",
        arguments: { limit: 5 },
      },
    });
    const auditText = (auditRes?.result as { content: Array<{ text: string }> })
      .content[0]!.text;
    assert.equal(auditText.includes("sk-1234567890abcdef"), false);
  } finally {
    registry.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
