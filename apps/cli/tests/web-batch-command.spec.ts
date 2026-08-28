import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IApiClient } from '../src/web-batch/transport.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebBatchCommand } from '../src/web-batch/command.ts'
import { WebBatchStore } from '../src/web-batch/store.ts'

const cleanup: string[] = []

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-web-batch-command-'))
  cleanup.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function capture() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: { write(chunk: string) { stdout += chunk } },
      stderr: { write(chunk: string) { stderr += chunk } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

describe('runWebBatchCommand', () => {
  it('replays status in manifest order and reports terminal failures', async () => {
    const home = await tempDir()
    const batchId = randomUUID()
    const cwd0 = join(home, 'work-0')
    const cwd1 = join(home, 'work-1')
    await mkdir(cwd0)
    await mkdir(cwd1)
    let session = 0
    const store = WebBatchStore.create(batchId, [
      { id: 'first', prompt: 'one', cwd: cwd0 },
      { id: 'second', prompt: 'two', cwd: cwd1 },
    ], 2, () => `session-${String(session++)}`, home)
    const [first, second] = store.tasks()
    if (first === undefined || second === undefined) throw new Error('task fixture missing')
    store.updateTask({ ...first, state: 'completed', reason: { kind: 'completed' }, text: 'ok' })
    store.updateTask({ ...second, state: 'failed', reason: { kind: 'error', error: { code: 'X', message: 'bad' } } })
    store.close()

    const output = capture()
    expect(await runWebBatchCommand({ mode: 'status', batchId }, { home, io: output.io })).toBe(1)
    const records = output.stdout().trim().split('\n').map(line => JSON.parse(line) as { type: string; taskId?: string })
    expect(records.map(record => [record.type, record.taskId])).toEqual([
      ['task.state', 'first'],
      ['task.state', 'second'],
      ['batch.finished', undefined],
    ])
    expect(output.stderr()).toBe('')
  })

  it('quiesces on SIGTERM, keeps the Web Session untouched, and releases its lock', async () => {
    const home = await tempDir()
    const cwd = join(home, 'work')
    await mkdir(cwd)
    const manifest = join(home, 'tasks.jsonl')
    await writeFile(manifest, `${JSON.stringify({ id: 'task', prompt: 'work', cwd })}\n`)
    const batchId = randomUUID()
    const signals = new EventEmitter()
    let settleStart = (): void => {}
    const starting = new Promise<void>((resolve) => { settleStart = resolve })
    let stopped = 0
    const output = capture()
    const execution = runWebBatchCommand({
      mode: 'run', launchUrl: 'http://127.0.0.1:1/?token=test', manifest, batchId, concurrency: 1,
    }, {
      home,
      io: output.io,
      uuid: randomUUID,
      api: () => ({ sessions: {} }) as unknown as IApiClient,
      connection: () => ({
        start: () => starting,
        async stop() {
          stopped += 1
          settleStart()
        },
      }),
      process: signals as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    })
    await vi.waitFor(() => { expect(output.stdout()).toContain('batch.started') })
    signals.emit('SIGTERM')
    expect(await execution).toBe(143)
    expect(stopped).toBeGreaterThan(0)
    expect(output.stdout().trim().split('\n').map(line => (JSON.parse(line) as { type: string }).type))
      .toEqual(['batch.started'])

    const reopened = WebBatchStore.open(batchId, home)
    try {
      expect(reopened.tasks()[0]?.state).toBe('queued')
      expect(reopened.runnerLocks()).toHaveLength(1)
      expect(reopened.runnerLocks()[0]?.releasedAt).toBeTypeOf('number')
      reopened.acquireRunner('next-runner', false)
      reopened.releaseRunner('next-runner')
    } finally {
      reopened.close()
    }
  })
})
