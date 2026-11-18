import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ApprovalDecision,
  ApprovalDecisionSchema,
  type ExecutionPlan,
  ExecutionPlanSchema,
  type PlanStatus,
  type PlanStep,
  type StoredPlan,
} from "./agent-protocol.js";
import {
  type AppRecord,
  AppRecordSchema,
  type AppStatus,
  AppStatusSchema,
  type AuditEvent,
  AuditEventSchema,
} from "./registry.js";
import { redactSecrets, validateAppSlug, validateDomain } from "./safety.js";

interface AppRow {
  slug: string;
  name: string;
  kind: AppRecord["kind"];
  domain: string | null;
  folder_path: string;
  internal_port: number;
  status: AppRecord["status"];
  cpu_limit: string;
  memory_limit_mb: number;
  created_at: string;
  updated_at: string;
}

interface AuditRow {
  id: string;
  actor: AuditEvent["actor"];
  action: string;
  target_slug: string | null;
  summary: string;
  risk_level: AuditEvent["riskLevel"];
  created_at: string;
}

interface PlanRow {
  id: string;
  goal: string;
  summary: string;
  steps_json: string;
  requires_user_approval: number;
  status: PlanStatus;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

/**
 * SQLite-backed System & App Registry (Step 8).
 * Uses Node's built-in `node:sqlite` in WAL mode with busy_timeout so
 * dashboard-api and agent containers share state safely without an external DB server.
 */
export class SystemRegistryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('web-app', 'personal-agent')),
        domain TEXT,
        folder_path TEXT NOT NULL,
        internal_port INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('provisioning', 'running', 'stopped', 'error')),
        cpu_limit TEXT NOT NULL,
        memory_limit_mb INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
        action TEXT NOT NULL,
        target_slug TEXT,
        summary TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_created_at
        ON audit_events (created_at DESC);

      CREATE TABLE IF NOT EXISTS execution_plans (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        summary TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        requires_user_approval INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
        decided_by TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
    `);
  }

  /** Inserts or updates an app metadata record in the registry. */
  upsertApp(record: AppRecord): AppRecord {
    const validated = AppRecordSchema.parse(record);
    const safeSlug = validateAppSlug(validated.slug);
    const safeDomain = validated.domain ? validateDomain(validated.domain) : null;

    const stmt = this.db.prepare(`
      INSERT INTO apps (
        slug, name, kind, domain, folder_path, internal_port,
        status, cpu_limit, memory_limit_mb, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        domain = excluded.domain,
        folder_path = excluded.folder_path,
        internal_port = excluded.internal_port,
        status = excluded.status,
        cpu_limit = excluded.cpu_limit,
        memory_limit_mb = excluded.memory_limit_mb,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      safeSlug,
      validated.name,
      validated.kind,
      safeDomain,
      validated.folderPath,
      validated.internalPort,
      validated.status,
      validated.cpuLimit,
      validated.memoryLimitMb,
      validated.createdAt,
      validated.updatedAt,
    );
    return { ...validated, slug: safeSlug, domain: safeDomain };
  }

  /** Fetches a single app record by slug, or null if absent. */
  getAppBySlug(slug: string): AppRecord | null {
    const stmt = this.db.prepare("SELECT * FROM apps WHERE slug = ?");
    const row = stmt.get(slug) as AppRow | undefined;
    return row ? this.mapAppRow(row) : null;
  }

  /** Lists all registered apps ordered by most recently created. */
  listApps(): AppRecord[] {
    const stmt = this.db.prepare(
      "SELECT * FROM apps ORDER BY created_at DESC, slug ASC",
    );
    const rows = stmt.all() as unknown as AppRow[];
    return rows.map((row) => this.mapAppRow(row));
  }

  /** Updates an existing app's lifecycle status and timestamp. */
  updateAppStatus(slug: string, status: AppStatus, updatedAt?: string): boolean {
    const validStatus = AppStatusSchema.parse(status);
    const ts = updatedAt ?? new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE apps SET status = ?, updated_at = ? WHERE slug = ?",
    );
    const result = stmt.run(validStatus, ts, slug);
    return result.changes > 0;
  }

  /** Persists a proposed ExecutionPlan so approval decisions can be enforced server-side. */
  savePlan(plan: ExecutionPlan): StoredPlan {
    const validated = ExecutionPlanSchema.parse(plan);
    const status: PlanStatus = validated.requiresUserApproval ? "pending" : "approved";
    const stmt = this.db.prepare(`
      INSERT INTO execution_plans (
        id, goal, summary, steps_json, requires_user_approval,
        status, decided_by, decision_note, created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      validated.id,
      redactSecrets(validated.goal),
      redactSecrets(validated.summary),
      JSON.stringify(validated.steps),
      validated.requiresUserApproval ? 1 : 0,
      status,
      null,
      null,
      validated.createdAt,
      null,
    );
    return {
      ...validated,
      goal: redactSecrets(validated.goal),
      summary: redactSecrets(validated.summary),
      status,
      decidedBy: null,
      decisionNote: null,
      decidedAt: null,
    };
  }

  /** Fetches a stored execution plan by ID. */
  getPlan(planId: string): StoredPlan | null {
    const stmt = this.db.prepare("SELECT * FROM execution_plans WHERE id = ?");
    const row = stmt.get(planId) as PlanRow | undefined;
    return row ? this.mapPlanRow(row) : null;
  }

  /** Lists stored execution plans ordered newest-first, optionally filtered by status. */
  listPlans(options?: { status?: PlanStatus; limit?: number }): StoredPlan[] {
    const bounded = Math.max(1, Math.min(options?.limit ?? 25, 100));
    if (options?.status) {
      const stmt = this.db.prepare(
        "SELECT * FROM execution_plans WHERE status = ? ORDER BY created_at DESC LIMIT ?",
      );
      const rows = stmt.all(options.status, bounded) as unknown as PlanRow[];
      return rows.map((row) => this.mapPlanRow(row));
    }
    const stmt = this.db.prepare(
      "SELECT * FROM execution_plans ORDER BY created_at DESC LIMIT ?",
    );
    const rows = stmt.all(bounded) as unknown as PlanRow[];
    return rows.map((row) => this.mapPlanRow(row));
  }

  /** Records an explicit one-way approval or rejection decision for a pending plan. */
  recordApproval(decision: ApprovalDecision): StoredPlan {
    const validated = ApprovalDecisionSchema.parse(decision);
    const existing = this.getPlan(validated.planId);
    if (!existing) {
      throw new Error(`Execution plan "${validated.planId}" not found.`);
    }
    if (existing.status !== "pending") {
      throw new Error(
        `Execution plan "${validated.planId}" is already "${existing.status}" and cannot be re-decided.`,
      );
    }

    const nextStatus: PlanStatus = validated.approved ? "approved" : "rejected";
    const decidedAt = new Date().toISOString();
    const cleanNote = validated.note ? redactSecrets(validated.note) : null;

    const stmt = this.db.prepare(`
      UPDATE execution_plans
      SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = stmt.run(
      nextStatus,
      validated.decidedBy,
      cleanNote,
      decidedAt,
      validated.planId,
    );
    if (result.changes === 0) {
      throw new Error(
        `Execution plan "${validated.planId}" is no longer pending.`,
      );
    }

    return {
      ...existing,
      status: nextStatus,
      decidedBy: validated.decidedBy,
      decisionNote: cleanNote,
      decidedAt,
    };
  }

  /** Marks an approved plan as executed so it cannot be replayed. */
  markPlanExecuted(planId: string): boolean {
    const stmt = this.db.prepare(
      "UPDATE execution_plans SET status = 'executed' WHERE id = ? AND status = 'approved'",
    );
    const result = stmt.run(planId);
    return result.changes > 0;
  }

  /** Appends an immutable audit event with defensive secret redaction. */
  recordAudit(event: AuditEvent): AuditEvent {
    const validated = AuditEventSchema.parse({
      ...event,
      summary: redactSecrets(event.summary).slice(0, 500),
    });
    const stmt = this.db.prepare(`
      INSERT INTO audit_events (id, actor, action, target_slug, summary, risk_level, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      validated.id,
      validated.actor,
      validated.action,
      validated.targetSlug,
      validated.summary,
      validated.riskLevel,
      validated.createdAt,
    );
    return validated;
  }

  /** Returns the most recent audit events up to `limit`. */
  listAuditEvents(limit = 50): AuditEvent[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    const stmt = this.db.prepare(
      "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?",
    );
    const rows = stmt.all(bounded) as unknown as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetSlug: row.target_slug,
      summary: row.summary,
      riskLevel: row.risk_level,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }

  private mapAppRow(row: AppRow): AppRecord {
    return {
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      domain: row.domain,
      folderPath: row.folder_path,
      internalPort: row.internal_port,
      status: row.status,
      cpuLimit: row.cpu_limit,
      memoryLimitMb: row.memory_limit_mb,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapPlanRow(row: PlanRow): StoredPlan {
    return {
      id: row.id,
      goal: row.goal,
      summary: row.summary,
      steps: JSON.parse(row.steps_json) as PlanStep[],
      requiresUserApproval: row.requires_user_approval === 1,
      status: row.status,
      decidedBy: row.decided_by,
      decisionNote: row.decision_note,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    };
  }
}
