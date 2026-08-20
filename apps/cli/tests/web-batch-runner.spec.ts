import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HistoryEntry,
  IApiClient,
  MuxFrame,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchOutput } from '../src/web-batch/output.ts'
import { WebBatchRunner, type BatchConnectionLifecycle } from '../src/web-batch/runner.ts'
import { WebBatchStore } from '../src/web-batch/store.ts'

const cleanup: string[] = []

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-web-batch-runner-'))
  cleanup.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function sessionEvent(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

function promptEvents(prompt: string, reason: TurnEndReason = { kind: 'completed' }): SessionEvent[] {
  return [
    sessionEvent('turn/start', 0, { turn: 1 }),
    sessionEvent('user/message', 1, {
      id: 'user-1', role: 'user', content: [{ type: 'text', text: prompt }],
      source: { kind: 'user', rpcId: 'prompt-1' },
    }),
    sessionEvent('assistant/message', 2, {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: `done:${prompt}` }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    }),
    sessionEvent('turn/end', 3, { turn: 1, reason }),
  ]
}

function mux(payload: MuxFrame, rpcId: string = randomUUID()): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as never, payload }
}

interface FakeApiOptions {
  create?(sessionId: string, calls: number): Promise<void> | void
  history?(sessionId: string, entries: readonly HistoryEntry[]): Promise<readonly HistoryEntry[]> | readonly HistoryEntry[]
  prompt?(sessionId: string, prompt: string, calls: number): Promise<void> | void
  subscribe?(sessionId: string, calls: number): boolean
}

class FakeApi {
  readonly histories = new Map<string, HistoryEntry[]>()
  readonly createCalls: string[] = []
  readonly historyCalls: string[] = []
  readonly promptCalls: string[] = []
  runner?: WebBatchRunner

  constructor(private readonly options: FakeApiOptions = {}) {}

  asClient(): IApiClient {
    return {
      sessions: {
        create: async (payload: { sessionId?: string }) => {
          const sessionId = payload.sessionId as string
          this.createCalls.push(sessionId)
          if (this.options.subscribe?.(sessionId, this.createCalls.length) !== false) {
            this.runner?.handleMuxEnvelope(mux({
              type: 'session/subscribed', sessionId: sessionId as never, lastSeq: -1,
            }))
          }
          await this.options.create?.(sessionId, this.createCalls.length)
          return { rpcId: randomUUID() as never, result: { ok: true, value: { sessionId: sessionId as never } } }
        },
        history: async (payload: { sessionId: string }) => {
          this.historyCalls.push(payload.sessionId)
          const entries = this.histories.get(payload.sessionId) ?? []
          const resolved = this.options.history === undefined
            ? entries
            : await this.options.history(payload.sessionId, entries)
          return {
            rpcId: randomUUID() as never,
            result: {
              ok: true as const,
              value: { events: [...resolved], hasMore: false },
            },
          }
        },
        prompt: async (payload: { sessionId: string; content: Array<{ type: string; text?: string }> }) => {
          const prompt = payload.content[0]?.text ?? ''
          this.promptCalls.push(payload.sessionId)
          await this.options.prompt?.(payload.sessionId, prompt, this.promptCalls.length)
          return { rpcId: randomUUID() as never, result: { ok: true as const, value: { accepted: true as const } } }
        },
      },
    } as unknown as IApiClient
  }

  publish(sessionId: string, events: readonly SessionEvent[]): void {
    for (const event of events) {
      this.runner?.handleMuxEnvelope(mux({ type: 'session/event', sessionId: sessionId as never, event }))
    }
  }
}

async function harness(
  taskCount: number,
  concurrency: number,
  api: FakeApi,
): Promise<{
  store: WebBatchStore
  runner: WebBatchRunner
  outputs: BatchOutput[]
  connection: BatchConnectionLifecycle
  close(): void
}> {
  const home = await tempDir()
  const tasks = []
  for (let index = 0; index < taskCount; index++) {
    const cwd = join(home, `work-${String(index)}`)
    await mkdir(cwd)
    tasks.push({ id: `task-${String(index)}`, prompt: `prompt-${String(index)}`, cwd })
  }
  let session = 0
  const store = WebBatchStore.create(
    randomUUID(), tasks, concurrency, () => `session-${String(session++)}`, home,
  )
  const outputs: BatchOutput[] = []
  const runner = new WebBatchRunner(store, api.asClient(), {
    output: (record) => { outputs.push(record) },
    diagnostic() {},
  }, { retryBaseMs: 1, retryMaxMs: 1 })
  api.runner = runner
  const connection: BatchConnectionLifecycle = {
    async start() {
      runner.handleGenerationStarting()
      runner.handleConnected()
    },
    async stop() {},
  }
  return { store, runner, outputs, connection, close: () => { store.close() } }
}

