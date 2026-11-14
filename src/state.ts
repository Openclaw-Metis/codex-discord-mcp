import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  promises as fsPromises,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Access, GroupPolicy, QueuedMessage, StatePaths, ThreadMap } from './types.js'

export function getStatePaths(stateDir = defaultStateDir()): StatePaths {
  return {
    stateDir,
    envFile: join(stateDir, '.env'),
    accessFile: join(stateDir, 'access.json'),
    approvedDir: join(stateDir, 'approved'),
    botPidFile: join(stateDir, 'bot.pid'),
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
    channels: normalizeChannels(parsed.channels),
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode ?? 'first',
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode ?? 'newline',
  }
}

// access.json may be hand-edited; a channel entry missing fields must not
// crash the inbound gate. Missing requireMention defaults to the safe value.
function normalizeChannels(
  channels: Record<string, Partial<GroupPolicy> | null> | undefined,
): Record<string, GroupPolicy> {
  const normalized: Record<string, GroupPolicy> = {}
  for (const [channelId, policy] of Object.entries(channels ?? {})) {
    if (!policy || typeof policy !== 'object') continue
    normalized[channelId] = {
      requireMention: policy.requireMention ?? true,
      allowUsers: Array.isArray(policy.allowUsers)
        ? policy.allowUsers.filter((user): user is string => typeof user === 'string')
        : [],
    }
  }
  return normalized
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

// Queue updates are read-modify-write. Serialize them per file within this
// process, or two concurrent updates (an inbound append while another channel
// marks its message handled) can silently drop one of the writes.
const fileLocks = new Map<string, Promise<unknown>>()

function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  fileLocks.set(path, tail)
  void tail.then(() => {
    if (fileLocks.get(path) === tail) fileLocks.delete(path)
  })
  return run
}

export async function appendQueuedMessage(
  message: QueuedMessage,
  paths = getStatePaths(),
): Promise<void> {
  await withFileLock(paths.queueFile, async () => {
    const queue = readQueue(paths)
    if (!queue.some(item => item.id === message.id)) {
      queue.push(message)
      await writeJsonAtomic(paths.queueFile, queue.slice(-500))
    }
  })
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
  return (await markMessagesHandled([id], paths)) > 0
}

// Mark several queued messages handled with a single queue rewrite. Returns
// how many entries changed status.
export async function markMessagesHandled(
  ids: string[],
  paths = getStatePaths(),
): Promise<number> {
  if (ids.length === 0) return 0
  const wanted = new Set(ids)
  return await withFileLock(paths.queueFile, async () => {
    const queue = readQueue(paths)
    let changed = 0
    for (const item of queue) {
      if (wanted.has(item.id) && item.status !== 'handled') {
        item.status = 'handled'
        changed += 1
      }
    }
    if (changed > 0) await writeJsonAtomic(paths.queueFile, queue)
    return changed
  })
}

// Remove regular files in `dir` (non-recursive) older than maxAgeMs. Used to
// keep the attachment inbox from growing without bound. Returns the count.
export function pruneOldFiles(dir: string, maxAgeMs: number, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile() || now - stat.mtimeMs <= maxAgeMs) continue
      rmSync(path, { force: true })
      removed += 1
    } catch {
      // vanished or unreadable; skip
    }
  }
  return removed
}

export function loadThreads(paths = getStatePaths()): ThreadMap {
  return readJson<ThreadMap>(paths.threadsFile, {})
}

export async function saveThread(
  chatId: string,
  threadId: string,
  paths = getStatePaths(),
): Promise<void> {
  await withFileLock(paths.threadsFile, async () => {
    const threads = loadThreads(paths)
    threads[chatId] = threadId
    await writeJsonAtomic(paths.threadsFile, threads)
  })
}

export async function removeThread(chatId: string, paths = getStatePaths()): Promise<void> {
  await withFileLock(paths.threadsFile, async () => {
    const threads = loadThreads(paths)
    if (!(chatId in threads)) return
    delete threads[chatId]
    await writeJsonAtomic(paths.threadsFile, threads)
  })
}

export function clearStateFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true })
}

export type ProcessLock = {
  path: string
  pid: number
  release: () => void
}

export function acquireProcessLock(
  path: string,
  label: string,
  pid = process.pid,
): ProcessLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: 'wx', mode: 0o600 })
      return buildProcessLock(path, pid)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err

      const owner = readPidFile(path)
      if (owner && isProcessAlive(owner)) {
        throw new Error(`${label} is already running with pid ${owner}`)
      }

      rmSync(path, { force: true })
    }
  }

  throw new Error(`${label} lock could not be acquired at ${path}`)
}

// The pid of a live process (other than `selfPid`) holding the lock file, if
// any. MCP mode uses this to tell whether a relay is serving the same bot.
export function liveLockOwner(path: string, selfPid = process.pid): number | undefined {
  const owner = readPidFile(path)
  if (!owner || owner === selfPid) return undefined
  return isProcessAlive(owner) ? owner : undefined
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

function buildProcessLock(path: string, pid: number): ProcessLock {
  let released = false
  return {
    path,
    pid,
    release: () => {
      if (released) return
      released = true
      try {
        if (readPidFile(path) === pid) rmSync(path, { force: true })
      } catch {}
    },
  }
}

function readPidFile(path: string): number | undefined {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }

  const match = /^\s*(\d+)\s*$/.exec(raw)
  if (!match) return undefined
  const pid = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function delayMs(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
