import http from "node:http";
import https from "node:https";
import { z } from "zod";
import { type AppRecord, type AppStatus, AppStatusSchema } from "./registry.js";
import {
  redactSecrets,
  validateAppSlug,
  validateDomain,
  validateHttpBaseUrl,
} from "./safety.js";
import type { SystemRegistryStore } from "./store.js";

export const RuntimeLifecycleActionSchema = z.enum([
  "start",
  "stop",
  "restart",
  "status",
]);
export type RuntimeLifecycleAction = z.infer<
  typeof RuntimeLifecycleActionSchema
>;

export const RuntimeLifecycleResultSchema = z.object({
  slug: z.string(),
  status: AppStatusSchema,
  detail: z.string().optional(),
});
export type RuntimeLifecycleResult = z.infer<
  typeof RuntimeLifecycleResultSchema
>;

export const RuntimeLogsResultSchema = z.object({
  slug: z.string(),
  lines: z.array(z.string()),
});
export type RuntimeLogsResult = z.infer<typeof RuntimeLogsResultSchema>;

export const RuntimeRouteCaddyResultSchema = z.object({
  ok: z.boolean(),
  slug: z.string(),
  domain: z.string().nullable(),
  routed: z.boolean(),
});
export type RuntimeRouteCaddyResult = z.infer<
  typeof RuntimeRouteCaddyResultSchema
>;

export const RuntimeRemoveResultSchema = z.object({
  ok: z.boolean(),
  slug: z.string(),
});
export type RuntimeRemoveResult = z.infer<typeof RuntimeRemoveResultSchema>;

export const RuntimeStatusesResultSchema = z.object({
  statuses: z.record(z.string(), AppStatusSchema),
});
export type RuntimeStatusesResult = z.infer<typeof RuntimeStatusesResultSchema>;

export const RuntimeHealthResultSchema = z.object({
  ok: z.boolean(),
  service: z.string().optional(),
});
export type RuntimeHealthResult = z.infer<typeof RuntimeHealthResultSchema>;

/** Narrow, allowlisted runtime bridge interface between core services and host Docker/Caddy. */
export interface RuntimeBridge {
  health(): Promise<RuntimeHealthResult>;
  lifecycle(
    slug: string,
    action: RuntimeLifecycleAction,
  ): Promise<RuntimeLifecycleResult>;
  getLogs(slug: string, tail: number): Promise<string[]>;
  routeCaddy(input: {
    slug: string;
    domain: string | null;
    internalPort: number;
  }): Promise<RuntimeRouteCaddyResult>;
  removeWorkload(
    slug: string,
    options?: { removeFiles?: boolean },
  ): Promise<RuntimeRemoveResult>;
  getStatuses(slugs: string[]): Promise<Record<string, AppStatus>>;
}

export class RuntimeBridgeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(redactSecrets(message));
    this.name = "RuntimeBridgeError";
    this.statusCode = statusCode;
  }
}

