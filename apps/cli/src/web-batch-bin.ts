/** Lazily loaded `dsh web-batch` command runner. */

/* v8 ignore file -- built-bin acceptance exercises this lazily loaded command runner. */

import { CommanderError } from 'commander'
import { parseWebBatchArgs } from './web-batch/args.ts'

const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time'

async function loadCommand(): Promise<typeof import('./web-batch/command.ts')> {
  const emitWarning: typeof process.emitWarning = process.emitWarning.bind(process)
  process.emitWarning = function (...args: unknown[]): void {
    const options = args[1]
    const type = typeof options === 'string'
      ? options
      : typeof options === 'object' && options !== null && 'type' in options
        ? options.type
        : undefined
    if (args[0] === SQLITE_EXPERIMENTAL_WARNING && type === 'ExperimentalWarning') return
    Reflect.apply(emitWarning, process, args)
  }
  try {
    return await import('./web-batch/command.ts')
  } finally {
    process.emitWarning = emitWarning
  }
}

/**
 * Parse and execute one Web batch subcommand invocation.
 * @param argv - Arguments after `dsh web-batch`.
 * @param version - Package version printed by `--version`.
 * @returns Process exit code.
 */
export async function runWebBatchCli(argv: readonly string[], version: string): Promise<number> {
  try {
    const invocation = parseWebBatchArgs(argv, version)
    const { runWebBatchCommand } = await loadCommand()
    return await runWebBatchCommand(invocation)
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    process.stderr.write(`dsh web-batch: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