describe('WebBatchRunner', () => {
  it('creates one Session, sends one prompt, and commits the final text and reason', async () => {
    const api = new FakeApi({
      prompt(sessionId, prompt) {
        api.publish(sessionId, promptEvents(prompt))
      },
    })
    const world = await harness(1, 1, api)
    try {
      await world.runner.run(world.connection, new AbortController().signal)
      expect(api.createCalls).toEqual(['session-0'])
      expect(api.promptCalls).toEqual(['session-0'])
      expect(world.runner.currentTasks()[0]).toEqual(expect.objectContaining({
        state: 'completed', promptSeq: 1, turn: 1, text: 'done:prompt-0', textSeq: 2,
        reason: { kind: 'completed' },
      }))
      expect(world.outputs.map(output => output.type === 'task.state' ? output.state : output.type))
        .toEqual(['running', 'completed'])
    } finally {
      world.close()
    }
  })

  it('keeps waiting-human in its slot and applies interaction replay idempotently', async () => {
    const api = new FakeApi({
      prompt(sessionId, prompt) {
        if (sessionId === 'session-0') {
          api.publish(sessionId, promptEvents(prompt).slice(0, 2))
          api.runner?.handleMuxEnvelope(mux({
            type: 'question/requested', sessionId: sessionId as never,
            questions: [{ id: 'q', question: 'Choose?' }],
          }, 'question-rpc'))
          return
        }
        api.publish(sessionId, promptEvents(prompt))
      },
    })
    const world = await harness(2, 1, api)
    try {
      const running = world.runner.run(world.connection, new AbortController().signal)
      await vi.waitFor(() => {
        expect(world.runner.currentTasks()[0]?.state).toBe('waiting-human')
      })
      expect(api.createCalls).toEqual(['session-0'])
      const duplicate = mux({
        type: 'question/requested', sessionId: 'session-0' as never,
        questions: [{ id: 'q', question: 'Choose?' }],
      }, 'question-rpc')
      const outputCount = world.outputs.length
      world.runner.handleMuxEnvelope(duplicate)
      expect(world.outputs).toHaveLength(outputCount)
      world.runner.handleMuxEnvelope(mux({
        type: 'question/resolved', sessionId: 'session-0' as never,
        questionRpcId: 'question-rpc' as never, outcome: 'answered',
      }))
      world.runner.handleMuxEnvelope(mux({
        type: 'question/resolved', sessionId: 'session-0' as never,
        questionRpcId: 'question-rpc' as never, outcome: 'answered',
      }))
      api.publish('session-0', promptEvents('prompt-0').slice(2))
      await running
      expect(api.createCalls).toEqual(['session-0', 'session-1'])
      expect(world.runner.currentTasks().map(task => task.state)).toEqual(['completed', 'completed'])
    } finally {
      world.close()
    }
  })

  it('reconciles lost create and prompt responses without duplicating either durable prompt', async () => {
    const api = new FakeApi({
      create(_sessionId, calls) {
        if (calls === 1) throw new Error('lost create response')
      },
      prompt(sessionId, prompt, calls) {
        if (calls === 1) {
          api.histories.set(sessionId, promptEvents(prompt).map(event => ({ event })))
          throw new Error('lost prompt response')
        }
      },
    })
    const world = await harness(1, 1, api)
    try {
      await world.runner.run(world.connection, new AbortController().signal)
      expect(api.createCalls).toEqual(['session-0', 'session-0', 'session-0'])
      expect(api.promptCalls).toEqual(['session-0'])
      expect(world.runner.currentTasks()[0]?.state).toBe('completed')
    } finally {
      world.close()
    }
  })

  it('reconstructs a queued prompt from history before a delayed mux baseline arrives', async () => {
    const api = new FakeApi()
    api.histories.set('session-0', [{
      event: sessionEvent('agent/inbox/spliced', 0, {
        target: 'next-turn',
        start: 0,
        inserted: [{
          id: 'queued-1', role: 'user', content: [{ type: 'text', text: 'prompt-0' }],
          source: { kind: 'user', rpcId: 'lost-prompt' },
        }],
      }),
    }])
    const world = await harness(1, 1, api)
    try {
      const running = world.runner.run(world.connection, new AbortController().signal)
      await vi.waitFor(() => { expect(api.historyCalls).toEqual(['session-0']) })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(api.promptCalls).toEqual([])
      api.runner?.handleMuxEnvelope(mux({
        type: 'session/queue',
        sessionId: 'session-0' as never,
        items: [{
          id: 'queued-1' as never,
          placement: 'queued',
          message: {
            id: 'queued-1' as never,
            role: 'user',
            content: [{ type: 'text', text: 'prompt-0' }],
            source: { kind: 'user', rpcId: 'lost-prompt' as never },
          },
        }],
      }))
      api.publish('session-0', [
        sessionEvent('turn/start', 1, { turn: 1 }),
        sessionEvent('user/message', 2, {
          id: 'queued-1', role: 'user', content: [{ type: 'text', text: 'prompt-0' }],
          source: { kind: 'user', rpcId: 'lost-prompt' },
        }),
        sessionEvent('assistant/message', 3, {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'done' }],
            source: { kind: 'model', provider: 'mock', model: 'mock' },
          },
        }),
        sessionEvent('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
      ])
      await running
      expect(world.runner.currentTasks()[0]).toEqual(expect.objectContaining({
        state: 'completed', promptSeq: 2, text: 'done',
      }))
      expect(api.promptCalls).toEqual([])
    } finally {
      world.close()
    }
  })

  it('does not resubmit a prompt claimed before its user message was durable', async () => {
    const api = new FakeApi()
    api.histories.set('session-0', [
      {
        event: sessionEvent('agent/inbox/spliced', 0, {
          target: 'next-turn',
          start: 0,
          inserted: [{
            id: 'claimed-1', role: 'user', content: [{ type: 'text', text: 'prompt-0' }],
            source: { kind: 'user', rpcId: 'lost-prompt' },
          }],
        }),
      },
      { event: sessionEvent('turn/start', 1, { turn: 1 }) },
      {
        event: sessionEvent('agent/inbox/spliced', 2, {
          target: 'next-turn', start: 0, removedCount: 1, inserted: [],
        }),
      },
    ])
    const world = await harness(1, 1, api)
    try {
      const running = world.runner.run(world.connection, new AbortController().signal)
      await vi.waitFor(() => { expect(api.historyCalls).toEqual(['session-0']) })
      expect(api.promptCalls).toEqual([])
      expect(world.runner.currentTasks()[0]).toEqual(expect.objectContaining({ turn: 1 }))

      api.publish('session-0', [
        sessionEvent('user/message', 3, {
          id: 'claimed-1', role: 'user', content: [{ type: 'text', text: 'prompt-0' }],
          source: { kind: 'user', rpcId: 'lost-prompt' },
        }),
        sessionEvent('assistant/message', 4, {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'done' }],
            source: { kind: 'model', provider: 'mock', model: 'mock' },
          },
        }),
        sessionEvent('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
      ])
      await running
      expect(world.runner.currentTasks()[0]).toEqual(expect.objectContaining({
        state: 'completed', promptSeq: 3, text: 'done',
      }))
      expect(api.promptCalls).toEqual([])
    } finally {
      world.close()
    }
  })

  it('keeps the durable turn reason authoritative when a Host error arrives first', async () => {
    const reason: TurnEndReason = {
      kind: 'error',
      error: { code: 'MODEL_FAILED', message: 'provider failed' },
    }
    const api = new FakeApi({
      prompt(sessionId, prompt) {
        const events = promptEvents(prompt, reason)
        api.publish(sessionId, events.slice(0, 2))
        api.runner?.handleHostEnvelope({
          rpcId: 'host-error' as never,
          payload: { type: 'host/agent-error', sessionId: sessionId as never, message: 'live provider failure' },
        })
        api.publish(sessionId, events.slice(2))
      },
    })
    const world = await harness(1, 1, api)
    try {
      await world.runner.run(world.connection, new AbortController().signal)
      expect(world.runner.currentTasks()[0]).toEqual(expect.objectContaining({ state: 'failed', reason }))
    } finally {
      world.close()
    }
  })

  it('buffers live durable events until history identifies the owned turn', async () => {
    const api = new FakeApi({
      history(sessionId, entries) {
        api.publish(sessionId, promptEvents('prompt-0').slice(2))
        return entries
      },
    })
    api.histories.set('session-0', promptEvents('prompt-0').slice(0, 2).map(event => ({ event })))
    const world = await harness(1, 1, api)
    const abort = new AbortController()
    const timeout = setTimeout(() => { abort.abort() }, 500)
    try {
      await world.runner.run(world.connection, abort.signal)
      expect(world.runner.currentTasks()[0]).toEqual(expect.objectContaining({
        state: 'completed', promptSeq: 1, turn: 1, text: 'done:prompt-0',
      }))
      expect(api.promptCalls).toEqual([])
    } finally {
      clearTimeout(timeout)
      world.close()
    }
  })

  it('waits for the current generation baseline before reconnect reconciliation', async () => {
    const api = new FakeApi({
      subscribe(_sessionId, calls) {
        return calls === 1
      },
      history(sessionId, entries) {
        if (api.historyCalls.length === 2) {
          api.publish(sessionId, promptEvents('prompt-0').slice(2))
        }
        return entries
      },
      prompt(sessionId, prompt) {
        const open = promptEvents(prompt).slice(0, 2)
        api.histories.set(sessionId, open.map(event => ({ event })))
        api.publish(sessionId, open)
      },
    })
    const world = await harness(1, 1, api)
    try {
      const running = world.runner.run(world.connection, new AbortController().signal)
      await vi.waitFor(() => { expect(api.promptCalls).toHaveLength(1) })

      world.runner.handleGenerationStarting()
      world.runner.handleConnected()
      await vi.waitFor(() => { expect(api.createCalls).toHaveLength(2) })
      expect(api.historyCalls).toHaveLength(1)

      world.runner.handleMuxEnvelope(mux({
        type: 'session/subscribed', sessionId: 'session-0' as never, lastSeq: 1,
      }))
      await running
      expect(api.historyCalls).toHaveLength(2)
      expect(world.runner.currentTasks()[0]).toEqual(expect.objectContaining({
        state: 'completed', promptSeq: 1, turn: 1, text: 'done:prompt-0',
      }))
    } finally {
      world.close()
    }
  })

  it('fails on another human prompt and reconciles Host-restart interruption', async () => {
    const conflictApi = new FakeApi()
    const conflict = await harness(1, 1, conflictApi)
    conflictApi.histories.set('session-0', [{ event: promptEvents('different')[1] as SessionEvent }])
    try {
      await conflict.runner.run(conflict.connection, new AbortController().signal)
      const task = conflict.runner.currentTasks()[0]
      expect(task?.state).toBe('failed')
      expect(task?.reason).toEqual(expect.objectContaining({ kind: 'session-conflict' }))
      expect(conflictApi.promptCalls).toEqual([])
    } finally {
      conflict.close()
    }

    const restartApi = new FakeApi({
      prompt(sessionId, prompt) {
        const open = promptEvents(prompt).slice(0, 2)
        restartApi.histories.set(sessionId, open.map(event => ({ event })))
        restartApi.publish(sessionId, open)
      },
    })
    const restart = await harness(1, 1, restartApi)
    try {
      const running = restart.runner.run(restart.connection, new AbortController().signal)
      await vi.waitFor(() => { expect(restartApi.promptCalls).toHaveLength(1) })
      restartApi.histories.get('session-0')?.push({
        event: sessionEvent('turn/end', 2, { turn: 1, reason: { kind: 'interrupted' } }),
      })
      restart.runner.handleGenerationStarting()
      restart.runner.handleConnected()
      await running
      expect(restartApi.createCalls).toEqual(['session-0', 'session-0'])
      expect(restart.runner.currentTasks()[0]).toEqual(expect.objectContaining({
        state: 'failed', reason: { kind: 'interrupted' },
      }))
    } finally {
      restart.close()
    }
  })
})
