/** Node Remote carrier and reconnecting compatibility streams for Web batches. */

import { randomUUID } from 'node:crypto'
import type {
  SessionControlFrame,
  SessionHistoryRecord,
  SessionQueuedItem,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import WebSocket, { type RawData } from 'ws'

/** Correlated compatibility envelope retained inside the batch scheduler. */
export interface RpcRequest<Frame> {
  readonly rpcId: string
  readonly payload: Frame
}

/** Scalar history row consumed by batch recovery. */
export interface HistoryEntry {
  readonly event: SessionEvent
}

interface BatchQueuedMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly source: { readonly kind: string; readonly rpcId?: string }
}

interface BatchQueueItem {
  readonly id: string
  readonly placement: 'queued' | 'steering' | 'context'
  readonly message: BatchQueuedMessage
}

/** Session and interaction frames consumed by the existing recovery state machine. */
export type MuxFrame =
  | { readonly type: 'session/subscribed'; readonly sessionId: string; readonly lastSeq: number }
  | { readonly type: 'session/event'; readonly sessionId: string; readonly event: SessionEvent }
  | { readonly type: 'session/queue'; readonly sessionId: string; readonly items: readonly BatchQueueItem[] }
  | { readonly type: 'session/jobs'; readonly sessionId: string }
  | { readonly type: 'session/projection'; readonly sessionId: string }
  | { readonly type: 'approval/requested'; readonly sessionId: string; readonly approvalId: string }
  | { readonly type: 'approval/resolved'; readonly sessionId: string; readonly approvalId: string }
  | { readonly type: 'question/requested'; readonly sessionId: string; readonly questions: readonly unknown[] }
  | { readonly type: 'question/resolved'; readonly sessionId: string; readonly questionRpcId: string }
  | { readonly type: 'stream/error' }

/** Host lifecycle frames consumed by batch failure diagnostics. */
export type HostFrame =
  | { readonly type: 'host/session-removed'; readonly sessionId: string }
  | { readonly type: 'host/agent-error'; readonly sessionId: string; readonly message: string }
  | { readonly type: 'host/session-status'; readonly sessionId: string; readonly running: boolean }
  | { readonly type: 'stream/error' }

interface RpcFailure {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

type RpcResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: RpcFailure }

interface RpcResponse<Value> {
  readonly rpcId: string
  readonly result: RpcResult<Value>
}

