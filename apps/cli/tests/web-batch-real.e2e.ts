import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DSH_BIN = join(REPO_ROOT, 'apps/cli/lib/bin.js')
const BATCH_BIN = join(REPO_ROOT, 'apps/cli/lib/web-batch-bin.js')
const HAS_KEY = (process.env.DEEPSEEK_API_KEY?.length ?? 0) > 0

async function probePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('port probe returned no address')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return address.port
}

async function waitForWeb(origin: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin)
      if (response.ok) return
    } catch {
      // Connection refusal is the expected startup state.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`dsh web did not listen at ${origin}`)
}

describe.skipIf(!HAS_KEY)('dsh-web-batch real provider smoke', () => {
  it('completes one Web Session through the built executables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-batch-real-'))
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    await mkdir(home)
    await mkdir(workspace)
    const manifest = join(root, 'tasks.jsonl')
    await writeFile(manifest, `${JSON.stringify({
      id: 'real-provider',
      prompt: 'Reply with exactly BATCH_SMOKE_OK and no other text.',
      cwd: workspace,
    })}\n`)
    const port = await probePort()
    const origin = `http://127.0.0.1:${String(port)}`
    const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ')
    const host = execa(process.execPath, [DSH_BIN, 'web', '--port', String(port)], {
      cwd: workspace,
      reject: false,
      env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: nodeOptions },
    })
    try {
      await waitForWeb(origin)
      const result = await execa(process.execPath, [
        BATCH_BIN, 'run', '--url', origin, '--manifest', manifest, '--concurrency', '1',
      ], {
        reject: false,
        timeout: 180_000,
        killSignal: 'SIGKILL',
        env: { DSH_HOME: home },
      })
      expect(result.exitCode, result.stderr).toBe(0)
      const records = result.stdout.split('\n').map(line => JSON.parse(line) as {
        type: string
        state?: string
        text?: string
      })
      expect(records.at(-1)?.type).toBe('batch.finished')
      expect(records.find(record => record.state === 'completed')?.text).toBe('BATCH_SMOKE_OK')
    } finally {
      host.kill('SIGTERM')
      const stopped = await Promise.race([
        host.then(() => true),
        new Promise<false>(resolve => setTimeout(() => { resolve(false) }, 10_000)),
      ])
      if (!stopped) {
        host.kill('SIGKILL')
        await host
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
