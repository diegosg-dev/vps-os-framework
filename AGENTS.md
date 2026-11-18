# AGENTS.md

## Project Overview & Stack
- **Goal**: A plug-and-play, non-Linux-style "VPS OS" framework running on top of Ubuntu Linux VPSs, designed for non-coding and non-Linux users.
- **Core Pillars**:
  1. **Management Dashboard**: Auto-provisioned, comprehensive web UI for server health, services, and apps.
  2. **Autonomous AI Agent (CTO / Sysadmin / Dev)**: Sets up and manages the server, Docker workloads, new applications, and isolated subagent/app installations in separate folders through natural conversation.
- **Stack**: Currently undecided (greenfield). Do **not** lock in a language, framework, or package manager without explicit user confirmation. Once chosen, update this section and **Commands & Verification**.

## Directory Map
Keep the repository root clean (`README.md`, `AGENTS.md`, `CLAUDE.md`, `assets/`). Do not dump source files or scratch scripts in the root.
- `docs/`: Architecture documentation, lifecycle flows, use-case guides, and FigJam visual exports.
- `bootstrap/` (when added): Ubuntu setup, provisioning, and plug-and-play installer scripts.
- `dashboard/` (when added): Server management web UI and backend API.
- `agent/` (when added): Core AI orchestrator, tools, and subagent runtime.
- `apps/` or `templates/` (when added): Isolated app/Docker templates deployed into separate folders.
- `tests/` (when added): Unit, integration, and provisioning verification tests.
- Update this map whenever a new top-level directory is introduced.

## Commands & Verification
- No build/test runner is configured yet; add exact commands here as soon as the stack is initialized.
- **Before finishing any task**, run the relevant checks for every file type you touched:
  - Shell scripts: syntax check (`bash -n <file>`) and `shellcheck` if available.
  - Docker / Compose: `docker compose config` to validate syntax.
  - App / Agent code: run the project's linter, typechecker, and test suite.
- Never claim a check or build passed without running it after your final edit.

## Strict Boundaries (Do Not Touch)
- **Secrets**: Never read, print, hardcode, or commit `.env`, `.env.*`, SSH keys, TLS private keys, API tokens, or credential files. Use `.env.example` with placeholder values only.
- **Host Safety**: Never run destructive system commands or modify host OS configuration outside an explicit sandbox/VM/container target. Keep generated apps and subagent installations isolated in dedicated directories/containers.
- **Scope & Config**: Do not modify lockfiles (unless adding an approved dependency), CI workflows, `assets/`, or unrelated files outside the task scope.

## Git & PR Hygiene
- **Branch naming**: Always name new branches `<type>/<short-kebab-description>` using `feat/`, `fix/`, `refactor/`, `chore/`, or `docs/` (e.g., `feat/dark-mode-toggle`).
- Work on feature branches or worktrees—never commit directly to `main` once established.
- Keep diffs minimal, focused, and easy to review; briefly explain **why** each change was made.
