---
name: vps-os-domain-tls
description: Verify DNS resolution and safely bind or update an automatic HTTPS domain route in Caddy for a VPS OS app without triggering ACME rate limits.
---

# Configure Domain & Auto-TLS Routing

## Preconditions
- Domain is a valid hostname (no spaces, paths, schemes, or Caddyfile control characters).
- Ports `80/tcp` and `443/tcp` are open in UFW and reachable from the public internet.

## Procedure
1. **Verify DNS before touching Caddy:** Resolve the target hostname (`getent hosts <domain>` or `dig +short <domain>`) and compare against the VPS public IP. If DNS does not point to this server yet, warn the user in plain English and ask them to update their A/AAAA record before enabling HTTPS.
2. **Require approved plan:** Ensure an approved `ExecutionPlan` exists before writing `/vps-os/caddy/apps.d/<slug>.caddy`.
3. **Write scoped route file:** Create `/vps-os/caddy/apps.d/<slug>.caddy` proxying `<domain>` over TLS to the app container's internal service name and port on its shared bridge. Never expose internal `/agent/*` or `127.0.0.1:8642` endpoints.
4. **Validate & reload Caddy:** Run `docker exec vps-os-caddy caddy validate --config /etc/caddy/Caddyfile` before reloading (`caddy reload --config /etc/caddy/Caddyfile`).
5. **Confirm HTTPS:** Verify TLS handshake and HTTP status, then report the live `https://<domain>` link to the user.
6. **Handle issuance failures calmly:** If the TLS handshake or certificate issuance fails, explain in plain English which common cause it is (DNS not pointing here yet, port `80`/`443` blocked, or ACME rate limit), how long to wait safely, and never hammer retries — repeated failed attempts can trigger longer ACME rate limits.
