import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  promises as fsPromises,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Access, QueuedMessage, StatePaths, ThreadMap } from './types.js'

export function getStatePaths(stateDir = defaultStateDir()): StatePaths {
  return {
    stateDir,
    envFile: join(stateDir, '.env'),
    accessFile: join(stateDir, 'access.json'),
    approvedDir: join(stateDir, 'approved'),
    inboxDir: join(stateDir, 'inbox'),
    queueFile: join(stateDir, 'queue.json'),
    threadsFile: join(stateDir, 'threads.json'),
  }
}

export function defaultStateDir(): string {
  return (
    process.env.CODEX_DISCORD_STATE_DIR ??
    process.env.DISCORD_STATE_DIR ??
    join(homedir(), '.codex', 'discord')
  )
}

export function ensureStateDir(paths = getStatePaths()): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
}

export function loadStateEnv(paths = getStatePaths()): void {
  try {
    chmodSync(paths.envFile, 0o600)
  } catch {}

  let raw = ''
  try {
    raw = readFileSync(paths.envFile, 'utf8')
  } catch {
    return
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
    if (!match) continue
    const [, key, value] = match
    if (process.env[key] === undefined) process.env[key] = unquoteEnv(value)
  }
}

function unquoteEnv(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function writeToken(token: string, paths = getStatePaths()): void {
  ensureStateDir(paths)
  writeFileSync(paths.envFile, `DISCORD_BOT_TOKEN=${token.trim()}\n`, { mode: 0o600 })
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowUsers: [],
    channels: {},
    pending: {},
    chunkMode: 'newline',
    replyToMode: 'first',
  }
}

export function loadAccess(paths = getStatePaths()): Access {
  const parsed = readJson<Partial<Access>>(paths.accessFile, undefined)
  if (!parsed) return defaultAccess()

  return {
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowUsers: parsed.allowUsers ?? [],
    channels: parsed.channels ?? {},
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode ?? 'first',
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode ?? 'newline',
  }
}

export async function saveAccess(access: Access, paths = getStatePaths()): Promise<void> {
  await writeJsonAtomic(paths.accessFile, access)
}

export function pruneExpiredPending(access: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, pending] of Object.entries(access.pending)) {
    if (pending.expiresAt <= now) {
      delete access.pending[code]
      changed = true
    }
  }
  return changed
}

export async function approvePendingCode(
  code: string,
  paths = getStatePaths(),
): Promise<PendingEntryApproval> {
  const access = loadAccess(paths)
  const pending = access.pending[code]
  if (!pending) {
    throw new Error(`No pending pairing code: ${code}`)
  }
  if (pending.expiresAt <= Date.now()) {
    delete access.pending[code]
    await saveAccess(access, paths)
    throw new Error(`Pairing code expired: ${code}`)
  }

  if (!access.allowUsers.includes(pending.senderId)) {
    access.allowUsers.push(pending.senderId)
  }
  delete access.pending[code]
  await saveAccess(access, paths)

  mkdirSync(paths.approvedDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(paths.approvedDir, pending.senderId), pending.chatId, { mode: 0o600 })

  return { senderId: pending.senderId, chatId: pending.chatId, username: pending.username }
}

export type PendingEntryApproval = {
  senderId: string
  chatId: string
  username?: string
}

export async function appendQueuedMessage(
  message: QueuedMessage,
  paths = getStatePaths(),
): Promise<void> {
  const queue = readQueue(paths)
  if (!queue.some(item => item.id === message.id)) {
    queue.push(message)
    await writeJsonAtomic(paths.queueFile, queue.slice(-500))
  }
}

export function readQueue(paths = getStatePaths()): QueuedMessage[] {
  return readJson<QueuedMessage[]>(paths.queueFile, [])
}

export function listPendingMessages(limit = 20, paths = getStatePaths()): QueuedMessage[] {
  return readQueue(paths)
    .filter(message => message.status === 'pending')
    .slice(0, Math.max(1, Math.min(limit, 100)))
}

export async function markMessageHandled(id: string, paths = getStatePaths()): Promise<boolean> {
  const queue = readQueue(paths)
  let changed = false
  for (const item of queue) {
    if (item.id === id) {
      item.status = 'handled'
      changed = true
      break
    }
  }
  if (changed) await writeJsonAtomic(paths.queueFile, queue)
  return changed
}

export function loadThreads(paths = getStatePaths()): ThreadMap {
  return readJson<ThreadMap>(paths.threadsFile, {})
}

export async function saveThread(
  chatId: string,
  threadId: string,
  paths = getStatePaths(),
): Promise<void> {
  const threads = loadThreads(paths)
  threads[chatId] = threadId
  await writeJsonAtomic(paths.threadsFile, threads)
}

export async function removeThread(chatId: string, paths = getStatePaths()): Promise<void> {
  const threads = loadThreads(paths)
  delete threads[chatId]
  await writeJsonAtomic(paths.threadsFile, threads)
}

export function clearStateFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true })
}

function readJson<T>(path: string, fallback: T): T
function readJson<T>(path: string, fallback: T | undefined): T | undefined
function readJson<T>(path: string, fallback: T | undefined): T | undefined {
  let raw: string
  try {
    raw = readFileWithRetry(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return fallback
    throw err
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {}
    return fallback
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await fsPromises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    await renameWithRetry(tmp, path)
  } catch (err) {
    await fsPromises.rm(tmp, { force: true })
    throw err
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const delays = [0, 25, 75, 150]
  let lastError: unknown

  for (const delay of delays) {
    if (delay > 0) await delayMs(delay)
    try {
      await fsPromises.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY') throw err
      lastError = err
    }
  }

  throw lastError
}

function readFileWithRetry(path: string): string {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY') throw err
      lastError = err
    }
  }
  throw lastError
}

async function delayMs(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
