---
name: vps-os-secrets-hygiene
description: Enforce strict secret redaction, 0600 file permissions, and safe handling of API keys, tokens, and .env files across all VPS OS operations.
---

# Secrets & Credential Hygiene

## Rules (Always Active)
1. **Never print or echo secrets:** Never display the contents of `/vps-os/.env`, `/apps/*/.env`, SSH private keys, TLS keys, `VPS_OS_ADMIN_TOKEN`, `HERMES_API_SERVER_KEY`, or `LLM_API_KEY` in chat, logs, or audit summaries.
2. **Keep `.env.example` placeholder-only:** Any template `.env.example` file may only contain `replace-with-...` placeholders.
3. **Scoped permissions:** Newly generated `.env` files must use `chmod 600` (`0600`) and live strictly inside `/vps-os/.env` or `/apps/<slug>/.env`.
4. **Sanitize diagnostics:** Before sharing command output, container logs, or error tracebacks with the user (or storing them in `MEMORY.md` / skills), mask bearer tokens, API keys (`sk-...`, `ghp_...`, etc.), passwords, and connection strings.
5. **Respond to exposure honestly:** If a secret slips out (in chat, logs, or an archive), tell the owner plainly which secret was exposed (by name, never by value), stop work on the affected service, and recommend rotating it before continuing.
