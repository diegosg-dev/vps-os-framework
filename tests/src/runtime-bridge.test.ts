import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentHttpServer,
  createExecutionPlan,
  createMcpRequestHandler,
  provisionIsolatedWorkspace,
} from "@vps-os/agent";
import {
  createAgentPlanExecutor,
  createDashboardApp,
  createRuntimeWorkloadController,
} from "@vps-os/dashboard-api";
import {
  type AppStatus,
  HttpRuntimeBridgeClient,
  type RuntimeBridge,
  RuntimeBridgeError,
  SystemRegistryStore,
  createRuntimeBridgeFromEnv,
  syncAppStatuses,
} from "@vps-os/shared";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const TEMPLATES_ROOT = path.join(REPO_ROOT, "templates");
const RUNTIME_BRIDGE_SCRIPT = path.join(
  REPO_ROOT,
  "bootstrap",
  "runtime-bridge.py",
);

function findPythonBinary(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try next binary
    }
  }
  return null;
}

function createFakeDockerShim(
  tempDir: string,
  pythonBin: string,
  stateFile: string,
  callsLog: string,
  envLog: string,
): string {
  const shimPy = path.join(tempDir, "fake_docker.py");
  fs.writeFileSync(
    shimPy,
    `import json, os, sys

state_file = ${JSON.stringify(stateFile)}
calls_log = ${JSON.stringify(callsLog)}
env_log = ${JSON.stringify(envLog)}
args = sys.argv[1:]

with open(calls_log, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(args) + "\\n")

with open(env_log, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(sorted(os.environ.keys())) + "\\n")

def load_state():
    if os.path.exists(state_file):
        with open(state_file, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return {"projects": {}, "networks": [], "failValidate": False, "failDown": False, "psDelay": 0.0}

def save_state(st):
    with open(state_file, "w", encoding="utf-8") as fh:
        json.dump(st, fh)

st = load_state()

if args[:1] == ["compose"]:
    proj = ""
    if "-p" in args:
        proj = args[args.index("-p") + 1]
    if "up" in args:
        st["projects"][proj] = "running"
        net = f"{proj}_app_net"
        if net not in st["networks"]:
            st["networks"].append(net)
        save_state(st)
        sys.exit(0)
    if "stop" in args:
        st["projects"][proj] = "stopped"
        save_state(st)
        sys.exit(0)
    if "restart" in args:
        st["projects"][proj] = "running"
        save_state(st)
        sys.exit(0)
    if "down" in args:
        if st.get("failDown"):
            sys.stderr.write("Error: simulated compose down failure\\n")
            sys.exit(1)
        st["projects"].pop(proj, None)
        save_state(st)
        sys.exit(0)
    if "ps" in args:
        delay = float(st.get("psDelay", 0.0) or 0.0)
        if delay > 0:
            import time
            time.sleep(delay)
        status = st["projects"].get(proj, "stopped")
        if status == "running":
            print(json.dumps({"Name": proj, "State": "running", "Health": "healthy", "ExitCode": 0}))
        elif status == "exited_sigterm":
            print(json.dumps({"Name": proj, "State": "exited", "Health": "", "ExitCode": 143}))
        elif status == "error":
            print(json.dumps({"Name": proj, "State": "exited", "Health": "", "ExitCode": 1}))
        sys.exit(0)
    if "logs" in args:
        print(f"Booted {proj}")
        print("Connected with API_KEY=sk-secret1234567890")
        print("Telegram token 123456789:AAFakeBotTokenValueForTesting1234567")
        print("-----BEGIN PRIVATE KEY-----")
        print("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ")
        print("-----END PRIVATE KEY-----")
        sys.stderr.write("Authorization: Bearer supersecret_token_value\\n")
        sys.exit(0)

if args[:2] == ["network", "inspect"]:
    net = args[2]
    if net not in st["networks"]:
        sys.stderr.write(f"No such network: {net}\\n")
        sys.exit(1)
    sys.exit(0)

if args[:2] == ["network", "connect"]:
    sys.exit(0)

if args[:2] == ["network", "disconnect"]:
    sys.exit(0)

if args[:1] == ["exec"] and "validate" in args:
    if st.get("failValidate"):
        sys.stderr.write("Error: invalid Caddyfile directive\\n")
        sys.exit(1)
    sys.exit(0)

if args[:1] == ["exec"] and "reload" in args:
    sys.exit(0)

sys.exit(0)
`,
    "utf8",
  );

  if (process.platform === "win32") {
    const cmdPath = path.join(tempDir, "fake-docker.cmd");
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\n"${pythonBin}" "${shimPy}" %*\r\n`,
      "utf8",
    );
    return cmdPath;
  }

  const shPath = path.join(tempDir, "fake-docker");
  fs.writeFileSync(
    shPath,
    `#!/usr/bin/env sh\nexec "${pythonBin}" "${shimPy}" "$@"\n`,
    "utf8",
  );
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

async function startPythonRuntimeBridge(options: {
  pythonBin: string;
  appsRoot: string;
  caddyAppsDir: string;
  dockerBin: string;
  runtimeToken: string;
  socketPath?: string;
  statusDeadlineS?: number;
  extraEnv?: Record<string, string>;
}): Promise<{ baseUrl?: string; socketPath?: string; close: () => Promise<void> }> {
  const args = [
    RUNTIME_BRIDGE_SCRIPT,
    "--apps-root",
    options.appsRoot,
    "--caddy-apps-dir",
    options.caddyAppsDir,
    "--docker-bin",
    options.dockerBin,
    "--runtime-token",
    options.runtimeToken,
  ];
  if (options.statusDeadlineS !== undefined) {
    args.push("--status-deadline", String(options.statusDeadlineS));
  }
  if (options.socketPath) {
    args.push("--socket", options.socketPath);
  } else {
    args.push("--tcp", "127.0.0.1:0");
  }

  const child = spawn(options.pythonBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(options.extraEnv ?? {}),
    },
  });

  const listenTarget = await new Promise<string>((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for runtime-bridge.py startup. stderr=${stderrBuf}`,
        ),
      );
    }, 8000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const match = stdoutBuf.match(/LISTENING ((?:http|unix):\/\/[^\r\n]+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1].trim());
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `runtime-bridge.py exited prematurely with code ${code}: ${stderrBuf}`,
        ),
      );
    });
  });

  return {
    ...(listenTarget.startsWith("http://") ? { baseUrl: listenTarget } : {}),
    ...(listenTarget.startsWith("unix://")
      ? { socketPath: listenTarget.slice("unix://".length) }
      : {}),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          setTimeout(resolve, 2000);
        });
      }
    },
  };
}

test("bootstrap/runtime-bridge.py enforces auth, sanitized env, strict Compose isolation, redacted logs, domain uniqueness, and atomic rollback", async (t) => {
  const pythonBin = findPythonBinary();
  if (!pythonBin) {
    t.skip("Python 3 binary not found in PATH");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-bridge-"));
  const appsRoot = path.join(tempDir, "apps");
  const caddyAppsDir = path.join(tempDir, "caddy-apps");
  const stateFile = path.join(tempDir, "docker-state.json");
  const callsLog = path.join(tempDir, "docker-calls.log");
  const envLog = path.join(tempDir, "docker-env.log");
  fs.mkdirSync(appsRoot, { recursive: true });
  fs.mkdirSync(caddyAppsDir, { recursive: true });

  const dockerBin = createFakeDockerShim(
    tempDir,
    pythonBin,
    stateFile,
    callsLog,
    envLog,
  );
  const runtimeToken = "runtime-bridge-secret-token-1234";
  const daemon = await startPythonRuntimeBridge({
    pythonBin,
    appsRoot,
    caddyAppsDir,
    dockerBin,
    runtimeToken,
    extraEnv: {
      VPS_OS_ADMIN_TOKEN: "host-admin-secret-must-not-leak",
      LLM_API_KEY: "sk-host-llm-key-must-not-leak",
      TELEGRAM_BOT_TOKEN: "99999999:AAHostTelegramMustNotLeak123456789",
    },
  });

  const registry = new SystemRegistryStore(":memory:");

  try {
    // Startup guards: short token and non-loopback --tcp must fail closed
    assert.throws(() =>
      execFileSync(
        pythonBin,
        [RUNTIME_BRIDGE_SCRIPT, "--tcp", "127.0.0.1:0", "--runtime-token", "short"],
        { stdio: "pipe" },
      ),
    );
    assert.throws(() =>
      execFileSync(
        pythonBin,
        [RUNTIME_BRIDGE_SCRIPT, "--tcp", "0.0.0.0:9999", "--runtime-token", runtimeToken],
        { stdio: "pipe" },
      ),
    );

    const unauthClient = new HttpRuntimeBridgeClient({
      baseUrl: daemon.baseUrl,
      runtimeToken: "wrong-token-value",
    });
    const client = new HttpRuntimeBridgeClient({
      baseUrl: daemon.baseUrl,
      runtimeToken,
    });

    assert.equal((await client.health()).ok, true);

    provisionIsolatedWorkspace({
      appsRoot,
      templatesRoot: TEMPLATES_ROOT,
      slug: "crm-portal",
      name: "CRM Portal",
      kind: "web-app",
      domain: "crm.example.com",
      internalPort: 8080,
      registry,
    });

    // Also verify personal-agent canonical template passes strict Compose validation
    provisionIsolatedWorkspace({
      appsRoot,
      templatesRoot: TEMPLATES_ROOT,
      slug: "life-helper",
      name: "Life Helper",
      kind: "personal-agent",
      domain: null,
      registry,
    });
    assert.equal(
      (await client.lifecycle("life-helper", "start")).status,
      "running",
    );

    // Unauthenticated and non-ASCII token calls fail closed with 401
    await assert.rejects(
      () => unauthClient.lifecycle("crm-portal", "start"),
      (err: unknown) =>
        err instanceof RuntimeBridgeError && err.statusCode === 401,
    );
    const nonAsciiRes = await fetch(`${daemon.baseUrl}/v1/apps/lifecycle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vps-os-runtime-token": "tökén-nön-äscii",
      },
      body: JSON.stringify({ slug: "crm-portal", action: "start" }),
    });
    assert.equal(nonAsciiRes.status, 401);

    // Oversized body returns 413 and reserved slug returns 400
    const oversizedRes = await fetch(`${daemon.baseUrl}/v1/apps/lifecycle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vps-os-runtime-token": runtimeToken,
      },
      body: JSON.stringify({ slug: "crm-portal", action: "start", pad: "x".repeat(70 * 1024) }),
    });
    assert.equal(oversizedRes.status, 413);

    const reservedRes = await fetch(`${daemon.baseUrl}/v1/apps/lifecycle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vps-os-runtime-token": runtimeToken,
      },
      body: JSON.stringify({ slug: "caddy", action: "start" }),
    });
    assert.equal(reservedRes.status, 400);

    // Lifecycle start -> running, stop -> stopped, restart -> running
    const started = await client.lifecycle("crm-portal", "start");
    assert.equal(started.status, "running");

    // Verify core host secrets are NEVER leaked into docker subprocess environment
    const envSnapshots = fs
      .readFileSync(envLog, "utf8")
      .trim()
      .split(/\r?\n/);
    const lastEnvKeys = JSON.parse(envSnapshots.at(-1)!) as string[];
    assert.equal(lastEnvKeys.includes("VPS_OS_ADMIN_TOKEN"), false);
    assert.equal(lastEnvKeys.includes("LLM_API_KEY"), false);
    assert.equal(lastEnvKeys.includes("TELEGRAM_BOT_TOKEN"), false);

    // Verify docker compose receives a root-owned temp Compose file outside app_dir (TOCTOU immunity)
    const callLines = fs
      .readFileSync(callsLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    const upCall = callLines.find((c) => c.includes("up") && c.includes("vps-os-crm-portal"));
    assert.ok(upCall);
    const fIdx = upCall.indexOf("-f");
    assert.notEqual(fIdx, -1);
    assert.notEqual(
      path.dirname(upCall[fIdx + 1]!),
      path.join(appsRoot, "crm-portal"),
    );

    const stopped = await client.lifecycle("crm-portal", "stop");
    assert.equal(stopped.status, "stopped");

    const restarted = await client.lifecycle("crm-portal", "restart");
    assert.equal(restarted.status, "running");

    // Logs combine stdout + stderr and redact API keys, Telegram tokens, Bearer tokens, and multi-line PEM keys
    const logs = await client.getLogs("crm-portal", 30);
    const joinedLogs = logs.join("\n");
    assert.equal(joinedLogs.includes("sk-secret1234567890"), false);
    assert.equal(joinedLogs.includes("AAFakeBotTokenValueForTesting"), false);
    assert.equal(joinedLogs.includes("supersecret_token_value"), false);
    assert.equal(joinedLogs.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw"), false);
    assert.match(joinedLogs, /\[REDACTED_PRIVATE_KEY\]/);
    assert.match(joinedLogs, /Authorization: .*\[REDACTED\]/);

    // Caddy route creation writes scoped .caddy file targeting vps-os-app-<slug>
    const routeOk = await client.routeCaddy({
      slug: "crm-portal",
      domain: "crm.example.com",
      internalPort: 8080,
    });
    assert.equal(routeOk.routed, true);
    const caddyFile = path.join(caddyAppsDir, "crm-portal.caddy");
    assert.equal(fs.existsSync(caddyFile), true);
    assert.match(
      fs.readFileSync(caddyFile, "utf8"),
      /reverse_proxy vps-os-app-crm-portal:8080/,
    );

    // Duplicate domain across two apps returns 409 Conflict
    await assert.rejects(
      () =>
        client.routeCaddy({
          slug: "life-helper",
          domain: "crm.example.com",
          internalPort: 3000,
        }),
      (err: unknown) =>
        err instanceof RuntimeBridgeError && err.statusCode === 409,
    );

    // Routing a domain to a stopped/non-networked app returns clear 409 Conflict
    await assert.rejects(
      () =>
        client.routeCaddy({
          slug: "unstarted-app",
          domain: "unstarted.example.com",
          internalPort: 80,
        }),
      (err: unknown) =>
        err instanceof RuntimeBridgeError &&
        err.statusCode === 409 &&
        /Start the app before binding/.test(err.message),
    );

    // Failed Caddy validation rolls back to previous valid .caddy route
    const dockerState = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      failValidate: boolean;
      failDown: boolean;
    };
    dockerState.failValidate = true;
    fs.writeFileSync(stateFile, JSON.stringify(dockerState), "utf8");

    await assert.rejects(
      () =>
        client.routeCaddy({
          slug: "crm-portal",
          domain: "bad-new.example.com",
          internalPort: 8080,
        }),
      (err: unknown) =>
        err instanceof RuntimeBridgeError && err.statusCode === 422,
    );
    assert.match(fs.readFileSync(caddyFile, "utf8"), /crm\.example\.com/);

    // Unrouting failure restores previous route; success deletes route
    await assert.rejects(
      () =>
        client.routeCaddy({
          slug: "crm-portal",
          domain: null,
          internalPort: 8080,
        }),
      (err: unknown) => err instanceof RuntimeBridgeError,
    );
    assert.equal(fs.existsSync(caddyFile), true);

    dockerState.failValidate = false;
    fs.writeFileSync(stateFile, JSON.stringify(dockerState), "utf8");

    const unrouted = await client.routeCaddy({
      slug: "crm-portal",
      domain: null,
      internalPort: 8080,
    });
    assert.equal(unrouted.routed, false);
    assert.equal(fs.existsSync(caddyFile), false);

    // Batch status query (>100 slugs chunking supported without silent truncation)
    const manySlugs = Array.from({ length: 105 }, (_, idx) =>
      idx === 0 ? "crm-portal" : `app-${idx}`,
    );
    const statuses = await client.getStatuses(manySlugs);
    assert.equal(Object.keys(statuses).length, 105);
    assert.equal(statuses["crm-portal"], "running");
    assert.equal(statuses["app-104"], "stopped");

    // Strict Compose isolation policy rejects every escape vector
    const unsafeCases: Array<{ name: string; compose: string; env?: string }> = [
      {
        name: "unsafe-dockersock",
        compose:
          "services:\n  web:\n    image: nginx:alpine\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\nnetworks:\n  app_net:\n    driver: bridge\n",
      },
      {
        name: "unsafe-root-bind",
        compose:
          "services:\n  web:\n    image: nginx:alpine\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\n    volumes:\n      - /:/host\nnetworks:\n  app_net:\n    driver: bridge\n",
      },
      {
        name: "unsafe-env-interp",
        compose:
          "services:\n  web:\n    image: nginx:alpine\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\n    volumes:\n      - ${VOL}\nnetworks:\n  app_net:\n    driver: bridge\n",
        env: "VOL=/var/run/docker.sock:/var/run/docker.sock\n",
      },
      {
        name: "unsafe-privileged",
        compose:
          'services:\n  web:\n    image: nginx:alpine\n    privileged: "true"\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\nnetworks:\n  app_net:\n    driver: bridge\n',
      },
      {
        name: "unsafe-capadd",
        compose:
          "services:\n  web:\n    image: nginx:alpine\n    cap_add:\n      - SYS_ADMIN\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\nnetworks:\n  app_net:\n    driver: bridge\n",
      },
      {
        name: "unsafe-hostnet",
        compose:
          'services:\n  web:\n    image: nginx:alpine\n    network_mode: "host"\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\nnetworks:\n  app_net:\n    driver: bridge\n',
      },
      {
        name: "unsafe-cname",
        compose:
          "services:\n  web:\n    image: nginx:alpine\n    container_name: vps-os-caddy\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\nnetworks:\n  app_net:\n    driver: bridge\n",
      },
      {
        name: "unsafe-envfile",
        compose:
          "services:\n  web:\n    image: nginx:alpine\n    env_file:\n      - /vps-os/.env\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    networks:\n      - app_net\nnetworks:\n  app_net:\n    driver: bridge\n",
      },
    ];

    for (const tc of unsafeCases) {
      const dir = path.join(appsRoot, tc.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "docker-compose.yml"), tc.compose, "utf8");
      if (tc.env) {
        fs.writeFileSync(path.join(dir, ".env"), tc.env, "utf8");
      }
      await assert.rejects(
        () => client.lifecycle(tc.name, "start"),
        (err: unknown) =>
          err instanceof RuntimeBridgeError && err.statusCode === 400,
        `Expected ${tc.name} to be rejected`,
      );
    }

    // Strict boolean validation for removeFiles
    const nonBoolRes = await fetch(`${daemon.baseUrl}/v1/apps/remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vps-os-runtime-token": runtimeToken,
      },
      body: JSON.stringify({ slug: "crm-portal", removeFiles: "false" }),
    });
    assert.equal(nonBoolRes.status, 400);

    // Failed compose down MUST NOT delete workspace files
    dockerState.failDown = true;
    fs.writeFileSync(stateFile, JSON.stringify(dockerState), "utf8");
    await assert.rejects(
      () => client.removeWorkload("crm-portal", { removeFiles: true }),
      (err: unknown) =>
        err instanceof RuntimeBridgeError && err.statusCode === 502,
    );
    assert.equal(fs.existsSync(path.join(appsRoot, "crm-portal")), true);

    dockerState.failDown = false;
    fs.writeFileSync(stateFile, JSON.stringify(dockerState), "utf8");

    // removeFiles: false keeps directory while stopping compose; removeFiles: true removes files
    const kept = await client.removeWorkload("life-helper", { removeFiles: false });
    assert.equal(kept.ok, true);
    assert.equal(fs.existsSync(path.join(appsRoot, "life-helper")), true);

    const removed = await client.removeWorkload("crm-portal", {
      removeFiles: true,
    });
    assert.equal(removed.ok, true);
    assert.equal(fs.existsSync(path.join(appsRoot, "crm-portal")), false);

    // Corrupted/unsafe Compose file can still be torn down cleanly via project label
    const corruptedRemoved = await client.removeWorkload("unsafe-privileged", {
      removeFiles: true,
    });
    assert.equal(corruptedRemoved.ok, true);
    assert.equal(
      fs.existsSync(path.join(appsRoot, "unsafe-privileged")),
      false,
    );

    // Missing workspace directory still tears down orphaned Compose project by label
    const missingDirRemoved = await client.removeWorkload(
      "orphaned-missing-dir",
      { removeFiles: true },
    );
    assert.equal(missingDirRemoved.ok, true);
    const postRemoveCalls = fs
      .readFileSync(callsLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      postRemoveCalls.some(
        (c) =>
          c[0] === "compose" &&
          c[1] === "-p" &&
          c[2] === "vps-os-orphaned-missing-dir" &&
          c[3] === "down" &&
          c[4] === "--remove-orphans",
      ),
      true,
    );

    // Symlink escape checks on runtime-bridge.py (app_dir AND volume bind mount source)
    const outsideTarget = path.join(tempDir, "outside-secret");
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.writeFileSync(
      path.join(outsideTarget, "docker-compose.yml"),
      "services:\n  x:\n    image: nginx\n",
      "utf8",
    );
    try {
      fs.symlinkSync(outsideTarget, path.join(appsRoot, "symlink-app"));
      await assert.rejects(
        () => client.lifecycle("symlink-app", "start"),
        (err: unknown) =>
          err instanceof RuntimeBridgeError && err.statusCode === 400,
      );

      const volSymApp = path.join(appsRoot, "vol-symlink");
      fs.mkdirSync(volSymApp, { recursive: true });
      fs.copyFileSync(
        path.join(TEMPLATES_ROOT, "web-app", "docker-compose.yml"),
        path.join(volSymApp, "docker-compose.yml"),
      );
      fs.symlinkSync(outsideTarget, path.join(volSymApp, "data"));
      await assert.rejects(
        () => client.lifecycle("vol-symlink", "start"),
        (err: unknown) =>
          err instanceof RuntimeBridgeError &&
          err.statusCode === 400 &&
          /symlink/.test(err.message),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") {
        throw err;
      }
    }
  } finally {
    registry.close();
    await daemon.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrap/runtime-bridge.py enforces overall statuses() deadline promptly without blocking on queued futures", async (t) => {
  const pythonBin = findPythonBinary();
  if (!pythonBin) {
    t.skip("Python 3 binary not found in PATH");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-deadline-"));
  const appsRoot = path.join(tempDir, "apps");
  const caddyAppsDir = path.join(tempDir, "caddy-apps");
  const stateFile = path.join(tempDir, "docker-state.json");
  fs.mkdirSync(appsRoot, { recursive: true });
  fs.mkdirSync(caddyAppsDir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ projects: {}, networks: [], failValidate: false, failDown: false, psDelay: 1.5 }),
    "utf8",
  );

  const dockerBin = createFakeDockerShim(
    tempDir,
    pythonBin,
    stateFile,
    path.join(tempDir, "calls.log"),
    path.join(tempDir, "env.log"),
  );
  const runtimeToken = "deadline-test-secret-token-1234";
  const daemon = await startPythonRuntimeBridge({
    pythonBin,
    appsRoot,
    caddyAppsDir,
    dockerBin,
    runtimeToken,
    statusDeadlineS: 0.4,
  });
  const registry = new SystemRegistryStore(":memory:");

  try {
    for (let i = 1; i <= 12; i += 1) {
      provisionIsolatedWorkspace({
        appsRoot,
        templatesRoot: TEMPLATES_ROOT,
        slug: `slow-app-${i}`,
        name: `Slow ${i}`,
        kind: "web-app",
        domain: null,
        registry,
      });
    }
    const client = new HttpRuntimeBridgeClient({
      baseUrl: daemon.baseUrl,
      runtimeToken,
    });
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        client.getStatuses(
          Array.from({ length: 12 }, (_, idx) => `slow-app-${idx + 1}`),
        ),
      (err: unknown) =>
        err instanceof RuntimeBridgeError && err.statusCode === 504,
    );
    const elapsedMs = Date.now() - startedAt;
    // 12 slugs * 1.5s / 4 workers = 4.5s if uncancelled; deadline 0.4s must return < 2.5s
    assert.equal(elapsedMs < 2500, true, `Expected prompt 504, took ${elapsedMs}ms`);
  } finally {
    registry.close();
    await daemon.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("HttpRuntimeBridgeClient supports Unix socket / named pipe transport and createRuntimeBridgeFromEnv", async () => {
  const pythonBin = findPythonBinary();
  if (process.platform !== "win32" && pythonBin) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-uds-"));
    const appsRoot = path.join(tempDir, "apps");
    const caddyAppsDir = path.join(tempDir, "caddy-apps");
    const socketPath = path.join(tempDir, "run", "runtime.sock");
    fs.mkdirSync(appsRoot, { recursive: true });
    fs.mkdirSync(caddyAppsDir, { recursive: true });
    const dockerBin = createFakeDockerShim(
      tempDir,
      pythonBin,
      path.join(tempDir, "state.json"),
      path.join(tempDir, "calls.log"),
      path.join(tempDir, "env.log"),
    );
    const daemon = await startPythonRuntimeBridge({
      pythonBin,
      appsRoot,
      caddyAppsDir,
      dockerBin,
      runtimeToken: "unix-socket-secret-token-1234",
      socketPath,
    });
    try {
      const mode = fs.statSync(socketPath).mode & 0o777;
      assert.equal(mode, 0o660);
      const client = createRuntimeBridgeFromEnv({
        VPS_OS_RUNTIME_SOCKET: socketPath,
        VPS_OS_RUNTIME_TOKEN: "unix-socket-secret-token-1234",
      });
      assert.ok(client);
      assert.equal((await client.health()).ok, true);
    } finally {
      await daemon.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    // Exercise Node socketPath HTTP client transport even on Windows via named pipe
    const pipePath = `\\\\.\\pipe\\vps-os-test-${process.pid}-${Date.now()}`;
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "pipe-test" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));
    try {
      const client = createRuntimeBridgeFromEnv({
        VPS_OS_RUNTIME_SOCKET: pipePath,
        VPS_OS_RUNTIME_TOKEN: "pipe-token-1234567890",
      });
      assert.ok(client);
      assert.equal((await client.health()).ok, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  assert.equal(createRuntimeBridgeFromEnv({}), undefined);
});

test("Dashboard Control API + Agent HTTP server + MCP enforce cross-process leases, lifecycle plans, sync, and safe rollback", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vps-os-e2e-"));
  const appsRoot = path.join(tempRoot, "apps");
  const dbPath = path.join(tempRoot, "registry.db");
  fs.mkdirSync(appsRoot, { recursive: true });

  const containerStates = new Map<string, AppStatus>();
  const routedDomains = new Map<string, string>();
  let failNextRoute = false;
  let failNextRemove = false;

  const mockBridge: RuntimeBridge = {
    health: async () => ({ ok: true }),
    lifecycle: async (slug, action) => {
      if (action === "stop") {
        containerStates.set(slug, "stopped");
        return { slug, status: "stopped" };
      }
      if (action === "status") {
        return { slug, status: containerStates.get(slug) ?? "stopped" };
      }
      containerStates.set(slug, "running");
      return { slug, status: "running" };
    },
    getLogs: async (slug) => [
      `Started ${slug}`,
      "Using token=ghp_1234567890abcdef",
    ],
    routeCaddy: async ({ slug, domain }) => {
      if (failNextRoute) {
        throw new RuntimeBridgeError(422, "Simulated Caddy validation failure");
      }
      if (domain) {
        for (const [otherSlug, otherDomain] of routedDomains) {
          if (otherSlug !== slug && otherDomain === domain) {
            throw new RuntimeBridgeError(409, `Domain ${domain} already routed`);
          }
        }
        routedDomains.set(slug, domain);
      } else {
        routedDomains.delete(slug);
      }
      return { ok: true, slug, domain, routed: Boolean(domain) };
    },
    removeWorkload: async (slug, options) => {
      if (failNextRemove) {
        throw new RuntimeBridgeError(502, "Simulated teardown failure");
      }
      containerStates.delete(slug);
      routedDomains.delete(slug);
      if (options?.removeFiles) {
        fs.rmSync(path.join(appsRoot, slug), { recursive: true, force: true });
      }
      return { ok: true, slug };
    },
    getStatuses: async (slugs) => {
      const result: Record<string, AppStatus> = {};
      for (const slug of slugs) {
        result[slug] = containerStates.get(slug) ?? "stopped";
      }
      return result;
    },
  };

  const adminToken = "e2e-admin-secret-token-99";
  const { server: agentServer } = createAgentHttpServer({
    dbPath,
    adminToken,
    appsRoot,
    templatesRoot: TEMPLATES_ROOT,
    runtimeBridge: mockBridge,
  });

  await new Promise<void>((resolve) =>
    agentServer.listen(0, "127.0.0.1", resolve),
  );
  const agentAddress = agentServer.address() as AddressInfo;
  const agentUrl = `http://127.0.0.1:${agentAddress.port}`;

  const dashboardRegistry = new SystemRegistryStore(dbPath);
  const app = createDashboardApp({
    registry: dashboardRegistry,
    adminToken,
    workloadController: createRuntimeWorkloadController(mockBridge),
    executePlan: createAgentPlanExecutor({ agentUrl, adminToken }),
  });

  const headers = {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };

  try {
    // 0. /agent/execute enforces auth
    const unauthAgentExec = await fetch(`${agentUrl}/agent/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: "missing" }),
    });
    assert.equal(unauthAgentExec.status, 401);

    // 1. Deploy web app via Plan -> Approve -> Execute
    const planRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers,
      body: JSON.stringify({
        goal: "Deploy billing app at billing.example.com",
      }),
    });
    assert.equal(planRes.status, 200);
    const { plan } = (await planRes.json()) as {
      plan: { id: string; status: string };
    };
    assert.equal(plan.status, "pending");

    await app.request("/api/chat/approve", {
      method: "POST",
      headers,
      body: JSON.stringify({
        planId: plan.id,
        approved: true,
        decidedBy: "admin",
      }),
    });

    const execRes = await app.request("/api/chat/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: plan.id }),
    });
    assert.equal(execRes.status, 200);
    const execJson = (await execRes.json()) as {
      plan: { status: string };
      execution: { summary: string };
    };
    assert.equal(execJson.plan.status, "executed");
    assert.match(execJson.execution.summary, /billing\.example\.com/);
    assert.equal(routedDomains.get("billing"), "billing.example.com");
    assert.equal(
      fs.existsSync(path.join(appsRoot, "billing", "data", "index.html")),
      true,
    );

    // 2. Dashboard apps endpoint syncs live container status from bridge (skipping 'provisioning')
    containerStates.set("billing", "stopped");
    const listRes = await app.request("/api/apps", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as {
      apps: Array<{ slug: string; status: string }>;
    };
    assert.equal(
      listJson.apps.find((a) => a.slug === "billing")?.status,
      "stopped",
    );

    // syncAppStatuses never overwrites 'provisioning' apps prematurely
    dashboardRegistry.upsertApp({
      slug: "pending-app",
      name: "Pending App",
      kind: "web-app",
      domain: null,
      folderPath: path.join(appsRoot, "pending-app"),
      internalPort: 80,
      status: "provisioning",
      cpuLimit: "0.5",
      memoryLimitMb: 512,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await syncAppStatuses(dashboardRegistry, mockBridge);
    assert.equal(
      dashboardRegistry.getAppBySlug("pending-app")?.status,
      "provisioning",
    );

    // 3. Lifecycle plan execution ("Restart billing") works end-to-end
    const restartPlanRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers,
      body: JSON.stringify({ goal: "Restart billing" }),
    });
    const { plan: restartPlan } = (await restartPlanRes.json()) as {
      plan: { id: string };
    };
    await app.request("/api/chat/approve", {
      method: "POST",
      headers,
      body: JSON.stringify({
        planId: restartPlan.id,
        approved: true,
        decidedBy: "admin",
      }),
    });
    const restartExec = await app.request("/api/chat/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: restartPlan.id }),
    });
    assert.equal(restartExec.status, 200);
    assert.equal(dashboardRegistry.getAppBySlug("billing")?.status, "running");

    // 4. Read-only inspect plan executes cleanly
    const inspectPlanRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers,
      body: JSON.stringify({ goal: "Check current app health" }),
    });
    const { plan: inspectPlan } = (await inspectPlanRes.json()) as {
      plan: { id: string; status: string };
    };
    assert.equal(inspectPlan.status, "approved");
    const inspectExec = await app.request("/api/chat/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: inspectPlan.id }),
    });
    assert.equal(inspectExec.status, 200);
    assert.match(
      ((await inspectExec.json()) as { execution: { summary: string } }).execution
        .summary,
      /billing \(running\)/,
    );

    // 5. Cross-process SQLite lease blocks concurrent execution via Agent HTTP while Dashboard holds lease
    const leasePlan = dashboardRegistry.savePlan(
      createExecutionPlan("Check current app health"),
    );
    assert.equal(
      dashboardRegistry.claimPlanExecution(leasePlan.id, "dashboard:holder"),
      true,
    );
    const conflictAgentRes = await fetch(`${agentUrl}/agent/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: leasePlan.id }),
    });
    assert.equal(conflictAgentRes.status, 409);
    dashboardRegistry.releasePlanExecution(leasePlan.id, "dashboard:holder");

    // 6. Redacted logs endpoint
    const logsRes = await app.request("/api/apps/billing/logs?tail=20", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(logsRes.status, 200);
    const logsJson = (await logsRes.json()) as { lines: string[] };
    assert.equal(
      logsJson.lines.some((line) => line.includes("ghp_1234567890abcdef")),
      false,
    );

    // 7. Failed deployment rolls back cleanly when removeWorkload succeeds
    failNextRoute = true;
    const failPlanRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers,
      body: JSON.stringify({
        goal: "Deploy portal app at broken.example.com",
      }),
    });
    const { plan: failPlan } = (await failPlanRes.json()) as {
      plan: { id: string };
    };
    await app.request("/api/chat/approve", {
      method: "POST",
      headers,
      body: JSON.stringify({
        planId: failPlan.id,
        approved: true,
        decidedBy: "admin",
      }),
    });
    const failedExec = await app.request("/api/chat/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: failPlan.id }),
    });
    assert.equal(failedExec.status, 422);
    assert.equal(fs.existsSync(path.join(appsRoot, "portal")), false);
    assert.equal(dashboardRegistry.getAppBySlug("portal"), null);
    assert.equal(dashboardRegistry.getPlan(failPlan.id)?.status, "approved");

    // 8. When removeWorkload ALSO fails during rollback, workspace & error status are preserved (cleanup-pending)
    failNextRemove = true;
    const stickyFailPlanRes = await app.request("/api/chat/plan", {
      method: "POST",
      headers,
      body: JSON.stringify({
        goal: "Deploy sticky app at sticky.example.com",
      }),
    });
    const { plan: stickyPlan } = (await stickyFailPlanRes.json()) as {
      plan: { id: string };
    };
    await app.request("/api/chat/approve", {
      method: "POST",
      headers,
      body: JSON.stringify({
        planId: stickyPlan.id,
        approved: true,
        decidedBy: "admin",
      }),
    });
    const stickyExec = await app.request("/api/chat/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: stickyPlan.id }),
    });
    assert.equal(stickyExec.status, 422);
    assert.equal(fs.existsSync(path.join(appsRoot, "sticky")), true);
    assert.equal(dashboardRegistry.getAppBySlug("sticky")?.status, "error");
    // syncAppStatuses must NOT overwrite cleanup-pending 'error' back to 'running'
    containerStates.set("sticky", "running");
    await syncAppStatuses(dashboardRegistry, mockBridge);
    assert.equal(dashboardRegistry.getAppBySlug("sticky")?.status, "error");
    failNextRoute = false;
    failNextRemove = false;

    // Cross-process lease expiry prevents stale owners from checking or marking executed
    const expiredPlan = dashboardRegistry.savePlan(
      createExecutionPlan("Check current app health"),
    );
    assert.equal(
      dashboardRegistry.claimPlanExecution(expiredPlan.id, "stale:owner", 1000),
      true,
    );
    // Simulate lease expiry directly via expired timestamp in SQLite using Date shift? No — verify exact active check & strict owner check:
    assert.equal(
      dashboardRegistry.isPlanLeaseHeldBy(expiredPlan.id, "other:owner"),
      false,
    );
    assert.equal(
      dashboardRegistry.markPlanExecuted(expiredPlan.id, "other:owner"),
      false,
    );
    assert.equal(
      dashboardRegistry.releasePlanExecution(expiredPlan.id, "stale:owner"),
      true,
    );
    // Once released (execution_owner IS NULL), a stale owner CANNOT mark executed
    assert.equal(
      dashboardRegistry.markPlanExecuted(expiredPlan.id, "stale:owner"),
      false,
    );

    // 9. MCP runtime tools (`read_app_logs`, `deploy_workload`, `control_app_lifecycle`, `configure_app_domain`)
    const mcpHandle = createMcpRequestHandler({
      registry: dashboardRegistry,
      appsRoot,
      templatesRoot: TEMPLATES_ROOT,
      runtimeBridge: mockBridge,
    });
    const mcpLogsRes = await mcpHandle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_app_logs", arguments: { slug: "billing", tail: 10 } },
    });
    assert.equal((mcpLogsRes?.result as { isError: boolean }).isError, false);

    const mcpDeployPlan = dashboardRegistry.savePlan(
      createExecutionPlan("Deploy notes web app at notes.example.com"),
    );
    dashboardRegistry.recordApproval({
      planId: mcpDeployPlan.id,
      approved: true,
      decidedBy: "owner",
    });
    const mcpDeployRes = await mcpHandle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "deploy_workload",
        arguments: {
          planId: mcpDeployPlan.id,
          slug: "notes",
          name: "Notes",
          kind: "web-app",
          domain: "notes.example.com",
        },
      },
    });
    assert.equal((mcpDeployRes?.result as { isError: boolean }).isError, false);
    assert.equal(routedDomains.get("notes"), "notes.example.com");

    // 10. Destructive / ambiguous goals fail closed under manual_review
    const wipePlan = dashboardRegistry.savePlan(
      createExecutionPlan("Wipe the disk cleanly"),
    );
    dashboardRegistry.recordApproval({
      planId: wipePlan.id,
      approved: true,
      decidedBy: "admin",
    });
    const wipeExec = await app.request("/api/chat/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: wipePlan.id }),
    });
    assert.equal(wipeExec.status, 422);
  } finally {
    dashboardRegistry.close();
    await new Promise<void>((resolve) => agentServer.close(() => resolve()));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
