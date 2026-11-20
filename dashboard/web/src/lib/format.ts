import type {
  AppCardView,
  AuditEventView,
  OnboardingPayload,
  SystemMetricsView,
} from "../types";

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMbToGb(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function providerDisplayName(provider: string | null | undefined): string {
  switch (provider) {
    case "opencode":
      return "OpenCode";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "openrouter":
      return "OpenRouter";
    case "nous":
      return "Nous";
    case "ollama":
      return "Ollama";
    case "vps-os-cto":
      return "VPS OS CTO";
    default:
      return provider || "VPS OS CTO";
  }
}

export function cpuLoadPercent(metrics: SystemMetricsView | null): number {
  if (!metrics) return 0;
  return Math.min(
    100,
    Math.max(
      0,
      Math.round((metrics.loadAverage1m / Math.max(1, metrics.cpuCount)) * 1000) /
        10,
    ),
  );
}

export interface ServerHealthSummary {
  score: number;
  label: "Healthy" | "Attention" | "Degraded";
  tone: "success" | "warning" | "danger";
  headline: string;
}

export function computeServerHealth(
  metrics: SystemMetricsView | null,
  apps: AppCardView[],
  onboarding: OnboardingPayload | null,
  offline: boolean,
): ServerHealthSummary {
  if (offline) {
    return {
      score: 0,
      label: "Degraded",
      tone: "danger",
      headline: "Control API is currently unreachable.",
    };
  }
  if (!metrics) {
    return {
      score: 100,
      label: "Healthy",
      tone: "success",
      headline: "Connecting to live host telemetry...",
    };
  }

  let score = 100;
  const notes: string[] = [];
  const cpuPct = cpuLoadPercent(metrics);
  if (cpuPct > 85) {
    score -= 25;
    notes.push("high CPU load");
  } else if (cpuPct > 65) {
    score -= 10;
  }

  if (metrics.memoryUsagePercent > 88) {
    score -= 25;
    notes.push("memory pressure");
  } else if (metrics.memoryUsagePercent > 75) {
    score -= 10;
  }

  if (metrics.disk && metrics.disk.usagePercent > 88) {
    score -= 20;
    notes.push("low disk space");
  } else if (metrics.disk && metrics.disk.usagePercent > 75) {
    score -= 8;
  }

  const erroredApps = apps.filter((a) => a.status === "error").length;
  if (erroredApps > 0) {
    score -= Math.min(30, erroredApps * 15);
    notes.push(`${erroredApps} workload error${erroredApps > 1 ? "s" : ""}`);
  }

  if (onboarding && !onboarding.state.llmConfigured) {
    score -= 8;
  }

  score = Math.max(10, Math.min(100, score));

  if (score >= 85) {
    return {
      score,
      label: "Healthy",
      tone: "success",
      headline: "All core services, isolation boundaries, and resources look great.",
    };
  }
  if (score >= 60) {
    return {
      score,
      label: "Attention",
      tone: "warning",
      headline:
        notes.length > 0
          ? `Server operational with ${notes.join(", ")}.`
          : "Server operational — review recommended configuration items.",
    };
  }
  return {
    score,
    label: "Degraded",
    tone: "danger",
    headline:
      notes.length > 0
        ? `Immediate attention needed: ${notes.join(", ")}.`
        : "Server health requires investigation.",
  };
}

export function classifyLogLine(line: string): "error" | "warn" | "info" | "plain" {
  if (/\b(ERROR|FATAL|CRITICAL|EXCEPTION|FAIL|ERR)\b/i.test(line)) {
    return "error";
  }
  if (/\b(WARN|WARNING|SLOW|RETRY)\b/i.test(line)) {
    return "warn";
  }
  if (/\b(INFO|READY|OK|PASS|PASSED|HEALTHY|LISTENING)\b/i.test(line)) {
    return "info";
  }
  return "plain";
}

export function triggerTextDownload(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function auditEventsToCsv(events: AuditEventView[]): string {
  const escape = (val: string | null | undefined) => {
    const str = val ?? "";
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const header = ["timestamp", "actor", "risk", "action", "target_slug", "summary"];
  const rows = events.map((evt) =>
    [
      evt.createdAt,
      evt.actor,
      evt.riskLevel,
      evt.action,
      evt.targetSlug ?? "",
      evt.summary,
    ]
      .map(escape)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
