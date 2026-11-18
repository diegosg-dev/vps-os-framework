---
name: vps-os-diagnose-and-recover
description: Safely diagnose unhealthy containers, port conflicts, disk/RAM pressure, or reverse-proxy errors on the VPS and perform controlled recovery.
---

# Diagnose and Safely Recover Services

## Preconditions
- Start read-only. Never restart, stop, or prune workloads without explaining the impact and getting user confirmation when data or uptime is affected.

## Procedure
1. **Check registry & recent audit trail:** Call `inspect_apps` and `list_audit_events` to see recent changes and expected app state.
2. **Gather host & container telemetry:**
   - Check host RAM, CPU load, and disk space (`df -h`, `free -m`) to rule out OOM kills or a full disk.
   - Check `docker ps -a` and `docker compose -f /apps/<slug>/docker-compose.yml ps` for restart loops or failing healthchecks.
   - Tail recent container logs (`--tail 100`) and strip any secret-looking lines before summarizing. Translate what the logs mean for the owner instead of pasting raw output.
3. **Check ingress & routes:** Verify `vps-os-caddy` logs and `/vps-os/caddy/apps.d/<slug>.caddy` if the symptom is 502/504 or TLS failure.
4. **Propose minimal fix:** Call `propose_plan` before editing Compose files, restarting services, or changing Caddy routes.
5. **Verify recovery:** After approval and execution, confirm the container is healthy, HTTP responds cleanly, and call `update_app_status` (`running` or `error`) to keep the dashboard accurate.
6. **Explain the incident to the owner:** After recovery, summarize in plain English what broke, why, what you changed to fix it, and one concrete way to prevent it from happening again. No blame, no raw logs unless the owner asks.