export interface HttpRuntimeBridgeClientOptions {
  socketPath?: string | undefined;
  baseUrl?: string | undefined;
  runtimeToken?: string | undefined;
  defaultTimeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 240_000;
const SHORT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_BATCH = 100;

/**
 * Typed HTTP-over-Unix-Socket (or loopback HTTP for tests) client for the host
 * `vps-os-runtime` daemon. Enforces input validation, wall-clock timeouts,
 * response caps, and secret redaction on every boundary.
 */
export class HttpRuntimeBridgeClient implements RuntimeBridge {
  private readonly socketPath: string | undefined;
  private readonly parsedBaseUrl: URL | undefined;
  private readonly runtimeToken: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: HttpRuntimeBridgeClientOptions) {
    const socket = options.socketPath?.trim() || undefined;
    const rawUrl = options.baseUrl?.trim() || undefined;
    if (!socket && !rawUrl) {
      throw new Error(
        "HttpRuntimeBridgeClient requires either socketPath or baseUrl.",
      );
    }

    this.socketPath = socket;
    this.parsedBaseUrl = rawUrl ? new URL(validateHttpBaseUrl(rawUrl)) : undefined;
    this.runtimeToken = options.runtimeToken?.trim() || undefined;
    this.defaultTimeoutMs = Math.max(
      500,
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    this.maxResponseBytes = Math.max(
      4096,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
  }

  async health(): Promise<RuntimeHealthResult> {
    const raw = await this.requestJson("GET", "/health", undefined, SHORT_TIMEOUT_MS);
    return RuntimeHealthResultSchema.parse(raw);
  }

  async lifecycle(
    slug: string,
    action: RuntimeLifecycleAction,
  ): Promise<RuntimeLifecycleResult> {
    const safeSlug = validateAppSlug(slug);
    const safeAction = RuntimeLifecycleActionSchema.parse(action);
    const timeoutMs =
      safeAction === "status" ? SHORT_TIMEOUT_MS : this.defaultTimeoutMs;
    const raw = await this.requestJson(
      "POST",
      "/v1/apps/lifecycle",
      { slug: safeSlug, action: safeAction },
      timeoutMs,
    );
    const parsed = RuntimeLifecycleResultSchema.parse(raw);
    return {
      ...parsed,
      ...(parsed.detail !== undefined
        ? { detail: redactSecrets(parsed.detail) }
        : {}),
    };
  }

  async getLogs(slug: string, tail: number): Promise<string[]> {
    const safeSlug = validateAppSlug(slug);
    const safeTail = z.number().int().min(1).max(500).parse(tail);
    const raw = await this.requestJson(
      "POST",
      "/v1/apps/logs",
      { slug: safeSlug, tail: safeTail },
      SHORT_TIMEOUT_MS,
    );
    const parsed = RuntimeLogsResultSchema.parse(raw);
    const joined = redactSecrets(parsed.lines.join("\n"));
    return joined ? joined.split(/\r?\n/).slice(-safeTail) : [];
  }

  async routeCaddy(input: {
    slug: string;
    domain: string | null;
    internalPort: number;
  }): Promise<RuntimeRouteCaddyResult> {
    const safeSlug = validateAppSlug(input.slug);
    const safeDomain = input.domain ? validateDomain(input.domain) : null;
    const safePort = z.number().int().min(1).max(65535).parse(input.internalPort);
    const raw = await this.requestJson(
      "POST",
      "/v1/apps/route-caddy",
      {
        slug: safeSlug,
        domain: safeDomain,
        internalPort: safePort,
      },
      this.defaultTimeoutMs,
    );
    return RuntimeRouteCaddyResultSchema.parse(raw);
  }

  async removeWorkload(
    slug: string,
    options?: { removeFiles?: boolean },
  ): Promise<RuntimeRemoveResult> {
    const safeSlug = validateAppSlug(slug);
    const raw = await this.requestJson(
      "POST",
      "/v1/apps/remove",
      {
        slug: safeSlug,
        removeFiles: Boolean(options?.removeFiles),
      },
      this.defaultTimeoutMs,
    );
    return RuntimeRemoveResultSchema.parse(raw);
  }

  async getStatuses(slugs: string[]): Promise<Record<string, AppStatus>> {
    const uniqueSlugs = Array.from(
      new Set(slugs.map((slug) => validateAppSlug(slug))),
    );
    if (uniqueSlugs.length === 0) {
      return {};
    }

    const merged: Record<string, AppStatus> = {};
    for (let i = 0; i < uniqueSlugs.length; i += MAX_STATUS_BATCH) {
      const batch = uniqueSlugs.slice(i, i + MAX_STATUS_BATCH);
      const raw = await this.requestJson(
        "POST",
        "/v1/apps/statuses",
        { slugs: batch },
        SHORT_TIMEOUT_MS,
      );
      const parsed = RuntimeStatusesResultSchema.parse(raw);
      Object.assign(merged, parsed.statuses);
    }
    return merged;
  }

  private async requestJson(
    method: "GET" | "POST",
    routePath: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (this.runtimeToken) {
      headers["x-vps-os-runtime-token"] = this.runtimeToken;
    }
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload, "utf8"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let req: http.ClientRequest | undefined;
      const timer = setTimeout(() => {
        req?.destroy();
        fail(
          new RuntimeBridgeError(
            504,
            `Host runtime bridge timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref();

      const fail = (err: RuntimeBridgeError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const succeed = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > this.maxResponseBytes) {
            res.destroy();
            fail(
              new RuntimeBridgeError(
                502,
                "Runtime bridge response exceeded maximum allowed size.",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on("error", (err) => {
          fail(
            new RuntimeBridgeError(
              502,
              `Runtime bridge stream error: ${err.message}`,
            ),
          );
        });

        res.on("end", () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 502;
          let parsed: unknown = null;
          if (text.trim()) {
            try {
              parsed = JSON.parse(text);
            } catch {
              fail(
                new RuntimeBridgeError(
                  status >= 400 ? status : 502,
                  `Runtime bridge returned invalid JSON (HTTP ${status}).`,
                ),
              );
              return;
            }
          }

          if (status >= 400) {
            const msg =
              typeof parsed === "object" &&
              parsed !== null &&
              "error" in parsed &&
              typeof (parsed as { error: unknown }).error === "string"
                ? (parsed as { error: string }).error
                : `Runtime bridge failed with HTTP ${status}.`;
            fail(new RuntimeBridgeError(status, msg));
            return;
          }

          succeed(parsed);
        });
      };

      if (this.socketPath) {
        req = http.request(
          {
            socketPath: this.socketPath,
            path: routePath,
            method,
            headers,
          },
          onResponse,
        );
      } else if (this.parsedBaseUrl) {
        const basePath = this.parsedBaseUrl.pathname.replace(/\/+$/, "");
        const transport =
          this.parsedBaseUrl.protocol === "https:" ? https : http;
        req = transport.request(
          {
            protocol: this.parsedBaseUrl.protocol,
            hostname: this.parsedBaseUrl.hostname,
            port: this.parsedBaseUrl.port || undefined,
            path: `${basePath}${routePath}`,
            method,
            headers,
          },
          onResponse,
        );
      } else {
        fail(new RuntimeBridgeError(500, "Runtime bridge transport is unconfigured."));
        return;
      }

      req.on("error", (err) => {
        fail(
          new RuntimeBridgeError(
            503,
            `Host runtime bridge is unavailable: ${err.message}`,
          ),
        );
      });

      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }
}

/** Builds an `HttpRuntimeBridgeClient` from standard `VPS_OS_RUNTIME_*` environment variables. */
export function createRuntimeBridgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpRuntimeBridgeClient | undefined {
  const socketPath = env.VPS_OS_RUNTIME_SOCKET?.trim();
  const baseUrl = env.VPS_OS_RUNTIME_URL?.trim();
  const runtimeToken = env.VPS_OS_RUNTIME_TOKEN?.trim();
  if (!socketPath && !baseUrl) {
    return undefined;
  }
  return new HttpRuntimeBridgeClient({
    socketPath,
    baseUrl,
    runtimeToken,
  });
}

export type StatusSyncProvider =
  | Pick<RuntimeBridge, "getStatuses">
  | ((slugs: string[]) => Promise<Record<string, AppStatus>> | Record<string, AppStatus>);

/**
 * Queries live container statuses from a runtime bridge or controller callback
 * and updates drifted registry records, preserving workloads currently in
 * `"provisioning"` or marked cleanup-pending.
 */
export async function syncAppStatuses(
  registry: SystemRegistryStore,
  provider: StatusSyncProvider | undefined,
  slugs?: string[],
): Promise<AppRecord[]> {
  const existingApps = registry.listApps();
  if (!provider || existingApps.length === 0) {
    return existingApps;
  }

  const cleanupPending = new Set(registry.listCleanupPendingSlugs());
  const isSyncEligible = (app: AppRecord): boolean =>
    app.status !== "provisioning" && !cleanupPending.has(app.slug);

  const targetSlugs = slugs
    ? slugs.filter((s) => existingApps.some((app) => app.slug === s && isSyncEligible(app)))
    : existingApps.filter(isSyncEligible).map((app) => app.slug);

  if (targetSlugs.length === 0) {
    return existingApps;
  }

  try {
    const fetchStatuses =
      typeof provider === "function"
        ? provider
        : (ids: string[]) => provider.getStatuses(ids);
    const liveStatuses = await fetchStatuses(targetSlugs);
    const now = new Date().toISOString();
    for (const app of existingApps) {
      if (!isSyncEligible(app)) continue;
      const live = liveStatuses[app.slug];
      if (live && live !== app.status) {
        registry.updateAppStatus(app.slug, live, now);
      }
    }
    return registry.listApps();
  } catch {
    return existingApps;
  }
}
