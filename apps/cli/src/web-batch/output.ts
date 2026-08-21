/** Versioned NDJSON output for dsh-web-batch. */

import type { BatchRecord, BatchTaskRecord } from './types.ts'

/** Aggregate terminal task counts. */
interface BatchCounts {
  completed: number
  failed: number
  cancelled: number
}

/** Public version-0 stdout record. */
export type BatchOutput =
  | { version: 0; type: 'batch.started'; batchId: string; taskCount: number; concurrency: number }
  | {
    version: 0
    type: 'task.state'
    batchId: string
    taskId: string
    sessionId: string
    state: BatchTaskRecord['state']
    pending: Array<'approval' | 'question'>
    reason?: unknown
    text?: string
  }
  | { version: 0; type: 'batch.finished'; batchId: string; counts: BatchCounts }

/** Build one task-state output after its database commit. */
export function taskStateOutput(batchId: string, task: BatchTaskRecord): BatchOutput {
  return {
    version: 0,
    type: 'task.state',
    batchId,
    taskId: task.id,
    sessionId: task.sessionId,
    state: task.state,
    pending: [...new Set(task.pending.map(item => item.kind))].sort(),
    ...task.reason === undefined ? {} : { reason: task.reason },
    ...task.text === undefined ? {} : { text: task.text },
  }
}

/** Count terminal outcomes; non-terminal tasks do not enter any count. */
function batchCounts(tasks: readonly BatchTaskRecord[]): BatchCounts {
  return tasks.reduce<BatchCounts>((counts, task) => {
    if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') {
      counts[task.state] += 1
    }
    return counts
  }, { completed: 0, failed: 0, cancelled: 0 })
}

/** Return whether every persisted task is terminal. */
export function batchFinished(tasks: readonly BatchTaskRecord[]): boolean {
  return tasks.every(task => task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled')
}

/** Build the terminal batch record from persisted state. */
export function batchFinishedOutput(batch: BatchRecord, tasks: readonly BatchTaskRecord[]): BatchOutput {
  return { version: 0, type: 'batch.finished', batchId: batch.batchId, counts: batchCounts(tasks) }
}

/** Write one complete JSON record and trailing newline. */
export function writeBatchOutput(
  stream: { write(chunk: string): unknown },
  output: BatchOutput,
): void {
  stream.write(`${JSON.stringify(output)}\n`)
}
