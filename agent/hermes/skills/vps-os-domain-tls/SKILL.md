---
name: vps-os-domain-tls
description: Validate DNS resolution, domain uniqueness, and isolated bridge network attachments before binding Caddy 2 Auto-TLS routes on ports 80/443.
---

# Configure Domain & Auto-TLS Routing

## Preconditions
- Hostname passes strict domain validation (lowercase RFC hostname, no paths/schemes/whitespace/Caddy control chars).
- Ports `80/tcp` and `443/tcp` are open in UFW; target app container is `running` so `vps-os-<slug>_app_net` bridge network exists.
- If the owner lacks a custom domain and `publicIp` is known, `<slug>.<ip-with-dashes>.sslip.io` provides DNS-resolved HTTPS via Caddy without custom registrar setup.

## Procedure
1. **Verify DNS & collisions:** Resolve target hostname (`getent hosts` / `dig +short`) against VPS `publicIp` and verify no other `.caddy` file in `/vps-os/caddy/apps.d/` owns that hostname (`route_caddy` enforces `409` uniqueness).
2. **Require approved plan:** Propose and approve a `route_caddy` (`{ slug, domain }`) or `prepare_app_workspace` step before modifying Caddy.
3. **Attach bridge & write route:** `runtime-bridge.py` connects `vps-os-caddy` to `vps-os-<slug>_app_net` and writes `/vps-os/caddy/apps.d/<slug>.caddy` proxying to `vps-os-app-<slug>:<internalPort>`.
4. **Atomic validate & reload:** Run `caddy validate --config /etc/caddy/Caddyfile` before `caddy reload`. On validation error, restore previous route file and disconnect newly attached bridge.
5. **Verify HTTPS & sync registry:** Confirm TLS handshake and HTTP response (`https://<domain>`), and verify `registry.db` reflects updated `domain`.

## Failure & Recovery
- Never rapid-retry failing ACME issuance (risks Let's Encrypt rate limits). Report confirmed DNS/firewall/upstream failure causes accurately and wait for DNS propagation or upstream health before retrying.
