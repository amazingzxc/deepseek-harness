/** Node ApiProxy carrier and reconnecting dual-stream controller. */

import {
  AbstractApiClient,
  type IApiClient,
} from '@deepseek-ai/dsh-host-apiproxy/client'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

const MUX_EVENTS_PATH = '/api/events.mux'
const HOST_EVENTS_PATH = '/api/events.host'

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/** ApiProxy client for Node: HTTP upstream and WebSocket event downlinks. */
export class NodeWebApiClient extends AbstractApiClient {
  constructor(private readonly origin: string, timeoutMs?: number) {
    super(timeoutMs)
  }

  protected override resolveBase(): string {
    return this.origin
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, { ...init, redirect: 'error' })
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    let ended = false
    const enqueue = (item: SocketItem<F>): void => {
      if (item.kind === 'end') {
        if (ended) return
        ended = true
      } else if (ended) {
        return
      }
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent<unknown>): void => {
      let full: ServerRequest
      let frame: F
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        process.stderr.write(`[dsh-web-batch] dropping malformed WebSocket frame on ${path}: ${String(error)}\n`)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    const handleEnd = (): void => { enqueue({ kind: 'end' }) }
    const handleAbort = (): void => {
      enqueue({ kind: 'end' })
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleEnd, { once: true })
    socket.addEventListener('error', handleEnd, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleEnd)
      socket.removeEventListener('error', handleEnd)
      handleAbort()
    }
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
