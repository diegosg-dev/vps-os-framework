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
import {
  type ChatAttachment,
  ChatAttachmentSchema,
  type ChatMessage,
  ChatMessageSchema,
  type ChatReasoningBlock,
  type ChatThread,
  ChatThreadSchema,
  type ChatToolCall,
} from "./chat.js";
import {
  type OnboardingState,
  OnboardingStateSchema,
  createDefaultOnboardingState,
} from "./onboarding.js";
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

interface ChatThreadRow {
  id: string;
  title: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface ChatMessageRow {
  id: string;
  thread_id: string;
  role: ChatMessage["role"];
  content: string;
  attachments_json: string;
  reasoning_json: string;
  tool_calls_json: string;
  plan_id: string | null;
  provider: string | null;
  model: string | null;
  status: ChatMessage["status"];
  created_at: string;
}

interface ChatAttachmentRow {
  id: string;
  thread_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  kind: ChatAttachment["kind"];
  text_preview: string | null;
  storage_path: string | null;
  data_base64: string | null;
  created_at: string;
}

export interface StoredChatAttachmentRecord extends ChatAttachment {
  storagePath: string | null;
  dataBase64: string | null;
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
        decided_at TEXT,
        execution_owner TEXT,
        execution_started_at TEXT,
        execution_expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_threads_updated_at
        ON chat_threads (updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        reasoning_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        plan_id TEXT,
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('streaming', 'completed', 'error')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created
        ON chat_messages (thread_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'text', 'file')),
        text_preview TEXT,
        storage_path TEXT,
        data_base64 TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const appCols = this.db
      .prepare("PRAGMA table_info(apps)")
      .all() as Array<{ name: string }>;
    const appColNames = new Set(appCols.map((col) => col.name));
    if (!appColNames.has("cleanup_pending")) {
      this.db.exec(
        "ALTER TABLE apps ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0;",
      );
    }

    try {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_unique_domain ON apps (lower(domain)) WHERE domain IS NOT NULL;",
      );
    } catch {
      // Ignore if legacy rows contain duplicate domains prior to manual cleanup
    }

