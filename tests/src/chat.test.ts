import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
