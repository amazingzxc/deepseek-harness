/** Strict JSONL manifest loader for dsh-web-batch. */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { BatchTaskInput } from './types.ts'

const TASK_KEYS = new Set(['id', 'prompt', 'cwd', 'agentPreset'])

function lineError(line: number, message: string): Error {
  return new Error(`manifest line ${String(line)}: ${message}`)
}

/**
 * Load and validate a task manifest.
 * @param path - JSONL manifest path.
 * @returns Tasks in non-empty-line order, with canonical working directories.
 */
export async function loadTaskManifest(path: string): Promise<BatchTaskInput[]> {
  const text = await readFile(path, 'utf8')
  const tasks: BatchTaskInput[] = []
  const ids = new Set<string>()
  const directories = new Set<string>()
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (raw.trim() === '') continue
    const line = index + 1
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw lineError(line, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw lineError(line, 'task must be a JSON object')
    }
    const record = value as Record<string, unknown>
    const unknown = Object.keys(record).filter(key => !TASK_KEYS.has(key))
    if (unknown.length > 0) throw lineError(line, `unknown field ${JSON.stringify(unknown[0])}`)
    if (typeof record.id !== 'string' || record.id.trim() === '') throw lineError(line, 'id must be a non-empty string')
    if (ids.has(record.id)) throw lineError(line, `duplicate id ${JSON.stringify(record.id)}`)
    if (typeof record.prompt !== 'string' || record.prompt.trim() === '') {
      throw lineError(line, 'prompt must be a non-empty string')
    }
    if (record.prompt.startsWith('/')) throw lineError(line, 'prompt must not start with "/"')
    if (typeof record.cwd !== 'string' || !isAbsolute(record.cwd)) {
      throw lineError(line, 'cwd must be an existing absolute directory')
    }
    if (record.agentPreset !== undefined
      && (typeof record.agentPreset !== 'string' || record.agentPreset.trim() === '')) {
      throw lineError(line, 'agentPreset must be a non-empty string when present')
    }
    let cwd: string
    try {
      cwd = await realpath(record.cwd)
      if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
    } catch {
      throw lineError(line, 'cwd must be an existing absolute directory')
    }
    if (directories.has(cwd)) throw lineError(line, `duplicate canonical cwd ${JSON.stringify(cwd)}`)
    ids.add(record.id)
    directories.add(cwd)
    tasks.push({
      id: record.id,
      prompt: record.prompt,
      cwd,
      ...record.agentPreset === undefined ? {} : { agentPreset: record.agentPreset },
    })
  }
  if (tasks.length === 0) throw new Error('manifest must contain at least one task')
  return tasks
}
