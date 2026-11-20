# Repository Structure, Confirmed Stack & Safety Boundaries

This document summarizes the engineering rules, directory layout, confirmed tech stack, and verification standards defined in [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md).

---

## Directory Map

The repository root stays intentionally minimal (`README.md`, `AGENTS.md`, `CLAUDE.md`, `assets/`, plus workspace/git config `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`, `.gitattributes`), with all documentation, source code, and templates placed in dedicated top-level directories:

| Directory | Status | Responsibility |
|---|---|---|
| `docs/` | Active | Documentation hub (`docs/README.md`), getting started, architecture, lifecycle flows, runtime/security deep dive, API/agent reference, Hermes CTO guide, and FigJam exports |
| `packages/shared/` | Active | Shared Zod schemas, safety/isolation guards, secret redaction, onboarding helpers, runtime bridge client, and SQLite WAL registry (`@vps-os/shared`) |
| `bootstrap/` | Active | Ubuntu setup (`install.sh`), onboarding host sync (`apply-onboarding.sh`), Host Runtime Bridge (`runtime-bridge.py`), Caddyfile, Dockerfile, and core Compose stack |
| `dashboard/api/` | Active | Hono Control Plane backend API (`@vps-os/dashboard-api`) |
| `dashboard/web/` | Active | React 19 + Vite + Tailwind v4 Management Web UI, Auth Gate, and 5-step Onboarding Wizard (`@vps-os/dashboard-web`) |
| `agent/` | Active | Autonomous AI CTO planner, executor, Hermes CTO pack (`agent/hermes/`), MCP stdio server, Vercel AI SDK toolset, and isolated subagent runtime (`@vps-os/agent`) |
| `templates/` | Active | Isolated per-app / per-agent Locked Apartment Docker Compose templates (`web-app/`, `personal-agent/`) deployed into `/apps/<slug>` |
| `tests/` | Active | Automated unit, isolation, API, onboarding, runtime bridge, and template/bootstrap guardrail tests (`@vps-os/tests`) |

---

## Confirmed Tech Stack

The repository uses a **TypeScript + pnpm workspace** core (`Node.js >= 24`, `pnpm@10`) paired with **Bash + Python 3 + Caddy 2 + Docker Compose v2** on Ubuntu LTS:

- **Bootstrap & Host Daemons (`0`, `10`):** POSIX/Bash (`bootstrap/install.sh`, `bootstrap/apply-onboarding.sh`) and Python 3 standard-library HTTP-over-Unix-Socket Host Runtime Bridge (`bootstrap/runtime-bridge.py`).
- **Ingress (`3`):** Caddy 2 Auto-TLS reverse proxy (`caddy:2-alpine`, `bootstrap/Caddyfile`) importing `/etc/caddy/apps.d/*.caddy`.
- **Shared Core & Registry (`8`):** TypeScript, Zod, and Node's built-in `node:sqlite` (WAL mode, `busy_timeout = 5000`).
- **Dashboard (`1`, `4`):** React 19 + Vite + Tailwind CSS v4 (`dashboard/web/`) and Hono on Node.js LTS (`dashboard/api/`).
- **Autonomous AI Agent (`5`, `6`):** Hermes Agent CTO Gateway (`systemd`, `agent/hermes/`) bridged via MCP JSON-RPC `stdio` to TypeScript + Vercel AI SDK (`ai`) + Zod tools (`agent/`). See [Hermes CTO Architecture & Onboarding](hermes-cto-onboarding.md).
- **Isolated Workloads (`7`, `9`):** Locked-apartment Docker Compose templates (`templates/personal-agent/`, `templates/web-app/`).

---

## Strict Safety & Isolation Boundaries

1. **Secrets Hygiene:**
   - Never read, print, hardcode, or commit `.env`, `.env.*`, SSH keys, TLS private keys, API tokens, or credential files.
   - Always ship `.env.example` templates with `replace-with-...` placeholder values only; generate real `0600` `.env` files at runtime.
2. **Host & Container Isolation:**
   - Never run destructive system commands or modify host OS configuration outside an explicit sandbox, VM, or container target.
   - Deploy every application and autonomous subagent installation into its own dedicated `/apps/<slug>` directory and `app_net` container boundary.
   - Grant terminal/execution power *inside* scoped containers (`personal-agent`)—never mount `/var/run/docker.sock` or host `/` inside any container.
3. **Root & Scope Discipline:**
   - Do not dump source files or scratch scripts into the repository root.
   - Do not modify `assets/`, `pnpm-lock.yaml` (unless adding an approved dependency), CI workflows, or unrelated configuration outside task scope.

---

## Verification Gates

Before finishing any implementation change, run the relevant checks for every file type touched:

- **Full workspace gate:** `corepack pnpm verify` (runs `corepack pnpm build && corepack pnpm typecheck && corepack pnpm test`).
- **Shell scripts (`bootstrap/*.sh`):** `bash -n <file>`, `shellcheck` (when available), and LF line endings check.
- **Python runtime bridge (`bootstrap/runtime-bridge.py`):** Python AST parse check + `tests/src/runtime-bridge.test.ts` (covered by `corepack pnpm test`).
- **Docker / Compose (`bootstrap/`, `templates/`):** `docker compose -f <file> config` on Docker-enabled hosts.

---

## Git & PR Hygiene

- **Feature branches / worktrees:** Work on branches named `<type>/<short-kebab-description>` (`feat/`, `fix/`, `refactor/`, `chore/`, `docs/`), never committing directly to `main` once established.
- **Small, focused diffs:** Keep changes minimal, explain *why* each change was made, and keep `AGENTS.md` and `CLAUDE.md` synchronized.
