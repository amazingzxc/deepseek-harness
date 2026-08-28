/** Command-line parser for the independent dsh-web-batch executable. */

import { Command, CommanderError } from 'commander'

/** Start a new batch from a JSONL manifest. */
interface RunBatchInvocation {
  mode: 'run'
  launchUrl: string
  manifest: string
  batchId?: string
  concurrency: number
}

/** Resume a persisted non-terminal batch. */
interface ResumeBatchInvocation {
  mode: 'resume'
  launchUrl: string
  batchId: string
  takeOver: boolean
}

/** Print the persisted state of a batch without connecting to its Web Host. */
interface StatusBatchInvocation {
  mode: 'status'
  batchId: string
}

/** Resolved dsh-web-batch invocation. */
export type WebBatchInvocation = RunBatchInvocation | ResumeBatchInvocation | StatusBatchInvocation

/** Validate and canonicalize the authenticated URL printed by `dsh web`. */
export function parseWebLaunchUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('--url must be the complete HTTP(S) URL printed by dsh web')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.hash !== ''
    || url.searchParams.size !== 1
    || !/^[A-Za-z0-9_-]+$/u.test(url.searchParams.get('token') ?? '')) {
    throw new Error('--url must be the complete HTTP(S) root URL with one token query printed by dsh web')
  }
  return url.href
}

/** Parse a positive integer option. */
export function parsePositiveInteger(value: string, option = '--concurrency'): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${option} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a positive safe integer`)
  return parsed
}

/** Validate a batch identity used as one on-disk path segment. */
export function parseBatchId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('--batch-id must be a UUID')
  }
  return value.toLowerCase()
}

/**
 * Parse arguments after the dsh-web-batch executable name.
 * @param argv - Command arguments.
 * @param version - Package version printed by `--version`.
 * @returns The validated invocation.
 */
export function parseWebBatchArgs(argv: readonly string[], version: string): WebBatchInvocation {
  let resolved: WebBatchInvocation | undefined
  const program = new Command()
    .name('dsh web-batch')
    .description('Drive recoverable task batches through an already-running dsh web host.')
    .version(version, '-V, --version', 'output the version number')
    .showHelpAfterError()
    .exitOverride()

  program.command('run')
    .requiredOption('--url <launch-url>', 'complete authenticated URL printed by dsh web')
    .requiredOption('--manifest <path>', 'JSONL task manifest')
    .option('--batch-id <uuid>', 'batch identity (generated when omitted)')
    .option('--concurrency <positive-int>', 'fixed concurrency', '1')
    .action((options: { url: string; manifest: string; batchId?: string; concurrency: string }) => {
      resolved = {
        mode: 'run',
        launchUrl: parseWebLaunchUrl(options.url),
        manifest: options.manifest,
        ...options.batchId === undefined ? {} : { batchId: parseBatchId(options.batchId) },
        concurrency: parsePositiveInteger(options.concurrency),
      }
    })

  program.command('resume')
    .requiredOption('--url <launch-url>', 'complete authenticated URL printed by dsh web')
    .requiredOption('--batch-id <uuid>', 'batch identity')
    .option('--take-over', 'replace an abandoned runner lock while preserving it')
    .action((options: { url: string; batchId: string; takeOver?: boolean }) => {
      resolved = {
        mode: 'resume',
        launchUrl: parseWebLaunchUrl(options.url),
        batchId: parseBatchId(options.batchId),
        takeOver: options.takeOver === true,
      }
    })

  program.command('status')
    .requiredOption('--batch-id <uuid>', 'batch identity')
    .action((options: { batchId: string }) => {
      resolved = { mode: 'status', batchId: parseBatchId(options.batchId) }
    })

  try {
    program.parse([...argv], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) throw error
    program.error(error instanceof Error ? error.message : String(error))
  }
  if (resolved === undefined) program.error('a command is required: run, resume, or status')
  return resolved as WebBatchInvocation
}
