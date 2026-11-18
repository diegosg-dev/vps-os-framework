import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
  SystemRegistryStore,
  createRuntimeBridgeFromEnv,
} from "@vps-os/shared";
import { createDashboardApp } from "./app.js";
import {
  createAgentPlanExecutor,
  createRuntimeWorkloadController,
} from "./runtime.js";

export * from "./app.js";
export * from "./metrics.js";
export * from "./onboarding.js";
export * from "./runtime.js";
export * from "./static.js";

const MIN_ADMIN_TOKEN_LENGTH = 16;

function parsePort(raw: string | undefined): number {
  const value = raw ?? "3001";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Fatal: Invalid PORT "${value}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  const adminToken = process.env.VPS_OS_ADMIN_TOKEN?.trim();
  if (
    !adminToken ||
    adminToken.startsWith("replace-with-") ||
    adminToken.length < MIN_ADMIN_TOKEN_LENGTH
  ) {
    console.error(
      `Fatal: VPS_OS_ADMIN_TOKEN must be configured with a non-placeholder secret of at least ${MIN_ADMIN_TOKEN_LENGTH} characters.`,
    );
    process.exit(1);
  }

  const port = parsePort(process.env.PORT);
  const hostname =
    process.env.HOST?.trim() ||
    (fs.existsSync("/.dockerenv") ? "0.0.0.0" : "127.0.0.1");
  const trustProxy = process.env.VPS_OS_TRUST_PROXY === "true";

  const dbPath =
    process.env.VPS_OS_REGISTRY_DB?.trim() || path.resolve("data/registry.db");
  if (dbPath === ":memory:") {
    console.warn(
      "Warning: VPS_OS_REGISTRY_DB is ':memory:'; plans and audit history will not persist across restarts.",
    );
  }

  const defaultWebDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/dist",
  );
  const webDistDir =
    process.env.VPS_OS_WEB_DIST ??
    (fs.existsSync(defaultWebDist) ? defaultWebDist : undefined);

  const registry = new SystemRegistryStore(dbPath);
  const dataDir =
    process.env.VPS_OS_DATA_DIR?.trim() ||
    (dbPath === ":memory:" ? undefined : path.dirname(path.resolve(dbPath)));
  const onboardingEnvPath = process.env.VPS_OS_ONBOARDING_ENV_FILE?.trim();
  const hermesHome = process.env.VPS_OS_HERMES_HOME?.trim();
  const setupClaimPath = process.env.VPS_OS_SETUP_CLAIM_FILE?.trim();
  const hermesGatewayUrl = process.env.HERMES_GATEWAY_URL?.trim();
  const hermesApiServerKey = process.env.HERMES_API_SERVER_KEY?.trim();

  const runtimeBridge = createRuntimeBridgeFromEnv();
  const workloadController = runtimeBridge
    ? createRuntimeWorkloadController(runtimeBridge)
    : undefined;

  const agentUrl = process.env.VPS_OS_AGENT_URL?.trim();
  const appsRoot = process.env.VPS_OS_APPS_ROOT?.trim();
  const defaultTemplatesRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../templates",
  );
  const templatesRoot =
    process.env.VPS_OS_TEMPLATES_ROOT?.trim() || defaultTemplatesRoot;
  const executePlan = createAgentPlanExecutor({
    agentUrl,
    adminToken,
    ...(appsRoot
      ? {
          localDeps: {
            registry,
            appsRoot,
            templatesRoot,
            runtimeBridge,
          },
        }
      : {}),
  });

  const app = createDashboardApp({
    registry,
    adminToken,
    trustProxy,
    initialEnv: process.env,
    ...(webDistDir ? { webDistDir } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(onboardingEnvPath ? { onboardingEnvPath } : {}),
    ...(hermesHome ? { hermesHome } : {}),
    ...(setupClaimPath ? { setupClaimPath } : {}),
    ...(hermesGatewayUrl ? { hermesGatewayUrl } : {}),
    ...(hermesApiServerKey ? { hermesApiServerKey } : {}),
    ...(workloadController ? { workloadController } : {}),
    ...(executePlan ? { executePlan } : {}),
  });

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(
      `VPS OS Dashboard API listening on http://${hostname}:${info.port}`,
    );
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceTimer = setTimeout(() => {
      try {
        registry.close();
      } catch {
        // ignore close errors on forced exit
      }
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    if ("closeIdleConnections" in server && typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    server.close(() => {
      clearTimeout(forceTimer);
      registry.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
