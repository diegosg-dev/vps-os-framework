import crypto from "node:crypto";
import {
  type ExecutionPlan,
  ExecutionPlanSchema,
  type PlanStep,
  type RiskLevel,
  type WorkloadKind,
  validateAppSlug,
  validateDomain,
} from "@vps-os/shared";

const HIGH_RISK_KEYWORDS =
  /\b(delete|remove|destroy|reset|wipe|erase|format|firewall|ufw|ssh|sudo|root|secret|token|password|key|\.env|deploy|install|create|provision|exec|shell)\b/i;
const READ_ONLY_PREFIX =
  /^\s*(check|status|list|show|inspect|get|view|health|metrics|describe|read)\b/i;
const MUTATION_KEYWORDS =
  /\b(restart|stop|start|update|upgrade|configure|route|domain|change|edit|write|modify|add|set|expose|open|enable|disable|build|run)\b/i;

const DEPLOY_VERB_PATTERN =
  /\b(deploy|install|create|provision|launch|spin\s+up)\b/i;
const DISALLOWED_AUTO_DEPLOY_KEYWORDS =
  /\b(delete|remove|destroy|reset|wipe|erase|format|firewall|ufw|ssh|sudo|root|exec|shell)\b/i;
const PERSONAL_AGENT_PATTERN =
  /\b(personal\s+(?:life\s+)?agent|life\s+agent|personal-agent)\b/i;
const LIFECYCLE_INTENT_PATTERN =
  /^\s*(start|stop|restart)\s+(?:the\s+)?(?:app\s+|container\s+|workload\s+)?([a-z0-9][a-z0-9-]{1,47})(?:\s+(?:app|container|workload))?\s*[.!]?\s*$/i;

const FILE_OR_TECH_EXTENSIONS = new Set([
  "yml",
  "yaml",
  "json",
  "env",
  "sh",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "html",
  "htm",
  "css",
  "md",
  "txt",
  "conf",
  "caddy",
  "db",
  "sql",
  "xml",
  "log",
  "lock",
  "toml",
  "ini",
  "cfg",
  "csv",
  "png",
  "jpg",
  "svg",
  "pdf",
]);

const SLUG_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "new",
  "my",
  "in",
  "its",
  "own",
  "isolated",
  "folder",
  "directory",
  "container",
  "docker",
  "with",
  "and",
  "or",
  "for",
  "to",
  "on",
  "at",
  "of",
  "check",
  "resource",
  "limits",
  "access",
  "deploy",
  "install",
  "create",
  "provision",
  "launch",
  "spin",
  "up",
  "web",
  "app",
  "application",
  "server",
  "service",
  "redacted",
  "api",
  "key",
  "token",
  "password",
  "secret",
  "port",
]);

export interface DerivedDeploySpec {
  slug: string;
  name: string;
  kind: WorkloadKind;
  domain: string | null;
  internalPort: number;
}

function truncateExcerpt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function extractDomainFromGoal(goal: string): string | null {
  const candidates =
    goal.match(
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi,
    ) ?? [];
  for (const raw of candidates) {
    const lower = raw.toLowerCase();
    const tld = lower.split(".").pop() ?? "";
    if (FILE_OR_TECH_EXTENSIONS.has(tld)) {
      continue;
    }
    try {
      return validateDomain(lower);
    } catch {
      // ignore invalid hostname candidate
    }
  }
  return null;
}

function extractPortFromGoal(goal: string): number | undefined {
  const match = goal.match(/\bport\s+(\d{1,5})\b/i);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return undefined;
}

function normalizeSlugCandidate(raw: string, kind: WorkloadKind): string | null {
  let cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  if (!cleaned || cleaned.length < 2) {
    return null;
  }

  try {
    return validateAppSlug(cleaned);
  } catch {
    const suffixed = `${cleaned.slice(0, 40)}-${kind === "personal-agent" ? "agent" : "app"}`;
    try {
      return validateAppSlug(suffixed);
    } catch {
      return null;
    }
  }
}

