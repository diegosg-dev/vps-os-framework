# Lifecycle Flows & Real-World Use Cases

This guide explains how all components of the **VPS OS Framework** work together in plain language—from first-time server setup to running an autonomous personal agent alongside separate web applications.

---

## Core Lifecycle Flows

### Flow A: First-Time Provisioning (`0` -> `10` -> `3`, `4`, `5`, `8`)

**Goal:** Turn a blank Ubuntu VPS into a browser-managed server appliance in one step.

1. **Bare Ubuntu VPS Entry (`0`):** An operator runs the one-shot installer from `bootstrap/` on a fresh Ubuntu LTS VPS.
2. **Host & Docker Setup (`10`):** The bootstrapper configures the firewall (exposing only required web ports `80`/`443` and hardened SSH), installs Docker Engine, and creates isolated Docker bridge networks.
3. **Core Stack Bring-Up (`3`, `4`, `5`, `8`):** The installer launches the **Auto-TLS Reverse Proxy (`3`)**, **Dashboard Control API (`4`)**, **VPS OS MCP Agent (`5`)**, and **System & App Registry (`8`)**, then installs **Hermes Agent** with the pre-seeded CTO pack (`SOUL.md`, `memories/`, `skills/vps-os-*`) and `vps-os-hermes-cto.service` (see [Hermes CTO Architecture & Onboarding](hermes-cto-onboarding.md)).
4. **Ready for Non-Linux Users (`1`, `2`):** You open `https://os.yourdomain.com` in a browser with valid HTTPS certificates already active—no more SSH or manual Linux setup required.

---

### Flow B: Conversational App Deployment (`2` -> `3` -> `5` <-> `11` -> `6` -> `9` -> `7` -> `3` & `8`)

**Goal:** Install and launch a new application just by asking for it in plain English.

1. **User Request (`2` -> `3` -> `5`):** In **Natural-Language CTO Chat (`2`)**, you ask: *"Install an analytics dashboard on `analytics.mydomain.com`."* The **Reverse Proxy (`3`)** routes the request to the **Autonomous AI Agent (`5`)**.
2. **Plan & Approval (`5` <-> `11`):** The agent consults the **LLM Provider API (`11`)**, generates a step-by-step deployment plan (folder path, container image, resource caps, domain route), and shows it in chat for your confirmation.
3. **Isolated Install (`6` -> `9` -> `7`):** After you approve, the agent spawns an **Isolated Subagent Runtime (`6`)** scoped to `/apps/analytics/`. It collects any needed passwords/tokens into a scoped `.env` file (`9`), validates the Compose configuration, and starts the **Isolated App Container (`7`)**.
4. **Route & Register (`3` & `8`):** The **Reverse Proxy (`3`)** binds automatic HTTPS for `analytics.mydomain.com`, and the agent updates the **System & App Registry (`8`)** so the new app appears live on your **Management Web UI (`1`)**.

---

### Flow C: Live Monitoring & Safe Recovery (`1` -> `3` -> `4` -> `8`, `10`)

**Goal:** Keep full visibility and one-click control without touching a terminal.

1. **Dashboard Polling (`1` -> `3` -> `4`):** Opening the **Management Web UI (`1`)** queries the **Dashboard Control API (`4`)** over HTTPS.
2. **State + Live Metrics (`4` -> `8`, `10`):** The API pulls instant app metadata from the **Registry (`8`)** and live CPU, RAM, disk, and container health metrics from the **Ubuntu Host (`10`)**.
3. **Safe Operations:** From the UI you can **Start**, **Stop**, **Restart**, inspect plain-English logs, or ask the **CTO Agent (`5`)** to diagnose a failing container and roll back safely.

---

## Featured Use Case: Personal Life Agent Container vs. Separate App Container

A common question is whether you can run **two very different workloads on the same VPS**:
1. A **Personal Life AI Agent** that needs **full terminal access** inside its workspace to run scripts, install packages, and automate tasks.
2. A **Separate App** (such as a client portal, SaaS, or finance tool) that must remain stable, fast, and untouched.

### How the "Locked Apartment" Isolation Model Solves This

Each installation lives in its own dedicated directory and container boundary—like separate locked apartments inside the same building:

```text
Ubuntu Linux VPS Host (10)
├── /vps-os/                    # Core Platform (Proxy 3, Dashboard 4, CTO Agent 5)
├── /apps/personal-agent/       # Apartment A: Personal Life Agent
│   ├── docker-compose.yml      # Resource caps (e.g. RAM/CPU limits) + isolated network
│   ├── .env                    # ONLY personal-agent tokens (Telegram, LLM, Calendar)
│   └── workspace/              # Full Linux shell & persistent files for the agent
└── /apps/my-web-app/           # Apartment B: Separate Application
    ├── docker-compose.yml      # Separate bridge network, independent healthcheck
    ├── .env                    # ONLY app database/auth secrets
    └── data/                   # Persistent app database & uploads
```

#### Why This Works Safely

- **Full Power *Inside* `/apps/personal-agent/`:** Inside its container, your Personal Agent has a complete Linux shell (`bash`), Python/Node/Git/curl, cron jobs, local SQLite storage, and file tools. It can write code, install dependencies, and execute terminal commands freely inside `workspace/`.
- **Hard Walls *Outside* Its Container:** It has **no access** to the host Ubuntu OS, no access to the host Docker socket, and no visibility into `/apps/my-web-app/`. It cannot read your other app's `.env` secrets or break its database.
- **Resource Protection:** CPU and memory limits on Apartment A guarantee that a heavy automation script in your Personal Agent can never starve Apartment B.
- **One-Click Recovery:** If your Personal Agent ever misconfigures its own container, you can rebuild or reset `/apps/personal-agent/` from the dashboard without interrupting `/apps/my-web-app/`.
- **Optional Explicit Bridges:** By default, the two containers cannot communicate. If you later ask the CTO Agent (*"Allow my Personal Agent to query My App's read-only API"*), only that narrow internal route is opened.

---

### End-to-End Walkthrough: Everyday Life with This Setup

1. **Setup via CTO Chat:** You tell the CTO Agent:
   - *"Create an isolated Personal Agent container with full terminal tools in its own folder and connect it to my Telegram."*
   - *"Deploy my separate web app in its own container at `app.mydomain.com`."*
2. **What You Can Ask Your Personal Agent Every Day:**
   - **File & Data Automation:** *"Clean these monthly expense CSVs with Python and send me a breakdown."* -> Runs a script inside `/apps/personal-agent/workspace/` and returns the summary.
   - **Scheduled Monitors:** *"Check this API/site every morning at 8am and message me if a slot opens."* -> Registers a scheduled script inside its own container and pings your Telegram.
   - **Personal Knowledge Base:** *"Organize my saved PDFs, notes, and reading summaries."* -> Maintains structured markdown/SQLite indexes in its persistent `workspace/` volume.
   - **On-Demand Micro-Tools:** *"Write a quick script that syncs my reminders into a daily checklist."* -> Builds, tests, and executes the tool inside its sandbox.
3. **What You See in the Management Dashboard:**
   - Two clean cards—**Personal Agent** and **My Web App**—showing live CPU/RAM usage, `Healthy` status, logs, and one-click **Restart / Stop / Backup / Update** controls.
