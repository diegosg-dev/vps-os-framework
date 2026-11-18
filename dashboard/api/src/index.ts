import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { SystemRegistryStore } from "@vps-os/shared";
import { createDashboardApp } from "./app.js";

export * from "./app.js";
export * from "./metrics.js";
export * from "./static.js";

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  const adminToken = process.env.VPS_OS_ADMIN_TOKEN;
  if (!adminToken || adminToken.startsWith("replace-with-")) {
    console.error(
      "Fatal: VPS_OS_ADMIN_TOKEN must be configured with a non-placeholder secret.",
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 3001);
  const dbPath = process.env.VPS_OS_REGISTRY_DB ?? ":memory:";
  const defaultWebDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/dist",
  );
  const webDistDir =
    process.env.VPS_OS_WEB_DIST ??
    (fs.existsSync(defaultWebDist) ? defaultWebDist : undefined);

  const registry = new SystemRegistryStore(dbPath);
  const app = createDashboardApp({
    registry,
    adminToken,
    ...(webDistDir ? { webDistDir } : {}),
  });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`VPS OS Dashboard API listening on http://localhost:${info.port}`);
  });

  const shutdown = () => {
    server.close(() => {
      registry.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
