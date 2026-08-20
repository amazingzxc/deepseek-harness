#!/usr/bin/env node
/** Independent dsh-web-batch executable. */

/* v8 ignore file -- built-bin acceptance exercises this self-executing entry. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CommanderError } from 'commander'
import { parseWebBatchArgs } from './web-batch/args.ts'
import { runWebBatchCommand } from './web-batch/command.ts'

function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

try {
  const invocation = parseWebBatchArgs(process.argv.slice(2), readVersion())
  process.exitCode = await runWebBatchCommand(invocation)
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode
  } else {
    process.stderr.write(`dsh-web-batch: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
