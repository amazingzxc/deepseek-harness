/** Shared domain values for the dsh-web-batch command. */

/** One validated task from the JSONL manifest. */
export interface BatchTaskInput {
  /** Caller-owned task identity, unique within the batch. */
  id: string
  /** Text sent as the batch-owned root prompt. */
  prompt: string
  /** Canonical absolute working directory for the Web Session. */
  cwd: string
  /** Optional Agent preset selected when the Web Session is created. */
  agentPreset?: string
}

/** Lifecycle state persisted for one batch task. */
export type BatchTaskState =
  | 'queued'
  | 'running'
  | 'waiting-human'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** One unresolved Web interaction tracked without answering it. */
export type PendingInteraction =
  | { kind: 'approval'; id: string }
  | { kind: 'question'; id: string }

/** Persisted batch metadata. */
export interface BatchRecord {
  /** Stable caller-visible batch identity. */
  batchId: string
  /** Fixed maximum number of non-terminal tasks. */
  concurrency: number
  /** Batch creation time in Unix milliseconds. */
  createdAt: number
}

/** Persisted task row reconstructed from SQLite. */
export interface BatchTaskRecord extends BatchTaskInput {
  /** Manifest order, starting at zero. */
  position: number
  /** Session identity allocated before the first network request. */
  sessionId: string
  /** Current task lifecycle state. */
  state: BatchTaskState
  /** Outstanding interaction identities in replay-stable order. */
  pending: PendingInteraction[]
  /** Sequence number of the batch prompt's durable user message, once known. */
  promptSeq?: number
  /** Turn number opened for the batch prompt, once known. */
  turn?: number
  /** Terminal turn reason, retained exactly as received from the Session log. */
  reason?: unknown
  /** Last non-empty assistant text in the owned turn. */
  text?: string
}

/** A runner-lock audit row. */
export interface RunnerLockRecord {
  /** Process-local random lock identity. */
  lockId: string
  /** Lock acquisition time in Unix milliseconds. */
  acquiredAt: number
  /** Clean release time, absent for a live or abandoned runner. */
  releasedAt?: number
  /** Replacement lock identity when the operator explicitly took over. */
  supersededBy?: string
}
