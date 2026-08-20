import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RpcId, type HostFrame, type IApiClient, type MuxFrame, type RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { WebSocketServer } from 'ws'
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

describe('NodeWebApiClient', () => {
  it('uses the configured origin for unary requests and rejects redirects', async () => {
    const seen: string[] = []
    const server = createServer((request, response) => {
      seen.push(request.url ?? '')
      if (request.url === '/api/host.describe') {
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'fixed',
          result: {
            ok: true,
            value: { version: '1', cwd: '/work', attachedSessions: 0, canOpenPath: false },
          },
        }))
        return
      }
      response.writeHead(302, { location: 'http://127.0.0.1:1/leak' })
      response.end()
    })
    const origin = await listen(server)
    class FixedClient extends NodeWebApiClient {
      protected override mintRpcId() { return 'fixed' as never }
    }
    const client = new FixedClient(origin)
    const described = await client.host.describe({})
    expect(described.result.ok).toBe(true)
    await expect(client.sessions.list({})).rejects.toThrow()
    expect(seen).toEqual(['/api/host.describe', '/api/session.list'])
  })

  it('parses WebSocket frames, drops malformed frames, and closes on abort', async () => {
    const server = createServer()
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (websocket) => {
        websocket.send('not-json')
        websocket.send(JSON.stringify({
          type: 'server-request',
          rpcId: 'host-1',
          method: 'host/session-status',
          payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
        }))
      })
    })
    const origin = await listen(server)
    const diagnostics = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const client = new NodeWebApiClient(origin)
    const abort = new AbortController()
    const frames: RpcRequest<HostFrame>[] = []
    for await (const frame of client.events.host({}, abort.signal)) {
      frames.push(frame)
      abort.abort()
    }
    expect(frames).toEqual([{
      rpcId: 'host-1', payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
    }])
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('dropping malformed WebSocket frame'))
    sockets.close()
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
          rpcId: 'describe' as never,
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
      rpcId: RpcId('mux-2'),
      payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: -1 },
    }]]
    const hostFrames: RpcRequest<HostFrame>[][] = [[], [{
      rpcId: RpcId('host-2'),
      payload: { type: 'host/session-status', sessionId: 'session-1' as never, running: true },
    }]]
    const api = {
      host: {
        describe: async () => ({
          rpcId: 'describe' as never,
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
          rpcId: 'describe' as never,
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
