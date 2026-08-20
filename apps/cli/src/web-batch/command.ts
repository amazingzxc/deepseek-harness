/** Process-facing orchestration for dsh-web-batch commands. */

import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { WebBatchInvocation } from './args.ts'
import { loadTaskManifest } from './manifest.ts'
import {
  batchCounts,
  batchFinished,
  batchFinishedOutput,
  taskStateOutput,
  writeBatchOutput,
  type BatchOutput,
} from './output.ts'
import { WebBatchRunner, type BatchConnectionLifecycle } from './runner.ts'
import { WebBatchStore } from './store.ts'
import { BatchConnection, NodeWebApiClient, type BatchConnectionSinks } from './transport.ts'

/** Process surfaces used by the command implementation. */
export interface WebBatchCommandIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/** Replaceable host facilities used by focused tests. */
export interface WebBatchCommandOptions {
  /** Harness home for batch databases. */
  home?: string
  /** Output and diagnostic streams. */
  io?: WebBatchCommandIo
  /** UUID source for batch, Session, and runner-lock identities. */
  uuid?: () => string
  /** ApiProxy client factory. */
  api?: (origin: string) => IApiClient
  /** Event-connection factory. */
  connection?: (api: IApiClient, sinks: BatchConnectionSinks) => BatchConnectionLifecycle
  /** Signal source. */
  process?: Pick<NodeJS.Process, 'on' | 'off'>
}

const DEFAULT_IO: WebBatchCommandIo = { stdout: process.stdout, stderr: process.stderr }

function resultCode(tasks: readonly { state: string }[]): number {
  return tasks.some(task => task.state === 'failed' || task.state === 'cancelled') ? 1 : 0
}

function diagnostic(io: WebBatchCommandIo, message: string, error?: unknown): void {
  io.stderr.write(
    `dsh-web-batch: ${message}${error === undefined ? '' : `: ${error instanceof Error ? error.message : inspect(error)}`}\n`,
  )
}

/**
 * Execute one parsed command and return its process exit code.
 * @param invocation - Validated command arguments.
 * @param options - Replaceable process facilities.
 * @returns Standard command or signal exit code.
 */
export async function runWebBatchCommand(
  invocation: WebBatchInvocation,
  options: WebBatchCommandOptions = {},
): Promise<number> {
  const io = options.io ?? DEFAULT_IO
  const uuid = options.uuid ?? randomUUID
  const emit = (record: BatchOutput): void => { writeBatchOutput(io.stdout, record) }
  const home = options.home

  if (invocation.mode === 'status') {
    const store = WebBatchStore.open(invocation.batchId, home)
    try {
      const batch = store.batch()
      const tasks = store.tasks()
      for (const task of tasks) emit(taskStateOutput(batch.batchId, task))
      if (batchFinished(tasks)) emit(batchFinishedOutput(batch, tasks))
      return resultCode(tasks)
    } finally {
      store.close()
    }
  }

  let store: WebBatchStore
  if (invocation.mode === 'run') {
    const tasks = await loadTaskManifest(invocation.manifest)
    const batchId = invocation.batchId ?? uuid()
    store = WebBatchStore.create(
      batchId,
      tasks,
      invocation.concurrency,
      () => `session-${uuid()}`,
      home,
    )
    emit({
      version: 0,
      type: 'batch.started',
      batchId,
      taskCount: tasks.length,
      concurrency: invocation.concurrency,
    })
  } else {
    store = WebBatchStore.open(invocation.batchId, home)
  }

  const lockId = `runner-${uuid()}`
  let acquired = false
  let connection: BatchConnectionLifecycle | undefined
  const abort = new AbortController()
  let signalCode: number | undefined
  const signalProcess = options.process ?? process
  const interrupt = (code: number): void => {
    if (signalCode !== undefined) return
    signalCode = code
    abort.abort()
    void connection?.stop()
  }
  const sigint = (): void => { interrupt(130) }
  const sigterm = (): void => { interrupt(143) }
  signalProcess.on('SIGINT', sigint)
  signalProcess.on('SIGTERM', sigterm)
  try {
    store.acquireRunner(lockId, invocation.mode === 'resume' && invocation.takeOver)
    acquired = true
    if (invocation.mode === 'resume') {
      for (const task of store.tasks()) emit(taskStateOutput(store.batchId, task))
    }
    const api = options.api?.(invocation.origin) ?? new NodeWebApiClient(invocation.origin)
    const runner = new WebBatchRunner(store, api, {
      output: emit,
      diagnostic: (message, error) => { diagnostic(io, message, error) },
    })
    connection = options.connection?.(api, runner.connectionSinks)
      ?? new BatchConnection(api, runner.connectionSinks)
    await runner.run(connection, abort.signal)
    await connection.stop()
    const tasks = runner.currentTasks()
    if (signalCode !== undefined) return signalCode
    if (batchFinished(tasks)) emit(batchFinishedOutput(store.batch(), tasks))
    return resultCode(tasks)
  } finally {
    signalProcess.off('SIGINT', sigint)
    signalProcess.off('SIGTERM', sigterm)
    abort.abort()
    await connection?.stop()
    if (acquired) store.releaseRunner(lockId)
    store.close()
  }
}

/** Public terminal counts used by acceptance tests and callers inspecting status. */
export { batchCounts }
