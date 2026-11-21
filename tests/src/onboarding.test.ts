import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_HERMES_PACK_DIR,
  HERMES_MEMORY_MAX_CHARS,
  HERMES_USER_MAX_CHARS,
  provisionHermesHome,
} from "@vps-os/agent";
import {
  createDashboardApp,
  discoverLlmProviderModels,
  extractModelIdsFromPayload,
} from "@vps-os/dashboard-api";
import {
  LLM_PROVIDER_CATALOG,
  OPENCODE_GO_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
  SystemRegistryStore,
  findProviderEndpointPreset,
  hashPassphrase,
  hashSetupCode,
  normalizeSetupCode,
  redactSecrets,
  renderServerMemoryMarkdown,
  renderUserMemoryMarkdown,
  updateHermesConfigYaml,
  validateHttpBaseUrl,
  verifyPassphrase,
} from "@vps-os/shared";

test("shared onboarding helpers handle setup codes, passphrases, URL validation, and bounded Hermes files", () => {
  assert.equal(normalizeSetupCode("ab3d-ef7h-jk9m"), "AB3DEF7HJK9M");
  assert.equal(
    hashSetupCode("ab3d-ef7h-jk9m"),
    hashSetupCode("AB3DEF7HJK9M"),
  );

  const hash = hashPassphrase("correct-horse-battery-staple");
  assert.match(hash, /^scrypt:/);
  assert.equal(verifyPassphrase("correct-horse-battery-staple", hash), true);
  assert.equal(verifyPassphrase("wrong-passphrase", hash), false);
  assert.equal(verifyPassphrase("anything", "invalid-format"), false);

  assert.equal(
    validateHttpBaseUrl("http://host.docker.internal:11434/"),
    "http://host.docker.internal:11434",
  );
  assert.throws(() => validateHttpBaseUrl("http://169.254.169.254/latest"), /Blocked/);
  assert.throws(() => validateHttpBaseUrl("http://user:pass@localhost:11434"), /credentials/);
  assert.throws(() => validateHttpBaseUrl("ftp://example.com"), /http:\/\/ or https:\/\//);

  const tgText = "token=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
  assert.equal(redactSecrets(tgText).includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), false);

  const userMd = renderUserMemoryMarkdown({
    ownerName: "Alex",
    technicalLevel: "non-technical",
    communicationStyle: "plain-english",
    approvalMode: "manual",
  });
  assert.equal(userMd.length <= HERMES_USER_MAX_CHARS, true);
  assert.match(userMd, /Alex/);

  const memMd = renderServerMemoryMarkdown(
    "# Server Memory\n\n## Baseline Checklist\n- old line",
    {
      scannedAt: "2026-11-18T00:00:00.000Z",
      hostname: "vps-01",
      osRelease: "Ubuntu 24.04 LTS",
      cpuCount: 4,
      memoryTotalMb: 8192,
      memoryUsedMb: 1024,
      diskTotalGb: 80,
      diskUsedGb: 12,
      checks: [
        { id: "core", label: "Core API", status: "ok", detail: "Healthy" },
      ],
      summary: "Healthy",
    },
    "os.example.org",
  );
  assert.equal(memMd.length <= HERMES_MEMORY_MAX_CHARS, true);
  assert.match(memMd, /Ubuntu 24\.04 LTS/);
  assert.match(memMd, /os\.example\.org/);
  assert.equal(memMd.includes("- old line"), false);

  const cfgTemplate = fs.readFileSync(
    path.join(DEFAULT_HERMES_PACK_DIR, "config.yaml"),
    "utf8",
  );
  const updatedCfg = updateHermesConfigYaml(cfgTemplate, {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    approvalMode: "manual",
  });
  assert.match(updatedCfg, /provider: "anthropic"/);
  assert.match(updatedCfg, /name: "claude-sonnet-4-20250514"/);
  assert.match(updatedCfg, /mode: manual/);
  assert.match(updatedCfg, /mcp_servers:/);
});

