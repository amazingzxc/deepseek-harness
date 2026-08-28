import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HostFrame, IApiClient, MuxFrame, RpcRequest } from '../src/web-batch/transport.ts'
import { type RawData, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BatchConnection, NodeWebApiClient } from '../src/web-batch/transport.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })))
  vi.restoreAllMocks()
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

describe('NodeWebApiClient', () => {
  it('exchanges the launch token, sends authenticated unary requests, and rejects redirects', async () => {
    const seen: string[] = []
    const server = createServer((request, response) => {
      seen.push(request.url ?? '')
      if (request.url === '/?token=test') {
        request.resume()
        response.writeHead(303, { location: '/', 'set-cookie': 'dsh=test; HttpOnly' })
        response.end()
        return
      }
      if (request.url === '/api/session/create') {
        let body = ''
        request.on('data', (chunk: Buffer | string) => {
          body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        })
        request.on('end', () => {
          const envelope = JSON.parse(body) as { rpcId: string }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            type: 'server-response',
            rpcId: envelope.rpcId,
            result: { ok: true, value: { sessionId: 'session-1' } },
          }))
        })
        return
      }
      response.writeHead(302, { location: 'http://127.0.0.1:1/leak' })
      response.end()
    })
    const origin = await listen(server)
    const client = new NodeWebApiClient(`${origin}/?token=test`)
    const created = await client.sessions.create({})
    expect(created.result).toEqual({ ok: true, value: { sessionId: 'session-1' } })
    await expect(client.sessions.prompt({
      sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'x' }],
    })).rejects.toThrow()
    expect(seen).toEqual(['/?token=test', '/api/session/create', '/api/session/prompt'])
  })

  it('maps Remote host events and closes the stream on abort', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/?token=test') {
        response.writeHead(303, { location: '/', 'set-cookie': 'dsh=test; HttpOnly' })
        response.end()
        return
      }
      response.writeHead(404)
      response.end()
    })
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (websocket) => {
        websocket.on('message', (raw) => {
          const opened = JSON.parse(rawDataText(raw)) as { type: string; streamId: string; endpoint?: string }
          if (opened.type !== 'open') return
          expect(opened.endpoint).toBe('$events')
          websocket.send(JSON.stringify({ type: 'item', streamId: opened.streamId, value: {
            type: 'ready', clientId: 'client-1', host: { home: '/home' },
          } }))
          websocket.send(JSON.stringify({ type: 'item', streamId: 'unrelated', value: null }))
          websocket.send(JSON.stringify({ type: 'item', streamId: opened.streamId, value: {
            type: 'emit', event: 'api-session/status', args: ['session-1', true],
          } }))
        })
      })
    })
    const origin = await listen(server)
    const client = new NodeWebApiClient(`${origin}/?token=test`)
    const abort = new AbortController()
    const frames: RpcRequest<HostFrame>[] = []
    for await (const frame of client.events.host({}, abort.signal)) {
      frames.push(frame)
      abort.abort()
    }
    expect(frames).toEqual([expect.objectContaining({
      payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
    })])
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
  })
})

function stream<F>(
  frames: readonly RpcRequest<F>[],
  onOpen: (() => void) | undefined,
  hold: Promise<void>,
): AsyncIterable<RpcRequest<F>> {
  return {
    async *[Symbol.asyncIterator]() {
      onOpen?.()
      for (const frame of frames) yield frame
      await hold
    },
  }
}

function openUntilAbort<F>(
  signal: AbortSignal,
  onOpen: (() => void) | undefined,
): AsyncIterable<RpcRequest<F>> {
  return {
    async *[Symbol.asyncIterator]() {
      onOpen?.()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
        if (signal.aborted) resolve()
      })
    },
  }
}

