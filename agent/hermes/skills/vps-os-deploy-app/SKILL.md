---
name: vps-os-deploy-app
description: Deploy a new isolated web app or personal-agent workload into /apps/<slug>, wire Caddy HTTPS routing, verify health, and register final status in the VPS OS registry.
---

# Deploy Isolated VPS OS App

## Preconditions
- `vps-os` MCP tools are available (`inspect_apps`, `propose_plan`, `get_plan_status`, `prepare_app_workspace`, `update_app_status`).
- Target slug is lowercase kebab-case (`2-48` chars, not a reserved system slug).
- If a public domain is requested, run the `vps-os-domain-tls` skill checks first.

## Procedure
1. **Inspect existing state:** Call `inspect_apps` to verify the slug and port do not collide with existing workloads.
2. **Propose an approved plan:** Call `propose_plan` with a clear goal describing the app, folder `/apps/<slug>`, domain (if any), and resource limits.
3. **Wait for explicit user approval:** Do not mutate `/apps` or Docker until `get_plan_status` returns `status: "approved"`.
4. **Provision isolated workspace:** Call `prepare_app_workspace` with the approved `planId`, `slug`, `name`, `kind` (`web-app` or `personal-agent`), `domain`, and `internalPort`.
5. **Customize Compose & scoped `.env`:** Update `/apps/<slug>/docker-compose.yml` only if a custom image/command is required, preserving `cap_drop: [ALL]`, `no-new-privileges:true`, CPU/RAM caps, isolated `app_net`, and zero `/var/run/docker.sock` mounts. Never write secrets into `docker-compose.yml` or `.env.example`.
6. **Validate & start:** Run `docker compose -f /apps/<slug>/docker-compose.yml config` first; then run `docker compose -f /apps/<slug>/docker-compose.yml up -d`.
7. **Configure Caddy (when `domain` is set):** Connect `vps-os-caddy` to the app's network if needed, write `/vps-os/caddy/apps.d/<slug>.caddy`, validate Caddy config, and reload `vps-os-caddy`.
8. **Verify & finalize status:** Confirm container health (`docker compose ps`) and internal HTTP response, then call `update_app_status` with `status: "running"`.
9. **Report to the owner:** Close in plain English — what was deployed, where it lives, the live link (if any), and what you verified before claiming success. Offer redacted logs only if the owner asks.

## Failure & Recovery
- If Compose validation or startup fails, capture redacted logs, call `update_app_status` with `status: "error"`, explain the cause in plain English, and offer a clean rollback (`docker compose down`) rather than leaving broken half-configured routes.
