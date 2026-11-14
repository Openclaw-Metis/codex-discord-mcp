import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendQueuedMessage,
  getStatePaths,
  liveLockOwner,
  loadAccess,
  markMessageHandled,
  markMessagesHandled,
  pruneOldFiles,
  readQueue,
} from '../src/state.js'

describe('loadAccess', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-state-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeAccess(value: unknown): ReturnType<typeof getStatePaths> {
    const paths = getStatePaths(dir)
    writeFileSync(paths.accessFile, JSON.stringify(value))
    return paths
  }

  it('returns defaults when the file is missing', () => {
    const access = loadAccess(getStatePaths(dir))
    expect(access.dmPolicy).toBe('pairing')
    expect(access.channels).toEqual({})
  })

  it('normalizes hand-edited channel entries missing fields', () => {
    const paths = writeAccess({
      channels: {
        c1: {}, // no requireMention, no allowUsers
        c2: { requireMention: false },
        c3: null, // garbage entry
        c4: { allowUsers: ['u1', 42, 'u2'] }, // mixed types
      },
    })

    const access = loadAccess(paths)
    expect(access.channels.c1).toEqual({ requireMention: true, allowUsers: [] })
    expect(access.channels.c2).toEqual({ requireMention: false, allowUsers: [] })
    expect(access.channels.c3).toBeUndefined()
    expect(access.channels.c4).toEqual({ requireMention: true, allowUsers: ['u1', 'u2'] })
  })
})

describe('queue and housekeeping helpers', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-state-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const queued = (id: string) => ({
    id,
    chatId: 'c',
    messageId: id,
    userId: 'u',
    user: 'user',
    content: 'hi',
    createdAt: '2026-11-14T00:00:00Z',
    receivedAt: '2026-11-14T00:00:00Z',
    source: 'discord' as const,
    attachments: [],
    status: 'pending' as const,
  })

  it('marks several messages handled in one pass', async () => {
    const paths = getStatePaths(dir)
    for (const id of ['a', 'b', 'c']) await appendQueuedMessage(queued(id), paths)
    expect(await markMessagesHandled(['a', 'c', 'missing'], paths)).toBe(2)
    expect(await markMessagesHandled(['a'], paths)).toBe(0)
    expect(readQueue(paths).map(item => item.status)).toEqual(['handled', 'pending', 'handled'])
    expect(await markMessageHandled('b', paths)).toBe(true)
  })

  it('prunes only regular files older than the cutoff', () => {
    const inbox = join(dir, 'inbox')
    mkdirSync(join(inbox, 'sub'), { recursive: true })
    writeFileSync(join(inbox, 'old.png'), 'x')
    writeFileSync(join(inbox, 'new.png'), 'x')
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    utimesSync(join(inbox, 'old.png'), old, old)
    expect(pruneOldFiles(inbox, 7 * 24 * 60 * 60 * 1000)).toBe(1)
    expect(existsSync(join(inbox, 'old.png'))).toBe(false)
    expect(existsSync(join(inbox, 'new.png'))).toBe(true)
    expect(existsSync(join(inbox, 'sub'))).toBe(true)
    expect(pruneOldFiles(join(dir, 'missing'), 0)).toBe(0)
  })

  it('reports a live lock owner other than this process', () => {
    const lockFile = join(dir, 'bot.pid')
    expect(liveLockOwner(lockFile)).toBeUndefined()
    writeFileSync(lockFile, `${process.pid}\n`)
    expect(liveLockOwner(lockFile)).toBeUndefined()
    expect(liveLockOwner(lockFile, -1)).toBe(process.pid)
    writeFileSync(lockFile, '999999999\n')
    expect(liveLockOwner(lockFile)).toBeUndefined()
  })
})

describe('concurrent queue updates', () => {
  it('does not lose writes when appends and marks interleave', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-state-'))
    try {
      const paths = getStatePaths(dir)
      const make = (id: string) => ({
        id,
        chatId: 'c',
        messageId: id,
        userId: 'u',
        user: 'user',
        content: 'hi',
        createdAt: '2026-11-14T00:00:00Z',
        receivedAt: '2026-11-14T00:00:00Z',
        source: 'discord' as const,
        attachments: [],
        status: 'pending' as const,
      })
      await appendQueuedMessage(make('a'), paths)
      await Promise.all([
        markMessageHandled('a', paths),
        appendQueuedMessage(make('b'), paths),
        appendQueuedMessage(make('c'), paths),
        markMessagesHandled(['b'], paths),
      ])
      const queue = readQueue(paths)
      expect(queue.map(item => `${item.id}:${item.status}`)).toEqual([
        'a:handled',
        'b:handled',
        'c:pending',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
