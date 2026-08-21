import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { parseBatchId, parsePositiveInteger, parseWebBatchArgs, parseWebOrigin } from '../src/web-batch/args.ts'
import { loadTaskManifest } from '../src/web-batch/manifest.ts'
import {
  BatchLockedError,
  batchDatabasePath,
  WEB_BATCH_APPLICATION_ID,
  WEB_BATCH_SCHEMA_VERSION,
  WebBatchStore,
} from '../src/web-batch/store.ts'

const cleanup: string[] = []

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-web-batch-'))
  cleanup.push(directory)
  return directory
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('dsh-web-batch arguments', () => {
  it('parses every command and canonicalizes values', () => {
    const id = randomUUID()
    expect(parseWebBatchArgs(['run', '--url', 'http://localhost:3141', '--manifest', 'tasks.jsonl'], '1'))
      .toEqual({ mode: 'run', origin: 'http://localhost:3141', manifest: 'tasks.jsonl', concurrency: 1 })
    expect(parseWebBatchArgs([
      'run', '--url', 'https://EXAMPLE.com:443', '--manifest', 'tasks.jsonl',
      '--batch-id', id.toUpperCase(), '--concurrency', '3',
    ], '1')).toEqual({
      mode: 'run', origin: 'https://example.com', manifest: 'tasks.jsonl', batchId: id, concurrency: 3,
    })
    expect(parseWebBatchArgs(['resume', '--url', 'http://127.0.0.1', '--batch-id', id, '--take-over'], '1'))
      .toEqual({ mode: 'resume', origin: 'http://127.0.0.1', batchId: id, takeOver: true })
    expect(parseWebBatchArgs(['status', '--batch-id', id], '1'))
      .toEqual({ mode: 'status', batchId: id })
  })

  it('rejects origins, batch ids, concurrency, and incomplete commands', () => {
    for (const value of [
      'ftp://example.com', 'http://user@example.com', 'http://example.com/a',
      'http://example.com?x=1', 'http://example.com/#x', 'not a url',
    ]) expect(() => parseWebOrigin(value)).toThrow('origin')
    for (const value of ['0', '-1', '1.5', '01', 'x', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => parsePositiveInteger(value)).toThrow('positive')
    }
    expect(() => parseBatchId('task-1')).toThrow('UUID')
    expect(() => parseWebBatchArgs([], '1')).toThrow()
    expect(() => parseWebBatchArgs(['run', '--url', 'http://localhost'], '1')).toThrow()
    expect(() => parseWebBatchArgs(['status', '--batch-id', randomUUID(), '--url', 'http://localhost'], '1')).toThrow()
  })
})

describe('task manifest', () => {
  it('loads strict JSONL, canonicalizes cwd, and preserves multiline prompts', async () => {
    const root = await tempDir()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    const alias = join(root, 'alias')
    await symlink(first, alias, 'dir')
    const path = join(root, 'tasks.jsonl')
    await writeFile(path, [
      '',
      JSON.stringify({ id: 'one', prompt: 'line one\nline two', cwd: alias, agentPreset: 'code' }),
      JSON.stringify({ id: 'two', prompt: 'work', cwd: second }),
      '',
    ].join('\n'))
    expect(await loadTaskManifest(path)).toEqual([
      { id: 'one', prompt: 'line one\nline two', cwd: first, agentPreset: 'code' },
      { id: 'two', prompt: 'work', cwd: second },
    ])
  })

  it('rejects malformed and ambiguous tasks with line diagnostics', async () => {
    const root = await tempDir()
    const cwd = join(root, 'cwd')
    await mkdir(cwd)
    const cases: Array<[string, string]> = [
      ['', 'at least one'],
      ['{', 'line 1: invalid JSON'],
      ['[]', 'line 1: task must be'],
      [JSON.stringify({ id: 'a', prompt: 'p', cwd, extra: true }), 'unknown field'],
      [JSON.stringify({ id: '', prompt: 'p', cwd }), 'id must'],
      [[{ id: 'a', prompt: 'p', cwd }, { id: 'a', prompt: 'q', cwd: root }]
        .map(value => JSON.stringify(value)).join('\n'), 'duplicate id'],
      [JSON.stringify({ id: 'a', prompt: ' ', cwd }), 'prompt must'],
      [JSON.stringify({ id: 'a', prompt: '/compact', cwd }), 'must not start'],
      [JSON.stringify({ id: 'a', prompt: 'p', cwd: 'relative' }), 'absolute directory'],
      [JSON.stringify({ id: 'a', prompt: 'p', cwd: join(root, 'missing') }), 'absolute directory'],
      [JSON.stringify({ id: 'a', prompt: 'p', cwd, agentPreset: '' }), 'agentPreset'],
      [[{ id: 'a', prompt: 'p', cwd }, { id: 'b', prompt: 'q', cwd }]
        .map(value => JSON.stringify(value)).join('\n'), 'duplicate canonical cwd'],
    ]
    for (const [contents, message] of cases) {
      const path = join(root, `${randomUUID()}.jsonl`)
      await writeFile(path, contents)
      await expect(loadTaskManifest(path)).rejects.toThrow(message)
    }
  })
})

