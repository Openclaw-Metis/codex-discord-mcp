import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureRolloutPosition,
  channelOutboxDir,
  collectRunAttachments,
  defaultOutboxDir,
  listRunDeliverables,
} from '../src/attachments.js'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngBase64(tag: number, len = 64): string {
  const buf = Buffer.alloc(len)
  Buffer.from(PNG_SIG).copy(buf)
  buf[8] = tag
  return buf.toString('base64')
}

function imageCall(id: string, prompt: string, result: string): string {
  return JSON.stringify({
    timestamp: '2026-06-18T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'image_generation_call', id, status: 'generating', revised_prompt: prompt, result },
  })
}

function touchAt(path: string, whenMs: number, content = 'x'): void {
  writeFileSync(path, content)
  const when = new Date(whenMs)
  utimesSync(path, when, when)
}

describe('defaultOutboxDir', () => {
  it('honors an explicit override', () => {
    expect(defaultOutboxDir({ CODEX_DISCORD_OUTBOX_DIR: '/custom/outbox' })).toBe('/custom/outbox')
  })

  it('defaults under CODEX_HOME', () => {
    expect(defaultOutboxDir({ CODEX_HOME: '/srv/.codex' })).toBe(join('/srv/.codex', 'discord_outbox'))
  })
})

describe('channelOutboxDir', () => {
  it('appends the chat id as a subdirectory', () => {
    expect(channelOutboxDir('/out', '123456')).toBe(join('/out', '123456'))
  })

  it('sanitizes path-hostile chat ids', () => {
    const dir = channelOutboxDir('/out', '../evil')
    expect(dir).toBe(join('/out', '___evil'))
  })
})

describe('listRunDeliverables', () => {
  let dir = ''
  const now = Date.now()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-outbox-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns only deliverable files written at or after the run start, oldest first', () => {
    touchAt(join(dir, 'first.md'), now + 1000)
    touchAt(join(dir, 'second.csv'), now + 2000)
    touchAt(join(dir, 'stale.pdf'), now - 60_000)
    touchAt(join(dir, 'script.py'), now + 1000)
    touchAt(join(dir, 'notes.log'), now + 1000)
    touchAt(join(dir, '.hidden.md'), now + 1000)

    const files = listRunDeliverables(dir, now)
    expect(files.map(f => basename(f))).toEqual(['first.md', 'second.csv'])
  })

  it('recurses into subdirectories and skips empty or oversized files', () => {
    const nested = join(dir, 'report')
    mkdirSync(nested)
    touchAt(join(nested, 'deep.html'), now + 1000)
    touchAt(join(dir, 'empty.md'), now + 2000, '')
    touchAt(join(dir, 'big.zip'), now + 3000, 'xxxxxxxxxx')

    expect(listRunDeliverables(dir, now).map(f => basename(f))).toEqual(['deep.html', 'big.zip'])
    expect(listRunDeliverables(dir, now, { maxBytes: 5 }).map(f => basename(f))).toEqual([
      'deep.html',
    ])
  })

  it('respects the limit and tolerates a missing directory', () => {
    touchAt(join(dir, 'a.md'), now + 1000)
    touchAt(join(dir, 'b.md'), now + 2000)
    expect(listRunDeliverables(dir, now, { limit: 1 })).toHaveLength(1)
    expect(listRunDeliverables(join(dir, 'missing'), now)).toEqual([])
  })
})

describe('captureRolloutPosition / collectRunAttachments', () => {
  let dir = ''
  const threadId = '019ed603-e23f-7cc0-bd5f-7f9193ee273b'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-attach-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeSessionsTree(): { root: string; rollout: string } {
    const day = join(dir, 'sessions', '2026', '06', '18')
    mkdirSync(day, { recursive: true })
    const rollout = join(day, `rollout-2026-06-18T00-00-00-${threadId}.jsonl`)
    return { root: join(dir, 'sessions'), rollout }
  }

  it('returns a zero position without a thread id or rollout file', () => {
    expect(captureRolloutPosition(undefined)).toEqual({ size: 0 })
    expect(captureRolloutPosition('0000-missing', join(dir, 'sessions'))).toEqual({ size: 0 })
  })

  it('attaches only images appended after the captured position, plus outbox deliverables', () => {
    const { root, rollout } = makeSessionsTree()
    writeFileSync(rollout, `${imageCall('ig_old', 'old', pngBase64(1))}\n`)

    const before = captureRolloutPosition(threadId, root)
    expect(before.file).toBe(rollout)
    expect(before.size).toBeGreaterThan(0)

    const runStartMs = Date.now()
    appendFileSync(rollout, `${imageCall('ig_new', 'new', pngBase64(2))}\n`)

    const outbox = join(dir, 'outbox')
    mkdirSync(outbox, { recursive: true })
    touchAt(join(outbox, 'summary.md'), runStartMs + 1000)

    const imagesOut = join(dir, 'images-out')
    const files = collectRunAttachments({
      threadId,
      before,
      outboxDir: outbox,
      runStartMs,
      sessionsRoot: root,
      imagesOutDir: imagesOut,
    })

    expect(files).toHaveLength(2)
    expect(files[0].startsWith(imagesOut)).toBe(true)
    expect(basename(files[1])).toBe('summary.md')
  })

  it('recovers the whole rollout for a brand-new thread (empty before-position)', () => {
    const { root, rollout } = makeSessionsTree()
    writeFileSync(rollout, `${imageCall('ig_1', 'p', pngBase64(3))}\n`)

    const files = collectRunAttachments({
      threadId,
      before: { size: 0 },
      outboxDir: join(dir, 'outbox'),
      runStartMs: Date.now(),
      sessionsRoot: root,
      imagesOutDir: join(dir, 'images-out'),
    })

    expect(files).toHaveLength(1)
  })

  it('returns no attachments when nothing new was produced', () => {
    const { root, rollout } = makeSessionsTree()
    writeFileSync(rollout, `${imageCall('ig_old', 'old', pngBase64(4))}\n`)
    const before = captureRolloutPosition(threadId, root)

    const files = collectRunAttachments({
      threadId,
      before,
      outboxDir: join(dir, 'outbox'),
      runStartMs: Date.now(),
      sessionsRoot: root,
      imagesOutDir: join(dir, 'images-out'),
    })

    expect(files).toEqual([])
  })
})
