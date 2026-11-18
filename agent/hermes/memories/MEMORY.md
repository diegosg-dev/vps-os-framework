# Server Memory (VPS OS CTO)

## Platform Layout
- Core platform root: `/vps-os` (`docker-compose.yml`, `.env`, `data/registry.db`, `Caddyfile`, `caddy/apps.d/*.caddy`)
- Hermes CTO home: `/vps-os/hermes` (`SOUL.md`, `memories/`, `skills/`, `state.db`)
- Isolated workloads root: `/apps/<slug>` (`docker-compose.yml`, `.env`, `.env.example`, `data/` or `workspace/`)
- Core Docker bridge network: `vps-os-core`
- Ingress: Caddy 2 handles automatic HTTPS (`80`/`443`) and imports `/etc/caddy/apps.d/*.caddy`. Never expose internal `/agent/*` or gateway ports publicly.

## Baseline Checklist (Populate on First Host Scan)
- Ubuntu version, CPU cores, total RAM, and root disk free space: pending initial baseline scan.
- Docker Engine & Compose v2 status: pending initial baseline scan.
- UFW firewall ports allowed: SSH, 80/tcp, 443/tcp.
