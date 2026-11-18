import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { SystemRegistryStore, redactSecrets } from "@vps-os/shared";
import { createExecutionPlan } from "./planner.js";

export * from "./planner.js";
export * from "./subagent-runtime.js";
export * from "./tools.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface AgentServerOptions {
  port?: number;
  dbPath?: string;
  adminToken?: string;
}

function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req: http.IncomingMessage): string | undefined {
  const headerToken = req.headers["x-vps-os-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return undefined;
}

/** Creates the internal Agent Runtime HTTP server (Step 5). */
export function createAgentHttpServer(options: AgentServerOptions = {}): {
  server: http.Server;
  registry: SystemRegistryStore;
} {
  const dbPath = options.dbPath ?? process.env.VPS_OS_REGISTRY_DB ?? ":memory:";
  const adminToken = options.adminToken ?? process.env.VPS_OS_ADMIN_TOKEN;
  const registry = new SystemRegistryStore(dbPath);

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/agent/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "vps-os-agent" }));
      return;
    }

    if (adminToken && !tokensEqual(extractToken(req), adminToken)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (req.method === "POST" && req.url === "/agent/plan") {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large." }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (aborted) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            goal?: string;
          };
          if (typeof parsed.goal !== "string" || !parsed.goal.trim()) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({ error: "Field 'goal' must be a non-empty string." }),
            );
            return;
          }
          const sanitizedGoal = redactSecrets(parsed.goal);
          const storedPlan = registry.savePlan(createExecutionPlan(sanitizedGoal));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              plan: storedPlan,
              registeredApps: registry.listApps().length,
            }),
          );
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON payload." }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("close", () => registry.close());
  return { server, registry };
}

/** Starts the lightweight Agent Runtime HTTP service when run directly. */
export function startAgentServer(
  options: AgentServerOptions = {},
): http.Server {
  const port = options.port ?? Number(process.env.PORT ?? 3002);
  const { server } = createAgentHttpServer(options);
  return server.listen(port);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  const token = process.env.VPS_OS_ADMIN_TOKEN;
  if (!token || token.startsWith("replace-with-")) {
    console.error(
      "Fatal: VPS_OS_ADMIN_TOKEN must be configured with a non-placeholder secret.",
    );
    process.exit(1);
  }
  const server = startAgentServer({ adminToken: token });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
