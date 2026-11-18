# CLAUDE.md

<!-- Mirrored from AGENTS.md for Claude Code compatibility. Keep both files in sync. -->

## Project Overview & Stack
- **Goal**: A plug-and-play, non-Linux-style "VPS OS" framework running on top of Ubuntu Linux VPSs, designed for non-coding and non-Linux users.
- **Core Pillars**:
  1. **Management Dashboard**: Auto-provisioned, comprehensive web UI for server health, services, and apps.
  2. **Autonomous AI Agent (CTO / Sysadmin / Dev)**: Sets up and manages the server, Docker workloads, new applications, and isolated subagent/app installations in separate folders through natural conversation.
- **Stack**: Confirmed TypeScript monorepo (`pnpm` workspaces, Node.js `>=22` LTS):
  - **Bootstrap & Ingress (`bootstrap/`)**: POSIX/Bash (`install.sh`), Caddy 2 (Auto-TLS reverse proxy), Docker Compose v2.
  - **Shared Core (`packages/shared/`)**: TypeScript, Zod, built-in `node:sqlite` (WAL mode) for System & App Registry.
  - **Dashboard (`dashboard/api/`, `dashboard/web/`)**: Hono (`@hono/node-server`) Control API + React 19, Vite, Tailwind CSS v4 Web UI.
  - **Autonomous AI Agent (`agent/`)**: TypeScript, Vercel AI SDK (`ai`), Zod tool schemas, isolated workspace provisioner.
  - **Workloads (`templates/`)**: Docker Compose v2 "Locked Apartment" templates (`personal-agent/`, `web-app/`).

## Directory Map
Keep the repository root clean (`README.md`, `AGENTS.md`, `CLAUDE.md`, `assets/`, plus workspace config `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`). Do not dump source files or scratch scripts in the root.
- `docs/`: Architecture documentation, lifecycle flows, use-case guides, and FigJam visual exports.
- `packages/shared/`: Shared Zod schemas, safety/isolation guards, secret redaction, and SQLite registry store (`@vps-os/shared`).
- `bootstrap/`: Ubuntu LTS setup script (`install.sh`), Caddyfile, and core `docker-compose.core.yml`.
- `dashboard/api/`: Hono Control API (`@vps-os/dashboard-api`).
- `dashboard/web/`: React + Vite + Tailwind Management Web UI & CTO Chat (`@vps-os/dashboard-web`).
- `agent/`: Core AI CTO planner, Vercel AI SDK toolset, and isolated subagent runtime (`@vps-os/agent`).
- `templates/`: Isolated per-app / per-agent Docker Compose templates deployed into separate folders.
- `tests/`: Automated unit, isolation, API, and template/bootstrap guardrail tests (`@vps-os/tests`).
- Update this map whenever a new top-level directory is introduced.

## Commands & Verification
- Install workspace dependencies: `corepack pnpm install` (or `pnpm install`)
- Typecheck all packages: `corepack pnpm typecheck`
- Build all packages and web UI: `corepack pnpm build`
- Run test suite: `corepack pnpm test`
- Full workspace verification: `corepack pnpm verify`
- Shell syntax check: `bash -n bootstrap/install.sh` (and `shellcheck bootstrap/install.sh` when available)
- Docker / Compose validation (on Docker-enabled hosts): `docker compose -f <file> config`
- **Before finishing any task**, run the relevant checks for every file type you touched and never claim a check or build passed without running it after your final edit.

## Strict Boundaries (Do Not Touch)
- **Secrets**: Never read, print, hardcode, or commit `.env`, `.env.*`, SSH keys, TLS private keys, API tokens, or credential files. Use `.env.example` with placeholder values only.
- **Host Safety**: Never run destructive system commands or modify host OS configuration outside an explicit sandbox/VM/container target. Keep generated apps and subagent installations isolated in dedicated directories/containers.
- **Scope & Config**: Do not modify lockfiles (unless adding an approved dependency), CI workflows, `assets/`, or unrelated files outside the task scope.

## Git & PR Hygiene
- **Branch naming**: Always name new branches `<type>/<short-kebab-description>` using `feat/`, `fix/`, `refactor/`, `chore/`, or `docs/` (e.g., `feat/dark-mode-toggle`).
- Work on feature branches or worktrees—never commit directly to `main` once established.
- Keep diffs minimal, focused, and easy to review; briefly explain **why** each change was made.
