import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DSH_BIN = join(REPO_ROOT, 'apps/cli/lib/bin.js')
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

function waitForLaunchUrl(child: { readonly stdout?: Readable | null; readonly stderr?: Readable | null }): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { reject(new Error(`dsh web did not become ready:\n${output}`)) }, 30_000)
    const append = (chunk: Buffer | string): void => {
      output += String(chunk)
      const launchUrl = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
      if (launchUrl === undefined) return
      clearTimeout(timer)
      resolve(launchUrl)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
  })
}

describe.skipIf(!HAS_KEY)('dsh web-batch real provider smoke', () => {
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
    const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ')
    const host = execa(process.execPath, [DSH_BIN, 'web', '--no-open', '--port', String(port)], {
      cwd: workspace,
      reject: false,
      env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: nodeOptions },
    })
    try {
      const launchUrl = await waitForLaunchUrl(host)
      const result = await execa(process.execPath, [
        DSH_BIN, 'web-batch', 'run', '--url', launchUrl, '--manifest', manifest, '--concurrency', '1',
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