/** Minimal API face the batch scheduler and its focused fakes share. */
export interface IApiClient {
  readonly host: {
    describe(payload: object, signal?: AbortSignal): Promise<RpcResponse<{ readonly home: string }>>
  }
  readonly sessions: {
    create(payload: {
      readonly sessionId?: string
      readonly cwd?: string
      readonly agentPreset?: string
    }, signal?: AbortSignal): Promise<RpcResponse<{ readonly sessionId: string }>>
    history(payload: {
      readonly sessionId: string
      readonly maxMessages?: number
      readonly beforeSeq?: number
    }, signal?: AbortSignal): Promise<RpcResponse<{
      readonly events: readonly HistoryEntry[]
      readonly hasMore: boolean
    }>>
    prompt(payload: {
      readonly sessionId: string
      readonly mode: 'queue' | 'steer'
      readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    }, signal?: AbortSignal): Promise<RpcResponse<{ readonly accepted: true }>>
  }
  readonly events: {
    mux(payload: object, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>>
    host(payload: object, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>>
  }
  close?(): Promise<void>
}

interface AuthenticatedWeb {
  readonly origin: string
  readonly cookie: string
}

type ChannelItem<Value> =
  | { readonly kind: 'value'; readonly value: Value }
  | { readonly kind: 'end' }
  | { readonly kind: 'error'; readonly error: unknown }

class AsyncChannel<Value> {
  private readonly items: ChannelItem<Value>[] = []
  private wake: (() => void) | undefined
  private ended = false

  push(value: Value): void {
    if (this.ended) return
    this.items.push({ kind: 'value', value })
    this.resume()
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.items.push({ kind: 'end' })
    this.resume()
  }

  fail(error: unknown): void {
    if (this.ended) return
    this.ended = true
    this.items.push({ kind: 'error', error })
    this.resume()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<Value> {
    const abort = (): void => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (true) {
        const item = this.items.shift()
        if (item === undefined) {
          await new Promise<void>((resolve) => { this.wake = resolve })
          continue
        }
        if (item.kind === 'end') return
        if (item.kind === 'error') throw item.error
        yield item.value
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end()
    }
  }

  private resume(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function envelope<Frame>(payload: Frame, rpcId: string = randomUUID()): RpcRequest<Frame> {
  return { rpcId, payload }
}

function response<Value>(result: RpcResult<Value>): RpcResponse<Value> {
  return { rpcId: randomUUID(), result }
}

function eventRecords(records: readonly SessionHistoryRecord[]): HistoryEntry[] {
  return records.flatMap(record => record.type === 'event'
    ? [{ event: record.event as SessionEvent }]
    : [])
}

function queueItems(items: readonly SessionQueuedItem[]): BatchQueueItem[] {
  return items.map(item => ({
    id: item.id,
    placement: item.placement,
    message: {
      id: item.message.id,
      role: 'user',
      content: item.message.content as BatchQueuedMessage['content'],
      source: item.placement === 'context'
        ? { kind: 'plugin' }
        : { kind: 'user', ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }) },
    },
  }))
}

function websocketUrl(origin: string): string {
  const url = new URL('/api/remote.mux', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

/** Node carrier for the current Gateway unary and multiplexed Remote protocols. */
export class NodeWebApiClient implements IApiClient {
  private readonly authentication: Promise<AuthenticatedWeb>
  private readonly sessionIds = new Set<string>()
  private readonly cursors = new Map<string, number>()
  private readonly muxSubscribers = new Set<(sessionId: string) => void>()
  private hostInfo: { readonly home: string } | undefined
  private hostWaiters = new Set<() => void>()

  constructor(private readonly launchUrl: string) {
    this.authentication = this.authenticate()
  }

  readonly host: IApiClient['host'] = {
    describe: async (_payload, signal) => {
      const host = await this.waitForHost(signal)
      return response({ ok: true, value: host })
    },
  }

  readonly sessions: IApiClient['sessions'] = {
    create: async (payload, signal) => {
      const result = await this.call<{ readonly sessionId: string }>('session/create', {
        request: payload,
      }, signal)
      if (result.ok) this.subscribeSession(result.value.sessionId)
      return response(result)
    },
    history: async (payload, signal) => {
      const throughSeq = this.cursors.get(payload.sessionId)
      if (throughSeq === undefined) {
        throw new Error('Session ' + JSON.stringify(payload.sessionId) + ' has no stream baseline')
      }
      const result = await this.call<{
        readonly records: readonly SessionHistoryRecord[]
        readonly hasMore: boolean
      }>('session/page', {
        request: {
          address: { kind: 'session', sessionId: payload.sessionId },
          throughSeq,
          ...(payload.beforeSeq === undefined ? {} : { beforeSeq: payload.beforeSeq }),
          ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
        },
      }, signal)
      return result.ok
        ? response({
          ok: true,
          value: { events: eventRecords(result.value.records), hasMore: result.value.hasMore },
        })
        : response(result)
    },
    prompt: async (payload, signal) => response(await this.call('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId: payload.sessionId,
        mode: payload.mode,
        content: payload.content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }, signal)),
  }

  readonly events: IApiClient['events'] = {
    mux: (_payload, signal, onOpen) => this.openMux(signal, onOpen),
    host: (_payload, signal, onOpen) => this.openHost(signal, onOpen),
  }

  async close(): Promise<void> {
    await this.authentication.catch(() => undefined)
  }

  private async authenticate(): Promise<AuthenticatedWeb> {
    const response = await globalThis.fetch(this.launchUrl, { redirect: 'manual' })
    const setCookie = response.headers.get('set-cookie')
    if (response.status !== 303 || setCookie === null) {
      throw new Error(
        'dsh web authentication returned HTTP ' + String(response.status)
        + '; pass the complete URL printed by dsh web',
      )
    }
    return {
      origin: new URL(this.launchUrl).origin,
      cookie: setCookie.split(';', 1)[0] as string,
    }
  }

  private async call<Value>(
    endpoint: string,
    args: object,
    signal?: AbortSignal,
  ): Promise<RpcResult<Value>> {
    const authenticated = await this.authentication
    const rpcId = randomUUID()
    const reply = await globalThis.fetch(authenticated.origin + '/api/' + endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: authenticated.cookie,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args },
      }),
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!reply.ok) throw new Error(endpoint + ' failed over HTTP ' + String(reply.status))
    const body: unknown = await reply.json()
    if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isRecord(body.result)) {
      throw new TypeError(endpoint + ' returned an invalid server-response envelope')
    }
    const result = body.result
    if (result.ok === true) return { ok: true, value: result.value as Value }
    if (result.ok !== false || !isRecord(result.error)
      || typeof result.error.code !== 'string' || typeof result.error.message !== 'string') {
      throw new TypeError(endpoint + ' returned an invalid result')
    }
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(Object.hasOwn(result.error, 'details') ? { details: result.error.details } : {}),
      },
    }
  }

  private subscribeSession(sessionId: string): void {
    if (this.sessionIds.has(sessionId)) return
    this.sessionIds.add(sessionId)
    for (const subscribe of this.muxSubscribers) subscribe(sessionId)
  }

  private async *openMux(signal: AbortSignal, onOpen?: () => void): AsyncGenerator<RpcRequest<MuxFrame>> {
    const channel = new AsyncChannel<RpcRequest<MuxFrame>>()
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal])
    const tasks = new Set<Promise<void>>()
    const publish = (frame: RpcRequest<MuxFrame>): void => { channel.push(frame) }
    const follow = (sessionId: string): void => {
      const task = this.pumpFollow(sessionId, combined, channel).finally(() => { tasks.delete(task) })
      tasks.add(task)
    }
    this.muxSubscribers.add(follow)
    this.muxFrames.add(publish)
    for (const sessionId of this.sessionIds) follow(sessionId)
    const control = this.pumpControl(combined, channel, onOpen)
    tasks.add(control)
    void control.finally(() => { tasks.delete(control) })
    try {
      yield* channel.iterate(signal)
    } finally {
      this.muxSubscribers.delete(follow)
      this.muxFrames.delete(publish)
      lifetime.abort()
      await Promise.allSettled(tasks)
      channel.end()
    }
  }

  private async pumpControl(
    signal: AbortSignal,
    channel: AsyncChannel<RpcRequest<MuxFrame>>,
    onOpen?: () => void,
  ): Promise<void> {
    let opened = false
    try {
      for await (const value of this.remoteStream('session/control', {}, signal)) {
        const frame = value as SessionControlFrame
        this.applyControlFrame(frame, channel)
        if (!opened) {
          opened = true
          onOpen?.()
        }
      }
      if (!signal.aborted) channel.fail(new Error('Session control stream ended'))
    } catch (error) {
      if (!signal.aborted) channel.fail(error)
    }
  }

  private applyControlFrame(
    frame: SessionControlFrame,
    channel: AsyncChannel<RpcRequest<MuxFrame>>,
  ): void {
    if (frame.type === 'baseline') {
      for (const sessionId of this.sessionIds) {
        channel.push(envelope({
          type: 'session/queue',
          sessionId,
          items: queueItems(frame.value.queues[sessionId as keyof typeof frame.value.queues] ?? []),
        }))
      }
      return
    }
    if (frame.type === 'queue') {
      channel.push(envelope({
        type: 'session/queue',
        sessionId: frame.sessionId,
        items: queueItems(frame.items),
      }))
      return
    }
    channel.push(envelope({
      type: frame.type === 'jobs' ? 'session/jobs' : 'session/projection',
      sessionId: frame.sessionId,
    }))
  }

  private async pumpFollow(
    sessionId: string,
    signal: AbortSignal,
    channel: AsyncChannel<RpcRequest<MuxFrame>>,
  ): Promise<void> {
    try {
      for await (const value of this.remoteStream('session/follow', {
        request: {
          address: { kind: 'session', sessionId },
          maxMessages: 200,
        },
      }, signal)) {
        if (!isRecord(value) || typeof value.type !== 'string') {
          throw new TypeError('session/follow returned an invalid frame')
        }
        if (value.type === 'snapshot') {
          if (!Number.isSafeInteger(value.cursor)) {
            throw new TypeError('session/follow returned an invalid cursor')
          }
          const cursor = value.cursor as number
          this.cursors.set(sessionId, cursor)
          channel.push(envelope({ type: 'session/subscribed', sessionId, lastSeq: cursor }))
          continue
        }
        if (value.type !== 'event' || !isRecord(value.event)) {
          throw new TypeError('session/follow returned an invalid event')
        }
        channel.push(envelope({
          type: 'session/event',
          sessionId,
          event: value.event as unknown as SessionEvent,
        }))
      }
      if (!signal.aborted) channel.fail(new Error('Session ' + JSON.stringify(sessionId) + ' event stream ended'))
    } catch (error) {
      if (!signal.aborted) channel.fail(error)
    }
  }

  private async *openHost(signal: AbortSignal, onOpen?: () => void): AsyncGenerator<RpcRequest<HostFrame>> {
    const channel = new AsyncChannel<RpcRequest<HostFrame>>()
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal])
    const pump = this.pumpHost(combined, channel, onOpen)
    try {
      yield* channel.iterate(signal)
    } finally {
      lifetime.abort()
      await pump
      this.publishHostInfo(undefined)
      channel.end()
    }
  }

  private async pumpHost(
    signal: AbortSignal,
    channel: AsyncChannel<RpcRequest<HostFrame>>,
    onOpen?: () => void,
  ): Promise<void> {
    const pending = new Map<string, { readonly event: string; readonly sessionId: string }>()
    try {
      for await (const value of this.remoteStream('$events', {}, signal)) {
        if (!isRecord(value) || typeof value.type !== 'string') {
          throw new TypeError('Remote event stream returned an invalid frame')
        }
        if (value.type === 'ready') {
          if (typeof value.clientId !== 'string' || !isRecord(value.host) || typeof value.host.home !== 'string') {
            throw new TypeError('Remote event stream returned an invalid ready frame')
          }
          this.publishHostInfo({ home: value.host.home })
          onOpen?.()
          continue
        }
        if (value.type === 'emit') {
          this.publishHostEvent(value, channel)
          continue
        }
        if (value.type === 'waterfall') {
          if (typeof value.eventId !== 'string' || typeof value.agentId !== 'string'
            || typeof value.event !== 'string' || !isRecord(value.request)) {
            throw new TypeError('Remote event stream returned an invalid waterfall frame')
          }
          if (!this.sessionIds.has(value.agentId)) continue
          pending.set(value.eventId, { event: value.event, sessionId: value.agentId })
          this.publishInteractionRequested(value)
          continue
        }
        if (value.type === 'cancel' && typeof value.eventId === 'string') {
          const found = pending.get(value.eventId)
          if (found !== undefined) {
            pending.delete(value.eventId)
            this.publishInteractionResolved(value.eventId, found)
          }
        }
      }
      if (!signal.aborted) channel.fail(new Error('Remote event stream ended'))
    } catch (error) {
      if (!signal.aborted) channel.fail(error)
    }
  }

  private publishHostEvent(
    frame: Record<string, unknown>,
    channel: AsyncChannel<RpcRequest<HostFrame>>,
  ): void {
    if (!Array.isArray(frame.args)) return
    const args: unknown[] = frame.args
    const sessionId = args[0]
    const value = args[1]
    if (typeof sessionId !== 'string') return
    if (frame.event === 'api-session/removed') {
      channel.push(envelope({ type: 'host/session-removed', sessionId }))
    } else if (frame.event === 'api-session/error' && typeof value === 'string') {
      channel.push(envelope({ type: 'host/agent-error', sessionId, message: value }))
    } else if (frame.event === 'api-session/status' && typeof value === 'boolean') {
      channel.push(envelope({ type: 'host/session-status', sessionId, running: value }))
    }
  }

  private publishInteractionRequested(frame: Record<string, unknown>): void {
    const sessionId = frame.agentId as string
    const eventId = frame.eventId as string
    if (frame.event === 'approval/request') {
      this.publishMuxFrame({
        type: 'approval/requested',
        sessionId,
        approvalId: eventId,
      })
    } else if (frame.event === 'user-questions/request') {
      const request = frame.request as Record<string, unknown>
      this.publishMuxFrame({
        type: 'question/requested',
        sessionId,
        questions: Array.isArray(request.questions) ? request.questions : [],
      }, eventId)
    }
  }

  private publishInteractionResolved(
    eventId: string,
    pending: { readonly event: string; readonly sessionId: string },
  ): void {
    if (pending.event === 'approval/request') {
      this.publishMuxFrame({
        type: 'approval/resolved',
        sessionId: pending.sessionId,
        approvalId: eventId,
      })
    } else if (pending.event === 'user-questions/request') {
      this.publishMuxFrame({
        type: 'question/resolved',
        sessionId: pending.sessionId,
        questionRpcId: eventId,
      })
    }
  }

  private readonly muxFrames = new Set<(frame: RpcRequest<MuxFrame>) => void>()

  private publishMuxFrame(frame: MuxFrame, rpcId?: string): void {
    const value = envelope(frame, rpcId)
    for (const publish of this.muxFrames) publish(value)
  }

  private async *remoteStream(
    endpoint: string,
    args: object,
    signal: AbortSignal,
  ): AsyncGenerator {
    const authenticated = await this.authentication
    signal.throwIfAborted()
    const socket = new WebSocket(websocketUrl(authenticated.origin), {
      headers: { cookie: authenticated.cookie },
    })
    const streamId = randomUUID()
    const channel = new AsyncChannel<unknown>()
    let opened = false
    let terminal = false
    const handleOpen = (): void => {
      opened = true
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint,
        payload: { args },
      }))
    }
    const handleMessage = (data: RawData): void => {
      try {
        const frame: unknown = JSON.parse(rawDataText(data))
        if (!isRecord(frame) || frame.streamId !== streamId || typeof frame.type !== 'string') return
        if (frame.type === 'item') {
          channel.push(frame.value)
        } else if (frame.type === 'end') {
          terminal = true
          channel.end()
        } else if (frame.type === 'error') {
          terminal = true
          channel.fail(new Error(endpoint + ' failed: ' + JSON.stringify(frame.error)))
        }
      } catch (error) {
        channel.fail(new Error(endpoint + ' returned an invalid stream frame', { cause: error }))
      }
    }
    const handleError = (error: Error): void => { channel.fail(error) }
    const handleClose = (): void => {
      if (!terminal && !signal.aborted) channel.fail(new Error(endpoint + ' WebSocket closed'))
      else channel.end()
    }
    const handleAbort = (): void => {
      if (opened && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'cancel', streamId }))
      }
      socket.close()
      channel.end()
    }
    socket.on('open', handleOpen)
    socket.on('message', handleMessage)
    socket.on('error', handleError)
    socket.on('close', handleClose)
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      yield* channel.iterate(signal)
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.off('open', handleOpen)
      socket.off('message', handleMessage)
      socket.off('error', handleError)
      socket.off('close', handleClose)
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
      channel.end()
    }
  }

  private publishHostInfo(host: { readonly home: string } | undefined): void {
    this.hostInfo = host
    const waiters = this.hostWaiters
    this.hostWaiters = new Set()
    for (const wake of waiters) wake()
  }

  private async waitForHost(signal?: AbortSignal): Promise<{ readonly home: string }> {
    while (this.hostInfo === undefined) {
      signal?.throwIfAborted()
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', wake)
          resolve()
        }
        this.hostWaiters.add(wake)
        signal?.addEventListener('abort', wake, { once: true })
      })
    }
    return this.hostInfo
  }
}

