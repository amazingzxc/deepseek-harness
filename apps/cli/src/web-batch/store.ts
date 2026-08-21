/** SQLite persistence for recoverable dsh-web-batch execution. */

import { openSync, closeSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {
  BatchRecord,
  BatchTaskInput,
  BatchTaskRecord,
  BatchTaskState,
  PendingInteraction,
  RunnerLockRecord,
} from './types.ts'

/** Current on-disk layout version for batch state. */
export const WEB_BATCH_SCHEMA_VERSION = 1

/** SQLite application identity for dsh-web-batch (`DWB0`). */
export const WEB_BATCH_APPLICATION_ID = 0x44574230

/** Thrown when another unreleased runner owns the batch. */
export class BatchLockedError extends Error {
  constructor(readonly lockId: string) {
    super(`batch is owned by runner lock ${lockId}; use --take-over only after confirming it is stale`)
    this.name = 'BatchLockedError'
  }
}

interface TaskRow {
  position: number
  task_id: string
  prompt: string
  cwd: string
  agent_preset: string | null
  session_id: string
  state: BatchTaskState
  pending_json: string
  prompt_seq: number | null
  turn_number: number | null
  reason_json: string | null
  final_text: string | null
  text_seq: number | null
}

interface LockRow {
  lock_id: string
  acquired_at: number
  released_at: number | null
  superseded_by: string | null
}

/** Resolve the database path for one UUID-validated batch identity. */
export function batchDatabasePath(batchId: string, home = resolveDshHome()): string {
  return join(home, 'web-batches', batchId, 'state.sqlite')
}

function ensurePrivateFile(path: string): void {
  try {
    const fd = openSync(path, 'wx', 0o600)
    closeSync(fd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  chmodSync(path, 0o600)
}

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { count } = db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    ).get() as { count: number }
    if (version === 0 && (applicationId !== 0 || count > 0)) {
      throw new Error(`batch database at ${JSON.stringify(path)} has an unversioned schema or application identity`)
    }
    if (version !== 0 && version !== WEB_BATCH_SCHEMA_VERSION) {
      throw new Error(
        `batch database at ${JSON.stringify(path)} has schema version ${String(version)}, `
        + `incompatible with this build (${String(WEB_BATCH_SCHEMA_VERSION)})`,
      )
    }
    if (version === WEB_BATCH_SCHEMA_VERSION && applicationId !== WEB_BATCH_APPLICATION_ID) {
      throw new Error(
        `batch database at ${JSON.stringify(path)} has application id ${String(applicationId)}, `
        + `expected ${String(WEB_BATCH_APPLICATION_ID)}`,
      )
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        batch_id TEXT PRIMARY KEY,
        concurrency INTEGER NOT NULL CHECK (concurrency > 0),
        created_at INTEGER NOT NULL,
        current_lock_id TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        batch_id TEXT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        task_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,
        agent_preset TEXT,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting-human', 'completed', 'failed', 'cancelled')),
        pending_json TEXT NOT NULL,
        prompt_seq INTEGER,
        turn_number INTEGER,
        reason_json TEXT,
        final_text TEXT,
        text_seq INTEGER,
        PRIMARY KEY (batch_id, position),
        UNIQUE (batch_id, task_id),
        UNIQUE (batch_id, cwd),
        UNIQUE (session_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runner_locks (
        batch_id TEXT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
        lock_id TEXT PRIMARY KEY,
        acquired_at INTEGER NOT NULL,
        released_at INTEGER,
        superseded_by TEXT REFERENCES runner_locks(lock_id)
      ) STRICT;
    `)
    if (version === 0) {
      db.exec(`PRAGMA application_id = ${String(WEB_BATCH_APPLICATION_ID)}`)
      db.exec(`PRAGMA user_version = ${String(WEB_BATCH_SCHEMA_VERSION)}`)
    }
    db.exec('COMMIT')
    db.exec('PRAGMA journal_mode = DELETE')
    return db
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The schema failure remains the actionable error when no transaction exists.
    }
    db.close()
    throw error
  }
}

function parsePending(value: string): PendingInteraction[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('stored pending interactions must be an array')
  return parsed as PendingInteraction[]
}

function taskFromRow(row: TaskRow): BatchTaskRecord {
  return {
    position: row.position,
    id: row.task_id,
    prompt: row.prompt,
    cwd: row.cwd,
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
    sessionId: row.session_id,
    state: row.state,
    pending: parsePending(row.pending_json),
    ...row.prompt_seq === null ? {} : { promptSeq: row.prompt_seq },
    ...row.turn_number === null ? {} : { turn: row.turn_number },
    ...row.reason_json === null ? {} : { reason: JSON.parse(row.reason_json) as unknown },
    ...row.final_text === null ? {} : { text: row.final_text },
    ...row.text_seq === null ? {} : { textSeq: row.text_seq },
  }
}

/** Durable state handle for exactly one batch database. */
export class WebBatchStore {
  private constructor(
    readonly path: string,
    readonly batchId: string,
    private readonly db: DatabaseSync,
  ) {}

  /**
   * Create a new batch and allocate every Session identity in one transaction.
   * @param batchId - Caller-visible UUID.
   * @param tasks - Validated manifest tasks.
   * @param concurrency - Fixed batch concurrency.
   * @param sessionId - Session identity factory, called in manifest order.
   * @param home - Harness home override.
   * @param now - Creation clock.
   * @returns The opened durable store.
   */
  static create(
    batchId: string,
    tasks: readonly BatchTaskInput[],
    concurrency: number,
    sessionId: () => string,
    home = resolveDshHome(),
    now = Date.now(),
  ): WebBatchStore {
    const root = join(home, 'web-batches')
    const directory = join(root, batchId)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    mkdirSync(directory, { recursive: false, mode: 0o700 })
    chmodSync(directory, 0o700)
    const path = join(directory, 'state.sqlite')
    ensurePrivateFile(path)
    const db = openDatabase(path)
    try {
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO batches (batch_id, concurrency, created_at) VALUES (?, ?, ?)')
        .run(batchId, concurrency, now)
      const insert = db.prepare(`
        INSERT INTO tasks (
          batch_id, position, task_id, prompt, cwd, agent_preset, session_id, state, pending_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', '[]')
      `)
      tasks.forEach((task, position) => {
        insert.run(batchId, position, task.id, task.prompt, task.cwd, task.agentPreset ?? null, sessionId())
      })
      db.exec('COMMIT')
      return new WebBatchStore(path, batchId, db)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the transaction failure.
      }
      db.close()
      throw error
    }
  }

  /** Open an existing batch database. */
  static open(batchId: string, home = resolveDshHome()): WebBatchStore {
    const path = batchDatabasePath(batchId, home)
    chmodSync(path, 0o600)
    const db = openDatabase(path)
    const batch = db.prepare('SELECT batch_id FROM batches').get() as { batch_id: string } | undefined
    if (batch?.batch_id !== batchId) {
      db.close()
      throw new Error(`batch database does not contain batch ${batchId}`)
    }
    return new WebBatchStore(path, batchId, db)
  }

  /** Close the SQLite handle. */
  close(): void {
    this.db.close()
  }

  /** Read immutable batch metadata. */
  batch(): BatchRecord {
    const row = this.db.prepare(
      'SELECT batch_id, concurrency, created_at FROM batches WHERE batch_id = ?',
    ).get(this.batchId) as { batch_id: string; concurrency: number; created_at: number } | undefined
    if (row === undefined) throw new Error(`batch ${this.batchId} is missing`)
    return { batchId: row.batch_id, concurrency: row.concurrency, createdAt: row.created_at }
  }

  /** Read all tasks in manifest order. */
  tasks(): BatchTaskRecord[] {
    return (this.db.prepare(
      `SELECT position, task_id, prompt, cwd, agent_preset, session_id, state, pending_json,
        prompt_seq, turn_number, reason_json, final_text, text_seq
      FROM tasks WHERE batch_id = ? ORDER BY position`,
    ).all(this.batchId) as unknown as TaskRow[]).map(taskFromRow)
  }

  /**
   * Acquire runner ownership, optionally superseding an abandoned lock.
   * @param lockId - New process-local lock identity.
   * @param takeOver - Whether an unreleased previous lock may be replaced.
   * @param now - Acquisition clock.
   */
  acquireRunner(lockId: string, takeOver: boolean, now = Date.now()): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`
        SELECT l.lock_id, l.released_at
        FROM batches b LEFT JOIN runner_locks l ON l.lock_id = b.current_lock_id
        WHERE b.batch_id = ?
      `).get(this.batchId) as { lock_id: string | null; released_at: number | null } | undefined
      if (row === undefined) throw new Error(`batch ${this.batchId} is missing`)
      if (row.lock_id !== null && row.released_at === null && !takeOver) throw new BatchLockedError(row.lock_id)
      this.db.prepare(
        'INSERT INTO runner_locks (batch_id, lock_id, acquired_at) VALUES (?, ?, ?)',
      ).run(this.batchId, lockId, now)
      if (row.lock_id !== null && row.released_at === null) {
        this.db.prepare('UPDATE runner_locks SET superseded_by = ? WHERE lock_id = ?')
          .run(lockId, row.lock_id)
      }
      this.db.prepare('UPDATE batches SET current_lock_id = ? WHERE batch_id = ?')
        .run(lockId, this.batchId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Mark this runner lock cleanly released without deleting its audit row. */
  releaseRunner(lockId: string, now = Date.now()): void {
    const result = this.db.prepare(
      `UPDATE runner_locks SET released_at = ?
       WHERE batch_id = ? AND lock_id = ? AND released_at IS NULL AND superseded_by IS NULL`,
    ).run(now, this.batchId, lockId)
    if (result.changes !== 1) throw new Error(`runner lock ${lockId} is not the current live lock`)
  }

  /** Read runner-lock history in acquisition order. */
  runnerLocks(): RunnerLockRecord[] {
    return (this.db.prepare(`
      SELECT lock_id, acquired_at, released_at, superseded_by
      FROM runner_locks WHERE batch_id = ? ORDER BY acquired_at, lock_id
    `).all(this.batchId) as unknown as LockRow[]).map(row => ({
      lockId: row.lock_id,
      acquiredAt: row.acquired_at,
      ...row.released_at === null ? {} : { releasedAt: row.released_at },
      ...row.superseded_by === null ? {} : { supersededBy: row.superseded_by },
    }))
  }

  /** Replace every mutable task field in one committed update. */
  updateTask(task: BatchTaskRecord): void {
    const result = this.db.prepare(`
      UPDATE tasks SET state = ?, pending_json = ?, prompt_seq = ?, turn_number = ?, reason_json = ?, final_text = ?, text_seq = ?
      WHERE batch_id = ? AND position = ? AND task_id = ? AND session_id = ?
    `).run(
      task.state,
      JSON.stringify(task.pending),
      task.promptSeq ?? null,
      task.turn ?? null,
      task.reason === undefined ? null : JSON.stringify(task.reason),
      task.text ?? null,
      task.textSeq ?? null,
      this.batchId,
      task.position,
      task.id,
      task.sessionId,
    )
    if (result.changes !== 1) throw new Error(`task ${task.id} is not present in batch ${this.batchId}`)
  }
}
