import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDashboardApp } from "@vps-os/dashboard-api";
import { SystemRegistryStore } from "@vps-os/shared";

test("Agentic Chat API supports threads, file uploads with secret redaction, reasoning traces, tool calls, and inline plans", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-chat-"));
  const dataDir = path.join(tempDir, "data");
  const registry = new SystemRegistryStore(path.join(dataDir, "registry.db"));

  const app = createDashboardApp({
    registry,
    adminToken: "chat-test-admin-token-1234",
    dataDir,
    disableExternalLlm: true,
    rateLimitMax: 100,
  });

  const authHeaders = { authorization: "Bearer chat-test-admin-token-1234" };

  try {
    // 1. Create a thread
    const createRes = await app.request("/api/chat/threads", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ title: "Initial Check" }),
    });
    assert.equal(createRes.status, 201);
    const { thread } = (await createRes.json()) as {
      thread: { id: string; title: string };
    };
    assert.equal(thread.title, "Initial Check");

    // 2. Upload a text config attachment containing a secret -> verify redaction in textPreview
    const configPayload = "PORT=8080\nAPI_KEY=sk-supersecret1234567890\n";
    const uploadRes = await app.request("/api/chat/attachments", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        threadId: thread.id,
        name: "docker-compose.yml",
        mimeType: "application/x-yaml",
        dataBase64: Buffer.from(configPayload, "utf8").toString("base64"),
      }),
    });
    assert.equal(uploadRes.status, 201);
    const { attachment } = (await uploadRes.json()) as {
      attachment: {
        id: string;
        name: string;
        kind: string;
        textPreview: string | null;
        url: string;
      };
    };
    assert.equal(attachment.name, "docker-compose.yml");
    assert.equal(attachment.kind, "text");
    assert.ok(attachment.textPreview?.includes("PORT=8080"));
    assert.equal(attachment.textPreview?.includes("sk-supersecret1234567890"), false);

    // 3. Upload a tiny PNG image and verify authenticated download serves inline image/png
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const imgUploadRes = await app.request("/api/chat/attachments", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        threadId: thread.id,
        name: "screenshot.png",
        mimeType: "image/png",
        dataBase64: pngBase64,
      }),
    });
    assert.equal(imgUploadRes.status, 201);
    const { attachment: imgAtt } = (await imgUploadRes.json()) as {
      attachment: { id: string; kind: string; url: string };
    };
    assert.equal(imgAtt.kind, "image");

    const imgGetRes = await app.request(imgAtt.url, { headers: authHeaders });
    assert.equal(imgGetRes.status, 200);
    assert.equal(imgGetRes.headers.get("content-type"), "image/png");
    assert.equal(imgGetRes.headers.get("content-disposition"), "inline");

    // 4. Send a mutating agent message with attachments (JSON mode) -> reasoning + tools + inline plan
    const msgRes = await app.request(`/api/chat/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        content: "Deploy billing web app at billing.example.com using this config",
        mode: "agent",
        attachmentIds: [attachment.id, imgAtt.id],
        stream: false,
      }),
    });
    assert.equal(msgRes.status, 200);
    const turn = (await msgRes.json()) as {
      userMessage: { attachments: Array<{ id: string }> };
      assistantMessage: {
        content: string;
        reasoning: Array<{ title: string; content: string; status: string }>;
        toolCalls: Array<{ toolName: string; status: string }>;
        planId: string | null;
      };
      plan: { id: string; status: string; requiresUserApproval: boolean } | null;
    };

    assert.equal(turn.userMessage.attachments.length, 2);
    assert.ok(turn.assistantMessage.reasoning.length >= 1);
    assert.equal(turn.assistantMessage.reasoning[0]?.status, "done");
    const toolNames = turn.assistantMessage.toolCalls.map((t) => t.toolName);
    assert.ok(toolNames.includes("inspect_system_metrics"));
    assert.ok(toolNames.includes("inspect_apps"));
    assert.ok(toolNames.includes("inspect_attachments"));
    assert.ok(toolNames.includes("propose_plan"));
    assert.ok(turn.plan);
    assert.equal(turn.assistantMessage.planId, turn.plan?.id);
    assert.equal(turn.plan?.status, "pending");

    // 5. Thread reload hydrates messages and plansById
    const getThreadRes = await app.request(`/api/chat/threads/${thread.id}`, {
      headers: authHeaders,
    });
    assert.equal(getThreadRes.status, 200);
    const loaded = (await getThreadRes.json()) as {
      messages: Array<{ id: string }>;
      plansById: Record<string, { id: string }>;
    };
    assert.equal(loaded.messages.length, 2);
    assert.ok(turn.plan && loaded.plansById[turn.plan.id]);

    // 6. Delete thread removes it cleanly
    const delRes = await app.request(`/api/chat/threads/${thread.id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    assert.equal(delRes.status, 200);
    assert.equal(
      (await app.request(`/api/chat/threads/${thread.id}`, { headers: authHeaders })).status,
      404,
    );
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Agentic Chat SSE streaming parses live OpenCode Zen reasoning_content and text deltas", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-chat-stream-"));
  const envPath = path.join(tempDir, "config", "onboarding.env");
  const registry = new SystemRegistryStore(path.join(tempDir, "data", "registry.db"));

  // Mock OpenCode Zen SSE response emitting both reasoning_content and content
  const mockFetch: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    assert.equal(urlStr, "https://opencode.ai/zen/v1/chat/completions");
    const reqHeaders = new Headers(init?.headers);
    assert.equal(reqHeaders.get("authorization"), "Bearer sk-opencode-live-key");
    assert.ok(reqHeaders.get("x-opencode-session"));

    const sseBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Checking server headroom..." } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Your VPS looks " } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "**healthy**!" } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    return new Response(sseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const app = createDashboardApp({
    registry,
    adminToken: "stream-test-admin-token-1234",
    onboardingEnvPath: envPath,
    chatFetch: mockFetch,
    rateLimitMax: 100,
  });

  const authHeaders = {
    "content-type": "application/json",
    authorization: "Bearer stream-test-admin-token-1234",
  };

  try {
    // Configure OpenCode provider via onboarding route
    const provRes = await app.request("/api/onboarding/provider", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        provider: "opencode",
        model: "claude-sonnet-4-5",
        apiKey: "sk-opencode-live-key",
      }),
    });
    assert.equal(provRes.status, 200);

    const threadRes = await app.request("/api/chat/threads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    const { thread } = (await threadRes.json()) as { thread: { id: string } };

    const streamRes = await app.request(`/api/chat/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { ...authHeaders, accept: "text/event-stream" },
      body: JSON.stringify({
        content: "Check system health",
        mode: "agent",
        stream: true,
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type") ?? "", /text\/event-stream/);

    const rawSse = await streamRes.text();
    assert.match(rawSse, /event: message_start/);
    assert.match(rawSse, /event: reasoning_delta/);
    assert.match(rawSse, /Checking server headroom/);
    assert.match(rawSse, /event: tool_done/);
    assert.match(rawSse, /event: text_delta/);
    assert.match(rawSse, /Your VPS looks /);
    assert.match(rawSse, /event: message_done/);

    // Verify persisted assistant message captured OpenCode reasoning + text
    const reloaded = (await (
      await app.request(`/api/chat/threads/${thread.id}`, {
        headers: { authorization: authHeaders.authorization },
      })
    ).json()) as {
      messages: Array<{
        role: string;
        content: string;
        provider: string | null;
        model: string | null;
        reasoning: Array<{ content: string }>;
      }>;
    };
    const assistant = reloaded.messages.find((m) => m.role === "assistant");
    assert.ok(assistant);
    assert.equal(assistant?.provider, "opencode");
    assert.equal(assistant?.model, "claude-sonnet-4-5");
    assert.equal(assistant?.content, "Your VPS looks **healthy**!");
    assert.ok(
      assistant?.reasoning.some((r) => r.content.includes("Checking server headroom")),
    );
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("T3-Code Chat upgrades: pin/archive ordering, fork checkpoints, ask mode, @mentions, edit/truncate, export, and clear", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-chat-t3-"));
  const registry = new SystemRegistryStore(path.join(tempDir, "data", "registry.db"));

  // Register a sample workload so @mention grounding triggers live log inspection
  registry.upsertApp({
    slug: "acme-crm",
    name: "Acme CRM",
    kind: "web-app",
    status: "running",
    folderPath: "/opt/vps-os/apps/acme-crm",
    domain: "crm.example.com",
    internalPort: 3000,
    memoryLimitMb: 512,
    cpuLimit: "1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const app = createDashboardApp({
    registry,
    adminToken: "t3-chat-test-token-1234",
    disableExternalLlm: true,
    rateLimitMax: 100,
    workloadController: {
      control: () => ({ status: "running" }),
      getLogs: (slug) => [`2026-11-21T00:00:00Z INFO [${slug}] listening on :3000`],
    },
  });

  const authHeaders = {
    "content-type": "application/json",
    authorization: "Bearer t3-chat-test-token-1234",
  };

  try {
    // 1. Create two threads and verify pinning orders the pinned thread first
    const t1Res = await app.request("/api/chat/threads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "Older Thread" }),
    });
    const t2Res = await app.request("/api/chat/threads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "Newer Thread" }),
    });
    assert.equal(t1Res.status, 201);
    assert.equal(t2Res.status, 201);
    const { thread: t1 } = (await t1Res.json()) as { thread: { id: string } };
    const { thread: t2 } = (await t2Res.json()) as { thread: { id: string } };

    const pinRes = await app.request(`/api/chat/threads/${t1.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinRes.status, 200);
    const { thread: pinnedT1 } = (await pinRes.json()) as {
      thread: { id: string; pinned: boolean; archived: boolean };
    };
    assert.equal(pinnedT1.pinned, true);
    assert.equal(pinnedT1.archived, false);

    const archiveRes = await app.request(`/api/chat/threads/${t2.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ archived: true }),
    });
    assert.equal(archiveRes.status, 200);

    const listRes = await app.request("/api/chat/threads", {
      headers: { authorization: authHeaders.authorization },
    });
    const { threads } = (await listRes.json()) as {
      threads: Array<{ id: string; pinned: boolean; archived: boolean }>;
    };
    assert.equal(threads[0]?.id, t1.id);
    assert.equal(threads.find((t) => t.id === t2.id)?.archived, true);

    // 2. Turn 1 in ASK mode with @acme-crm and @audit-trail mentions:
    //    should run read_app_logs + list_audit_events and MUST NOT create a mutating plan.
    const askRes = await app.request(`/api/chat/threads/${t1.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Deploy billing web app at billing.example.com — explain only, do not mutate",
        mode: "ask",
        effort: "high",
        mentionedSlugs: ["acme-crm", "audit-trail"],
        stream: false,
      }),
    });
    assert.equal(askRes.status, 200);
    const askTurn = (await askRes.json()) as {
      userMessage: { id: string };
      assistantMessage: {
        id: string;
        toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
        planId: string | null;
      };
      plan: unknown;
    };
    const askTools = askTurn.assistantMessage.toolCalls.map((tc) => tc.toolName);
    assert.ok(askTools.includes("read_app_logs"));
    assert.ok(askTools.includes("list_audit_events"));
    assert.equal(askTools.includes("propose_plan"), false);
    assert.equal(askTurn.plan, null);
    assert.equal(askTurn.assistantMessage.planId, null);

    // 3. Turn 2 normal message so thread has 4 messages total
    const turn2Res = await app.request(`/api/chat/threads/${t1.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Summarize memory usage (ignore token sk-leakedsecret987654321)",
        mode: "agent",
        effort: "low",
        stream: false,
      }),
    });
    assert.equal(turn2Res.status, 200);
    const turn2 = (await turn2Res.json()) as {
      userMessage: { id: string };
      assistantMessage: { id: string };
    };

    // 3b. Unpin & unarchive via PATCH and verify updated flags + natural ordering.
    // With no pinned threads, ordering falls back to updated_at DESC; t1 was just
    // messaged (turns 1 & 2) so it must now sort ahead of the untouched t2.
    const unpinRes = await app.request(`/api/chat/threads/${t1.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ pinned: false }),
    });
    assert.equal(unpinRes.status, 200);
    const { thread: unpinnedT1 } = (await unpinRes.json()) as {
      thread: { pinned: boolean; archived: boolean };
    };
    assert.equal(unpinnedT1.pinned, false);
    assert.equal(unpinnedT1.archived, false);

    const unarchiveRes = await app.request(`/api/chat/threads/${t2.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ archived: false }),
    });
    assert.equal(unarchiveRes.status, 200);
    const { thread: unarchivedT2 } = (await unarchiveRes.json()) as {
      thread: { pinned: boolean; archived: boolean };
    };
    assert.equal(unarchivedT2.pinned, false);
    assert.equal(unarchivedT2.archived, false);

    const listRes2 = await app.request("/api/chat/threads", {
      headers: { authorization: authHeaders.authorization },
    });
    const { threads: threads2 } = (await listRes2.json()) as {
      threads: Array<{ id: string; pinned: boolean; archived: boolean }>;
    };
    assert.equal(threads2[0]?.id, t1.id);
    assert.equal(threads2.find((t) => t.id === t1.id)?.pinned, false);
    assert.equal(threads2.find((t) => t.id === t2.id)?.archived, false);

    // 4. Fork from Turn 1 assistant checkpoint -> forked thread has exactly 2 messages + parentThreadId
    const partialForkRes = await app.request(`/api/chat/threads/${t1.id}/fork`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ upToMessageId: askTurn.assistantMessage.id }),
    });
    assert.equal(partialForkRes.status, 201);
    const partialFork = (await partialForkRes.json()) as {
      thread: { id: string; parentThreadId: string | null; messageCount: number };
      messages: Array<{ id: string }>;
    };
    assert.equal(partialFork.thread.parentThreadId, t1.id);
    assert.equal(partialFork.messages.length, 2);
    assert.equal(partialFork.thread.messageCount, 2);

    // 4b. Fork from a non-existent checkpoint message id is rejected with 404
    const badForkRes = await app.request(`/api/chat/threads/${t1.id}/fork`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ upToMessageId: "non-existent-id" }),
    });
    assert.equal(badForkRes.status, 404);
    const badForkThreads = (await (
      await app.request("/api/chat/threads", {
        headers: { authorization: authHeaders.authorization },
      })
    ).json()) as { threads: Array<{ id: string }> };
    assert.equal(
      badForkThreads.threads.filter((t) => t.id === t1.id).length,
      1,
      "failed fork must not leave a partial duplicate thread",
    );

    // 5. Export Markdown transcript -> verifies live auto-titled Markdown headers, disposition, and secret redaction
    // (chat-routes auto-titles a thread on its first message, so fetch the live title instead of "Older Thread")
    const t1StateRes = await app.request(`/api/chat/threads/${t1.id}`, {
      headers: { authorization: authHeaders.authorization },
    });
    assert.equal(t1StateRes.status, 200);
    const t1State = (await t1StateRes.json()) as {
      thread: { id: string; title: string };
    };
    assert.ok(t1State.thread.title.startsWith("Deploy billing web app"));

    const exportRes = await app.request(`/api/chat/threads/${t1.id}/export`, {
      headers: { authorization: authHeaders.authorization },
    });
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(
      exportRes.headers.get("content-disposition") ?? "",
      /^attachment; filename="[a-z0-9-]+\.md"$/,
    );
    const markdown = await exportRes.text();
    assert.ok(markdown.includes(`# ${t1State.thread.title}`));
    assert.equal(markdown.includes("sk-leakedsecret987654321"), false);

    // 5b. Export for a non-existent thread is rejected with 404
    const missingExportRes = await app.request(
      "/api/chat/threads/non-existent/export",
      { headers: { authorization: authHeaders.authorization } },
    );
    assert.equal(missingExportRes.status, 404);

    // 6. Edit & Resend via truncateFromMessageId replaces Turn 2 cleanly (remains 4 messages total)
    const editRes = await app.request(`/api/chat/threads/${t1.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Edited follow-up checking disk space",
        mode: "agent",
        effort: "medium",
        truncateFromMessageId: turn2.userMessage.id,
        stream: false,
      }),
    });
    assert.equal(editRes.status, 200);
    const afterEdit = (await (
      await app.request(`/api/chat/threads/${t1.id}`, {
        headers: { authorization: authHeaders.authorization },
      })
    ).json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(afterEdit.messages.length, 4);
    assert.equal(afterEdit.messages[2]?.content, "Edited follow-up checking disk space");

    // 7. Clear thread removes all messages while preserving thread metadata
    const clearRes = await app.request(`/api/chat/threads/${t1.id}/clear`, {
      method: "POST",
      headers: { authorization: authHeaders.authorization },
    });
    assert.equal(clearRes.status, 200);
    const clearJson = (await clearRes.json()) as {
      ok: boolean;
      cleared: number;
      thread: { id: string; messageCount: number };
    };
    assert.equal(clearJson.ok, true);
    assert.equal(clearJson.cleared, 4);
    assert.equal(clearJson.thread.messageCount, 0);
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Agentic Chat surfaces unresolved @mentions in the reasoning trace and rejects invalid requests", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-chat-mentions-"));
  const registry = new SystemRegistryStore(path.join(tempDir, "data", "registry.db"));

  registry.upsertApp({
    slug: "billing-api",
    name: "Billing API",
    kind: "web-app",
    status: "running",
    folderPath: "/opt/vps-os/apps/billing-api",
    domain: "billing.example.com",
    internalPort: 3000,
    memoryLimitMb: 512,
    cpuLimit: "1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  let logReads = 0;
  const app = createDashboardApp({
    registry,
    adminToken: "mention-test-token-1234",
    disableExternalLlm: true,
    rateLimitMax: 100,
    workloadController: {
      control: () => ({ status: "running" }),
      getLogs: (slug) => {
        logReads += 1;
        return [`2026-11-21T00:00:00Z INFO [${slug}] heartbeat ok`];
      },
    },
  });

  const authHeaders = {
    "content-type": "application/json",
    authorization: "Bearer mention-test-token-1234",
  };

  try {
    const threadRes = await app.request("/api/chat/threads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "Mention Probe" }),
    });
    assert.equal(threadRes.status, 201);
    const { thread } = (await threadRes.json()) as { thread: { id: string } };

    // Unknown @mention in ask mode: no read_app_logs run, reasoning flags the typo
    const mentionRes = await app.request(`/api/chat/threads/${thread.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Explain current disk and memory headroom briefly",
        mode: "ask",
        mentionedSlugs: ["no-such-app"],
        stream: false,
      }),
    });
    assert.equal(mentionRes.status, 200);
    const mentionTurn = (await mentionRes.json()) as {
      assistantMessage: {
        reasoning: Array<{ title: string; content: string; status: string }>;
        toolCalls: Array<{ toolName: string }>;
        planId: string | null;
      };
      plan: unknown;
    };
    const mentionTools = mentionTurn.assistantMessage.toolCalls.map(
      (t) => t.toolName,
    );
    assert.equal(mentionTools.includes("read_app_logs"), false);
    assert.equal(mentionTools.includes("propose_plan"), false);
    assert.equal(mentionTurn.assistantMessage.planId, null);
    assert.equal(mentionTurn.plan, null);
    assert.equal(logReads, 0);
    assert.ok(
      mentionTurn.assistantMessage.reasoning.some((r) =>
        r.content.includes("Unrecognized @mentions ignored: @no-such-app"),
      ),
    );
    assert.ok(
      mentionTurn.assistantMessage.reasoning.some((r) =>
        r.content.includes("@no-such-app"),
      ),
    );

    // Validation: more than 10 mentionedSlugs is rejected with 400
    const tooManyRes = await app.request(`/api/chat/threads/${thread.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Audit everything about this host",
        mode: "ask",
        mentionedSlugs: Array.from({ length: 11 }, (_, i) => `app-${i}`),
        stream: false,
      }),
    });
    assert.equal(tooManyRes.status, 400);

    // Validation: unknown mode string is rejected with 400
    const invalidModeRes = await app.request(`/api/chat/threads/${thread.id}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "Check system health",
        mode: "invalid",
        stream: false,
      }),
    });
    assert.equal(invalidModeRes.status, 400);

    // Rejected requests must not persist any messages
    const afterReject = (await (
      await app.request(`/api/chat/threads/${thread.id}`, {
        headers: { authorization: authHeaders.authorization },
      })
    ).json()) as { messages: Array<{ id: string }> };
    assert.equal(afterReject.messages.length, 2);
    assert.equal(logReads, 0);
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SystemRegistryStore migrates a legacy chat_threads schema idempotently", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-chat-legacy-"));
  const dbPath = path.join(tempDir, "legacy-registry.db");

  // Simulate a pre-upgrade database whose chat_threads table lacks
  // pinned / archived / parent_thread_id columns.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare(
      "INSERT INTO chat_threads (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "legacy-thread-1",
      "Legacy Thread",
      null,
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  legacy.close();

  const store = new SystemRegistryStore(dbPath);
  // Second connection re-runs migrate() on the already-upgraded schema
  // to prove the migration is idempotent and data-preserving.
  const reopened = new SystemRegistryStore(dbPath);
  try {
    const thread = store.getChatThread("legacy-thread-1");
    assert.ok(thread);
    assert.equal(thread.title, "Legacy Thread");
    assert.equal(thread.pinned, false);
    assert.equal(thread.archived, false);
    assert.equal(thread.parentThreadId, null);

    const reloaded = reopened.getChatThread("legacy-thread-1");
    assert.ok(reloaded);
    assert.equal(reloaded.title, "Legacy Thread");
    assert.equal(reloaded.pinned, false);
    assert.equal(reloaded.archived, false);
    assert.equal(reloaded.parentThreadId, null);
  } finally {
    reopened.close();
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Agent mode skips bogus manual_review plans on conversational prompts and exposes publicIp telemetry", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-chat-convo-"));
  const dataDir = path.join(tempDir, "data");
  const registry = new SystemRegistryStore(path.join(dataDir, "registry.db"));
  registry.saveOnboardingState({
    publicIp: "109.199.127.133",
    domainMode: "ip-only",
  });

  const app = createDashboardApp({
    registry,
    adminToken: "master-admin-token-for-convo-tests",
    dataDir,
    disableExternalLlm: true,
  });
  const authHeaders = {
    authorization: "Bearer master-admin-token-for-convo-tests",
  };

  try {
    const threadRes = await app.request("/api/chat/threads", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ title: "Conversational checks" }),
    });
    const { thread } = (await threadRes.json()) as { thread: { id: string } };

    for (const prompt of ["whats the link", "via ip", "approve", "what should I deploy?"]) {
      const res = await app.request(`/api/chat/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({
          content: prompt,
          mode: "agent",
          stream: false,
        }),
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as {
        assistantMessage: {
          planId: string | null;
          toolCalls: Array<{ toolName: string; output?: Record<string, unknown> }>;
        };
        plan: unknown;
      };
      assert.equal(json.plan, null, `prompt "${prompt}" must not spawn a bogus plan`);
      assert.equal(json.assistantMessage.planId, null);
      const metricsTool = json.assistantMessage.toolCalls.find(
        (tc) => tc.toolName === "inspect_system_metrics",
      );
      assert.equal(metricsTool?.output?.publicIp, "109.199.127.133");
      assert.equal(metricsTool?.output?.dashboardUrl, "http://109.199.127.133");
    }
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("YOLO Sandbox mode auto-approves and executes safe deploys while blocking manual_review goals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-chat-yolo-"));
  const dataDir = path.join(tempDir, "data");
  const registry = new SystemRegistryStore(path.join(dataDir, "registry.db"));

  let executedCount = 0;
  const app = createDashboardApp({
    registry,
    adminToken: "master-admin-token-for-yolo-tests",
    dataDir,
    disableExternalLlm: true,
    executePlan: async (plan) => {
      executedCount += 1;
      return {
        summary: `Provisioned workload for ${plan.goal}`,
      };
    },
  });
  const authHeaders = {
    authorization: "Bearer master-admin-token-for-yolo-tests",
  };

  try {
    // 1. Toggle YOLO mode via onboarding/approval-mode route
    const modeRes = await app.request("/api/onboarding/approval-mode", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ approvalMode: "yolo" }),
    });
    assert.equal(modeRes.status, 200);
    assert.equal(registry.getOnboardingState().persona.approvalMode, "yolo");

    const threadRes = await app.request("/api/chat/threads", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ title: "YOLO tests" }),
    });
    const { thread } = (await threadRes.json()) as { thread: { id: string } };

    // 2. Safe deploy auto-approves & executes immediately without pausing
    const deployRes = await app.request(`/api/chat/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        content: "Deploy hello-yolo web app in its own isolated container",
        mode: "agent",
        stream: false,
      }),
    });
    assert.equal(deployRes.status, 200);
    const deployJson = (await deployRes.json()) as {
      assistantMessage: { toolCalls: Array<{ toolName: string; status: string }> };
      plan: { status: string } | null;
    };
    assert.equal(executedCount, 1);
    assert.equal(deployJson.plan?.status, "executed");
    assert.ok(
      deployJson.assistantMessage.toolCalls.some(
        (tc) => tc.toolName === "execute_plan" && tc.status === "success",
      ),
    );

    // 3. Destructive manual_review goal still stays pending and never auto-executes
    const wipeRes = await app.request(`/api/chat/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        content: "Disable ufw firewall on the host",
        mode: "agent",
        stream: false,
      }),
    });
    assert.equal(wipeRes.status, 200);
    const wipeJson = (await wipeRes.json()) as {
      plan: { status: string } | null;
    };
    assert.equal(executedCount, 1);
    assert.equal(wipeJson.plan?.status, "pending");
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