describe('WebBatchStore', () => {
  it('creates private versioned state with preallocated sessions in manifest order', async () => {
    const home = await tempDir()
    await chmod(home, 0o755)
    const batchId = randomUUID()
    const cwd1 = join(home, 'work-1')
    const cwd2 = join(home, 'work-2')
    await mkdir(cwd1)
    await mkdir(cwd2)
    const ids = ['session-1', 'session-2']
    const store = WebBatchStore.create(batchId, [
      { id: 'one', prompt: 'first', cwd: cwd1 },
      { id: 'two', prompt: 'second', cwd: cwd2, agentPreset: 'code' },
    ], 2, () => {
      const id = ids.shift()
      if (id === undefined) throw new Error('session id fixture exhausted')
      return id
    }, home, 100)
    expect(store.batch()).toEqual({ batchId, concurrency: 2, createdAt: 100 })
    expect(store.tasks()).toEqual([
      expect.objectContaining({ position: 0, id: 'one', sessionId: 'session-1', state: 'queued', pending: [] }),
      expect.objectContaining({ position: 1, id: 'two', sessionId: 'session-2', state: 'queued', pending: [] }),
    ])
    store.close()

    const path = batchDatabasePath(batchId, home)
    expect((await stat(join(home, 'web-batches'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(home, 'web-batches', batchId))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const db = new DatabaseSync(path)
    expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: WEB_BATCH_APPLICATION_ID })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: WEB_BATCH_SCHEMA_VERSION })
    db.close()
  })

  it('persists task updates and runner lock history across reopen', async () => {
    const home = await tempDir()
    const batchId = randomUUID()
    const cwd = join(home, 'work')
    await mkdir(cwd)
    const store = WebBatchStore.create(
      batchId, [{ id: 'one', prompt: 'first', cwd }], 1, () => 'session-1', home, 100,
    )
    const task = store.tasks()[0]!
    store.updateTask({
      ...task,
      state: 'waiting-human',
      pending: [{ kind: 'question', id: 'q-1' }],
      promptSeq: 2,
      turn: 1,
      text: 'partial',
    })
    store.acquireRunner('runner-1', false, 110)
    expect(() => { store.acquireRunner('runner-2', false, 120) }).toThrow(BatchLockedError)
    store.acquireRunner('runner-2', true, 130)
    expect(store.runnerLocks()).toEqual([
      { lockId: 'runner-1', acquiredAt: 110, supersededBy: 'runner-2' },
      { lockId: 'runner-2', acquiredAt: 130 },
    ])
    store.releaseRunner('runner-2', 140)
    store.close()

    const reopened = WebBatchStore.open(batchId, home)
    expect(reopened.tasks()[0]).toEqual(expect.objectContaining({
      state: 'waiting-human', pending: [{ kind: 'question', id: 'q-1' }], promptSeq: 2, turn: 1, text: 'partial',
    }))
    expect(reopened.runnerLocks()[1]).toEqual({ lockId: 'runner-2', acquiredAt: 130, releasedAt: 140 })
    reopened.acquireRunner('runner-3', false, 150)
    reopened.releaseRunner('runner-3', 160)
    reopened.close()
  })

  it('rejects foreign, unversioned, and incompatible databases before mutation', async () => {
    const home = await tempDir()
    for (const [configure, message] of [
      [(db: DatabaseSync) => { db.exec('CREATE TABLE foreign_table (id INTEGER)') }, 'unversioned'],
      [(db: DatabaseSync) => {
        db.exec(`PRAGMA application_id = 123; PRAGMA user_version = ${WEB_BATCH_SCHEMA_VERSION}`)
      }, 'application id'],
      [(db: DatabaseSync) => {
        db.exec(`PRAGMA application_id = ${WEB_BATCH_APPLICATION_ID}; PRAGMA user_version = 99`)
      }, 'schema version'],
    ] as const) {
      const batchId = randomUUID()
      const directory = join(home, 'web-batches', batchId)
      await mkdir(directory, { recursive: true })
      const path = join(directory, 'state.sqlite')
      const db = new DatabaseSync(path)
      configure(db)
      db.close()
      expect(() => WebBatchStore.open(batchId, home)).toThrow(message)
      const check = new DatabaseSync(path)
      expect(check.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'batches'").get())
        .toEqual({ count: 0 })
      check.close()
    }
  })
})