describe('BatchConnection', () => {
  it('reconnects when one event stream does not open before the deadline', async () => {
    let generation = 0
    let starts = 0
    const diagnostics: string[] = []
    const api = {
      host: {
        describe: async () => ({
          rpcId: 'describe',
          result: {
            ok: true as const,
            value: { version: '1', cwd: '/work', attachedSessions: 0, canOpenPath: false },
          },
        }),
      },
      events: {
        mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => {
          return openUntilAbort<MuxFrame>(signal, generation === 0 ? undefined : onOpen)
        },
        host: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => {
          generation += 1
          return openUntilAbort<HostFrame>(signal, onOpen)
        },
      },
    } as unknown as IApiClient
    const connection = new BatchConnection(api, {
      onGenerationStarting() { starts += 1 },
      onMuxEnvelope() {},
      onHostEnvelope() {},
      onDiagnostic: (message) => { diagnostics.push(message) },
    }, { backoffBaseMs: 1, backoffMaxMs: 1, streamOpenTimeoutMs: 5 })

    await connection.start()
    expect(generation).toBe(2)
    expect(starts).toBe(2)
    expect(diagnostics).toContain('event connection failed; reconnecting')
    await connection.stop()
  })

  it('reconnects both streams, isolates sink failures, and stops at quiescence', async () => {
    let generation = 0
    let releaseFirst = (): void => {}
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve })
    let releaseSecond = (): void => {}
    const secondDone = new Promise<void>((resolve) => { releaseSecond = resolve })
    const muxFrames: RpcRequest<MuxFrame>[][] = [[], [{
      rpcId: 'mux-2',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: -1 },
    }]]
    const hostFrames: RpcRequest<HostFrame>[][] = [[], [{
      rpcId: 'host-2',
      payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
    }]]
    const api = {
      host: {
        describe: async () => ({
          rpcId: 'describe',
          result: {
            ok: true as const,
            value: { version: '1', cwd: '/work', attachedSessions: 0, canOpenPath: false },
          },
        }),
      },
      events: {
        mux: (_payload: unknown, _signal: AbortSignal, onOpen?: () => void) => {
          const index = generation
          return stream(muxFrames[index] ?? [], onOpen, index === 0 ? firstDone : secondDone)
        },
        host: (_payload: unknown, _signal: AbortSignal, onOpen?: () => void) => {
          const index = generation++
          return stream(hostFrames[index] ?? [], onOpen, index === 0 ? firstDone : secondDone)
        },
      },
    } as unknown as IApiClient
    const mux: RpcRequest<MuxFrame>[] = []
    const host: RpcRequest<HostFrame>[] = []
    const diagnostics: string[] = []
    const connection = new BatchConnection(api, {
      onMuxEnvelope(envelope) {
        mux.push(envelope)
        throw new Error('sink defect')
      },
      onHostEnvelope: (envelope) => { host.push(envelope) },
      onDiagnostic: (message) => { diagnostics.push(message) },
    }, { backoffBaseMs: 1, backoffMaxMs: 1 })
    await connection.start()
    releaseFirst()
    await vi.waitFor(() => {
      expect(mux).toHaveLength(1)
      expect(host).toHaveLength(1)
    })
    expect(diagnostics).toContain('event sink failed')
    const stopped = connection.stop()
    releaseSecond()
    await stopped
    expect(generation).toBe(2)
  })

  it('contains diagnostic sink failures', async () => {
    const ended = Promise.resolve()
    const api = {
      host: {
        describe: async () => ({
          rpcId: 'describe',
          result: {
            ok: true as const,
            value: { version: '1', cwd: '/work', attachedSessions: 0, canOpenPath: false },
          },
        }),
      },
      events: {
        mux: (_payload: unknown, _signal: AbortSignal, onOpen?: () => void) => stream([], onOpen, ended),
        host: (_payload: unknown, _signal: AbortSignal, onOpen?: () => void) => stream([], onOpen, ended),
      },
    } as unknown as IApiClient
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const connection = new BatchConnection(api, {
      onMuxEnvelope() {},
      onHostEnvelope() {},
      onDiagnostic() { throw new Error('diagnostic defect') },
    }, { backoffBaseMs: 1, backoffMaxMs: 1 })
    const ready = connection.start()
    await vi.waitFor(() => {
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('diagnostic sink failed'))
    })
    await connection.stop()
    await expect(ready).resolves.toBeUndefined()
  })
})
