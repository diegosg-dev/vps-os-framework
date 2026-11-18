---
name: vps-os-backup-cron
description: Set up safe, scheduled backups for VPS OS registry SQLite databases and isolated /apps/<slug> volumes using Hermes cronjob automation.
---

# Configure Automated VPS OS Backups

## Preconditions
- Backup target directory exists with sufficient free disk space (`df -h`).
- Any persistent schedule change is approved by the user via `propose_plan` first.

## Procedure
1. **Identify critical state:**
   - Core registry: `/vps-os/data/registry.db`
   - Hermes CTO state: `/vps-os/hermes/memories/` and `/vps-os/hermes/state.db`
   - Per-app persistent volumes: `/apps/*/data` and `/apps/*/workspace`
   - Never bundle plaintext `.env` secrets into unencrypted shared backup archives unless explicitly stored in a root-only (`0600`) encrypted archive.
2. **Use safe SQLite hot backups:** Always copy SQLite WAL databases with `sqlite3 <db> ".backup '<dest>'"` instead of raw `cp` to avoid corrupted snapshots.
3. **Schedule with `cronjob`:** Register a recurring `cronjob` with explicit retention pruning (e.g., keep last 7 daily snapshots) and post-backup integrity verification.
4. **Test one backup immediately:** Run the backup once, verify archive readability and size, and report in plain English: what is backed up, how often it runs, where backups live, and how long they are kept.
