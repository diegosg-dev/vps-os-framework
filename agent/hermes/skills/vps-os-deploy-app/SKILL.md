---
name: vps-os-deploy-app
description: Deploy an isolated container workload (web application, API, site, or background worker) into /apps/<slug>, configure optional Caddy HTTPS routing, verify runtime health, and register state in SQLite.
---

# Deploy Isolated VPS OS Workload

## Preconditions
- `vps-os` typed tools are available (`inspect_apps`, `propose_plan`, `get_plan_status`, `prepare_app_workspace`, `control_app_lifecycle`, `remove_workload`, `route_caddy`, `update_app_status`).
- Target `slug` is lowercase kebab-case (`2-48` chars, not reserved).
- Workloads run rootless/sandboxed (`cap_drop: [ALL]`, `no-new-privileges:true`, isolated bridge `vps-os-<slug>_app_net`). Listening services MUST bind unprivileged port `>=1024` (standard `web-app`: `8080` via `nginxinc/nginx-unprivileged:alpine`) and writable cache/tmp paths if customized.
- Do not suggest AI-agent or chatbot templates unless the owner explicitly requested one. Keep workload selection neutral (`web-app` for HTTP sites/APIs/services; headless worker only for non-HTTP daemons/workers).

## Procedure
1. **Inspect existing state:** Call `inspect_apps` to verify `slug`, folder `/apps/<slug>`, and requested domain do not collide with registered apps.
2. **Propose an approved plan:** Call `propose_plan` (or emit `prepare_app_workspace` step) specifying `slug`, `name`, `kind`, `domain` (`null` for internal-only, `<domain>`, or `<slug>.<ip-with-dashes>.sslip.io` when HTTPS is desired without a custom domain), and `internalPort`.
3. **Honor approval gate:** Do not mutate `/apps` or Docker unless `get_plan_status` is `approved` (or YOLO auto-approval claimed the lease).
4. **Provision isolated workspace:** Call `prepare_app_workspace` to scaffold `/apps/<slug>/docker-compose.yml`, scoped `.env` (`0600`), and persistent `./data` or `./workspace`.
5. **Preserve Compose isolation policy (`runtime-bridge.py`):**
   - Only `app_net` bridge network allowed; no `ports:` host bindings or `/var/run/docker.sock` mounts.
   - Only relative `./data` or `./workspace` bind mounts; no forbidden `DOCKER_*` or control-plane env overrides.
   - Non-root image/command compatible with `cap_drop: ALL` and `no-new-privileges:true`.
6. **Validate & start:** Run `docker compose config` check + `lifecycle(slug, "start")`.
7. **Configure Caddy TLS (when `domain` is non-null):** Connect `vps-os-caddy` to `vps-os-<slug>_app_net`, write `/vps-os/caddy/apps.d/<slug>.caddy` (`reverse_proxy vps-os-app-<slug>:<internalPort>`), run `caddy validate` + `caddy reload`.
8. **Verify & report:** Confirm container status is `running`/healthy and HTTP upstream responds cleanly, then report folder `/apps/<slug>`, internal port, status, and live `https://<domain>` link (if routed).

## Failure & Recovery
- If Compose validation, startup, or Caddy routing fails, capture redacted logs, roll back cleanly (`removeWorkload` when pre-existing state was absent, or preserve folder with `cleanup_pending` + `status: "error"` if teardown fails), and report the concrete failing cause.