test("Dashboard onboarding supports one-time claim, brute-force lock, passphrase login, and full wizard flow", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-onboard-"));
  const dataDir = path.join(tempDir, "data");
  const envPath = path.join(tempDir, "config", "onboarding.env");
  const hermesHome = path.join(tempDir, "hermes");
  provisionHermesHome({ hermesHome });

  const registry = new SystemRegistryStore(path.join(dataDir, "registry.db"));
  const setupCode = "WXYZ-2345-MNOP";
  const appliedReasons: string[] = [];

  const app = createDashboardApp({
    registry,
    adminToken: "master-admin-token-for-onboarding-tests",
    dataDir,
    onboardingEnvPath: envPath,
    hermesHome,
    initialSetupCodeHash: hashSetupCode(setupCode),
    publicIp: "203.0.113.42",
    verifyDns: async (domain, expectedIp) => ({
      domain,
      resolvedIps: ["203.0.113.42"],
      expectedIp,
      matches: true,
      message: `DNS verified for ${domain}.`,
    }),
    testProviderConnection: async (input) => ({
      ok: true,
      provider: input.provider,
      model: input.model,
      latencyMs: 42,
      message: `Connected to ${input.provider} (${input.model}) in 42ms.`,
    }),
    checkHermesHealth: async () => ({
      reachable: true,
      url: "http://host.docker.internal:8642",
      detail: "Hermes CTO Gateway is active and responding.",
    }),
    triggerHostApply: async (reason) => {
      appliedReasons.push(reason);
      return { queued: true, detail: `Queued ${reason}` };
    },
  });

  try {
    // 1. Public status works unauthenticated without leaking IP/domain
    const statusRes = await app.request("/api/onboarding/status");
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      onboardingCompleted: boolean;
      claimAvailable: boolean;
      passphraseConfigured: boolean;
    };
    assert.equal(statusJson.onboardingCompleted, false);
    assert.equal(statusJson.claimAvailable, true);
    assert.equal(statusJson.passphraseConfigured, false);
    assert.equal("publicIp" in statusJson, false);

    // 2. Protected onboarding state rejects unauthenticated caller
    assert.equal((await app.request("/api/onboarding/state")).status, 401);

    // 3. Invalid setup code fails, valid code claims once and blocks replay
    const badClaim = await app.request("/api/auth/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "WRONG-CODE-1234" }),
    });
    assert.equal(badClaim.status, 401);

    const claimRes = await app.request("/api/auth/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "wxyz2345mnop" }),
    });
    assert.equal(claimRes.status, 200);
    const claimJson = (await claimRes.json()) as { token: string };
    assert.match(claimJson.token, /^vpsos_sess_/);

    // Replay blocked
    const replayClaim = await app.request("/api/auth/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode }),
    });
    assert.equal(replayClaim.status, 401);

    let sessionHeaders = { authorization: `Bearer ${claimJson.token}` };

    // 4. Fetch authenticated onboarding state
    const stateRes = await app.request("/api/onboarding/state", {
      headers: sessionHeaders,
    });
    assert.equal(stateRes.status, 200);
    const stateJson = (await stateRes.json()) as {
      state: { publicIp: string | null };
      providerCatalog: Array<{ id: string }>;
    };
    assert.equal(stateJson.state.publicIp, "203.0.113.42");
    assert.equal(stateJson.providerCatalog.length, 6);
    assert.equal(stateJson.providerCatalog[0]?.id, "opencode");

    // 5. Reject placeholder domain os.example.com, accept real domain
    const badDomainRes = await app.request("/api/onboarding/domain", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ mode: "domain", domain: "os.example.com" }),
    });
    assert.equal(badDomainRes.status, 400);

    const domainRes = await app.request("/api/onboarding/domain", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({
        mode: "domain",
        domain: "os.myserver.org",
        acmeEmail: "owner@myserver.org",
      }),
    });
    assert.equal(domainRes.status, 200);
    const domainJson = (await domainRes.json()) as {
      state: { domain: string; dnsVerified: boolean };
      dnsCheck: { matches: boolean };
    };
    assert.equal(domainJson.state.domain, "os.myserver.org");
    assert.equal(domainJson.state.dnsVerified, true);
    assert.equal(domainJson.dnsCheck.matches, true);

    // 6. Test provider connection & save provider secret safely to 0600 env file (not SQLite)
    const testProvRes = await app.request("/api/onboarding/provider/test", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "sk-proj-testsecret1234567890",
      }),
    });
    assert.equal(testProvRes.status, 200);
    assert.equal(
      ((await testProvRes.json()) as { result: { ok: boolean } }).result.ok,
      true,
    );

    const saveProvRes = await app.request("/api/onboarding/provider", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "sk-proj-testsecret1234567890",
      }),
    });
    assert.equal(saveProvRes.status, 200);
    const provJsonText = await saveProvRes.text();
    assert.equal(provJsonText.includes("sk-proj-testsecret1234567890"), false);

    // 7. Configure memorable passphrase -> rotates session epoch (old token revoked)
    const secRes = await app.request("/api/onboarding/security", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({ passphrase: "my-super-safe-vps-passphrase" }),
    });
    assert.equal(secRes.status, 200);
    const secJson = (await secRes.json()) as { token: string };
    assert.equal(
      (await app.request("/api/onboarding/state", { headers: sessionHeaders })).status,
      401,
    );
    sessionHeaders = { authorization: `Bearer ${secJson.token}` };

    // Passphrase login works
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "my-super-safe-vps-passphrase" }),
    });
    assert.equal(loginRes.status, 200);
    assert.equal(
      (
        await app.request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase: "wrong-password-123" }),
        })
      ).status,
      401,
    );

    // 8. Persona & Telegram token
    const personaRes = await app.request("/api/onboarding/persona", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({
        ownerName: "Diego",
        technicalLevel: "non-technical",
        communicationStyle: "plain-english",
        approvalMode: "manual",
        telegramBotToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      }),
    });
    assert.equal(personaRes.status, 200);
    const personaJson = (await personaRes.json()) as {
      state: { telegramConfigured: boolean; discordConfigured: boolean };
    };
    assert.equal(personaJson.state.telegramConfigured, true);
    assert.equal(personaJson.state.discordConfigured, false);

    // 9. Baseline scan updates MEMORY.md cleanly within char limits
    const scanRes = await app.request("/api/onboarding/baseline-scan", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({}),
    });
    assert.equal(scanRes.status, 200);

    // 10. Complete onboarding
    const completeRes = await app.request("/api/onboarding/complete", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeaders },
      body: JSON.stringify({}),
    });
    assert.equal(completeRes.status, 200);
    const completeJson = (await completeRes.json()) as {
      state: { completed: boolean };
    };
    assert.equal(completeJson.state.completed, true);

    // Verify onboarding.env & Hermes files persisted properly and secrets stayed out of SQLite/audit
    const envContent = fs.readFileSync(envPath, "utf8");
    assert.match(envContent, /^VPS_OS_DOMAIN=os\.myserver\.org$/m);
    assert.match(envContent, /^LLM_API_KEY=sk-proj-testsecret1234567890$/m);
    assert.match(
      envContent,
      /^TELEGRAM_BOT_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw$/m,
    );

    const userMd = fs.readFileSync(path.join(hermesHome, "memories", "USER.md"), "utf8");
    assert.equal(userMd.length <= HERMES_USER_MAX_CHARS, true);
    assert.match(userMd, /Diego/);

    const memMd = fs.readFileSync(path.join(hermesHome, "memories", "MEMORY.md"), "utf8");
    assert.equal(memMd.length <= HERMES_MEMORY_MAX_CHARS, true);
    assert.match(memMd, /os\.myserver\.org/);

    const auditEvents = registry.listAuditEvents(50);
    const auditBlob = JSON.stringify(auditEvents);
    assert.equal(auditBlob.includes("sk-proj-testsecret1234567890"), false);
    assert.equal(auditBlob.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), false);
    assert.ok(appliedReasons.includes("onboarding-completed"));
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Setup claim locks permanently after 5 invalid attempts", async () => {
  const registry = new SystemRegistryStore(":memory:");
  const app = createDashboardApp({
    registry,
    adminToken: "master-admin-token-for-lock-test",
    initialSetupCodeHash: hashSetupCode("ABCD-2345-EFGH"),
    rateLimitMax: 50,
  });

  try {
    for (let i = 0; i < 4; i++) {
      const res = await app.request("/api/auth/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: "BAD0-0000-0000" }),
      });
      assert.equal(res.status, 401);
    }

    const fifthRes = await app.request("/api/auth/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "BAD0-0000-0000" }),
    });
    assert.equal(fifthRes.status, 429);

    // Even the real code is now rejected once locked
    const realRes = await app.request("/api/auth/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "ABCD-2345-EFGH" }),
    });
    assert.equal(realRes.status, 429);
  } finally {
    registry.close();
  }
});

