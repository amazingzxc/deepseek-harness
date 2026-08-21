/** Recoverable Web Session scheduler for dsh-web-batch. */

import { isDeepStrictEqual } from 'node:util'
import type {
  HistoryEntry,
  HostFrame,
  IApiClient,
  MuxFrame,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { BatchOutput } from './output.ts'
import { taskStateOutput } from './output.ts'
import type { BatchTaskRecord, PendingInteraction } from './types.ts'
import type { WebBatchStore } from './store.ts'
import type { BatchConnection } from './transport.ts'

const HISTORY_PAGE_MESSAGES = 200
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 10_000

/** Connection lifecycle consumed by the scheduler. */
export interface BatchConnectionLifecycle {
  /** Establish the first stream generation. */
  start(): Promise<void>
  /** Stop and await all stream work. */
  stop(): Promise<void>
}

/** Runner output and diagnostic callbacks. */
export interface BatchRunnerSinks {
  /** Publish one state record after its SQLite commit. */
  output(record: BatchOutput): void
  /** Publish a non-protocol diagnostic to stderr. */
  diagnostic(message: string, error?: unknown): void
}

/** Transport-reconciliation retry policy. */
export interface BatchRunnerConfig {
  /** Delay before the first retry. */
  retryBaseMs?: number
  /** Maximum retry delay. */
  retryMaxMs?: number
}

function terminal(task: BatchTaskRecord): boolean {
  return task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled'
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function settleOrAbort(work: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      resolve(false)
    }
    signal.addEventListener('abort', abort, { once: true })
    void work.then(
      () => {
        signal.removeEventListener('abort', abort)
        resolve(true)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

type QueueItem = Extract<MuxFrame, { type: 'session/queue' }>['items'][number]
type HumanPrompt = { kind: 'text'; text: string } | { kind: 'rich' }

function humanPrompt(message: Pick<QueueItem['message'], 'source' | 'content'>): HumanPrompt | undefined {
  if (message.source.kind !== 'user') return undefined
  if (message.content.length !== 1 || message.content[0]?.type !== 'text') return { kind: 'rich' }
  return { kind: 'text', text: message.content[0].text }
}

function directUserPrompt(event: SessionEvent): HumanPrompt | undefined {
  return event.type === 'user/message' ? humanPrompt(event.data) : undefined
}

function queuedUserPrompt(item: QueueItem): HumanPrompt | undefined {
  return humanPrompt(item.message)
}

function ownsPrompt(input: HumanPrompt, prompt: string): boolean {
  return input.kind === 'text' && input.text === prompt
}

interface HistoryInboxState {
  pending: HumanPrompt[]
  claimed: Array<{ prompt: HumanPrompt; turn: number }>
}

function historyInboxState(entries: readonly HistoryEntry[]): HistoryInboxState {
  type SpliceEvent = SessionEvent<'agent/inbox/spliced'>
  type Target = SpliceEvent['data']['target']
  type Message = SpliceEvent['data']['inserted'][number]
  const inbox: Record<Target, Message[]> = { 'next-turn': [], 'next-step': [] }
  const claimed: HistoryInboxState['claimed'] = []
  let turn: number | undefined
  for (const { event } of entries) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      if (event.data.turn === turn) turn = undefined
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      const removed = inbox[target].splice(start, removedCount, ...inserted)
      if (outcome === undefined && turn !== undefined) {
        for (const message of removed) {
          const prompt = humanPrompt(message)
          if (prompt !== undefined) claimed.push({ prompt, turn })
        }
      }
    }
  }
  const pending = [...inbox['next-turn'], ...inbox['next-step']].flatMap((message) => {
    const prompt = humanPrompt(message)
    return prompt === undefined ? [] : [prompt]
  })
  return { pending, claimed }
}

function assistantText(event: SessionEvent<'assistant/message'>): string {
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function terminalState(reason: TurnEndReason): BatchTaskRecord['state'] {
  if (reason.kind === 'completed') return 'completed'
  if (reason.kind === 'aborted' && reason.reason.kind === 'user') return 'cancelled'
  return 'failed'
}

interface BaselineState {
  settled: Promise<void>
  resolve(): void
  lastSeq: number
  historyPending: boolean
  updates: Array<
    | { kind: 'event'; event: SessionEvent }
    | { kind: 'queue'; frame: Extract<MuxFrame, { type: 'session/queue' }> }
  >
}

/** Scheduler state machine over one opened {@link WebBatchStore}. */
export class WebBatchRunner {
  private readonly tasks = new Map<number, BatchTaskRecord>()
  private readonly positionBySession = new Map<string, number>()
  private readonly terminalWaiters = new Map<number, Set<() => void>>()
  private readonly openTurn = new Map<string, number>()
  private readonly promptQueued = new Set<string>()
  private readonly promptClaimed = new Set<string>()
  private readonly baselines = new Map<string, BaselineState>()
  private connectionEpoch = 0
  private connectionWaiters = new Set<() => void>()
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number

  constructor(
    private readonly store: WebBatchStore,
    private readonly api: IApiClient,
    private readonly sinks: BatchRunnerSinks,
    config: BatchRunnerConfig = {},
  ) {
    this.retryBaseMs = config.retryBaseMs ?? RETRY_BASE_MS
    this.retryMaxMs = config.retryMaxMs ?? RETRY_MAX_MS
    for (const task of store.tasks()) {
      this.tasks.set(task.position, task)
      this.positionBySession.set(task.sessionId, task.position)
    }
  }

  /** Sinks passed directly to {@link BatchConnection}. */
  readonly connectionSinks: ConstructorParameters<typeof BatchConnection>[1] = {
    onGenerationStarting: () => { this.handleGenerationStarting() },
    onMuxEnvelope: (envelope) => { this.handleMuxEnvelope(envelope) },
    onHostEnvelope: (envelope) => { this.handleHostEnvelope(envelope) },
    onConnected: () => { this.handleConnected() },
    onDiagnostic: (message, error) => { this.sinks.diagnostic(message, error) },
  }

  /** Snapshot current in-memory state in manifest order. */
  currentTasks(): BatchTaskRecord[] {
    return [...this.tasks.values()].sort((left, right) => left.position - right.position)
  }

  /** Discard per-stream baselines before a new connection generation starts. */
  handleGenerationStarting(): void {
    this.promptQueued.clear()
    this.promptClaimed.clear()
    for (const baseline of this.baselines.values()) baseline.resolve()
    this.baselines.clear()
  }

  /** Record one completed connection generation and wake active tasks to reconcile. */
  handleConnected(): void {
    this.connectionEpoch += 1
    const waiters = this.connectionWaiters
    this.connectionWaiters = new Set()
    for (const resolve of waiters) resolve()
  }

  /** Apply one validated mux envelope. */
  handleMuxEnvelope(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (!('sessionId' in frame)) return
    const task = this.taskForSession(frame.sessionId)
    if (task === undefined || terminal(task)) return
    switch (frame.type) {
      case 'session/subscribed':
        this.beginBaseline(task, frame.lastSeq)
        break
      case 'session/event': {
        const baseline = this.baselines.get(task.sessionId)
        if (baseline?.historyPending === true) {
          baseline.updates.push({ kind: 'event', event: frame.event })
        } else {
          this.applyDurableEvent(task, frame.event)
        }
        break
      }
      case 'approval/requested':
        this.addPending(task, { kind: 'approval', id: frame.approvalId })
        break
      case 'approval/resolved':
        this.removePending(task, 'approval', frame.approvalId)
        break
      case 'question/requested':
        this.addPending(task, { kind: 'question', id: envelope.rpcId })
        break
      case 'question/resolved':
        this.removePending(task, 'question', frame.questionRpcId)
        break
      case 'session/queue':
        if (this.baselines.get(task.sessionId)?.historyPending === true) {
          this.baselines.get(task.sessionId)?.updates.push({ kind: 'queue', frame })
        } else {
          this.applyQueue(task, frame)
        }
        break
      case 'session/jobs':
      case 'session/projection':
        break
      default:
        frame satisfies never
    }
  }

  /** Apply one validated Host envelope. */
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    if (!('sessionId' in frame)) return
    const task = this.taskForSession(frame.sessionId)
    if (task === undefined || terminal(task)) return
    if (frame.type === 'host/session-removed') {
      this.fail(task, { kind: 'session-removed' })
    } else if (frame.type === 'host/agent-error') {
      this.sinks.diagnostic(`task ${task.id}: Host reported an Agent error`, new Error(frame.message))
    }
  }

  /**
   * Run active and queued tasks until all are terminal or `signal` aborts.
   * Non-terminal tasks, including waiting-human, retain their slots.
   */
  async run(connection: BatchConnectionLifecycle, signal: AbortSignal): Promise<void> {
    const started = connection.start()
    if (!await settleOrAbort(started, signal)) {
      await connection.stop()
      await started.catch(() => undefined)
      return
    }
    const active = new Set<Promise<void>>()
    const launch = (task: BatchTaskRecord): void => {
      const work = this.runTask(task.position, signal).finally(() => { active.delete(work) })
      active.add(work)
    }
    for (const task of this.currentTasks()) {
      if (task.state === 'running' || task.state === 'waiting-human') launch(task)
    }
    const concurrency = this.store.batch().concurrency
    while (!signal.aborted) {
      while (active.size < concurrency) {
        const queued = this.currentTasks().find(task => task.state === 'queued')
        if (queued === undefined) break
        launch(queued)
      }
      if (active.size === 0) break
      await settleOrAbort(Promise.race(active), signal)
    }
    await Promise.allSettled(active)
  }

  private taskForSession(sessionId: string): BatchTaskRecord | undefined {
    const position = this.positionBySession.get(sessionId)
    return position === undefined ? undefined : this.tasks.get(position)
  }

  private latest(position: number): BatchTaskRecord {
    const task = this.tasks.get(position)
    if (task === undefined) throw new Error(`missing batch task at position ${String(position)}`)
    return task
  }

  private commit(next: BatchTaskRecord, publish = true): BatchTaskRecord {
    const current = this.latest(next.position)
    if (isDeepStrictEqual(current, next)) return current
    this.store.updateTask(next)
    this.tasks.set(next.position, next)
    if (publish) this.sinks.output(taskStateOutput(this.store.batchId, next))
    if (terminal(next)) {
      const waiters = this.terminalWaiters.get(next.position)
      this.terminalWaiters.delete(next.position)
      for (const resolve of waiters ?? []) resolve()
    }
    return next
  }

  private beginBaseline(task: BatchTaskRecord, lastSeq: number): void {
    let resolve = (): void => {}
    const baseline: BaselineState = {
      settled: new Promise<void>((done) => { resolve = done }),
      resolve: () => { resolve() },
      lastSeq,
      historyPending: true,
      updates: [],
    }
    this.baselines.set(task.sessionId, baseline)
    this.promptQueued.delete(task.sessionId)
    this.promptClaimed.delete(task.sessionId)
    const before = task
    const cleared = task.pending.length === 0
      ? task
      : { ...task, pending: [], state: task.state === 'waiting-human' ? 'running' as const : task.state }
    this.commit(cleared, false)
    setImmediate(() => {
      if (this.baselines.get(task.sessionId) !== baseline) return
      baseline.resolve()
      const current = this.latest(task.position)
      if (!isDeepStrictEqual(before, current)) this.sinks.output(taskStateOutput(this.store.batchId, current))
    })
  }

  private async waitForBaseline(sessionId: string, signal: AbortSignal): Promise<BaselineState | undefined> {
    while (!signal.aborted) {
      const baseline = this.baselines.get(sessionId)
      if (baseline !== undefined) {
        if (!await settleOrAbort(baseline.settled, signal)) return undefined
        if (this.baselines.get(sessionId) === baseline) return baseline
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    return undefined
  }

  private addPending(task: BatchTaskRecord, pending: PendingInteraction): void {
    const current = this.latest(task.position)
    if (current.pending.some(item => item.kind === pending.kind && item.id === pending.id)) return
    this.commit({ ...current, state: 'waiting-human', pending: [...current.pending, pending] })
  }

  private removePending(task: BatchTaskRecord, kind: PendingInteraction['kind'], id: string): void {
    const current = this.latest(task.position)
    const pending = current.pending.filter(item => item.kind !== kind || item.id !== id)
    if (pending.length === current.pending.length) return
    this.commit({ ...current, state: pending.length === 0 ? 'running' : 'waiting-human', pending })
  }

  private applyQueue(task: BatchTaskRecord, frame: Extract<MuxFrame, { type: 'session/queue' }>): void {
    const direct = frame.items.flatMap((item) => {
      const prompt = queuedUserPrompt(item)
      return prompt === undefined ? [] : [prompt]
    })
    const current = this.latest(task.position)
    if (direct.some(input => !ownsPrompt(input, task.prompt))
      || direct.length > 1
      || (current.promptSeq !== undefined && direct.length > 0)) {
      this.fail(this.latest(task.position), { kind: 'session-conflict', message: 'another human prompt is queued' })
      return
    }
    if (direct.some(input => ownsPrompt(input, task.prompt))) this.promptQueued.add(task.sessionId)
    else this.promptQueued.delete(task.sessionId)
  }

  private applyDurableEvent(task: BatchTaskRecord, event: SessionEvent): void {
    let current = this.latest(task.position)
    if (terminal(current)) return
    if (event.type === 'turn/start') {
      this.openTurn.set(task.sessionId, event.data.turn)
      return
    }
    const userPrompt = directUserPrompt(event)
    if (userPrompt !== undefined) {
      if (current.promptSeq === undefined) {
        const turn = this.openTurn.get(task.sessionId)
        if (!ownsPrompt(userPrompt, task.prompt) || turn === undefined || this.promptQueued.has(task.sessionId)) {
          this.fail(current, { kind: 'session-conflict', message: 'another human prompt entered the Session' })
          return
        }
        current = this.commit({ ...current, promptSeq: event.seq, turn }, false)
        this.promptQueued.delete(task.sessionId)
        this.promptClaimed.delete(task.sessionId)
      } else if (event.seq !== current.promptSeq) {
        this.fail(current, { kind: 'session-conflict', message: 'another human prompt entered the Session' })
        return
      }
    }
    if (event.type === 'assistant/message' && event.data.turn === current.turn) {
      const text = assistantText(event)
      if (text !== '' && event.seq > (current.textSeq ?? -1)) {
        current = this.commit({ ...current, text, textSeq: event.seq }, false)
      }
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      this.commit({
        ...current,
        state: terminalState(event.data.reason),
        pending: [],
        reason: event.data.reason,
      })
      this.openTurn.delete(task.sessionId)
    }
  }

  private reconcileHistory(task: BatchTaskRecord, entries: readonly HistoryEntry[]): void {
    const inbox = historyInboxState(entries)
    const humanPrompts = [...inbox.pending, ...inbox.claimed.map(claim => claim.prompt)]
    if (humanPrompts.some(prompt => !ownsPrompt(prompt, task.prompt))) {
      this.fail(this.latest(task.position), { kind: 'session-conflict', message: 'another human prompt entered the Session' })
      return
    }
    const claimedTurns = [...new Set(inbox.claimed.map(claim => claim.turn))]
    const before = this.latest(task.position)
    const enteredPrompt = entries.some(({ event }) => directUserPrompt(event) !== undefined)
    if (claimedTurns.length > 1
      || (before.turn !== undefined && claimedTurns.length === 1 && claimedTurns[0] !== before.turn)
      || inbox.pending.filter(prompt => ownsPrompt(prompt, task.prompt)).length > 1
      || (inbox.pending.some(prompt => ownsPrompt(prompt, task.prompt))
        && (before.promptSeq !== undefined || claimedTurns.length > 0 || enteredPrompt))) {
      this.fail(before, { kind: 'session-conflict', message: 'another human prompt entered the Session' })
      return
    }
    const claimedTurn = claimedTurns[0]
    if (claimedTurn !== undefined) {
      if (before.turn === undefined) this.commit({ ...before, turn: claimedTurn }, false)
      this.promptClaimed.add(task.sessionId)
    } else if (inbox.pending.some(prompt => ownsPrompt(prompt, task.prompt))) {
      this.promptQueued.add(task.sessionId)
    }

    let turn: number | undefined
    for (const { event } of entries) {
      const current = this.latest(task.position)
      if (terminal(current)) return
      if (event.type === 'turn/start') turn = event.data.turn
      const prompt = directUserPrompt(event)
      if (prompt !== undefined) {
        if (current.promptSeq === undefined) {
          if (!ownsPrompt(prompt, task.prompt) || turn === undefined) {
            this.fail(current, { kind: 'session-conflict', message: 'another human prompt entered the Session' })
            return
          }
          this.commit({ ...current, promptSeq: event.seq, turn }, false)
          this.promptQueued.delete(task.sessionId)
          this.promptClaimed.delete(task.sessionId)
        } else if (event.seq !== current.promptSeq) {
          this.fail(current, { kind: 'session-conflict', message: 'another human prompt entered the Session' })
          return
        }
      }
      this.applyDurableEvent(this.latest(task.position), event)
    }
  }

  private finishHistoryBaseline(
    task: BatchTaskRecord,
    baseline: BaselineState,
    entries: readonly HistoryEntry[],
  ): void {
    if (this.baselines.get(task.sessionId) !== baseline || !baseline.historyPending) return
    baseline.historyPending = false
    const historyLastSeq = entries.at(-1)?.event.seq ?? -1
    const baselinePrompts = historyInboxState(
      entries.filter(({ event }) => event.seq <= baseline.lastSeq),
    ).pending
    const updates = baseline.updates.splice(0)
    let baselineQueuePending = true
    for (const [index, update] of updates.entries()) {
      if (update.kind === 'event') {
        if (update.event.seq > historyLastSeq) {
          this.applyDurableEvent(this.latest(task.position), update.event)
        }
        continue
      }
      const following = updates[index + 1]
      if (following?.kind === 'event'
        && following.event.type === 'agent/inbox/spliced'
        && following.event.seq <= historyLastSeq) {
        continue
      }
      const prompts = update.frame.items.flatMap((item) => {
        const prompt = queuedUserPrompt(item)
        return prompt === undefined ? [] : [prompt]
      })
      if (baselineQueuePending && isDeepStrictEqual(prompts, baselinePrompts)) {
        baselineQueuePending = false
        continue
      }
      baselineQueuePending = false
      this.applyQueue(this.latest(task.position), update.frame)
    }
  }

  private fail(task: BatchTaskRecord, reason: unknown): void {
    if (terminal(task)) return
    this.commit({ ...task, state: 'failed', pending: [], reason })
  }

  private async runTask(position: number, signal: AbortSignal): Promise<void> {
    let current = this.latest(position)
    if (current.state === 'queued') current = this.commit({ ...current, state: 'running' })
    const terminalPromise = this.waitForTerminal(position, signal)
    let retryAttempt = 0
    while (!signal.aborted && !terminal(this.latest(position))) {
      const observedEpoch = this.connectionEpoch
      try {
        const task = this.latest(position)
        const created = await this.api.sessions.create({
          sessionId: task.sessionId as never,
          cwd: task.cwd,
          ...task.agentPreset === undefined ? {} : { agentPreset: task.agentPreset },
        }, signal)
        if (!created.result.ok) {
          this.fail(task, created.result.error)
          break
        }
        const baseline = await this.waitForBaseline(task.sessionId, signal)
        if (baseline === undefined || aborted(signal)) break
        const history = await this.readHistory(task, signal)
        if (history === undefined) break
        this.reconcileHistory(task, history)
        if (this.baselines.get(task.sessionId) !== baseline) continue
        this.finishHistoryBaseline(task, baseline, history)
        const reconciled = this.latest(position)
        if (terminal(reconciled)) break
        if (reconciled.promptSeq === undefined
          && !this.promptQueued.has(reconciled.sessionId)
          && !this.promptClaimed.has(reconciled.sessionId)) {
          const prompted = await this.api.sessions.prompt({
            sessionId: reconciled.sessionId as never,
            mode: 'queue',
            content: [{ type: 'text', text: reconciled.prompt }],
          }, signal)
          if (!prompted.result.ok) {
            this.fail(reconciled, prompted.result.error)
            break
          }
        }
        retryAttempt = 0
        await Promise.race([terminalPromise, this.waitForConnectionAfter(observedEpoch, signal)])
      } catch (error) {
        if (aborted(signal)) break
        retryAttempt += 1
        this.sinks.diagnostic(`task ${this.latest(position).id}: transport failed; reconciling`, error)
        const wait = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, retryAttempt - 1))
        await delay(wait, signal)
      }
    }
    await terminalPromise
  }

  private async readHistory(task: BatchTaskRecord, signal: AbortSignal): Promise<HistoryEntry[] | undefined> {
    const pages: HistoryEntry[][] = []
    let beforeSeq: number | undefined
    while (!signal.aborted) {
      const response = await this.api.sessions.history({
        sessionId: task.sessionId as never,
        maxMessages: HISTORY_PAGE_MESSAGES,
        ...beforeSeq === undefined ? {} : { beforeSeq },
      }, signal)
      if (!response.result.ok) {
        this.fail(this.latest(task.position), response.result.error)
        return undefined
      }
      const page = response.result.value
      pages.unshift(page.events)
      if (!page.hasMore) return pages.flat()
      const first = page.events[0]?.event.seq
      if (first === undefined) throw new Error('session.history returned hasMore with an empty page')
      beforeSeq = first
    }
    return undefined
  }

  private waitForTerminal(position: number, signal: AbortSignal): Promise<void> {
    if (terminal(this.latest(position)) || signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let waiters = this.terminalWaiters.get(position)
      if (waiters === undefined) this.terminalWaiters.set(position, waiters = new Set())
      const done = (): void => {
        signal.removeEventListener('abort', done)
        waiters.delete(done)
        resolve()
      }
      waiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private waitForConnectionAfter(epoch: number, signal: AbortSignal): Promise<void> {
    if (this.connectionEpoch > epoch || signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done)
        this.connectionWaiters.delete(done)
        resolve()
      }
      this.connectionWaiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }
}
