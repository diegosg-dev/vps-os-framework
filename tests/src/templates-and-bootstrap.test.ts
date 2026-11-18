import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function findBashBinary(): string | null {
  const candidates = [
    "bash",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

test("bootstrap/install.sh passes bash -n and avoids destructive defaults", () => {
  const scriptPath = path.join(REPO_ROOT, "bootstrap", "install.sh");
  const script = fs.readFileSync(scriptPath, "utf8");

  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.equal(script.includes("rm -rf /"), false);

  const bash = findBashBinary();
  if (bash) {
    execFileSync(bash, ["-n", scriptPath], { stdio: "pipe" });
  }
});

test("bootstrap core files include Dockerfile, private agent routing, and non-empty Caddy apps.d", () => {
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "bootstrap", "Dockerfile")),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(REPO_ROOT, "bootstrap", "caddy", "apps.d", "00-default.caddy"),
    ),
    true,
  );

  const caddyfile = fs.readFileSync(
    path.join(REPO_ROOT, "bootstrap", "Caddyfile"),
    "utf8",
  );
  assert.equal(
    caddyfile.includes("handle /agent/*"),
    false,
    "Caddyfile must not expose internal /agent/* endpoints publicly",
  );
});

test("docker-compose templates enforce Locked Apartment isolation", () => {
  const composeFiles = [
    path.join(REPO_ROOT, "bootstrap", "docker-compose.core.yml"),
    path.join(REPO_ROOT, "templates", "personal-agent", "docker-compose.yml"),
    path.join(REPO_ROOT, "templates", "web-app", "docker-compose.yml"),
  ];

  for (const file of composeFiles) {
    const content = fs.readFileSync(file, "utf8");
    assert.equal(
      content.includes("/var/run/docker.sock"),
      false,
      `${file} must never mount the Docker socket`,
    );
    assert.match(
      content,
      /no-new-privileges:true/,
      `${file} must enforce no-new-privileges:true`,
    );
    assert.match(
      content,
      /cap_drop:/,
      `${file} must drop Linux capabilities`,
    );
  }
});

test(".env.example files contain safe placeholders only", () => {
  const envExamples = [
    path.join(REPO_ROOT, ".env.example"),
    path.join(REPO_ROOT, "bootstrap", ".env.example"),
    path.join(REPO_ROOT, "templates", "personal-agent", ".env.example"),
    path.join(REPO_ROOT, "templates", "web-app", ".env.example"),
  ];

  for (const file of envExamples) {
    const content = fs.readFileSync(file, "utf8");
    assert.equal(/\bsk-[A-Za-z0-9]{12,}/.test(content), false);
    assert.equal(/BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/.test(content), false);
  }
});
