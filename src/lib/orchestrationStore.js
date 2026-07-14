import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

const runStatuses = new Set(["draft", "queued", "running", "paused", "attention", "integrating", "completed", "failed", "cancelled"]);
const itemStatuses = new Set(["queued", "blocked", "preparing", "implementing", "verifying", "ready", "integrating", "completed", "attention", "failed", "cancelled"]);
const attemptKinds = new Set(["implement", "verify", "repair", "integrate", "aggregate-verify"]);
const attemptStatuses = new Set(["queued", "leased", "running", "succeeded", "failed", "cancelled", "reconciling"]);
const artifactKinds = new Set(["git-summary", "validation", "open-spec-validation", "verifier", "conflict", "integration-result"]);
const activeRunStatuses = ["queued", "running", "paused", "attention", "integrating"];
const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);
const maxItemsPerRun = 50;
const maxArtifactSummaryLength = 8_000;
const maxArtifactDataLength = 32_000;
const maxErrorLength = 1_200;
const maxRepairAttempts = 4;
const transientFailureClasses = new Set(["agent-failed", "lease-expired"]);

export class OrchestrationStore {
  constructor(options = {}) {
    const dbPath = path.resolve(options.dbPath || path.join(config.dataDir, "echo.sqlite"));
    this.db = options.db || new Database(dbPath);
    this.ownsDb = !options.db;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close() {
    if (this.ownsDb) this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_runs (
        id TEXT PRIMARY KEY,
        owner_user TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        base_branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'running', 'paused', 'attention', 'integrating', 'completed', 'failed', 'cancelled')),
        desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'paused', 'cancelled')),
        runtime_policy_json TEXT NOT NULL DEFAULT '{}',
        integration_policy TEXT NOT NULL DEFAULT 'isolated-branch',
        result_json TEXT NOT NULL DEFAULT '{}',
        error_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        cancelled_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_owner_agent_updated
        ON orchestration_runs(owner_user, target_agent_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_agent_status
        ON orchestration_runs(target_agent_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS orchestration_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
        change_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        snapshot_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'blocked', 'preparing', 'implementing', 'verifying', 'ready', 'integrating', 'completed', 'attention', 'failed', 'cancelled')),
        current_attempt_id TEXT,
        final_commit TEXT NOT NULL DEFAULT '',
        verifier_conclusion TEXT NOT NULL DEFAULT '',
        error_summary TEXT NOT NULL DEFAULT '',
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        claimed_by TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, change_id),
        UNIQUE(run_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_items_run_position
        ON orchestration_items(run_id, position);
      CREATE INDEX IF NOT EXISTS idx_orchestration_items_claim
        ON orchestration_items(status, next_retry_at, lease_expires_at);

      CREATE TABLE IF NOT EXISTS orchestration_dependencies (
        run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES orchestration_items(id) ON DELETE CASCADE,
        depends_on_item_id TEXT NOT NULL REFERENCES orchestration_items(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(item_id, depends_on_item_id),
        CHECK(item_id <> depends_on_item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_dependencies_run
        ON orchestration_dependencies(run_id, item_id);

      CREATE TABLE IF NOT EXISTS orchestration_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
        item_id TEXT REFERENCES orchestration_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('implement', 'verify', 'repair', 'integrate', 'aggregate-verify')),
        attempt_number INTEGER NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'reconciling')),
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT,
        failure_class TEXT NOT NULL DEFAULT '',
        error_summary TEXT NOT NULL DEFAULT '',
        next_retry_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(item_id, kind, attempt_number)
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_attempts_run_status
        ON orchestration_attempts(run_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_orchestration_attempts_lease
        ON orchestration_attempts(status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS orchestration_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
        item_id TEXT REFERENCES orchestration_items(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES orchestration_attempts(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('git-summary', 'validation', 'open-spec-validation', 'verifier', 'conflict', 'integration-result')),
        status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'info')),
        summary TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_artifacts_run_item
        ON orchestration_artifacts(run_id, item_id, created_at);
    `);
  }

  createRun(input = {}) {
    const normalized = normalizeRunInput(input);
    const now = nowIso();
    const runId = normalized.id || crypto.randomUUID();
    const itemIds = new Map(normalized.items.map((item) => [item.changeId, crypto.randomUUID()]));
    assertAcyclic(normalized.items);

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO orchestration_runs (
          id, owner_user, target_agent_id, project_id, title, base_branch, base_commit,
          status, desired_state, runtime_policy_json, integration_policy, created_at, updated_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'running', ?, 'isolated-branch', ?, ?, ?)
      `).run(
        runId,
        normalized.ownerUser,
        normalized.targetAgentId,
        normalized.projectId,
        normalized.title,
        normalized.baseBranch,
        normalized.baseCommit,
        JSON.stringify(normalized.runtimePolicy),
        now,
        now,
        now
      );
      const insertItem = this.db.prepare(`
        INSERT INTO orchestration_items (
          id, run_id, change_id, title, position, snapshot_json, snapshot_fingerprint,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      normalized.items.forEach((item, position) => {
        insertItem.run(
          itemIds.get(item.changeId),
          runId,
          item.changeId,
          item.title,
          position,
          JSON.stringify(item.snapshot),
          item.fingerprint,
          item.dependsOn.length ? "blocked" : "queued",
          now,
          now
        );
      });
      const insertDependency = this.db.prepare(`
        INSERT INTO orchestration_dependencies (run_id, item_id, depends_on_item_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const item of normalized.items) {
        for (const dependency of item.dependsOn) {
          insertDependency.run(runId, itemIds.get(item.changeId), itemIds.get(dependency), now);
        }
      }
    })();
    return this.getRun(runId, { ownerUser: normalized.ownerUser });
  }

  getRun(id, options = {}) {
    const run = this.db.prepare("SELECT * FROM orchestration_runs WHERE id = ?").get(normalizeId(id));
    if (!run || (options.ownerUser && run.owner_user !== normalizeOwner(options.ownerUser))) return null;
    const items = this.db.prepare("SELECT * FROM orchestration_items WHERE run_id = ? ORDER BY position").all(run.id);
    const dependencies = this.db.prepare(`
      SELECT d.item_id AS itemId, dependency.change_id AS dependsOn
      FROM orchestration_dependencies d
      JOIN orchestration_items dependency ON dependency.id = d.depends_on_item_id
      WHERE d.run_id = ? ORDER BY dependency.position
    `).all(run.id);
    const dependsOnByItem = new Map();
    for (const dependency of dependencies) {
      const values = dependsOnByItem.get(dependency.itemId) || [];
      values.push(dependency.dependsOn);
      dependsOnByItem.set(dependency.itemId, values);
    }
    const attempts = this.db.prepare("SELECT * FROM orchestration_attempts WHERE run_id = ? ORDER BY created_at, attempt_number").all(run.id);
    const artifacts = this.db.prepare("SELECT * FROM orchestration_artifacts WHERE run_id = ? ORDER BY created_at, id").all(run.id);
    return summarizeRun(run, items, attempts, artifacts, dependsOnByItem);
  }

  listRuns(options = {}) {
    const ownerUser = normalizeOwner(options.ownerUser);
    if (!ownerUser) throw badRequest("User is required.");
    const targetAgentId = bounded(options.targetAgentId, 160);
    const projectId = bounded(options.projectId, 160);
    const clauses = ["owner_user = ?"];
    const params = [ownerUser];
    if (targetAgentId) { clauses.push("target_agent_id = ?"); params.push(targetAgentId); }
    if (projectId) { clauses.push("project_id = ?"); params.push(projectId); }
    if (options.activeOnly) {
      clauses.push(`status IN (${activeRunStatuses.map(() => "?").join(", ")})`);
      params.push(...activeRunStatuses);
    }
    const limit = clampInt(options.limit, 1, 100, 30);
    const rows = this.db.prepare(`
      SELECT id FROM orchestration_runs WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => this.getRun(row.id, { ownerUser }));
  }

  hasActiveRuns(targetAgentId) {
    const placeholders = activeRunStatuses.map(() => "?").join(", ");
    return Boolean(this.db.prepare(`
      SELECT 1 FROM orchestration_runs WHERE target_agent_id = ? AND status IN (${placeholders}) LIMIT 1
    `).get(bounded(targetAgentId, 160), ...activeRunStatuses));
  }

  reconcileRunStatuses() {
    const now = nowIso();
    const rows = this.db.prepare(`
      SELECT run.id FROM orchestration_runs run
      WHERE run.desired_state = 'running' AND run.status IN ('queued', 'running')
        AND EXISTS (
          SELECT 1 FROM orchestration_items item
          WHERE item.run_id = run.id AND item.status IN ('attention', 'failed')
        )
      ORDER BY run.created_at
    `).all();
    if (!rows.length) return [];
    const update = this.db.prepare("UPDATE orchestration_runs SET status = 'attention', updated_at = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const row of rows) update.run(now, row.id);
    })();
    return rows.map((row) => row.id);
  }

  controlRun(id, action, options = {}) {
    const runId = normalizeId(id);
    const ownerUser = normalizeOwner(options.ownerUser);
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!new Set(["pause", "resume", "cancel", "finish"]).has(normalizedAction)) throw badRequest("Unsupported orchestration action.");
    const now = nowIso();
    this.db.transaction(() => {
      const run = this.db.prepare("SELECT * FROM orchestration_runs WHERE id = ?").get(runId);
      assertRunOwner(run, ownerUser);
      if (terminalRunStatuses.has(run.status)) {
        if (normalizedAction === "cancel" && run.status === "cancelled") return;
        if (normalizedAction === "finish" && run.status === "failed") return;
        throw conflict("Orchestration Run is already terminal.");
      }
      if (normalizedAction === "pause") {
        this.db.prepare(`UPDATE orchestration_runs SET desired_state = 'paused', status = 'paused', updated_at = ? WHERE id = ?`).run(now, runId);
      } else if (normalizedAction === "resume") {
        const nextStatus = resumedRunStatus(this.db, runId);
        this.db.prepare(`UPDATE orchestration_runs SET desired_state = 'running', status = ?,
          error_summary = CASE WHEN ? = 'attention' THEN error_summary ELSE '' END, updated_at = ? WHERE id = ?`)
          .run(nextStatus, nextStatus, now, runId);
      } else if (normalizedAction === "cancel") {
        this.db.prepare(`
          UPDATE orchestration_runs SET desired_state = 'cancelled', status = 'cancelled', cancelled_at = ?, completed_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, now, runId);
        this.db.prepare(`
          UPDATE orchestration_items SET status = 'cancelled', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE run_id = ? AND status NOT IN ('completed', 'cancelled')
        `).run(now, runId);
        this.db.prepare(`
          UPDATE orchestration_attempts SET status = 'cancelled', completed_at = ?, lease_owner = '', lease_expires_at = NULL, updated_at = ?
          WHERE run_id = ? AND status IN ('queued', 'leased', 'running', 'reconciling')
        `).run(now, now, runId);
      } else {
        this.db.prepare(`
          UPDATE orchestration_runs SET desired_state = 'cancelled', status = 'failed',
            error_summary = CASE WHEN error_summary = '' THEN 'Run ended after recovery could not converge.' ELSE error_summary END,
            completed_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, runId);
        this.db.prepare(`
          UPDATE orchestration_items SET status = 'cancelled', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE run_id = ? AND status IN ('queued', 'blocked', 'preparing', 'implementing', 'verifying', 'integrating')
        `).run(now, runId);
        this.db.prepare(`
          UPDATE orchestration_attempts SET status = 'cancelled', completed_at = ?, lease_owner = '',
            lease_expires_at = NULL, updated_at = ?
          WHERE run_id = ? AND status IN ('queued', 'leased', 'running', 'reconciling')
        `).run(now, now, runId);
      }
    })();
    return this.getRun(runId, { ownerUser });
  }

  retryItem(runId, itemId, options = {}) {
    const ownerUser = normalizeOwner(options.ownerUser);
    const now = nowIso();
    this.db.transaction(() => {
      const run = this.db.prepare("SELECT * FROM orchestration_runs WHERE id = ?").get(normalizeId(runId));
      assertRunOwner(run, ownerUser);
      if (run.desired_state !== "running") throw conflict("Resume the orchestration Run before retrying an Item.");
      const item = this.db.prepare("SELECT * FROM orchestration_items WHERE id = ? AND run_id = ?").get(normalizeId(itemId), run.id);
      if (!item) throw notFound("Orchestration Item not found.");
      if (!new Set(["attention", "failed"]).has(item.status)) throw conflict("Only an attention or failed Item can be retried.");
      const latestAttempt = this.db.prepare(`
        SELECT failure_class FROM orchestration_attempts WHERE item_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(item.id);
      if (!transientFailureClasses.has(latestAttempt?.failure_class)) {
        throw conflict("This orchestration failure needs Agent recovery instead of retrying the same Attempt.");
      }
      const repairCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM orchestration_attempts WHERE item_id = ? AND kind = 'repair'
      `).get(item.id).count;
      if (repairCount >= maxRepairAttempts) throw conflict("This Item has reached its bounded retry limit.");
      this.db.prepare(`
        UPDATE orchestration_attempts SET status = 'cancelled', completed_at = ?, lease_owner = '',
          lease_expires_at = NULL, updated_at = ?
        WHERE item_id = ? AND status IN ('queued', 'leased', 'running', 'reconciling')
      `).run(now, now, item.id);
      this.db.prepare(`
        UPDATE orchestration_items SET status = 'queued', error_summary = '', next_retry_at = NULL,
          retry_count = CASE WHEN retry_count < 1 THEN 1 ELSE retry_count END,
          current_attempt_id = NULL, claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(now, item.id);
      this.db.prepare("UPDATE orchestration_runs SET status = 'running', error_summary = '', updated_at = ? WHERE id = ?").run(now, run.id);
    })();
    return this.getRun(runId, { ownerUser });
  }

  recoverItem(runId, itemId, options = {}) {
    const ownerUser = normalizeOwner(options.ownerUser);
    const now = nowIso();
    this.db.transaction(() => {
      const run = this.db.prepare("SELECT * FROM orchestration_runs WHERE id = ?").get(normalizeId(runId));
      assertRunOwner(run, ownerUser);
      if (run.desired_state !== "running") throw conflict("Resume the orchestration Run before asking Echo to recover an Item.");
      const item = this.db.prepare("SELECT * FROM orchestration_items WHERE id = ? AND run_id = ?").get(normalizeId(itemId), run.id);
      if (!item) throw notFound("Orchestration Item not found.");
      if (!new Set(["attention", "failed"]).has(item.status)) throw conflict("Only an attention or failed Item can be recovered.");
      const repairCount = this.db.prepare(`
        SELECT COUNT(*) AS count FROM orchestration_attempts WHERE item_id = ? AND kind = 'repair'
      `).get(item.id).count;
      if (repairCount >= maxRepairAttempts) throw conflict("This Item has reached its bounded Agent recovery limit.");
      this.db.prepare(`
        UPDATE orchestration_attempts SET status = 'cancelled', completed_at = ?, lease_owner = '',
          lease_expires_at = NULL, updated_at = ?
        WHERE item_id = ? AND status IN ('queued', 'leased', 'running', 'reconciling')
      `).run(now, now, item.id);
      this.db.prepare(`
        UPDATE orchestration_items SET status = 'queued', next_retry_at = NULL,
          retry_count = CASE WHEN retry_count < 1 THEN 1 ELSE retry_count END,
          current_attempt_id = NULL, claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(now, item.id);
      this.db.prepare("UPDATE orchestration_runs SET status = 'running', updated_at = ? WHERE id = ?").run(now, run.id);
    })();
    return this.getRun(runId, { ownerUser });
  }

  claimNextItem(input = {}) {
    const targetAgentId = bounded(input.targetAgentId, 160);
    const leaseOwner = bounded(input.leaseOwner, 160);
    if (!targetAgentId || !leaseOwner) throw badRequest("Desktop agent and lease owner are required.");
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + clampInt(input.leaseMs, 10_000, 300_000, 60_000)).toISOString();
    return this.db.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT item.*, run.runtime_policy_json, run.desired_state, run.status AS run_status
        FROM orchestration_items item
        JOIN orchestration_runs run ON run.id = item.run_id
        WHERE run.target_agent_id = ?
          AND run.desired_state = 'running'
          AND run.status IN ('queued', 'running')
          AND item.status IN ('queued', 'blocked')
          AND (item.next_retry_at IS NULL OR item.next_retry_at <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_dependencies dependency
            JOIN orchestration_items prerequisite ON prerequisite.id = dependency.depends_on_item_id
            WHERE dependency.item_id = item.id AND prerequisite.status NOT IN ('ready', 'completed')
          )
        ORDER BY run.created_at, item.position
      `).all(targetAgentId, now);
      for (const candidate of candidates) {
        const runtimePolicy = parseJson(candidate.runtime_policy_json, {});
        const maxConcurrency = clampInt(runtimePolicy.maxConcurrency, 1, 8, 2);
        const activeCount = this.db.prepare(`
          SELECT COUNT(*) AS count FROM orchestration_items
          WHERE run_id = ? AND status IN ('preparing', 'implementing', 'verifying')
        `).get(candidate.run_id).count;
        if (activeCount >= maxConcurrency) continue;
        const attemptKind = Number(candidate.retry_count || 0) > 0 ? "repair" : "implement";
        const attemptNumber = this.db.prepare(`
          SELECT COALESCE(MAX(attempt_number), 0) + 1 AS value FROM orchestration_attempts
          WHERE item_id = ? AND kind = ?
        `).get(candidate.id, attemptKind).value;
        const attemptId = crypto.randomUUID();
        const changed = this.db.prepare(`
          UPDATE orchestration_items SET status = 'preparing', current_attempt_id = ?, claimed_by = ?,
            lease_expires_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'blocked')
        `).run(attemptId, leaseOwner, leaseExpiresAt, now, candidate.id).changes;
        if (!changed) continue;
        this.db.prepare(`
          INSERT INTO orchestration_attempts (
            id, run_id, item_id, kind, attempt_number, status, lease_owner, lease_expires_at,
            created_at, started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'leased', ?, ?, ?, ?, ?)
        `).run(attemptId, candidate.run_id, candidate.id, attemptKind, attemptNumber, leaseOwner, leaseExpiresAt, now, now, now);
        this.db.prepare("UPDATE orchestration_runs SET status = 'running', updated_at = ? WHERE id = ?").run(now, candidate.run_id);
        return this.getAttempt(attemptId);
      }
      return null;
    })();
  }

  bindAttemptSession(attemptId, input = {}) {
    const attempt = this.db.prepare("SELECT * FROM orchestration_attempts WHERE id = ?").get(normalizeId(attemptId));
    if (!attempt) throw notFound("Orchestration Attempt not found.");
    if (attempt.lease_owner !== bounded(input.leaseOwner, 160)) throw conflict("Attempt lease owner does not match.");
    const sessionId = bounded(input.sessionId, 160);
    if (!sessionId) throw badRequest("Attempt Session is required.");
    if (attempt.session_id && attempt.session_id !== sessionId) throw conflict("Attempt is already bound to another Session.");
    const now = nowIso();
    this.db.prepare(`UPDATE orchestration_attempts SET session_id = ?, status = 'running', updated_at = ? WHERE id = ?`)
      .run(sessionId, now, attempt.id);
    if (attempt.item_id) this.db.prepare(`UPDATE orchestration_items SET status = 'implementing', updated_at = ? WHERE id = ?`).run(now, attempt.item_id);
    return this.getAttempt(attempt.id);
  }

  claimReconciliation(input = {}) {
    const targetAgentId = bounded(input.targetAgentId, 160);
    const leaseOwner = bounded(input.leaseOwner, 160);
    if (!targetAgentId || !leaseOwner) throw badRequest("Desktop agent and lease owner are required.");
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + clampInt(input.leaseMs, 10_000, 300_000, 60_000)).toISOString();
    return this.db.transaction(() => {
      const candidate = this.db.prepare(`
        SELECT attempt.* FROM orchestration_attempts attempt
        JOIN orchestration_runs run ON run.id = attempt.run_id
        WHERE run.target_agent_id = ? AND run.desired_state = 'running'
          AND run.status IN ('queued', 'running', 'integrating') AND attempt.status = 'reconciling'
        ORDER BY attempt.updated_at, attempt.created_at LIMIT 1
      `).get(targetAgentId);
      if (!candidate) return null;
      const changed = this.db.prepare(`
        UPDATE orchestration_attempts SET status = 'running', lease_owner = ?, lease_expires_at = ?,
          failure_class = '', error_summary = '', updated_at = ? WHERE id = ? AND status = 'reconciling'
      `).run(leaseOwner, leaseExpiresAt, now, candidate.id).changes;
      if (!changed) return null;
      if (candidate.item_id) this.db.prepare(`
        UPDATE orchestration_items SET status = ?, claimed_by = ?, lease_expires_at = ?,
          error_summary = '', updated_at = ? WHERE id = ?
      `).run(candidate.session_id ? "implementing" : "preparing", leaseOwner, leaseExpiresAt, now, candidate.item_id);
      this.db.prepare("UPDATE orchestration_runs SET status = ?, error_summary = '', updated_at = ? WHERE id = ?")
        .run(candidate.kind === "integrate" ? "integrating" : "running", now, candidate.run_id);
      return this.getAttempt(candidate.id);
    })();
  }

  claimIntegration(input = {}) {
    const targetAgentId = bounded(input.targetAgentId, 160);
    const leaseOwner = bounded(input.leaseOwner, 160);
    if (!targetAgentId || !leaseOwner) throw badRequest("Desktop agent and lease owner are required.");
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + clampInt(input.leaseMs, 10_000, 300_000, 60_000)).toISOString();
    return this.db.transaction(() => {
      const run = this.db.prepare(`
        SELECT * FROM orchestration_runs run
        WHERE target_agent_id = ? AND desired_state = 'running' AND status IN ('running', 'queued')
          AND EXISTS (SELECT 1 FROM orchestration_items item WHERE item.run_id = run.id)
          AND EXISTS (SELECT 1 FROM orchestration_items item WHERE item.run_id = run.id AND item.status = 'ready')
          AND NOT EXISTS (SELECT 1 FROM orchestration_items item WHERE item.run_id = run.id AND item.status NOT IN ('ready', 'completed'))
          AND NOT EXISTS (SELECT 1 FROM orchestration_attempts attempt WHERE attempt.run_id = run.id AND attempt.kind IN ('integrate', 'aggregate-verify') AND attempt.status IN ('queued', 'leased', 'running', 'succeeded'))
        ORDER BY created_at LIMIT 1
      `).get(targetAgentId);
      if (!run) return null;
      const attemptId = crypto.randomUUID();
      const changed = this.db.prepare(`UPDATE orchestration_runs SET status = 'integrating', updated_at = ? WHERE id = ? AND status IN ('running', 'queued')`)
        .run(now, run.id).changes;
      if (!changed) return null;
      const attemptNumber = this.db.prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS value FROM orchestration_attempts WHERE run_id = ? AND kind = 'integrate'`).get(run.id).value;
      this.db.prepare(`
        INSERT INTO orchestration_attempts (
          id, run_id, item_id, kind, attempt_number, status, lease_owner, lease_expires_at, created_at, started_at, updated_at
        ) VALUES (?, ?, NULL, 'integrate', ?, 'leased', ?, ?, ?, ?, ?)
      `).run(attemptId, run.id, attemptNumber, leaseOwner, leaseExpiresAt, now, now, now);
      return this.getAttempt(attemptId);
    })();
  }

  completeIntegration(attemptId, input = {}) {
    const now = nowIso();
    const id = normalizeId(attemptId);
    return this.db.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM orchestration_attempts WHERE id = ? AND kind = 'integrate'").get(id);
      if (!attempt) throw notFound("Integration Attempt not found.");
      if (attempt.lease_owner !== bounded(input.leaseOwner, 160)) throw conflict("Attempt lease owner does not match.");
      const desiredState = this.db.prepare("SELECT desired_state FROM orchestration_runs WHERE id = ?").get(attempt.run_id)?.desired_state;
      if (desiredState === "cancelled") throw conflict("Cancelled orchestration Run cannot complete integration.");
      if (attempt.status === "succeeded") return this.getRun(attempt.run_id);
      const ok = input.ok === true;
      const errorSummary = bounded(input.errorSummary, maxErrorLength);
      this.db.prepare(`
        UPDATE orchestration_attempts SET status = ?, failure_class = ?, error_summary = ?, lease_owner = '',
          lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?
      `).run(ok ? "succeeded" : "failed", ok ? "" : bounded(input.failureClass || "integration-failed", 80), errorSummary, now, now, id);
      if (ok) {
        const result = {
          branch: bounded(input.branch, 240),
          commit: normalizeCommit(input.commit),
          validationSummary: bounded(input.validationSummary, maxArtifactSummaryLength)
        };
        if (!result.branch || !result.commit) throw badRequest("Integration branch and commit are required.");
        this.db.prepare(`UPDATE orchestration_items SET status = 'completed', updated_at = ? WHERE run_id = ? AND status = 'ready'`).run(now, attempt.run_id);
        this.db.prepare(`
          UPDATE orchestration_runs SET status = 'completed', result_json = ?, error_summary = '', completed_at = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(result), now, now, attempt.run_id);
      } else {
        this.db.prepare(`UPDATE orchestration_runs SET status = 'attention', error_summary = ?, updated_at = ? WHERE id = ?`)
          .run(errorSummary || "Integration needs attention.", now, attempt.run_id);
      }
      return this.getRun(attempt.run_id);
    })();
  }

  reconcileBaseline(attemptId, input = {}) {
    const now = nowIso();
    const id = normalizeId(attemptId);
    const leaseOwner = bounded(input.leaseOwner, 160);
    const completedChangeIds = [...new Set((input.completedChangeIds || []).map((value) => bounded(value, 160)).filter(Boolean))];
    const branch = bounded(input.branch, 240);
    const commit = normalizeCommit(input.commit);
    const unavailable = input.unavailable === true;
    if (completedChangeIds.length && (!branch || !commit)) throw badRequest("Baseline branch and commit are required for reconciliation.");

    return this.db.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM orchestration_attempts WHERE id = ?").get(id);
      if (!attempt) throw notFound("Orchestration Attempt not found.");
      if (attempt.lease_owner !== leaseOwner) throw conflict("Attempt lease owner does not match.");

      if (completedChangeIds.length) {
        const placeholders = completedChangeIds.map(() => "?").join(", ");
        const itemIds = this.db.prepare(`
          SELECT id FROM orchestration_items WHERE run_id = ? AND change_id IN (${placeholders})
        `).all(attempt.run_id, ...completedChangeIds).map((item) => item.id);
        if (itemIds.length) {
          const itemPlaceholders = itemIds.map(() => "?").join(", ");
          this.db.prepare(`
            UPDATE orchestration_attempts SET status = 'succeeded', failure_class = '', error_summary = '',
              lease_owner = '', lease_expires_at = NULL, completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE item_id IN (${itemPlaceholders}) AND status IN ('queued', 'leased', 'running', 'reconciling')
          `).run(now, now, ...itemIds);
          this.db.prepare(`
            UPDATE orchestration_items SET status = 'completed', error_summary = '', next_retry_at = NULL,
              claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE id IN (${itemPlaceholders})
          `).run(now, ...itemIds);
        }
      }

      if (unavailable) {
        const errorSummary = bounded(input.errorSummary || "The managed orchestration Worktree is unavailable.", maxErrorLength);
        this.db.prepare(`
          UPDATE orchestration_attempts SET status = 'failed', failure_class = 'worktree-unavailable', error_summary = ?,
            lease_owner = '', lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?
        `).run(errorSummary, now, now, id);
        if (attempt.item_id) this.db.prepare(`
          UPDATE orchestration_items SET status = 'attention', error_summary = ?, claimed_by = NULL,
            lease_expires_at = NULL, next_retry_at = NULL, updated_at = ? WHERE id = ?
        `).run(errorSummary, now, attempt.item_id);
        this.db.prepare("UPDATE orchestration_runs SET status = 'attention', error_summary = ?, updated_at = ? WHERE id = ?")
          .run(errorSummary, now, attempt.run_id);
        return this.getRun(attempt.run_id);
      }

      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM orchestration_items WHERE run_id = ? AND status <> 'completed'")
        .get(attempt.run_id).count;
      if (remaining === 0) {
        this.db.prepare(`
          UPDATE orchestration_attempts SET status = 'succeeded', failure_class = '', error_summary = '',
            lease_owner = '', lease_expires_at = NULL, completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE id = ? AND status IN ('queued', 'leased', 'running', 'reconciling')
        `).run(now, now, id);
        const result = { branch, commit, validationSummary: "Reconciled against the Desktop base Workspace." };
        this.db.prepare(`
          UPDATE orchestration_runs SET status = 'completed', result_json = ?, error_summary = '',
            completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?
        `).run(JSON.stringify(result), now, now, attempt.run_id);
      } else {
        this.db.prepare("UPDATE orchestration_runs SET status = 'running', error_summary = '', updated_at = ? WHERE id = ?")
          .run(now, attempt.run_id);
      }
      return this.getRun(attempt.run_id);
    })();
  }

  renewAttemptLease(attemptId, input = {}) {
    const leaseOwner = bounded(input.leaseOwner, 160);
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + clampInt(input.leaseMs, 10_000, 300_000, 60_000)).toISOString();
    const changed = this.db.prepare(`
      UPDATE orchestration_attempts SET lease_expires_at = ?, status = 'running', updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running')
    `).run(leaseExpiresAt, now, normalizeId(attemptId), leaseOwner).changes;
    if (!changed) return null;
    const attempt = this.getAttempt(attemptId);
    this.db.prepare(`
      UPDATE orchestration_items SET status = 'implementing', lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND current_attempt_id = ?
    `).run(leaseExpiresAt, now, attempt.itemId, attempt.id);
    return this.getAttempt(attemptId);
  }

  reconcileExpiredLeases(options = {}) {
    const now = options.now || nowIso();
    return this.db.transaction(() => {
      const expired = this.db.prepare(`
        SELECT * FROM orchestration_attempts
        WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
      `).all(now);
      for (const attempt of expired) {
        this.db.prepare(`
          UPDATE orchestration_attempts SET status = 'reconciling', failure_class = 'lease-expired',
            error_summary = 'Desktop lease expired; reclaiming the same local execution.',
            lease_owner = '', lease_expires_at = NULL, updated_at = ? WHERE id = ?
        `).run(now, attempt.id);
        if (attempt.item_id) this.db.prepare(`
          UPDATE orchestration_items SET status = 'preparing', claimed_by = NULL, lease_expires_at = NULL,
            error_summary = 'Desktop 连接中断，正在自动恢复', updated_at = ? WHERE id = ?
        `).run(now, attempt.item_id);
        this.db.prepare(`UPDATE orchestration_runs SET status = ?, error_summary = '', updated_at = ? WHERE id = ?`)
          .run(attempt.kind === "integrate" ? "integrating" : "running", now, attempt.run_id);
      }
      return expired.length;
    })();
  }

  completeAttempt(attemptId, input = {}) {
    const normalizedStatus = normalizeEnum(input.status, attemptStatuses, "Attempt status");
    if (!new Set(["succeeded", "failed", "cancelled"]).has(normalizedStatus)) throw badRequest("Attempt completion status is invalid.");
    const now = nowIso();
    const attempt = this.db.transaction(() => {
      const current = this.db.prepare("SELECT * FROM orchestration_attempts WHERE id = ?").get(normalizeId(attemptId));
      if (!current) throw notFound("Orchestration Attempt not found.");
      if (new Set(["succeeded", "failed", "cancelled"]).has(current.status)) return current;
      if (input.leaseOwner && current.lease_owner !== bounded(input.leaseOwner, 160)) throw conflict("Attempt lease owner does not match.");
      const desiredState = this.db.prepare("SELECT desired_state FROM orchestration_runs WHERE id = ?").get(current.run_id)?.desired_state;
      if (desiredState === "cancelled") {
        this.db.prepare(`UPDATE orchestration_attempts SET status = 'cancelled', lease_owner = '', lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
          .run(now, now, current.id);
        return this.db.prepare("SELECT * FROM orchestration_attempts WHERE id = ?").get(current.id);
      }
      const failureClass = bounded(input.failureClass, 80);
      const errorSummary = bounded(input.errorSummary, maxErrorLength);
      this.db.prepare(`
        UPDATE orchestration_attempts SET status = ?, session_id = ?, failure_class = ?, error_summary = ?,
          lease_owner = '', lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?
      `).run(normalizedStatus, bounded(input.sessionId || current.session_id, 160), failureClass, errorSummary, now, now, current.id);
      if (current.item_id) {
        const nextItemStatus = normalizedStatus === "succeeded" ? "verifying" : (input.retryable ? "queued" : "attention");
        const retryCount = normalizedStatus === "failed" ? 1 : 0;
        const nextRetryAt = input.retryable
          ? new Date(Date.now() + retryBackoffMs(Number(input.retryCount || 0))).toISOString()
          : null;
        this.db.prepare(`
          UPDATE orchestration_items SET status = ?, error_summary = ?, retry_count = retry_count + ?,
            next_retry_at = ?, claimed_by = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
        `).run(nextItemStatus, errorSummary, retryCount, nextRetryAt, now, current.item_id);
      }
      if (normalizedStatus !== "succeeded" && !input.retryable) {
        this.db.prepare("UPDATE orchestration_runs SET status = 'attention', error_summary = ?, updated_at = ? WHERE id = ?")
          .run(errorSummary || "Orchestration Attempt needs attention.", now, current.run_id);
      }
      return this.db.prepare("SELECT * FROM orchestration_attempts WHERE id = ?").get(current.id);
    })();
    return summarizeAttempt(attempt);
  }

  markItemReady(itemId, input = {}) {
    const commit = normalizeCommit(input.commit);
    const conclusion = bounded(input.verifierConclusion, 800);
    if (!commit || !conclusion) throw badRequest("Commit and verifier conclusion are required.");
    const id = normalizeId(itemId);
    const evidence = this.db.prepare(`
      SELECT kind, status FROM orchestration_artifacts WHERE item_id = ?
    `).all(id);
    const passedKinds = new Set(evidence.filter((item) => item.status === "passed" || item.status === "info").map((item) => item.kind));
    if (!passedKinds.has("git-summary") || !passedKinds.has("validation") || !passedKinds.has("verifier")) {
      throw conflict("Git summary, validation, and verifier Artifacts are required before readiness.");
    }
    const now = nowIso();
    const changed = this.db.prepare(`
      UPDATE orchestration_items SET status = 'ready', final_commit = ?, verifier_conclusion = ?,
        error_summary = '', updated_at = ? WHERE id = ? AND status IN ('verifying', 'attention')
    `).run(commit, conclusion, now, id).changes;
    if (!changed) throw conflict("Orchestration Item is not ready for verification completion.");
    return this.getItem(id);
  }

  addArtifact(input = {}) {
    const runId = normalizeId(input.runId);
    const itemId = input.itemId ? normalizeId(input.itemId) : null;
    const attemptId = input.attemptId ? normalizeId(input.attemptId) : null;
    const kind = normalizeEnum(input.kind, artifactKinds, "Artifact kind");
    const status = normalizeEnum(input.status || "info", new Set(["passed", "failed", "info"]), "Artifact status");
    if (!this.db.prepare("SELECT 1 FROM orchestration_runs WHERE id = ?").get(runId)) throw notFound("Orchestration Run not found.");
    if (itemId && !this.db.prepare("SELECT 1 FROM orchestration_items WHERE id = ? AND run_id = ?").get(itemId, runId)) {
      throw badRequest("Artifact Item does not belong to the Run.");
    }
    if (attemptId && !this.db.prepare("SELECT 1 FROM orchestration_attempts WHERE id = ? AND run_id = ?").get(attemptId, runId)) {
      throw badRequest("Artifact Attempt does not belong to the Run.");
    }
    const artifact = {
      id: crypto.randomUUID(),
      runId,
      itemId,
      attemptId,
      kind,
      status,
      summary: bounded(input.summary, maxArtifactSummaryLength),
      dataJson: boundedJson(input.data, maxArtifactDataLength),
      createdAt: nowIso()
    };
    this.db.prepare(`
      INSERT INTO orchestration_artifacts (id, run_id, item_id, attempt_id, kind, status, summary, data_json, created_at)
      VALUES (@id, @runId, @itemId, @attemptId, @kind, @status, @summary, @dataJson, @createdAt)
    `).run(artifact);
    return summarizeArtifact(this.db.prepare("SELECT * FROM orchestration_artifacts WHERE id = ?").get(artifact.id));
  }

  getAttempt(id) {
    const row = this.db.prepare("SELECT * FROM orchestration_attempts WHERE id = ?").get(normalizeId(id));
    return row ? summarizeAttempt(row) : null;
  }

  getItem(id) {
    const row = this.db.prepare("SELECT * FROM orchestration_items WHERE id = ?").get(normalizeId(id));
    return row ? summarizeItem(row, []) : null;
  }
}

let defaultStore;

export function orchestrationStore() {
  defaultStore ||= new OrchestrationStore();
  return defaultStore;
}

function normalizeRunInput(input) {
  const ownerUser = normalizeOwner(input.ownerUser);
  const targetAgentId = bounded(input.targetAgentId, 160);
  const projectId = bounded(input.projectId, 160);
  const baseBranch = bounded(input.baseBranch, 240);
  const baseCommit = normalizeCommit(input.baseCommit);
  if (!ownerUser || !targetAgentId || !projectId || !baseBranch || !baseCommit) {
    throw badRequest("User, Desktop agent, Workspace, base branch, and base commit are required.");
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > maxItemsPerRun) {
    throw badRequest(`Orchestration Run requires 1-${maxItemsPerRun} change Items.`);
  }
  const changeIds = new Set();
  const items = input.items.map((item) => {
    const changeId = normalizeChangeId(item.changeId || item.id);
    if (!changeId || changeIds.has(changeId)) throw badRequest("Orchestration change ids must be unique and bounded.");
    changeIds.add(changeId);
    const snapshot = normalizeSnapshot(item.snapshot || item);
    return {
      changeId,
      title: bounded(item.title || changeId, 240),
      snapshot,
      fingerprint: bounded(item.fingerprint, 128) || sha256(JSON.stringify(snapshot)),
      dependsOn: Array.isArray(item.dependsOn) ? [...new Set(item.dependsOn.map(normalizeChangeId).filter(Boolean))] : []
    };
  });
  for (const item of items) {
    const unknown = item.dependsOn.find((id) => !changeIds.has(id));
    if (unknown) throw badRequest(`Unknown orchestration dependency: ${unknown}.`);
    if (item.dependsOn.includes(item.changeId)) throw badRequest("An orchestration Item cannot depend on itself.");
  }
  return {
    id: input.id ? normalizeId(input.id) : "",
    ownerUser,
    targetAgentId,
    projectId,
    title: bounded(input.title || `OpenSpec ${items.length} changes`, 240),
    baseBranch,
    baseCommit,
    runtimePolicy: normalizeRuntimePolicy(input.runtimePolicy),
    items
  };
}

function normalizeRuntimePolicy(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const permissionMode = input.permissionMode === "edit" ? "approve" : input.permissionMode || "default";
  return {
    backendId: bounded(input.backendId, 120),
    model: bounded(input.model, 160),
    permissionMode: normalizeEnum(permissionMode, new Set(["default", "strict", "approve", "full"]), "Permission mode"),
    maxConcurrency: clampInt(input.maxConcurrency, 1, 8, 2),
    worktreeMode: "always"
  };
}

function normalizeSnapshot(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    proposal: bounded(input.proposal || input.proposalSummary, 8_000),
    tasks: Array.isArray(input.tasks) ? input.tasks.slice(0, 200).map((task) => bounded(typeof task === "string" ? task : task?.text, 500)) : [],
    specs: Array.isArray(input.specs) ? input.specs.slice(0, 100).map((spec) => bounded(typeof spec === "string" ? spec : spec?.id || spec?.name, 240)) : []
  };
}

function assertAcyclic(items) {
  const graph = new Map(items.map((item) => [item.changeId, item.dependsOn]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw badRequest("Orchestration dependencies must be acyclic.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function summarizeRun(run, items, attempts, artifacts, dependsOnByItem) {
  const summarizedItems = items.map((item) => summarizeItem(
    item,
    dependsOnByItem.get(item.id) || [],
    attempts.filter((attempt) => attempt.item_id === item.id),
    artifacts.filter((artifact) => artifact.item_id === item.id)
  ));
  if (terminalRunStatuses.has(run.status)) {
    for (const item of summarizedItems) item.availableActions = [];
  } else if (run.desired_state !== "running") {
    for (const item of summarizedItems) {
      if (item.availableActions.includes("finish-run")) item.availableActions = ["finish-run"];
      else item.availableActions = [];
    }
  }
  return {
    id: run.id,
    ownerUser: run.owner_user,
    targetAgentId: run.target_agent_id,
    projectId: run.project_id,
    title: run.title,
    baseBranch: run.base_branch,
    baseCommit: run.base_commit,
    status: run.status,
    desiredState: run.desired_state,
    runtimePolicy: parseJson(run.runtime_policy_json, {}),
    integrationPolicy: run.integration_policy,
    result: parseJson(run.result_json, {}),
    errorSummary: bounded(run.error_summary, maxErrorLength),
    availableActions: runAvailableActions(run),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    cancelledAt: run.cancelled_at,
    progress: {
      completed: summarizedItems.filter((item) => item.status === "ready" || item.status === "completed").length,
      integrated: summarizedItems.filter((item) => item.status === "completed").length,
      ready: summarizedItems.filter((item) => item.status === "ready").length,
      attention: summarizedItems.filter((item) => item.status === "attention").length,
      total: summarizedItems.length
    },
    items: summarizedItems,
    artifacts: artifacts.filter((artifact) => !artifact.item_id).map(summarizeArtifact)
  };
}

function summarizeItem(row, dependsOn = [], attempts = [], artifacts = []) {
  const summarizedAttempts = attempts.map(summarizeAttempt);
  return {
    id: row.id,
    runId: row.run_id,
    changeId: row.change_id,
    title: row.title,
    position: row.position,
    snapshot: parseJson(row.snapshot_json, {}),
    snapshotFingerprint: row.snapshot_fingerprint,
    dependsOn,
    status: itemStatuses.has(row.status) ? row.status : "attention",
    currentAttemptId: row.current_attempt_id || "",
    finalCommit: row.final_commit,
    verifierConclusion: bounded(row.verifier_conclusion, 800),
    errorSummary: bounded(row.error_summary, maxErrorLength),
    retryCount: Number(row.retry_count || 0),
    nextRetryAt: row.next_retry_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    availableActions: itemAvailableActions(row, summarizedAttempts),
    attempts: summarizedAttempts,
    artifacts: artifacts.map(summarizeArtifact)
  };
}

function runAvailableActions(run) {
  if (terminalRunStatuses.has(run.status)) return [];
  if (run.status === "paused") return ["resume", "finish"];
  if (run.status === "attention") return ["finish"];
  return ["pause", "finish"];
}

function resumedRunStatus(db, runId) {
  const itemStatuses = db.prepare("SELECT status FROM orchestration_items WHERE run_id = ?").all(runId).map((item) => item.status);
  if (itemStatuses.some((status) => status === "attention" || status === "failed")) return "attention";
  const integrationStatus = db.prepare(`
    SELECT status FROM orchestration_attempts
    WHERE run_id = ? AND kind IN ('integrate', 'aggregate-verify')
    ORDER BY created_at DESC LIMIT 1
  `).get(runId)?.status;
  if (new Set(["queued", "leased", "running", "reconciling"]).has(integrationStatus)) return "integrating";
  return "running";
}

function itemAvailableActions(row, attempts) {
  if (!new Set(["attention", "failed"]).has(row.status)) return [];
  const repairCount = attempts.filter((attempt) => attempt.kind === "repair").length;
  const latest = attempts.at(-1);
  if (transientFailureClasses.has(latest?.failureClass)) {
    return repairCount < maxRepairAttempts ? ["retry", "finish-run"] : ["finish-run"];
  }
  return repairCount < maxRepairAttempts ? ["recover", "finish-run"] : ["finish-run"];
}

function summarizeAttempt(row) {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id || "",
    kind: attemptKinds.has(row.kind) ? row.kind : "implement",
    attemptNumber: Number(row.attempt_number || 0),
    sessionId: row.session_id,
    status: attemptStatuses.has(row.status) ? row.status : "reconciling",
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    failureClass: bounded(row.failure_class, 80),
    errorSummary: bounded(row.error_summary, maxErrorLength),
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function summarizeArtifact(row) {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id || "",
    attemptId: row.attempt_id || "",
    kind: row.kind,
    status: row.status,
    summary: bounded(row.summary, maxArtifactSummaryLength),
    data: parseJson(bounded(row.data_json, maxArtifactDataLength), {}),
    createdAt: row.created_at
  };
}

function boundedJson(value, maxLength) {
  const serialized = JSON.stringify(value && typeof value === "object" ? value : {});
  if (serialized.length <= maxLength) return serialized;
  return JSON.stringify({ truncated: true, summary: bounded(serialized, maxLength - 40) });
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeEnum(value, allowed, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) throw badRequest(`${label} is invalid.`);
  return normalized;
}

function normalizeOwner(value) { return bounded(value, 120); }
function normalizeId(value) {
  const id = bounded(value, 160);
  if (!id) throw badRequest("Orchestration id is required.");
  return id;
}
function normalizeChangeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}
function normalizeCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(commit) ? commit : "";
}
function bounded(value, max) { return String(value || "").trim().slice(0, max); }
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}
function retryBackoffMs(retryCount) { return Math.min(5 * 60_000, 5_000 * (2 ** Math.min(6, Math.max(0, retryCount)))); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function nowIso() { return new Date().toISOString(); }

function assertRunOwner(run, ownerUser) {
  if (!run || (ownerUser && run.owner_user !== ownerUser)) throw notFound("Orchestration Run not found.");
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function badRequest(message) { return httpError(message, 400); }
function notFound(message) { return httpError(message, 404); }
function conflict(message) { return httpError(message, 409); }

export const orchestrationLimits = Object.freeze({
  maxItemsPerRun,
  maxArtifactSummaryLength,
  maxArtifactDataLength
});

export const orchestrationStatusValues = Object.freeze({
  runs: [...runStatuses],
  items: [...itemStatuses],
  attempts: [...attemptStatuses]
});
