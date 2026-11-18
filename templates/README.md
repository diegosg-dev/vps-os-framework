# Isolated Workload Templates (`templates/`)

Every application or personal AI agent deployed by the VPS OS Framework uses a **"Locked Apartment"** isolation model:

1. **Dedicated Folder:** Each install lives in `/apps/<slug>/` with its own `docker-compose.yml` and `.env`.
2. **Isolated Network:** Each workload runs on its own bridge network (never sharing a default network with sibling apps unless explicitly bridged). When exposing a `web-app` domain via Caddy, attach only `vps-os-caddy` to that app's network (`docker network connect <slug>_app_net vps-os-caddy`).
3. **Scoped Volumes & Secrets:** Containers only mount their own `./workspace` or `./data` directory and receive only their own `.env` variables.
4. **No Host Escape:** Templates never mount `/var/run/docker.sock` or host root `/`, and enforce `cap_drop: [ALL]`, `no-new-privileges:true`, plus CPU/RAM limits.