test("OpenCode provider supports Zen, Go, and local opencode serve setup & env persistence", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-opencode-"));
  const envPath = path.join(tempDir, "config", "onboarding.env");
  const hermesHome = path.join(tempDir, "hermes");
  provisionHermesHome({ hermesHome });

  const registry = new SystemRegistryStore(path.join(tempDir, "data", "registry.db"));
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer master-admin-token-for-opencode-tests",
  };

  const app = createDashboardApp({
    registry,
    adminToken: "master-admin-token-for-opencode-tests",
    onboardingEnvPath: envPath,
    hermesHome,
    dataDir: path.join(tempDir, "data"),
    testProviderConnection: async (input) => ({
      ok: true,
      provider: input.provider,
      model: input.model,
      latencyMs: 18,
      availableModels: ["claude-sonnet-4-5", "gpt-5.2", "deepseek-r1"],
      message: `Connected to OpenCode (${input.model}) in 18ms. Found 3 models.`,
    }),
  });

  try {
    // 1. OpenCode Go requires an API key
    const goNoKeyRes = await app.request("/api/onboarding/provider", {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "opencode",
        model: "deepseek-r1",
        baseUrl: "https://opencode.ai/zen/go/v1",
      }),
    });
    assert.equal(goNoKeyRes.status, 400);

    // 2. OpenCode Zen saves cleanly with OPENCODE_API_KEY and default Zen URL
    const zenSaveRes = await app.request("/api/onboarding/provider", {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "opencode",
        model: "claude-sonnet-4-5",
        apiKey: "sk-opencode-secret-key-999999",
      }),
    });
    assert.equal(zenSaveRes.status, 200);
    const zenJson = (await zenSaveRes.json()) as {
      state: { llmProvider: string; llmModel: string; llmBaseUrl: string; llmConfigured: boolean };
    };
    assert.equal(zenJson.state.llmProvider, "opencode");
    assert.equal(zenJson.state.llmModel, "claude-sonnet-4-5");
    assert.equal(zenJson.state.llmBaseUrl, "https://opencode.ai/zen/v1");
    assert.equal(zenJson.state.llmConfigured, true);

    const zenEnv = fs.readFileSync(envPath, "utf8");
    assert.match(zenEnv, /^LLM_PROVIDER=opencode$/m);
    assert.match(zenEnv, /^LLM_BASE_URL=https:\/\/opencode\.ai\/zen\/v1$/m);
    assert.match(zenEnv, /^OPENCODE_API_KEY=sk-opencode-secret-key-999999$/m);

    // 3. Test endpoint returns discovered models list
    const testRes = await app.request("/api/onboarding/provider/test", {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "opencode",
        model: "claude-sonnet-4-5",
      }),
    });
    assert.equal(testRes.status, 200);
    const testJson = (await testRes.json()) as {
      result: { ok: boolean; availableModels?: string[] };
    };
    assert.equal(testJson.result.ok, true);
    assert.deepEqual(testJson.result.availableModels, [
      "claude-sonnet-4-5",
      "gpt-5.2",
      "deepseek-r1",
    ]);

    // 4. Local OpenCode Server works without API key and clears OPENCODE_API_KEY
    const localSaveRes = await app.request("/api/onboarding/provider", {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "opencode",
        model: "gpt-5.2",
        baseUrl: "http://host.docker.internal:4096",
      }),
    });
    assert.equal(localSaveRes.status, 200);
    const localEnv = fs.readFileSync(envPath, "utf8");
    assert.match(localEnv, /^LLM_BASE_URL=http:\/\/host\.docker\.internal:4096$/m);
    assert.equal(localEnv.includes("OPENCODE_API_KEY="), false);

    // Hermes config.yaml reflects opencode provider
    const hermesCfg = fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8");
    assert.match(hermesCfg, /provider: "opencode"/);
    assert.match(hermesCfg, /name: "gpt-5\.2"/);
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenCode presets provide accurate per-mode models and live /models discovery filters chat-completions", async () => {
  const opencodeEntry = LLM_PROVIDER_CATALOG.find((entry) => entry.id === "opencode");
  assert.ok(opencodeEntry);

  const zenPreset = findProviderEndpointPreset(opencodeEntry, OPENCODE_ZEN_BASE_URL);
  const goPreset = findProviderEndpointPreset(opencodeEntry, OPENCODE_GO_BASE_URL);
  assert.ok(zenPreset?.suggestedModels?.length);
  assert.ok(goPreset?.suggestedModels?.length);
  assert.equal(goPreset.defaultModel, "glm-5.3");
  assert.equal(goPreset.suggestedModels.includes("claude-sonnet-4-5"), false);
  assert.equal(goPreset.suggestedModels.includes("gpt-5.2"), false);
  assert.ok(goPreset.suggestedModels.includes("kimi-k3.1-pro"));

  const filtered = extractModelIdsFromPayload(
    {
      data: [
        { id: "glm-5.3", type: "chat", recommended_api: "chat-completions" },
        { id: "claude-sonnet-4-5", type: "chat", recommended_api: "messages" },
        { id: "gpt-5.2", type: "chat", recommended_api: "responses" },
        { id: "text-embedding-3-small", type: "embeddings", recommended_api: "embeddings" },
        { id: "kimi-k3.1-pro", type: "chat", recommended_api: "chat-completions" },
      ],
    },
    { preferChatCompletions: true },
  );
  assert.deepEqual(filtered, ["glm-5.3", "kimi-k3.1-pro"]);

  const liveResult = await discoverLlmProviderModels(
    { provider: "opencode", baseUrl: OPENCODE_GO_BASE_URL, apiKey: "sk-test" },
    async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "glm-5.3", type: "chat", recommended_api: "chat-completions" },
            { id: "qwen4-max", type: "chat", recommended_api: "messages" },
            { id: "deepseek-v4-pro", type: "chat", recommended_api: "chat-completions" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  assert.equal(liveResult.source, "live");
  assert.deepEqual(liveResult.models, ["glm-5.3", "deepseek-v4-pro"]);

  const fallbackResult = await discoverLlmProviderModels(
    { provider: "opencode", baseUrl: OPENCODE_GO_BASE_URL, apiKey: "sk-test" },
    async () => {
      throw new Error("offline");
    },
  );
  assert.equal(fallbackResult.source, "fallback");
  assert.deepEqual(fallbackResult.models, goPreset.suggestedModels);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-models-route-"));
  const registry = new SystemRegistryStore(path.join(tempDir, "registry.db"));
  const app = createDashboardApp({
    registry,
    adminToken: "master-admin-token-for-models-route",
    discoverProviderModels: async (input) => ({
      models:
        input.baseUrl === OPENCODE_GO_BASE_URL
          ? ["glm-5.3", "kimi-k3.1-pro"]
          : ["glm-5.3", "kimi-k3"],
      source: "live",
    }),
  });
  try {
    const res = await app.request("/api/onboarding/provider/models", {
      method: "POST",
      headers: {
        authorization: "Bearer master-admin-token-for-models-route",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "opencode",
        baseUrl: OPENCODE_GO_BASE_URL,
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { models: string[]; source: string };
    assert.equal(json.source, "live");
    assert.deepEqual(json.models, ["glm-5.3", "kimi-k3.1-pro"]);
  } finally {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
