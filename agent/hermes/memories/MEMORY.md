# Server Memory (VPS OS CTO)

## Platform Layout
- Control plane: `/vps-os` (`docker-compose.yml`, `.env`, `data/registry.db` SQLite WAL, `Caddyfile`, `caddy/apps.d/*.caddy`, `/run/vps-os/runtime.sock`).
- Runtime home & skills: `/vps-os/hermes` (`SOUL.md`, `memories/`, `skills/`, `state.db`).
- Isolated workloads: `/apps/<slug>` (`docker-compose.yml`, `.env` `0600`, `./data` or `./workspace`).
- Networking & Ingress: isolated `vps-os-<slug>_app_net` bridge per workload; Caddy 2 terminates `80/tcp` & `443/tcp` via `/etc/caddy/apps.d/*.caddy` (`vps-os-app-<slug>:8080`). UFW allows SSH, `80/tcp`, `443/tcp`.

## Architecture Constraints & Baseline
- Containers run with `cap_drop: ALL` and `no-new-privileges:true` (services bind ports `>=1024`, e.g., `8080`).
- Host OS specs & Docker/Compose baseline: verify via live telemetry (`inspect_system_metrics` / `inspect_apps`).

## Persistent Context Slot (Future Memory System)
- Owner workload preferences, custom domains, and operational notes belong here (never secrets).
