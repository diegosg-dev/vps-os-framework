---
name: vps-os-diagnose-and-recover
description: Perform technical root-cause diagnostics on failing containers, permission/port errors under cap_drop ALL, OOM kills, disk pressure, or Caddy 502/TLS errors and recover workloads safely.
---

# Diagnose and Safely Recover Services

## Preconditions
- Start read-only (`inspect_apps`, `read_app_logs`, `list_audit_events`). Never mutate containers or files without an approved `ExecutionPlan` when state/uptime changes.

## Technical Diagnostic Procedure
1. **Check registry & audit trail:** Inspect registered `status`, `cleanup_pending`, `domain`, `internalPort`, and recent `list_audit_events` failures.
2. **Check host headroom:** Inspect CPU load, RAM pressure (`free -m` / `OOMKilled`), and disk usage (`df -h` — low disk breaks Docker pulls and SQLite writes).
3. **Inspect container failure signatures (`read_app_logs` / `docker ps -a`):**
   - `chown` / `Operation not permitted` / exit `1` on privileged ports (`80`/`443`): Caused by `cap_drop: ALL` + `no-new-privileges:true` against root images (e.g. standard `nginx:alpine`). Fix by switching to `nginxinc/nginx-unprivileged:alpine` listening on port `8080` (`>=1024`) with user-owned runtime dirs.
   - Exit `137` / `OOMKilled: true`: Container hit its Compose `mem_limit`; profile workload or raise memory limit carefully.
   - `runtime-bridge.py` HTTP `400` Compose rejection: Non-compliant `cap_drop`, missing `no-new-privileges:true`, disallowed `ports:`, forbidden env key, symlinked mount, or non-`app_net` network.
4. **Inspect Caddy ingress (`502` / `504` / TLS failures):**
   - Verify `/vps-os/caddy/apps.d/<slug>.caddy` targets `vps-os-app-<slug>:<internalPort>` and matches container's real listening port.
   - Verify `vps-os-caddy` is connected to `vps-os-<slug>_app_net` (`docker network inspect`).
5. **Execute minimal recovery plan:** Propose `control_app_lifecycle` (`restart`), `route_caddy`, `remove_workload`, or updated Compose/config fix; execute after approval.
6. **Verify & summarize:** Confirm `status: running`, passing healthcheck, and live HTTP check, then summarize confirmed root cause, any remaining uncertainty, change applied, and prevention measure.
