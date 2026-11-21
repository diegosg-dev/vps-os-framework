import fs from "node:fs";
import os from "node:os";
import { type SystemMetrics, SystemMetricsSchema } from "@vps-os/shared";

export interface DiskMetrics {
  mountPath: string;
  totalMb: number;
  usedMb: number;
  usagePercent: number;
}

export interface TelemetrySample {
  collectedAt: string;
  loadAverage1m: number;
  cpuCount: number;
  cpuLoadPercent: number;
  memoryUsagePercent: number;
  memoryUsedMb: number;
  diskUsagePercent: number | null;
}

/**
 * Bounded in-memory ring buffer storing recent sanitized telemetry samples
 * so the dashboard can render live trend sparklines across page reloads.
 */
export class TelemetryHistoryBuffer {
  private readonly samples: TelemetrySample[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 60, initialSamples: TelemetrySample[] = []) {
    this.maxSamples = Math.max(1, maxSamples);
    for (const sample of initialSamples.slice(-this.maxSamples)) {
      this.samples.push(sample);
    }
  }

  record(metrics: SystemMetrics, disk: DiskMetrics | null): TelemetrySample {
    const cpuLoadPercent = Math.min(
      100,
      Math.max(
        0,
        Math.round((metrics.loadAverage1m / Math.max(1, metrics.cpuCount)) * 1000) /
          10,
      ),
    );
    const sample: TelemetrySample = {
      collectedAt: metrics.collectedAt,
      loadAverage1m: metrics.loadAverage1m,
      cpuCount: metrics.cpuCount,
      cpuLoadPercent,
      memoryUsagePercent: metrics.memoryUsagePercent,
      memoryUsedMb: metrics.memoryUsedMb,
      diskUsagePercent: disk ? disk.usagePercent : null,
    };

    const last = this.samples.at(-1);
    if (last && last.collectedAt === sample.collectedAt) {
      this.samples[this.samples.length - 1] = sample;
    } else {
      this.samples.push(sample);
      if (this.samples.length > this.maxSamples) {
        this.samples.splice(0, this.samples.length - this.maxSamples);
      }
    }
    return sample;
  }

  list(limit?: number): TelemetrySample[] {
    if (limit === undefined || limit >= this.samples.length) {
      return [...this.samples];
    }
    return this.samples.slice(-Math.max(1, limit));
  }
}

function readLinuxAvailableMemoryBytes(totalBytes: number): number | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (!match?.[1]) return null;
    const availableBytes = Number(match[1]) * 1024;
    if (!Number.isFinite(availableBytes) || availableBytes < 0) {
      return null;
    }
    return Math.min(totalBytes, availableBytes);
  } catch {
    return null;
  }
}

/**
 * Collects sanitized host telemetry using Node's built-in `os` module
 * (and Linux `/proc/meminfo` `MemAvailable` when present) without spawning shell commands.
 */
export function collectSystemMetrics(): SystemMetrics {
  const totalBytes = os.totalmem();
  const linuxAvailBytes = readLinuxAvailableMemoryBytes(totalBytes);
  const freeBytes = linuxAvailBytes ?? os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const totalMb = Math.round(totalBytes / (1024 * 1024));
  const usedMb = Math.round(usedBytes / (1024 * 1024));
  const usagePercent =
    totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

  return SystemMetricsSchema.parse({
    hostname: os.hostname(),
    platform: os.platform(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpuCount: Math.max(1, os.cpus().length),
    loadAverage1m: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    memoryTotalMb: totalMb,
    memoryUsedMb: usedMb,
    memoryUsagePercent: usagePercent,
    collectedAt: new Date().toISOString(),
  });
}

/**
 * Collects root filesystem capacity metrics via `fs.statfsSync` without shell execution.
 */
export function collectDiskMetrics(targetPath = "/"): DiskMetrics | null {
  try {
    const resolvedTarget =
      process.platform === "win32" && targetPath === "/"
        ? pathRootForPlatform()
        : targetPath;
    const stats = fs.statfsSync(resolvedTarget);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const totalMb = Math.round(totalBytes / (1024 * 1024));
    const usedMb = Math.round(usedBytes / (1024 * 1024));
    const usagePercent =
      totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
    return {
      mountPath: resolvedTarget,
      totalMb,
      usedMb,
      usagePercent,
    };
  } catch {
    return null;
  }
}

function pathRootForPlatform(): string {
  const parsed = process.cwd().slice(0, 3);
  return parsed.endsWith("\\") || parsed.endsWith("/") ? parsed : process.cwd();
}
