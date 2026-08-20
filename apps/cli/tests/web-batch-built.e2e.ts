import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { WebBatchStore } from '../src/web-batch/store.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const batchBin = join(repoRoot, 'apps/cli/lib/web-batch-bin.js')
const cliVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function runBuilt(
  args: readonly string[],
  home: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await execa(process.execPath, [batchBin, ...args], {
    reject: false,
    timeout: 10_000,
    env: {
      DSH_HOME: home,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    },
  })
  return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode ?? -1 }
}

describe.skipIf(!existsSync(batchBin))('dsh-web-batch built bin', () => {
  it('runs under plain Node and publishes both package bins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-batch-built-'))
    cleanup.push(home)
    const version = await runBuilt(['--version'], home)
    expect(version).toEqual({ stdout: cliVersion, stderr: '', code: 0 })
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>
    }
    expect(manifest.bin).toEqual({ dsh: 'lib/bin.js', 'dsh-web-batch': 'lib/web-batch-bin.js' })
  })

  it('prints version-0 status NDJSON from the persisted SQLite database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-batch-built-'))
    cleanup.push(home)
    const cwd = join(home, 'work')
    await mkdir(cwd)
    const batchId = '123e4567-e89b-42d3-a456-426614174000'
    const store = WebBatchStore.create(
      batchId, [{ id: 'task', prompt: 'work', cwd }], 1, () => 'session-fixed', home, 100,
    )
    const task = store.tasks()[0]
    if (task === undefined) throw new Error('task fixture missing')
    store.updateTask({ ...task, state: 'completed', reason: { kind: 'completed' }, text: 'done' })
    store.close()
    const result = await runBuilt(['status', '--batch-id', batchId], home)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.split('\n').map(line => JSON.parse(line) as unknown)).toEqual([
      {
        version: 0, type: 'task.state', batchId, taskId: 'task', sessionId: 'session-fixed',
        state: 'completed', pending: [], reason: { kind: 'completed' }, text: 'done',
      },
      { version: 0, type: 'batch.finished', batchId, counts: { completed: 1, failed: 0, cancelled: 0 } },
    ])
  })

  it('rejects a malformed manifest before opening a network connection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-batch-built-'))
    cleanup.push(home)
    const manifest = join(home, 'tasks.jsonl')
    await writeFile(manifest, '{\n')
    const result = await runBuilt(['run', '--url', 'http://127.0.0.1:1', '--manifest', manifest], home)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('manifest line 1: invalid JSON')
  })
})