function toDisplayName(slug: string): string {
  return slug
    .split("-")
    .map((word) =>
      word.length <= 3 && word !== "app" && word !== "web"
        ? word.toUpperCase()
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

/**
 * Extracts a deterministic, validated workload deployment specification from
 * a plain-English goal when the request clearly asks to create/deploy an app
 * or personal agent. Returns null if the goal is not a workload deployment.
 */
export function extractDeploySpecFromGoal(goal: string): DerivedDeploySpec | null {
  if (!DEPLOY_VERB_PATTERN.test(goal) || DISALLOWED_AUTO_DEPLOY_KEYWORDS.test(goal)) {
    return null;
  }

  const isPersonalAgent =
    PERSONAL_AGENT_PATTERN.test(goal) ||
    (/\btelegram\b/i.test(goal) && /\bagent\b/i.test(goal));
  const kind: WorkloadKind = isPersonalAgent ? "personal-agent" : "web-app";
  // Built-in personal-agent template runs a headless worker (`sleep infinity`),
  // so only bind public HTTPS domains automatically for web-app workloads.
  const domain = kind === "web-app" ? extractDomainFromGoal(goal) : null;
  // Built-in web-app template serves HTTP on port 8080 (nginx-unprivileged:alpine),
  // matching its container healthcheck and cap_drop: ALL isolation.
  const internalPort =
    kind === "personal-agent"
      ? (extractPortFromGoal(goal) ?? 3000)
      : 8080;

  let slugCandidate: string | null = null;
  let explicitName: string | null = null;

  const explicitSlugMatch = goal.match(
    /\b(?:slug|named|called)\s+["']?([a-zA-Z0-9-]+(?:\s+(?!at\b|on\b|with\b|for\b|port\b)[a-zA-Z0-9-]+){0,3})["']?/i,
  );
  if (explicitSlugMatch?.[1]) {
    explicitName = explicitSlugMatch[1].trim();
    slugCandidate = normalizeSlugCandidate(explicitName, kind);
  }

  if (!slugCandidate) {
    const subjectMatch = goal.match(
      /\b(?:deploy|install|create|provision|launch|spin\s+up)\s+(?:a\s+|an\s+|the\s+|new\s+|my\s+)*([a-zA-Z0-9][a-zA-Z0-9-]{1,30}(?:\s+[a-zA-Z0-9][a-zA-Z0-9-]{1,30})?)\s+(?:web\s+app|app|application|dashboard|portal|site|service)\b/i,
    );
    if (subjectMatch?.[1]) {
      const tokens = subjectMatch[1]
        .trim()
        .split(/\s+/)
        .filter((t) => !SLUG_STOP_WORDS.has(t.toLowerCase()));
      if (tokens.length > 0) {
        const joined = tokens.join("-");
        slugCandidate = normalizeSlugCandidate(joined, kind);
      }
    }
  }

  if (!slugCandidate) {
    if (kind === "personal-agent") {
      slugCandidate = /\blife\b/i.test(goal)
        ? "personal-life-agent"
        : "personal-agent";
    } else {
      const stripped = goal
        .replace(
          /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi,
          " ",
        )
        .replace(/\b[A-Za-z0-9_]+=\[REDACTED\]/g, " ")
        .split(/[^a-zA-Z0-9-]+/)
        .filter((w) => w.length >= 2 && !SLUG_STOP_WORDS.has(w.toLowerCase()));
      if (stripped.length > 0) {
        slugCandidate = normalizeSlugCandidate(stripped.slice(0, 3).join("-"), kind);
      }
    }
  }

  if (!slugCandidate && domain) {
    const firstLabel = domain.split(".")[0] ?? "";
    if (firstLabel && !["www", "app", "api"].includes(firstLabel)) {
      slugCandidate = normalizeSlugCandidate(firstLabel, kind);
    } else {
      slugCandidate = normalizeSlugCandidate(domain.replace(/\./g, "-"), kind);
    }
  }

  const finalSlug =
    slugCandidate ?? (kind === "personal-agent" ? "personal-agent" : "web-app");

  return {
    slug: finalSlug,
    name: explicitName || toDisplayName(finalSlug),
    kind,
    domain,
    internalPort,
  };
}

/**
 * Classifies the risk level of a natural-language CTO request using a
 * fail-closed policy: only explicit read-only queries are low risk.
 */
export function classifyGoalRisk(goal: string): RiskLevel {
  if (HIGH_RISK_KEYWORDS.test(goal)) {
    return "high";
  }
  if (READ_ONLY_PREFIX.test(goal) && !MUTATION_KEYWORDS.test(goal)) {
    return "low";
  }
  return "medium";
}

/**
 * Builds a structured, reviewable ExecutionPlan before any subagent or
 * container mutation is executed (Steps 2 & 5).
 */
export function createExecutionPlan(goal: string): ExecutionPlan {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new Error("Goal cannot be empty.");
  }

  const riskLevel = classifyGoalRisk(trimmedGoal);
  const requiresApproval = riskLevel !== "low";
  const excerpt = truncateExcerpt(trimmedGoal, 300);

  let steps: PlanStep[];

  if (riskLevel === "low") {
    steps = [
      {
        id: "step-1",
        title: "Inspect system registry and service health",
        description:
          "Read current app records, container statuses, and host metrics without modifying state.",
        toolName: "inspect_apps",
        riskLevel: "low",
        requiresApproval: false,
      },
    ];
  } else {
    const lifecycleMatch = trimmedGoal.match(LIFECYCLE_INTENT_PATTERN);
    const deploySpec = extractDeploySpecFromGoal(trimmedGoal);

    if (lifecycleMatch?.[1] && lifecycleMatch[2]) {
      const action = lifecycleMatch[1].toLowerCase() as "start" | "stop" | "restart";
      let validSlug: string | null = null;
      try {
        validSlug = validateAppSlug(lifecycleMatch[2].toLowerCase());
      } catch {
        validSlug = null;
      }

      if (validSlug) {
        steps = [
          {
            id: "step-1",
            title: "Verify target app in registry",
            description: `Confirm "${validSlug}" exists and inspect its current status.`,
            toolName: "inspect_apps",
            riskLevel: "low",
            requiresApproval: false,
          },
          {
            id: "step-2",
            title: `${action.slice(0, 1).toUpperCase()}${action.slice(1)} workload "${validSlug}"`,
            description: `Run Docker Compose ${action} via the host runtime bridge and update registry status.`,
            toolName: "control_app_lifecycle",
            riskLevel: "medium",
            requiresApproval: true,
            args: { slug: validSlug, action },
          },
        ];
      } else {
        steps = [
          {
            id: "step-1",
            title: "Manual review required",
            description:
              "Target app slug is invalid or reserved; clarify which registered app to control.",
            toolName: "manual_review",
            riskLevel,
            requiresApproval: true,
          },
        ];
      }
    } else if (deploySpec) {
      const routeNote = deploySpec.domain
        ? ` and route HTTPS for ${deploySpec.domain}`
        : "";
      steps = [
        {
          id: "step-1",
          title: "Inspect existing workloads and validate boundaries",
          description: `Verify slug "${deploySpec.slug}", scoped folder /apps/${deploySpec.slug}, and port ${deploySpec.internalPort}.`,
          toolName: "inspect_apps",
          riskLevel: "low",
          requiresApproval: false,
        },
        {
          id: "step-2",
          title: `Provision isolated ${deploySpec.kind} "${deploySpec.slug}"`,
          description: `Create /apps/${deploySpec.slug}, start isolated Compose container${routeNote}.`,
          toolName: "prepare_app_workspace",
          riskLevel,
          requiresApproval: true,
          args: {
            slug: deploySpec.slug,
            name: deploySpec.name,
            kind: deploySpec.kind,
            domain: deploySpec.domain,
            internalPort: deploySpec.internalPort,
          },
        },
        {
          id: "step-3",
          title: "Update System & App Registry",
          description:
            "Record app metadata and append an audit event without storing plaintext secrets.",
          toolName: "update_app_status",
          riskLevel: "medium",
          requiresApproval: true,
          args: { slug: deploySpec.slug },
        },
      ];
    } else {
      steps = [
        {
          id: "step-1",
          title: "Manual review required before host action",
          description:
            "This request is ambiguous or touches host-level controls outside automatic container provisioning.",
          toolName: "manual_review",
          riskLevel,
          requiresApproval: true,
        },
      ];
    }
  }

  return ExecutionPlanSchema.parse({
    id: crypto.randomUUID(),
    goal: trimmedGoal,
    summary: requiresApproval
      ? `Planned ${steps.length} steps for "${excerpt}" (approval required before execution).`
      : `Read-only inspection plan for "${excerpt}".`,
    steps,
    requiresUserApproval: requiresApproval,
    createdAt: new Date().toISOString(),
  });
}
