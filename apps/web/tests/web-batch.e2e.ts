// Web e2e scenario: the published batch executable creates a Session through
// ApiProxy, while the resident browser remains the sole owner of answering a
// blocking question. The checked NDJSON is the automation-facing transcript.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { execa, type ResultPromise } from 'execa'
import { describe, expect, it } from 'vitest'
import {
  fixtureUserPrompts, launchWebScaffold, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const BATCH_BIN = join(REPO_ROOT, 'apps/cli/lib/web-batch-bin.js')
const FIXTURE = fileURLToPath(new URL('./snapshots/question-composer/session.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./snapshots/web-batch/cli.expected.jsonl', import.meta.url))
const BATCH_ID = '123e4567-e89b-42d3-a456-426614174000'
const MODE = webSnapshotMode()

interface OutputRecord {
  type: string
  sessionId?: string
  state?: string
}

function completeRecords(stdout: string): OutputRecord[] {
  return stdout.split('\n').slice(0, -1).map(line => JSON.parse(line) as OutputRecord)
}

function normalizedNdjson(stdout: string): string {
  return `${completeRecords(stdout).map(record => JSON.stringify({
    ...record,
    ...record.sessionId === undefined ? {} : { sessionId: '{{sessionId}}' },
  })).join('\n')}\n`
}

describe.skipIf(MODE === 'record')('web e2e: dsh-web-batch question round trip', () => {
  it('keeps the browser as interaction owner and completes the same Session', async () => {
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    let child: ResultPromise | undefined
    let settled: ReturnType<WebScaffold['whenTurnSettled']> | undefined
    let primaryFailure: unknown
    try {
      expect(existsSync(BATCH_BIN), 'run pnpm run build before Web e2e').toBe(true)
      const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
      expect(prompts).toHaveLength(1)
      const prompt = prompts[0]
      if (prompt === undefined) throw new Error('question fixture has no user prompt')

      scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: 15 })
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const treeItems = page.locator('[role="treeitem"]')
      const rowsBeforeBatch = await treeItems.count()

      const manifest = join(scaffold.workspaceCwd, 'tasks.jsonl')
      await writeFile(manifest, `${JSON.stringify({
        id: 'question', prompt, cwd: join(scaffold.workspaceCwd, 'workspace'),
      })}\n`)
      let liveStdout = ''
      child = execa(process.execPath, [
        BATCH_BIN,
        'run',
        '--url', scaffold.baseUrl,
        '--manifest', manifest,
        '--batch-id', BATCH_ID,
      ], {
        reject: false,
        stripFinalNewline: false,
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {
          DSH_HOME: join(scaffold.workspaceCwd, '.batch-home'),
        },
      })
      child.stdout?.on('data', (chunk: Buffer) => { liveStdout += chunk.toString() })

      await expect.poll(
        () => completeRecords(liveStdout).some(record => record.state === 'waiting-human'),
        { timeout: 30_000 },
      ).toBe(true)
      const waiting = completeRecords(liveStdout).find(record => record.state === 'waiting-human')
      expect(waiting?.sessionId).toBeTypeOf('string')

      await expect.poll(
        () => treeItems.count(),
        { timeout: 10_000 },
      ).toBeGreaterThan(rowsBeforeBatch)
      const composer = page.locator('[data-question-key]')
      let openedBatchSession = false
      for (let index = 0; index < await treeItems.count(); index++) {
        await treeItems.nth(index).click()
        openedBatchSession = await composer.waitFor({ timeout: 3_000 }).then(() => true, () => false)
        if (openedBatchSession) break
      }
      expect(openedBatchSession, `session rows: ${JSON.stringify(await treeItems.allTextContents())}`).toBe(true)
      await composer.getByRole('checkbox', { name: 'Blue' }).click()
      const custom = composer.getByRole('textbox')
      await custom.fill('Include accessibility notes')
      settled = scaffold.whenTurnSettled(60_000)
      await custom.press('Enter')

      expect(await settled).toBe(waiting?.sessionId)
      const result = await child
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stderr).toBe('')
      expect(normalizedNdjson(result.stdout)).toBe(await readFile(EXPECTED, 'utf8'))
      await expect.poll(() => page?.getByText('DONE', { exact: true }).count(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1)
      expect(await composer.count()).toBe(0)
    } catch (error) {
      primaryFailure = error
      if (page !== undefined) await saveFailureShot(page, 'web-e2e-batch')
      throw error
    } finally {
      if (child !== undefined && child.exitCode === undefined) child.kill('SIGKILL')
      await child?.catch(() => undefined)
      await settled?.catch(() => undefined)
      await browser?.close()
      try {
        await scaffold?.close()
      } catch (error) {
        if (primaryFailure === undefined) throw error
      }
    }
  }, 120_000)
})