/** Reconnect policy for the batch event streams. */
export interface BatchConnectionConfig {
  /** Delay before the first reconnect attempt. */
  backoffBaseMs?: number
  /** Exponential multiplier applied after each consecutive failure. */
  backoffFactor?: number
  /** Maximum delay between attempts. */
  backoffMaxMs?: number
  /** Maximum time to wait for both event streams to open. */
  streamOpenTimeoutMs?: number
}

/** Business-frame sinks owned by the batch runner. */
export interface BatchConnectionSinks {
  /** Observe a generation before either event stream can deliver frames. */
  onGenerationStarting?(): void
  /** Receive one validated mux envelope. */
  onMuxEnvelope(envelope: RpcRequest<MuxFrame>): void
  /** Receive one validated Host envelope. */
  onHostEnvelope(envelope: RpcRequest<HostFrame>): void
  /** Observe each generation after both streams and unary RPC are reachable. */
  onConnected?(): void
  /** Receive contained transport and sink diagnostics. */
  onDiagnostic(message: string, error?: unknown): void
}

const CONNECTION_DEFAULTS: Required<BatchConnectionConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  streamOpenTimeoutMs: 3_000,
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

function rejectAfterStreamOpenTimeout(ms: number, signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(expire, ms)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    function expire(): void {
      signal.removeEventListener('abort', cancel)
      reject(new Error(`event streams did not open within ${String(ms)}ms`))
    }
    function cancel(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
  })
}

