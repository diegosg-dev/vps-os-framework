# Repository Structure, Greenfield Policy & Safety Boundaries

This document summarizes the engineering rules, directory layout, and verification standards defined in [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md).

---

## Directory Map

The repository root stays intentionally minimal (`README.md`, `AGENTS.md`, `CLAUDE.md`, `assets/`), with all documentation, source code, and templates placed in dedicated top-level directories:

| Directory | Status | Responsibility |
|---|---|---|
| `docs/` | Active | Architecture overview, FigJam exports, lifecycle flows, and boundary docs |
| `packages/shared/` | Active | Shared Zod schemas, safety/isolation guards, secret redaction, and SQLite registry |
| `bootstrap/` | Active | Ubuntu setup, host hardening, Caddy reverse proxy, and core Compose stack |
| `dashboard/api/` | Active | Hono Control Plane backend API |
| `dashboard/web/` | Active | React + Vite + Tailwind Management Web UI & CTO Chat |
| `agent/` | Active | Autonomous AI CTO planner, Hermes CTO pack (`agent/hermes/`), MCP server, and isolated subagent runtime |
| `templates/` | Active | Isolated per-app / per-agent Docker Compose templates deployed into separate folders |
| `tests/` | Active | Unit, isolation, API, and template/bootstrap guardrail tests |

---

## Confirmed Tech Stack

The repository uses a **TypeScript + pnpm workspace** core paired with **Bash + Caddy + Docker Compose v2** on Ubuntu LTS:

- **Ingress (`3`) & Bootstrap (`0`):** POSIX/Bash (`bootstrap/install.sh`), Caddy 2 Auto-TLS reverse proxy, and Docker Compose v2.
- **Shared Core & Registry (`8`):** TypeScript, Zod, and Node's built-in `node:sqlite` (WAL mode).
- **Dashboard (`1`, `4`):** React 19 + Vite + Tailwind CSS v4 (`dashboard/web/`) and Hono on Node.js LTS (`dashboard/api/`).
- **Autonomous AI Agent (`5`, `6`):** Hermes Agent CTO Gateway (`systemd`, `agent/hermes/`) bridged via MCP JSON-RPC `stdio` to TypeScript + Vercel AI SDK (`ai`) + Zod tools (`agent/`). See [Hermes CTO Architecture & Onboarding](hermes-cto-onboarding.md).
- **Isolated Workloads (`7`, `9`):** Locked-apartment Docker Compose templates (`templates/personal-agent/`, `templates/web-app/`).

---

## Strict Safety & Isolation Boundaries

1. **Secrets Hygiene:**
   - Never read, print, hardcode, or commit `.env`, `.env.*`, SSH keys, TLS private keys, API tokens, or credential files.
   - Always ship `.env.example` templates with placeholder values only; generate real `.env` files per isolated app at runtime.
2. **Host & Container Isolation:**
   - Never run destructive system commands or modify host OS configuration outside an explicit sandbox, VM, or container target.
   - Deploy every application and autonomous subagent installation into its own dedicated directory and container boundary.
   - Grant terminal/execution power *inside* scoped containers—never expose the host Ubuntu root or Docker socket to untrusted or personal-automation workloads.
3. **Root & Scope Discipline:**
   - Do not dump source files or scratch scripts into the repository root.
   - Do not modify `assets/`, CI workflows, or unrelated configuration outside task scope.

---

## Verification Gates

Before finishing any implementation change, run the relevant checks for every file type touched:

- **Shell scripts (`bootstrap/`):** `bash -n <file>` and `shellcheck` (when available).
- **Docker / Compose (`apps/`, `templates/`):** `docker compose config` to validate syntax and schema.
- **App / Agent code (`dashboard/`, `agent/`):** Run the configured linter, typechecker, and test suite.

---

## Git & PR Hygiene

- **Feature branches / worktrees:** Work on branches named `<type>/<short-kebab-description>` (`feat/`, `fix/`, `refactor/`, `chore/`, `docs/`), never committing directly to `main` once established.
- **Small, focused diffs:** Keep changes minimal, explain *why* each change was made, and keep `AGENTS.md` and `CLAUDE.md` synchronized.
