import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  assert.match(
    script,
    /! grep -q "VPS_OS_SITE_ADDRESS" "\$\{VPS_OS_ROOT\}\/docker-compose\.yml"/,
  );
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
  assert.match(
    coreCompose,
    /^\s*caddy:\r?\n[\s\S]*?^\s+environment:\r?\n(?:^\s+-\s+.*\r?\n)*?^\s+-\s+VPS_OS_SITE_ADDRESS=\$\{VPS_OS_SITE_ADDRESS:-localhost\}\r?\n[\s\S]*?^\s*dashboard-api:/m,
    "caddy service must pass VPS_OS_SITE_ADDRESS=${VPS_OS_SITE_ADDRESS:-localhost}",
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

function toBashPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function runHardenSshInSandbox(
  bash: string,
  scriptPath: string,
  options: {
    confDir: string;
    rootKeysPath: string;
    sudoUser?: string;
    sudoUserHome?: string;
    forceOverwrite?: boolean;
  },
): { stdout: string; reloadCalls: string[]; confExists: boolean; confContent: string } {
  const reloadLogPath = path.join(options.confDir, "..", "systemctl-reloads.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INSTALL_SCRIPT: toBashPath(scriptPath),
    SSH_CONFIG_DIR: toBashPath(options.confDir),
    SSH_ROOT_AUTHORIZED_KEYS: toBashPath(options.rootKeysPath),
    RELOAD_LOG: toBashPath(reloadLogPath),
    TEST_FORCE_OVERWRITE: options.forceOverwrite ? "--force" : "",
  };
  if (options.sudoUser !== undefined) {
    env.SUDO_USER = options.sudoUser;
  } else {
    delete env.SUDO_USER;
  }
  if (options.sudoUserHome !== undefined) {
    env.SSH_SUDO_USER_HOME = toBashPath(options.sudoUserHome);
  } else {
    delete env.SSH_SUDO_USER_HOME;
  }

  const bashCmd = [
    'source "${INSTALL_SCRIPT}"',
    'FORCE_OVERWRITE="${TEST_FORCE_OVERWRITE}"',
    'systemctl() { printf "%s\\n" "$*" >> "${RELOAD_LOG}"; }',
    "harden_ssh",
  ].join("\n");

  const stdout = execFileSync(bash, ["-euo", "pipefail", "-c", bashCmd], {
    env,
    encoding: "utf8",
  });

  const confPath = path.join(options.confDir, "99-vps-os-hardening.conf");
  const confExists = fs.existsSync(confPath);
  const confContent = confExists ? fs.readFileSync(confPath, "utf8") : "";
  const reloadCalls = fs.existsSync(reloadLogPath)
    ? fs
        .readFileSync(reloadLogPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  return { stdout, reloadCalls, confExists, confContent };
}

test("bootstrap/install.sh harden_ssh guards against password-only VPS lockout", () => {
  const scriptPath = path.join(REPO_ROOT, "bootstrap", "install.sh");
  const script = fs.readFileSync(scriptPath, "utf8");

  assert.match(script, /has_authorized_ssh_keys\(\)/);
  assert.match(script, /if ! has_authorized_ssh_keys; then/);
  assert.match(script, /skipping SSH hardening because no valid SSH public keys were found/i);
  assert.match(script, /--force/);

  const bash = findBashBinary();
  if (!bash) {
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-harden-ssh-"));
  try {
    // Case 1: No authorized_keys file -> must skip hardening and never reload ssh
    const case1Dir = path.join(tmpRoot, "case1");
    const case1ConfDir = path.join(case1Dir, "sshd_config.d");
    fs.mkdirSync(case1ConfDir, { recursive: true });
    const res1 = runHardenSshInSandbox(bash, scriptPath, {
      confDir: case1ConfDir,
      rootKeysPath: path.join(case1Dir, "missing_authorized_keys"),
    });
    assert.equal(res1.confExists, false, "must not write hardening config without SSH keys");
    assert.deepEqual(res1.reloadCalls, [], "must not reload ssh when hardening is skipped");
    assert.match(res1.stdout, /skipping SSH hardening/i);
    assert.match(res1.stdout, /--force/);

    // Case 2: Comments-only / blank authorized_keys -> must still skip hardening
    const case2Dir = path.join(tmpRoot, "case2");
    const case2ConfDir = path.join(case2Dir, "sshd_config.d");
    fs.mkdirSync(case2ConfDir, { recursive: true });
    const case2Keys = path.join(case2Dir, "authorized_keys");
    fs.writeFileSync(
      case2Keys,
      "\n  # ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestCommentedKey user@host\n# another comment\n   \n",
      "utf8",
    );
    const res2 = runHardenSshInSandbox(bash, scriptPath, {
      confDir: case2ConfDir,
      rootKeysPath: case2Keys,
    });
    assert.equal(res2.confExists, false, "must ignore comments-only authorized_keys");
    assert.deepEqual(res2.reloadCalls, []);

    // Case 3: Valid root SSH public key -> writes both directives and reloads ssh
    const case3Dir = path.join(tmpRoot, "case3");
    const case3ConfDir = path.join(case3Dir, "sshd_config.d");
    fs.mkdirSync(case3ConfDir, { recursive: true });
    const case3Keys = path.join(case3Dir, "authorized_keys");
    fs.writeFileSync(
      case3Keys,
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleValidKeyPayload0123456789 user@host\n",
      "utf8",
    );
    const res3 = runHardenSshInSandbox(bash, scriptPath, {
      confDir: case3ConfDir,
      rootKeysPath: case3Keys,
    });
    assert.equal(res3.confExists, true, "must write hardening config when root key exists");
    assert.match(res3.confContent, /^PermitRootLogin prohibit-password$/m);
    assert.match(res3.confContent, /^PasswordAuthentication no$/m);
    assert.deepEqual(res3.reloadCalls, ["reload ssh"]);

    // Case 4: Missing root keys, valid options-prefixed key in SUDO_USER's ~/.ssh/authorized_keys
    const case4Dir = path.join(tmpRoot, "case4");
    const case4ConfDir = path.join(case4Dir, "sshd_config.d");
    const sudoHome = path.join(case4Dir, "alice");
    fs.mkdirSync(case4ConfDir, { recursive: true });
    fs.mkdirSync(path.join(sudoHome, ".ssh"), { recursive: true });
    fs.writeFileSync(
      path.join(sudoHome, ".ssh", "authorized_keys"),
      'no-port-forwarding,command="/bin/true" sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t alice@laptop\n',
      "utf8",
    );
    const res4 = runHardenSshInSandbox(bash, scriptPath, {
      confDir: case4ConfDir,
      rootKeysPath: path.join(case4Dir, "missing_root_keys"),
      sudoUser: "alice",
      sudoUserHome: sudoHome,
    });
    assert.equal(res4.confExists, true, "must accept valid key in SUDO_USER authorized_keys");
    assert.match(res4.confContent, /^PermitRootLogin prohibit-password$/m);
    assert.match(res4.confContent, /^PasswordAuthentication no$/m);
    assert.deepEqual(res4.reloadCalls, ["reload ssh"]);

    // Case 5: SUDO_USER=root must not check sudo-user fallback when root keys are missing
    const case5Dir = path.join(tmpRoot, "case5");
    const case5ConfDir = path.join(case5Dir, "sshd_config.d");
    fs.mkdirSync(case5ConfDir, { recursive: true });
    const res5 = runHardenSshInSandbox(bash, scriptPath, {
      confDir: case5ConfDir,
      rootKeysPath: path.join(case5Dir, "missing_root_keys"),
      sudoUser: "root",
      sudoUserHome: sudoHome,
    });
    assert.equal(res5.confExists, false, "must skip hardening when SUDO_USER is root and root keys are missing");
    assert.deepEqual(res5.reloadCalls, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("bootstrap/install.sh uses non-interactive apt_get with lock timeout and verbose Hermes install", () => {
  const scriptPath = path.join(REPO_ROOT, "bootstrap", "install.sh");
  const script = fs.readFileSync(scriptPath, "utf8");

  assert.match(
    script,
    /export DEBIAN_FRONTEND="\$\{DEBIAN_FRONTEND:-noninteractive\}"/,
    "install.sh must export DEBIAN_FRONTEND=noninteractive",
  );
  assert.match(
    script,
    /export NEEDRESTART_MODE="\$\{NEEDRESTART_MODE:-a\}"/,
    "install.sh must export NEEDRESTART_MODE=a",
  );
  assert.match(
    script,
    /export NEEDRESTART_SUSPEND="\$\{NEEDRESTART_SUSPEND:-1\}"/,
    "install.sh must export NEEDRESTART_SUSPEND=1",
  );
  assert.match(
    script,
    /apt-get -o DPkg::Lock::Timeout=120 "\$@"/,
    "apt_get helper must wait up to 120s for dpkg lock",
  );
  assert.doesNotMatch(
    script,
    /^\s*apt-get\s+(update|install)\b/m,
    "install.sh should route apt-get calls through apt_get helper",
  );
  assert.match(
    script,
    /curl -fsSL https:\/\/hermes-agent\.nousresearch\.com\/install\.sh \|\s*HERMES_HOME="\$\{HERMES_HOME\}" bash -s -- --non-interactive --skip-browser --skip-computer-use --verbose/,
    "ensure_hermes must invoke Hermes installer with headless non-interactive and verbose flags",
  );
  assert.match(
    script,
    /if \[\[ "\$\{INSTALL_HERMES\}" != "true" \]\]; then/,
    "ensure_hermes must preserve INSTALL_HERMES opt-out",
  );

  const bash = findBashBinary();
  if (!bash) {
    return;
  }

  const stdout = execFileSync(
    bash,
    [
      "-euo",
      "pipefail",
      "-c",
      'source "${INSTALL_SCRIPT}"; INSTALL_HERMES=false; curl() { echo "UNEXPECTED_CURL"; exit 99; }; ensure_hermes',
    ],
    {
      env: { ...process.env, INSTALL_SCRIPT: toBashPath(scriptPath) },
      encoding: "utf8",
    },
  );
  assert.match(stdout, /Skipping Hermes Agent installation \(INSTALL_HERMES=false\)/);
});