/**
 * Owns both event streams as one reconnecting lifecycle. `stop()` aborts and
 * awaits the active streams and backoff delay before returning.
 */
export class BatchConnection {
  private readonly config: Required<BatchConnectionConfig>
  private running = false
  private generation: AbortController | undefined
  private backoff: AbortController | undefined
  private loopPromise?: Promise<void>
  private readyPromise?: Promise<void>
  private resolveReady?: () => void
  private rejectReady?: (error: Error) => void
  private ready = false

  constructor(
    private readonly api: IApiClient,
    private readonly sinks: BatchConnectionSinks,
    config: BatchConnectionConfig = {},
  ) {
    this.config = { ...CONNECTION_DEFAULTS, ...config }
  }

  /** Start the reconnect loop and resolve after one complete generation handshake. */
  start(): Promise<void> {
    if (this.loopPromise !== undefined) return this.readyPromise as Promise<void>
    this.running = true
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.loopPromise = this.loop()
    return this.readyPromise
  }

  /** Stop and await all owned streams and timers. */
  async stop(): Promise<void> {
    if (this.loopPromise === undefined) return
    this.running = false
    this.generation?.abort()
    this.backoff?.abort()
    await this.loopPromise
    await this.api.close?.()
  }

  private isRunning(): boolean {
    return this.running
  }

