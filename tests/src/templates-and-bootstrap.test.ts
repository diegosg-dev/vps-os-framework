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

function findPythonBinary(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

test("bootstrap/install.sh, apply-onboarding.sh, and runtime-bridge.py pass syntax checks and use LF endings", () => {
  const scriptPath = path.join(REPO_ROOT, "bootstrap", "install.sh");
  const applyScriptPath = path.join(REPO_ROOT, "bootstrap", "apply-onboarding.sh");
  const bridgeScriptPath = path.join(REPO_ROOT, "bootstrap", "runtime-bridge.py");
  const script = fs.readFileSync(scriptPath, "utf8");
  const applyScript = fs.readFileSync(applyScriptPath, "utf8");
  const bridgeScript = fs.readFileSync(bridgeScriptPath, "utf8");

  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.equal(script.includes("\r\n"), false, "install.sh must use LF line endings");
  assert.equal(script.includes("rm -rf /"), false);

  assert.match(applyScript, /^#!\/usr\/bin\/env bash/);
  assert.match(applyScript, /set -euo pipefail/);
  assert.equal(
    applyScript.includes("\r\n"),
    false,
    "apply-onboarding.sh must use LF line endings",
  );
  assert.equal(
    /^\s*(?:source|\.)\s+.*onboarding\.env/m.test(applyScript),
    false,
    "apply-onboarding.sh must never source onboarding.env",
  );

  assert.match(bridgeScript, /^#!\/usr\/bin\/env python3/);
  assert.equal(
    bridgeScript.includes("\r\n"),
    false,
    "runtime-bridge.py must use LF line endings",
  );
  assert.equal(
    bridgeScript.includes("shell=True"),
    false,
    "runtime-bridge.py must never invoke subprocesses with shell=True",
  );

  const bash = findBashBinary();
  if (bash) {
    execFileSync(bash, ["-n", scriptPath], { stdio: "pipe" });
    execFileSync(bash, ["-n", applyScriptPath], { stdio: "pipe" });
  }

  const pyBin = findPythonBinary();
  if (pyBin) {
    execFileSync(
      pyBin,
      [
        "-c",
        "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())",
        bridgeScriptPath,
      ],
      { stdio: "pipe" },
    );
  }

  assert.match(script, /sync_hermes_pack/);
  assert.match(script, /vps-os-hermes-cto\.service/);
  assert.match(script, /generate_setup_claim/);
  assert.match(script, /configure_onboarding_sync_service/);
  assert.match(script, /configure_runtime_bridge_service/);
  assert.match(script, /vps-os-runtime\.service/);
  assert.match(script, /VPS_OS_RUNTIME_TOKEN/);
  assert.match(script, /runtime-bridge\.env/);
  assert.match(script, /ProtectSystem=strict/);
  assert.match(script, /! grep -q "ProtectHome=true"/);
  assert.match(script, /print_onboarding_summary/);
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

  const coreCompose = fs.readFileSync(
    path.join(REPO_ROOT, "bootstrap", "docker-compose.core.yml"),
    "utf8",
  );
  assert.match(coreCompose, /VPS_OS_RUNTIME_SOCKET=\/run\/vps-os\/runtime\.sock/);
  assert.match(coreCompose, /VPS_OS_RUNTIME_TOKEN=\$\{VPS_OS_RUNTIME_TOKEN:\?/);
  assert.match(coreCompose, /VPS_OS_AGENT_URL=http:\/\/agent:3002/);

  const personalAgentCompose = fs.readFileSync(
    path.join(REPO_ROOT, "templates", "personal-agent", "docker-compose.yml"),
    "utf8",
  );
  assert.match(personalAgentCompose, /\binit:\s*true\b/);
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
