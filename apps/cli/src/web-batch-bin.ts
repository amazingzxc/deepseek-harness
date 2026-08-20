#!/usr/bin/env node
/** Independent dsh-web-batch executable. */

/* v8 ignore file -- built-bin acceptance exercises this self-executing entry. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CommanderError } from 'commander'
import { parseWebBatchArgs } from './web-batch/args.ts'

const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time'

function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

async function loadCommand(): Promise<typeof import('./web-batch/command.ts')> {
  const emitWarning = process.emitWarning
  process.emitWarning = function (...args: unknown[]): void {
    const options = args[1]
    const type = typeof options === 'string'
      ? options
      : typeof options === 'object' && options !== null && 'type' in options
        ? (options as { type?: unknown }).type
        : undefined
    if (args[0] === SQLITE_EXPERIMENTAL_WARNING && type === 'ExperimentalWarning') return
    Reflect.apply(emitWarning, process, args)
  } as typeof process.emitWarning
  try {
    return await import('./web-batch/command.ts')
  } finally {
    process.emitWarning = emitWarning
  }
}

try {
  const invocation = parseWebBatchArgs(process.argv.slice(2), readVersion())
  const { runWebBatchCommand } = await loadCommand()
  process.exitCode = await runWebBatchCommand(invocation)
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode
  } else {
    process.stderr.write(`dsh-web-batch: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
