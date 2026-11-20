# VPS OS Framework Documentation

Welcome to the **VPS OS Framework** documentation hub. This guide helps server owners, developers, and security reviewers understand how VPS OS turns a bare Ubuntu LTS server into a browser-managed, AI-assisted appliance with strict **"Locked Apartment"** workload isolation.

---

## Choose Your Reading Path

```mermaid
flowchart LR
    start["VPS OS Docs Hub (docs/README.md)"]

    subgraph owner ["Server Owner (Non-Linux / Non-Coding)"]
        gs["1. Getting Started & First-Boot Wizard<br/>(getting-started.md)"]
        fl["2. Lifecycle Flows & Use Cases<br/>(flows-and-use-cases.md)"]
        gs --> fl
    end

    subgraph dev ["Developer & Contributor"]
        arch["1. Architecture Overview<br/>(architecture.md)"]
        api["2. API, Agent & Registry Reference<br/>(api-and-agent-reference.md)"]
        bnd["3. Structure & Guardrails<br/>(boundaries-and-structure.md)"]
        arch --> api --> bnd
    end

    subgraph sec ["Security & Runtime Reviewer"]
        rt["1. Runtime Bridge & Isolation Model<br/>(runtime-and-security.md)"]
        hermes["2. Hermes CTO & Onboarding<br/>(hermes-cto-onboarding.md)"]
        rt --> hermes
    end

    start --> owner
    start --> dev
    start --> sec
```

---

## Documentation Catalog

| Document | Audience | What You Will Learn | Key Diagrams & Visuals |
|---|---|---|---|
| **[Getting Started & Onboarding](getting-started.md)** | Owners & Operators | One-shot Ubuntu install, CLI flags, one-time `#claim=` setup code, 5-step Browser Wizard, and local dev/test setup | Bootstrap-to-Wizard flowchart, Host Apply sequence diagram |
| **[Architecture Overview](architecture.md)** | Everyone | Full `0`–`11` + `V` layer breakdown (*Role, Inputs, Mechanics, Outputs, Safety/Stack*) and confirmed tech stack | FigJam PNG exports + editable Mermaid system flow |
| **[Lifecycle Flows & Use Cases](flows-and-use-cases.md)** | Owners & Designers | First-time provisioning, plain-English app deployment, live monitoring, and Personal Life Agent vs. Web App isolation | Provisioning flow, Deploy + Rollback sequence, Locked Apartment topology |
| **[Runtime Bridge & Security](runtime-and-security.md)** | Security & Infra | Socket-less Docker isolation, `vps-os-runtime` Unix socket bridge, TOCTOU-safe Compose validation, auth/sessions, and secret redaction | Trust-boundary graph, Deployment & Rollback state machine |
| **[API, Agent & Registry Reference](api-and-agent-reference.md)** | Developers & Integrators | Hono Control API endpoints, Runtime Bridge API, Agent HTTP & 10 MCP tools, planner heuristics, SQLite schema, and env vars | `ExecutionPlan` & lease state diagram, End-to-end request flow |
| **[Hermes CTO & Onboarding](hermes-cto-onboarding.md)** | CTO / Agent Builders | Hermes Gateway (`systemd`), `SOUL.md`, bounded memory, progressive skills, MCP bridge, and upgrade ownership | Phase 1 topology, Approval-gated MCP sequence, Upgrade ownership graph |
| **[Repository Structure & Boundaries](boundaries-and-structure.md)** | Contributors | Directory map, confirmed stack, secret/host safety rules, verification gates, and Git/PR hygiene | Directory & verification reference tables |

---

## System Layers Mapped to Source Code

```mermaid
flowchart TB
    subgraph entry ["Entry Plane (Steps 1-2)"]
        ui["dashboard/web/<br/>React 19 + Vite + Tailwind v4"]
    end

    subgraph ingress ["Ingress & TLS (Step 3)"]
        caddy["bootstrap/Caddyfile<br/>Caddy 2 Auto-TLS + apps.d/*.caddy"]
    end

    subgraph core ["Core Services (Steps 4-6 & 8)"]
        api["dashboard/api/<br/>Hono Control API (:3001)"]
        agent["agent/<br/>Planner, Executor & MCP Server (:3002)"]
        shared["packages/shared/<br/>Zod Schemas, Safety & SQLite WAL"]
    end

    subgraph host ["Ubuntu Host Daemons (Steps 0 & 5)"]
        install["bootstrap/install.sh<br/>+ apply-onboarding.sh"]
        bridge["bootstrap/runtime-bridge.py<br/>vps-os-runtime.service (Unix socket)"]
        hermes["agent/hermes/<br/>Hermes CTO Gateway (127.0.0.1:8642)"]
    end

    subgraph apps ["Isolated Workloads (Steps 7 & 9)"]
        tpl["templates/<br/>web-app/ & personal-agent/"]
    end

    ui -->|"HTTPS"| caddy
    caddy -->|"Proxy / & /api/*"| api
    api <-->|"HTTP :3002"| agent
    api -->|"Read/Write"| shared
    agent -->|"Read/Write"| shared
    hermes <-->|"MCP stdio"| agent
    api -->|"Unix socket"| bridge
    agent -->|"Unix socket"| bridge
    bridge -->|"Validated Compose & Caddy"| apps
    install -->|"Provisions"| host
    tpl -.->|"Instantiated into /apps/&lt;slug&gt;"| apps
```

---

## Related Governance Files

- **[Project README](../README.md)** — High-level overview, quick start, and architecture summary.
- **[AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md)** — Guardrails, commands, and PR conventions for AI coding agents.
- **[Templates Guide](../templates/README.md)** — Locked Apartment container rules for `web-app` and `personal-agent` workloads.