  private async loop(): Promise<void> {
    let attempt = 0
    try {
      while (this.isRunning()) {
        const controller = new AbortController()
        this.generation = controller
        try {
          this.sinks.onGenerationStarting?.()
        } catch (error) {
          this.diagnose('connection generation sink failed', error)
        }
        let muxOpened = (): void => {}
        let hostOpened = (): void => {}
        const streamsOpen = Promise.all([
          new Promise<void>((resolve) => { muxOpened = resolve }),
          new Promise<void>((resolve) => { hostOpened = resolve }),
        ])
        const mux = this.pump(
          this.api.events.mux({}, controller.signal, muxOpened),
          (envelope) => { this.sinks.onMuxEnvelope(envelope) },
        )
        const host = this.pump(
          this.api.events.host({}, controller.signal, hostOpened),
          (envelope) => { this.sinks.onHostEnvelope(envelope) },
        )
        const generationEnded = Promise.race([mux, host])
        const streamOpenDeadline = new AbortController()
        try {
          const description = this.api.host.describe({}, controller.signal)
          const handshake = Promise.all([description, streamsOpen]).then(([response]) => {
            if (!response.result.ok) {
              throw new Error(`host.describe failed: ${response.result.error.code}: ${response.result.error.message}`)
            }
          })
          await Promise.race([
            handshake,
            rejectAfterStreamOpenTimeout(this.config.streamOpenTimeoutMs, streamOpenDeadline.signal),
            generationEnded.then(() => { throw new Error('event stream ended during connection handshake') }),
          ])
          attempt = 0
          try {
            this.sinks.onConnected?.()
          } catch (error) {
            this.diagnose('connection sink failed', error)
          }
          if (!this.ready) {
            this.ready = true
            this.resolveReady?.()
          }
          await generationEnded
          if (this.isRunning()) this.diagnose('event connection lost; reconnecting')
        } catch (error) {
          if (this.isRunning()) this.diagnose('event connection failed; reconnecting', error)
        } finally {
          streamOpenDeadline.abort()
          controller.abort()
          await Promise.allSettled([mux, host])
          if (this.generation === controller) this.generation = undefined
        }
        if (!this.isRunning()) break
        attempt += 1
        const wait = Math.min(
          this.config.backoffMaxMs,
          this.config.backoffBaseMs * this.config.backoffFactor ** Math.max(0, attempt - 1),
        )
        const backoff = new AbortController()
        this.backoff = backoff
        await delay(wait, backoff.signal)
        if (this.backoff === backoff) this.backoff = undefined
      }
    } finally {
      if (!this.ready) this.rejectReady?.(new Error('event connection stopped before it became ready'))
    }
  }

  private async pump<F extends { type: string }>(
    stream: AsyncIterable<RpcRequest<F>>,
    sink: (envelope: RpcRequest<F>) => void,
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope.payload.type === 'stream/error') return
        try {
          sink(envelope)
        } catch (error) {
          this.diagnose('event sink failed', error)
        }
      }
    } catch (error) {
      if (this.isRunning()) this.diagnose('event stream failed', error)
    }
  }

  private diagnose(message: string, error?: unknown): void {
    try {
      this.sinks.onDiagnostic(message, error)
    } catch (diagnosticError) {
      process.stderr.write(`[dsh-web-batch] diagnostic sink failed: ${String(diagnosticError)}\n`)
    }
  }
}
