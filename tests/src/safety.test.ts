import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SystemRegistryStore,
  redactSecrets,
  resolveScopedAppDir,
  validateAppSlug,
  validateDomain,
} from "@vps-os/shared";

test("validateAppSlug accepts valid slugs and rejects reserved or unsafe names", () => {
  assert.equal(validateAppSlug("personal-agent"), "personal-agent");
  assert.equal(validateAppSlug("crm01"), "crm01");

  assert.throws(() => validateAppSlug("../escape"), /Invalid app slug/);
  assert.throws(() => validateAppSlug("a"), /Invalid app slug/);
  assert.throws(() => validateAppSlug("Bad_Slug"), /Invalid app slug/);
  assert.throws(() => validateAppSlug("dashboard"), /Reserved app slug/);
});

test("resolveScopedAppDir enforces lexical containment and blocks symlinks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-scope-"));
  const appsRoot = path.join(tempDir, "apps");
  const outsideDir = path.join(tempDir, "outside");
  fs.mkdirSync(appsRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  try {
    const resolved = resolveScopedAppDir(appsRoot, "my-app");
    assert.equal(resolved, path.join(appsRoot, "my-app"));

    assert.throws(() => resolveScopedAppDir(appsRoot, "../etc"), /Invalid app slug/);
    assert.throws(() => resolveScopedAppDir(appsRoot, "foo/bar"), /Invalid app slug/);

    // Symlink pointing outside appsRoot (or to sibling) must be rejected
    const siblingDir = path.join(appsRoot, "sibling-app");
    fs.mkdirSync(siblingDir, { recursive: true });

    const outsideLink = path.join(appsRoot, "evil-outside");
    const siblingLink = path.join(appsRoot, "evil-sibling");
    try {
      fs.symlinkSync(outsideDir, outsideLink, "junction");
      fs.symlinkSync(siblingDir, siblingLink, "junction");
      assert.throws(
        () => resolveScopedAppDir(appsRoot, "evil-outside"),
        /symbolic link|escapes/,
      );
      assert.throws(
        () => resolveScopedAppDir(appsRoot, "evil-sibling"),
        /symbolic link|escapes/,
      );
    } catch (err) {
      // If OS lacks symlink privilege (non-admin Windows without Developer Mode), skip only symlink assertion.
      if ((err as NodeJS.ErrnoException).code !== "EPERM") {
        throw err;
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("validateDomain rejects whitespace, paths, and Caddyfile injection", () => {
  assert.equal(validateDomain("App.Example.COM"), "app.example.com");
  assert.throws(() => validateDomain("bad domain.com"), /Invalid domain/);
  assert.throws(() => validateDomain("app.com/evil"), /Invalid domain/);
  assert.throws(() => validateDomain("app.com {\n respond 200\n}"), /Invalid domain/);
});

test("redactSecrets masks env, YAML, JSON, header, provider tokens, and PEM keys", () => {
  const raw = [
    "LLM_API_KEY=sk-1234567890abcdef",
    "password=hunter2",
    "api_key: secret_val_123",
    '{"token":"tok_abc123456"}',
    "Authorization: Bearer secretToken12345",
    "xoxb-1234567890-abcdef",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAL\n-----END RSA PRIVATE KEY-----",
  ].join(" ");

  const redacted = redactSecrets(raw);

  for (const leaked of [
    "sk-1234567890abcdef",
    "hunter2",
    "secret_val_123",
    "tok_abc123456",
    "secretToken12345",
    "xoxb-1234567890-abcdef",
    "MIIBOgIBAAJBAL",
  ]) {
    assert.equal(redacted.includes(leaked), false, `Expected ${leaked} to be redacted`);
  }
  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);
});

test("SystemRegistryStore validates inputs, redacts audit summaries, and tracks plans", () => {
  const store = new SystemRegistryStore(":memory:");
  const now = "2026-11-18T00:00:00.000Z";

  store.upsertApp({
    slug: "life-agent",
    name: "Personal Life Agent",
    kind: "personal-agent",
    domain: null,
    folderPath: "/apps/life-agent",
    internalPort: 3000,
    status: "running",
    cpuLimit: "1.0",
    memoryLimitMb: 1024,
    createdAt: now,
    updatedAt: now,
  });

  assert.equal(store.listApps().length, 1);
  assert.equal(store.updateAppStatus("life-agent", "stopped"), true);
  assert.equal(store.updateAppStatus("non-existent", "stopped"), false);
  assert.throws(
    () => store.updateAppStatus("life-agent", "invalid" as never),
    /Invalid/,
  );

  store.recordAudit({
    id: "evt-1",
    actor: "agent",
    action: "app.stopped",
    targetSlug: "life-agent",
    summary: "Stopped life-agent with password=mysecretpass",
    riskLevel: "medium",
    createdAt: now,
  });

  const events = store.listAuditEvents(10);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.summary.includes("mysecretpass"), false);

  store.close();
});
