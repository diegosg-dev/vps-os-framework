import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SystemRegistryStore, redactSecrets } from "@vps-os/shared";
import { z } from "zod";
import { type AgentToolsetDeps, createAgentToolset } from "./tools.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface ExecutableTool {
  description?: string;
  inputSchema: z.ZodType;
  execute?: (
    input: unknown,
    options: { toolCallId: string; messages: never[]; abortSignal?: AbortSignal },
  ) => Promise<unknown>;
}

function makeError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message: redactSecrets(message) },
  };
}

/**
 * Redacts string leaves *before* JSON serialization. Applying secret regexes to a
 * raw JSON string can corrupt escaped quotes (e.g. `\"`) inside summary fields.
 */
function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactJsonValue(val);
    }
    return out;
  }
  return value;
}

/**
 * Creates a Model Context Protocol (MCP) JSON-RPC 2.0 request handler backed by
 * the typed VPS OS CTO toolset so Hermes Agent can safely inspect and manage apps.
 */
export function createMcpRequestHandler(
  deps: AgentToolsetDeps,
): (rawMessage: unknown) => Promise<JsonRpcResponse | null> {
  const toolset = createAgentToolset(
    deps,
  ) as unknown as Record<string, ExecutableTool>;

  return async (rawMessage: unknown): Promise<JsonRpcResponse | null> => {
    if (
      typeof rawMessage !== "object" ||
      rawMessage === null ||
      Array.isArray(rawMessage)
    ) {
      return makeError(null, -32600, "Invalid Request");
    }

    const req = rawMessage as Partial<JsonRpcRequest>;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return makeError(req.id ?? null, -32600, "Invalid JSON-RPC 2.0 request");
    }

    // Notifications carry no `id` and expect no response.
    if (req.id === undefined) {
      return null;
    }

    const id = req.id;

    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: "vps-os-mcp",
            version: "0.1.0",
          },
        },
      };
    }

    if (req.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (req.method === "tools/list") {
      const tools = Object.entries(toolset).map(([name, def]) => ({
        name,
        description: def.description ?? "",
        inputSchema: z.toJSONSchema(def.inputSchema),
      }));
      return {
        jsonrpc: "2.0",
        id,
        result: { tools },
      };
    }

    if (req.method === "tools/call") {
      const params = req.params ?? {};
      const toolName =
        typeof params.name === "string" ? params.name : undefined;
      if (!toolName || !Object.hasOwn(toolset, toolName)) {
        return makeError(id, -32602, `Unknown tool: ${String(toolName)}`);
      }

      const def = toolset[toolName];
      if (!def?.execute) {
        return makeError(id, -32603, `Tool "${toolName}" is not executable.`);
      }

      const rawArgs =
        typeof params.arguments === "object" && params.arguments !== null
          ? params.arguments
          : {};
      const parsed = def.inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const msg = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
          .join("; ");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: redactSecrets(`Invalid arguments: ${msg}`) }],
            isError: true,
          },
        };
      }

      try {
        const output = await def.execute(parsed.data, {
          toolCallId: String(id ?? "mcp"),
          messages: [],
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(redactJsonValue(output), null, 2),
              },
            ],
            isError: false,
          },
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Tool execution failed.";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: redactSecrets(message) }],
            isError: true,
          },
        };
      }
    }

    return makeError(id, -32601, `Method not found: ${req.method}`);
  };
}

export interface McpStdioServerOptions {
  dbPath?: string;
  appsRoot?: string;
  templatesRoot?: string;
}

/** Starts the newline-delimited JSON-RPC MCP stdio server for Hermes Agent. */
export function startMcpStdioServer(
  options: McpStdioServerOptions = {},
): { close: () => void } {
  const defaultTemplatesRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../templates",
  );
  const registry = new SystemRegistryStore(
    options.dbPath ?? process.env.VPS_OS_REGISTRY_DB ?? "/data/registry.db",
  );
  const handler = createMcpRequestHandler({
    registry,
    appsRoot: options.appsRoot ?? process.env.VPS_OS_APPS_ROOT ?? "/apps",
    templatesRoot:
      options.templatesRoot ??
      process.env.VPS_OS_TEMPLATES_ROOT ??
      defaultTemplatesRoot,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rl.close();
    registry.close();
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        process.stdout.write(
          `${JSON.stringify(makeError(null, -32700, "Parse error"))}\n`,
        );
        return;
      }

      const response = await handler(parsed);
      if (response !== null) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    })();
  });

  rl.on("close", close);
  return { close };
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  const { close } = startMcpStdioServer();
  const shutdown = () => {
    close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}