    const planCols = this.db
      .prepare("PRAGMA table_info(execution_plans)")
      .all() as Array<{ name: string }>;
    const colNames = new Set(planCols.map((col) => col.name));
    if (!colNames.has("execution_owner")) {
      this.db.exec("ALTER TABLE execution_plans ADD COLUMN execution_owner TEXT;");
    }
    if (!colNames.has("execution_started_at")) {
      this.db.exec("ALTER TABLE execution_plans ADD COLUMN execution_started_at TEXT;");
    }
    if (!colNames.has("execution_expires_at")) {
      this.db.exec("ALTER TABLE execution_plans ADD COLUMN execution_expires_at TEXT;");
    }
  }

  /** Inserts or updates an app metadata record in the registry. */
  upsertApp(record: AppRecord): AppRecord {
    const validated = AppRecordSchema.parse(record);
    const safeSlug = validateAppSlug(validated.slug);
    const safeDomain = validated.domain ? validateDomain(validated.domain) : null;

    if (safeDomain) {
      const conflict = this.db
        .prepare("SELECT slug FROM apps WHERE lower(domain) = lower(?) AND slug != ?")
        .get(safeDomain, safeSlug) as { slug: string } | undefined;
      if (conflict) {
        throw new Error(
          `Domain "${safeDomain}" is already assigned to app "${conflict.slug}".`,
        );
      }
    }

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

  /** Marks or clears the cleanup-pending flag on a failed-deploy app record. */
  setAppCleanupPending(slug: string, pending: boolean): boolean {
    const safeSlug = validateAppSlug(slug);
    const stmt = this.db.prepare(
      "UPDATE apps SET cleanup_pending = ? WHERE slug = ?",
    );
    const result = stmt.run(pending ? 1 : 0, safeSlug);
    return result.changes > 0;
  }

  /** Lists slugs whose cleanup failed after an aborted deployment. */
  listCleanupPendingSlugs(): string[] {
    const stmt = this.db.prepare(
      "SELECT slug FROM apps WHERE cleanup_pending = 1",
    );
    const rows = stmt.all() as Array<{ slug: string }>;
    return rows.map((row) => row.slug);
  }

  /** Removes an app metadata record by slug (used for clean teardown or failed-deploy rollback). */
  deleteApp(slug: string): boolean {
    const safeSlug = validateAppSlug(slug);
    const stmt = this.db.prepare("DELETE FROM apps WHERE slug = ?");
    const result = stmt.run(safeSlug);
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

  /**
   * Atomically claims an approved execution plan across processes using a
   * time-bounded lease so concurrent callers (Dashboard, Agent, MCP) cannot
   * double-execute the same plan.
   */
  claimPlanExecution(
    planId: string,
    ownerId: string,
    leaseMs = 300_000,
  ): boolean {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + Math.max(1000, leaseMs)).toISOString();
    const stmt = this.db.prepare(`
      UPDATE execution_plans
      SET execution_owner = ?, execution_started_at = ?, execution_expires_at = ?
      WHERE id = ? AND status = 'approved'
        AND (execution_owner IS NULL OR execution_expires_at IS NULL OR execution_expires_at < ?)
    `);
    const result = stmt.run(ownerId, nowIso, expiresIso, planId, nowIso);
    return result.changes > 0;
  }

  /** Checks whether an approved plan currently holds a valid active lease for `ownerId`. */
  isPlanLeaseHeldBy(planId: string, ownerId: string): boolean {
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT 1 FROM execution_plans
      WHERE id = ? AND status = 'approved'
        AND execution_owner = ? AND execution_expires_at >= ?
    `);
    const row = stmt.get(planId, ownerId, nowIso);
    return row !== undefined;
  }

  /** Releases an in-flight execution lease after a failed or aborted run. */
  releasePlanExecution(planId: string, ownerId: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE execution_plans
      SET execution_owner = NULL, execution_started_at = NULL, execution_expires_at = NULL
      WHERE id = ? AND execution_owner = ? AND status = 'approved'
    `);
    const result = stmt.run(planId, ownerId);
    return result.changes > 0;
  }

  /** Marks an approved plan as executed so it cannot be replayed. */
  markPlanExecuted(planId: string, ownerId?: string): boolean {
    if (ownerId) {
      const nowIso = new Date().toISOString();
      const stmt = this.db.prepare(`
        UPDATE execution_plans
        SET status = 'executed', execution_owner = NULL, execution_started_at = NULL, execution_expires_at = NULL
        WHERE id = ? AND status = 'approved'
          AND execution_owner = ? AND (execution_expires_at IS NULL OR execution_expires_at >= ?)
      `);
      const result = stmt.run(planId, ownerId, nowIso);
      return result.changes > 0;
    }
    const stmt = this.db.prepare(`
      UPDATE execution_plans
      SET status = 'executed', execution_owner = NULL, execution_started_at = NULL, execution_expires_at = NULL
      WHERE id = ? AND status = 'approved'
    `);
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

  /** Reads the persisted onboarding wizard state (returns defaults if uninitialized). */
  getOnboardingState(): OnboardingState {
    const stmt = this.db.prepare(
      "SELECT value_json FROM system_settings WHERE key = 'onboarding_state'",
    );
    const row = stmt.get() as { value_json: string } | undefined;
    if (!row) {
      return createDefaultOnboardingState();
    }
    try {
      return OnboardingStateSchema.parse(JSON.parse(row.value_json));
    } catch {
      return createDefaultOnboardingState();
    }
  }

  /** Merges and persists sanitized onboarding state into SQLite (never stores plaintext secrets). */
  saveOnboardingState(patch: Partial<OnboardingState>): OnboardingState {
    const current = this.getOnboardingState();
    const next = OnboardingStateSchema.parse({
      ...current,
      ...patch,
      persona: {
        ...current.persona,
        ...(patch.persona ?? {}),
      },
      updatedAt: new Date().toISOString(),
    });
    const stmt = this.db.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at)
      VALUES ('onboarding_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(JSON.stringify(next), next.updatedAt);
    return next;
  }

  /** Reads the salted scrypt admin passphrase hash, or null if none is configured. */
  getPassphraseHash(): string | null {
    const stmt = this.db.prepare(
      "SELECT value_json FROM system_settings WHERE key = 'admin_passphrase_hash'",
    );
    const row = stmt.get() as { value_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return typeof parsed === "string" && parsed.startsWith("scrypt:")
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  /** Stores a salted scrypt admin passphrase hash. */
  setPassphraseHash(hash: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at)
      VALUES ('admin_passphrase_hash', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(JSON.stringify(hash), now);
  }

  /** Reads the monotonic session epoch used to invalidate issued session tokens. */
  getSessionEpoch(): number {
    const stmt = this.db.prepare(
      "SELECT value_json FROM system_settings WHERE key = 'session_epoch'",
    );
    const row = stmt.get() as { value_json: string } | undefined;
    if (!row) return 1;
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1
        ? parsed
        : 1;
    } catch {
      return 1;
    }
  }

  /** Increments and returns the session epoch, revoking previously issued session tokens. */
  bumpSessionEpoch(): number {
    const nextEpoch = this.getSessionEpoch() + 1;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at)
      VALUES ('session_epoch', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(JSON.stringify(nextEpoch), now);
    return nextEpoch;
  }

  /** Creates a new agentic chat thread. */
  createChatThread(input: {
    id: string;
    title: string;
    provider?: string | null;
    model?: string | null;
    createdAt?: string;
  }): ChatThread {
    const now = input.createdAt ?? new Date().toISOString();
    const cleanTitle = redactSecrets(input.title.trim() || "New Conversation").slice(0, 160);
    const stmt = this.db.prepare(`
      INSERT INTO chat_threads (id, title, provider, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      input.id,
      cleanTitle,
      input.provider ?? null,
      input.model ?? null,
      now,
      now,
    );
    return ChatThreadSchema.parse({
      id: input.id,
      title: cleanTitle,
      provider: input.provider ?? null,
      model: input.model ?? null,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Lists chat threads ordered by most recently updated. */
  listChatThreads(limit = 50): ChatThread[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    const stmt = this.db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS message_count
      FROM chat_threads t
      ORDER BY t.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(bounded) as unknown as ChatThreadRow[];
    return rows.map((row) => this.mapChatThreadRow(row));
  }

  /** Fetches a single chat thread by ID, or null if missing. */
  getChatThread(threadId: string): ChatThread | null {
    const stmt = this.db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS message_count
      FROM chat_threads t
      WHERE t.id = ?
    `);
    const row = stmt.get(threadId) as ChatThreadRow | undefined;
    return row ? this.mapChatThreadRow(row) : null;
  }

  /** Updates a chat thread's title, provider, model, or updatedAt timestamp. */
  updateChatThread(
    threadId: string,
    patch: {
      title?: string;
      provider?: string | null;
      model?: string | null;
      updatedAt?: string;
    },
  ): ChatThread | null {
    const existing = this.getChatThread(threadId);
    if (!existing) return null;
    const nextTitle =
      patch.title !== undefined
        ? redactSecrets(patch.title.trim() || existing.title).slice(0, 160)
        : existing.title;
    const nextProvider =
      patch.provider !== undefined ? patch.provider : existing.provider;
    const nextModel = patch.model !== undefined ? patch.model : existing.model;
    const updatedAt = patch.updatedAt ?? new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE chat_threads
      SET title = ?, provider = ?, model = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(nextTitle, nextProvider, nextModel, updatedAt, threadId);
    return this.getChatThread(threadId);
  }

  /** Deletes a chat thread and cascades to its messages. */
  deleteChatThread(threadId: string): boolean {
    const stmt = this.db.prepare("DELETE FROM chat_threads WHERE id = ?");
    const result = stmt.run(threadId);
    return result.changes > 0;
  }

  /** Appends a secret-redacted chat message to a thread and bumps thread updated_at. */
  appendChatMessage(message: ChatMessage): ChatMessage {
    const sanitized = this.sanitizeChatMessage(message);
    const stmt = this.db.prepare(`
      INSERT INTO chat_messages (
        id, thread_id, role, content, attachments_json, reasoning_json,
        tool_calls_json, plan_id, provider, model, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sanitized.id,
      sanitized.threadId,
      sanitized.role,
      sanitized.content,
      JSON.stringify(sanitized.attachments),
      JSON.stringify(sanitized.reasoning),
      JSON.stringify(sanitized.toolCalls),
      sanitized.planId,
      sanitized.provider,
      sanitized.model,
      sanitized.status,
      sanitized.createdAt,
    );
    this.db
      .prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?")
      .run(sanitized.createdAt, sanitized.threadId);
    return sanitized;
  }

  /** Updates an existing chat message (used as streaming turns finish or plans update). */
  updateChatMessage(message: ChatMessage): ChatMessage {
    const sanitized = this.sanitizeChatMessage(message);
    const stmt = this.db.prepare(`
      UPDATE chat_messages
      SET content = ?, attachments_json = ?, reasoning_json = ?, tool_calls_json = ?,
          plan_id = ?, provider = ?, model = ?, status = ?
      WHERE id = ? AND thread_id = ?
    `);
    stmt.run(
      sanitized.content,
      JSON.stringify(sanitized.attachments),
      JSON.stringify(sanitized.reasoning),
      JSON.stringify(sanitized.toolCalls),
      sanitized.planId,
      sanitized.provider,
      sanitized.model,
      sanitized.status,
      sanitized.id,
      sanitized.threadId,
    );
    this.db
      .prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), sanitized.threadId);
    return sanitized;
  }

  /** Lists all messages in a thread ordered chronologically. */
  listChatMessages(threadId: string, limit = 200): ChatMessage[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    const stmt = this.db.prepare(`
      SELECT * FROM chat_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `);
    const rows = stmt.all(threadId, bounded) as unknown as ChatMessageRow[];
    return rows.map((row) => this.mapChatMessageRow(row));
  }

  /** Persists uploaded attachment metadata (and redacted text preview / storage pointer). */
  saveChatAttachment(record: {
    id: string;
    threadId?: string | null;
    name: string;
    mimeType: string;
    sizeBytes: number;
    kind: ChatAttachment["kind"];
    textPreview?: string | null;
    storagePath?: string | null;
    dataBase64?: string | null;
    createdAt?: string;
  }): StoredChatAttachmentRecord {
    const createdAt = record.createdAt ?? new Date().toISOString();
    const safePreview = record.textPreview
      ? redactSecrets(record.textPreview).slice(0, 16_000)
      : null;
    const stmt = this.db.prepare(`
      INSERT INTO chat_attachments (
        id, thread_id, name, mime_type, size_bytes, kind,
        text_preview, storage_path, data_base64, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.threadId ?? null,
      record.name,
      record.mimeType,
      record.sizeBytes,
      record.kind,
      safePreview,
      record.storagePath ?? null,
      record.dataBase64 ?? null,
      createdAt,
    );
    return {
      ...ChatAttachmentSchema.parse({
        id: record.id,
        threadId: record.threadId ?? null,
        name: record.name,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        kind: record.kind,
        textPreview: safePreview,
        url: `/api/chat/attachments/${record.id}`,
        createdAt,
      }),
      storagePath: record.storagePath ?? null,
      dataBase64: record.dataBase64 ?? null,
    };
  }

  /** Fetches a stored chat attachment record including storage path/payload. */
  getChatAttachment(attachmentId: string): StoredChatAttachmentRecord | null {
    const stmt = this.db.prepare("SELECT * FROM chat_attachments WHERE id = ?");
    const row = stmt.get(attachmentId) as ChatAttachmentRow | undefined;
    return row ? this.mapChatAttachmentRow(row) : null;
  }

  /** Fetches multiple attachments by ID, optionally attaching them to a thread. */
  getChatAttachmentsByIds(
    attachmentIds: string[],
    bindThreadId?: string,
  ): StoredChatAttachmentRecord[] {
    const results: StoredChatAttachmentRecord[] = [];
    for (const id of attachmentIds) {
      const record = this.getChatAttachment(id);
      if (!record) continue;
      if (bindThreadId && record.threadId === null) {
        this.db
          .prepare("UPDATE chat_attachments SET thread_id = ? WHERE id = ?")
          .run(bindThreadId, id);
        record.threadId = bindThreadId;
      }
      results.push(record);
    }
    return results;
  }

  close(): void {
    this.db.close();
  }

  private sanitizeChatMessage(message: ChatMessage): ChatMessage {
    const validated = ChatMessageSchema.parse(message);
    return {
      ...validated,
      content: redactSecrets(validated.content),
      reasoning: validated.reasoning.map((block) => ({
        ...block,
        title: redactSecrets(block.title),
        content: redactSecrets(block.content),
      })),
      toolCalls: validated.toolCalls.map((call) => ({
        ...call,
        label: redactSecrets(call.label),
        error: call.error ? redactSecrets(call.error) : null,
      })),
    };
  }

  private mapChatThreadRow(row: ChatThreadRow): ChatThread {
    return {
      id: row.id,
      title: row.title,
      provider: row.provider,
      model: row.model,
      messageCount: Number(row.message_count ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapChatMessageRow(row: ChatMessageRow): ChatMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      content: row.content,
      attachments: JSON.parse(row.attachments_json) as ChatAttachment[],
      reasoning: JSON.parse(row.reasoning_json) as ChatReasoningBlock[],
      toolCalls: JSON.parse(row.tool_calls_json) as ChatToolCall[],
      planId: row.plan_id,
      provider: row.provider,
      model: row.model,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private mapChatAttachmentRow(row: ChatAttachmentRow): StoredChatAttachmentRecord {
    return {
      id: row.id,
      threadId: row.thread_id,
      name: row.name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      kind: row.kind,
      textPreview: row.text_preview,
      url: `/api/chat/attachments/${row.id}`,
      createdAt: row.created_at,
      storagePath: row.storage_path,
      dataBase64: row.data_base64,
    };
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
