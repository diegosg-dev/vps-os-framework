# Repository Structure, Greenfield Policy & Safety Boundaries

This document summarizes the engineering rules, directory layout, and verification standards defined in [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md).

---

## Directory Map

The repository root stays intentionally minimal (`README.md`, `AGENTS.md`, `CLAUDE.md`, `assets/`), with all documentation, source code, and templates placed in dedicated top-level directories:

| Directory | Status | Responsibility |
|---|---|---|
| `docs/` | Active | Architecture overview, FigJam exports, lifecycle flows, and boundary docs |
| `bootstrap/` | Planned | Ubuntu setup, host hardening, Docker setup, and plug-and-play installer scripts |
| `dashboard/` | Planned | Management Web UI and Control Plane backend API |
| `agent/` | Planned | Autonomous AI CTO orchestrator, tool engine, and isolated subagent runtime |
| `apps/` or `templates/` | Planned | Isolated per-app / per-agent Docker Compose templates deployed into separate folders |
| `tests/` | Planned | Unit, integration, and sandboxed provisioning verification tests |

---

## Greenfield Stack Policy

The language, web framework, agent SDK, database, and package manager are **intentionally undecided** at this stage:

- Architecture and documentation define **clear layer interfaces and isolation boundaries** without prematurely locking in a stack.
- Once a stack is explicitly confirmed for `bootstrap/`, `dashboard/`, and `agent/`, update the **Project Overview & Stack** and **Commands & Verification** sections of [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) together.

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
