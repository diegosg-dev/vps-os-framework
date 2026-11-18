import fs from "node:fs";
import path from "node:path";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const RESERVED_SLUGS = new Set([
  "core",
  "vps-os",
  "caddy",
  "dashboard",
  "agent",
  "system",
  "root",
  "admin",
]);

const ENV_OR_YAML_SECRET_PATTERN =
  /\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd|pass|credential|auth)[A-Za-z0-9_]*)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const JSON_SECRET_PATTERN =
  /"([A-Za-z0-9_]*(?:key|token|secret|password|passwd|pass|credential|auth)[A-Za-z0-9_]*)"\s*:\s*"([^"]*)"/gi;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const KNOWN_TOKEN_PREFIX_PATTERN =
  /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g;
const PEM_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * Validates that an application or personal-agent slug is safe for folder names,
 * Docker Compose project names, and internal DNS labels.
 */
export function validateAppSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid app slug "${slug}": must be 2-48 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Reserved app slug "${slug}" cannot be used.`);
  }
  return slug;
}

/**
 * Resolves an isolated workspace path under `appsRoot`, rejecting lexical traversal
 * as well as any pre-existing symlink inside `appsRoot` that points elsewhere.
 */
export function resolveScopedAppDir(appsRoot: string, slug: string): string {
  const safeSlug = validateAppSlug(slug);
  const resolvedRoot = path.resolve(appsRoot);
  const candidate = path.resolve(resolvedRoot, safeSlug);
  const relative = path.relative(resolvedRoot, candidate);

  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative !== safeSlug
  ) {
    throw new Error(
      `Security boundary violation: resolved path escapes apps root "${resolvedRoot}".`,
    );
  }

  if (fs.existsSync(resolvedRoot)) {
    const rootStat = fs.lstatSync(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(
        `Security boundary violation: apps root "${resolvedRoot}" must be a real directory.`,
      );
    }

    const realRoot = fs.realpathSync(resolvedRoot);
    try {
      const candidateStat = fs.lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        throw new Error(
          `Security boundary violation: target "${candidate}" cannot be a symbolic link.`,
        );
      }
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate !== path.join(realRoot, safeSlug)) {
        throw new Error(
          `Security boundary violation: real path "${realCandidate}" escapes apps root.`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  return candidate;
}

/**
 * Validates a public hostname before writing reverse-proxy routes.
 * Prevents control characters, paths, or Caddyfile syntax injection.
 */
export function validateDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) {
    throw new Error(`Invalid domain name "${domain}".`);
  }
  return normalized;
}

/**
 * Redacts common secret patterns (env/YAML/JSON keys, auth headers, provider tokens,
 * and PEM private key blocks) before logging or returning to UI/LLM context.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(PEM_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(AUTH_HEADER_PATTERN, "$1 [REDACTED]")
    .replace(JSON_SECRET_PATTERN, '"$1":"[REDACTED]"')
    .replace(
      ENV_OR_YAML_SECRET_PATTERN,
      (_match, key: string, sep: string) => `${key}${sep}${sep === ":" ? " " : ""}[REDACTED]`,
    )
    .replace(KNOWN_TOKEN_PREFIX_PATTERN, "[REDACTED]");
}
