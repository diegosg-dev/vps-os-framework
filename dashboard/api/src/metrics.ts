import os from "node:os";
import { type SystemMetrics, SystemMetricsSchema } from "@vps-os/shared";

/**
 * Collects sanitized host telemetry using Node's built-in `os` module
 * without spawning shell commands.
 */
export function collectSystemMetrics(): SystemMetrics {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
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
