import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions } from '../src/codex.js'
import { RelayController, type RelayBridge, type RelayRunner } from '../src/relay.js'
import { appendQueuedMessage, getStatePaths, readQueue } from '../src/state.js'
import type { LocalAttachment, QueuedMessage, StatePaths } from '../src/types.js'

type Deferred = {
  resolve: (value: { text: string; filePaths: string[] }) => void
  reject: (err: Error) => void
}

class FakeRunner implements RelayRunner {
  calls: { message: QueuedMessage; options?: RunOptions }[] = []
  pending: Deferred[] = []
  forgets: string[] = []
  threads = new Map<string, string>()

  runForMessage(message: QueuedMessage, options?: RunOptions) {
    this.calls.push({ message, options })
    return new Promise<{ text: string; filePaths: string[] }>((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('codex run cancelled')))
      this.pending.push({ resolve, reject })
    })
  }

  async forgetThread(chatId: string): Promise<void> {
    this.forgets.push(chatId)
    this.threads.delete(chatId)
  }

  currentThread(chatId: string): string | undefined {
    return this.threads.get(chatId)
  }
}

class FakeBridge implements RelayBridge {
  sent: { chatId: string; text: string; replyTo?: string; files?: string[] }[] = []
  reactions: string[] = []
  unreactions: string[] = []
  downloads: LocalAttachment[] | Error = []
  failFilesOnce = false

  async sendMessage(params: { chatId: string; text: string; replyTo?: string; files?: string[] }) {
    if (this.failFilesOnce && params.files?.length) {
      this.failFilesOnce = false
      throw new Error('upload failed')
    }
    this.sent.push(params)
    return ['sent-id']
  }
  async sendTyping(): Promise<void> {}
  async react(_chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push(`${messageId}:${emoji}`)
  }
  async unreact(_chatId: string, messageId: string, emoji: string): Promise<void> {
    this.unreactions.push(`${messageId}:${emoji}`)
  }
  async downloadAttachmentFiles(): Promise<LocalAttachment[]> {
    if (this.downloads instanceof Error) throw this.downloads
    return this.downloads
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('RelayController', () => {
  let dir = ''
  let paths: StatePaths
  let bridge: FakeBridge
  let runner: FakeRunner
  let relay: RelayController
  let clock = Date.parse('2026-11-14T12:00:00Z')

  function message(id: string, content = `prompt ${id}`, extra: Partial<QueuedMessage> = {}) {
    return {
      id,
      chatId: 'chan',
      messageId: id,
      userId: 'u1',
      user: 'user',
      content,
      createdAt: new Date(clock).toISOString(),
      receivedAt: new Date(clock).toISOString(),
      source: 'discord',
      attachments: [],
      status: 'pending',
      ...extra,
    } satisfies QueuedMessage
  }

  async function deliver(msg: QueuedMessage) {
    await appendQueuedMessage(msg, paths)
    relay.handle(msg)
    await tick()
  }

  function status(id: string) {
    return readQueue(paths).find(item => item.id === id)?.status
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-relay-'))
    paths = getStatePaths(dir)
    bridge = new FakeBridge()
    runner = new FakeRunner()
    clock = Date.parse('2026-11-14T12:00:00Z')
    relay = new RelayController(
      bridge,
      runner,
      paths,
      { resumeByChannel: true, replayMaxAgeMs: 60 * 60 * 1000, downloadAttachments: true },
      { now: () => clock, log: () => {} },
    )
  })
  afterEach(async () => {
    // Settle in-flight runs and control replies before deleting their state
    // dir; Windows refuses to remove a directory with a write in progress.
    await relay.shutdown(1000)
    await relay.whenIdle('chan')
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('runs a message, replies with text and files, and marks it handled', async () => {
    await deliver(message('m1'))
    expect(runner.calls).toHaveLength(1)
    runner.pending[0].resolve({ text: 'done', filePaths: ['/out/a.png'] })
    await relay.whenIdle('chan')
    expect(bridge.sent).toEqual([
      { chatId: 'chan', text: 'done', replyTo: 'm1', files: ['/out/a.png'] },
    ])
    expect(status('m1')).toBe('handled')
  })

  it('falls back to a text-only reply when attaching fails', async () => {
    bridge.failFilesOnce = true
    await deliver(message('m1'))
    runner.pending[0].resolve({ text: 'done', filePaths: ['/out/a.png'] })
    await relay.whenIdle('chan')
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0].text).toContain('could not be attached')
    expect(bridge.sent[0].files).toBeUndefined()
  })

  it('reports a failed run and marks it handled', async () => {
    await deliver(message('m1'))
    runner.pending[0].reject(new Error('codex exited with code 1: boom'))
    await relay.whenIdle('chan')
    expect(bridge.sent[0].text).toBe('Codex run failed: codex exited with code 1: boom')
    expect(status('m1')).toBe('handled')
  })

  it('serializes runs per channel and marks queued messages with a reaction', async () => {
    await deliver(message('m1'))
    await deliver(message('m2'))
    expect(runner.calls).toHaveLength(1)
    expect(bridge.reactions).toEqual(['m2:⏳'])

    runner.pending[0].resolve({ text: 'one', filePaths: [] })
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2))
    expect(bridge.unreactions).toEqual(['m2:⏳'])

    runner.pending[1].resolve({ text: 'two', filePaths: [] })
    await relay.whenIdle('chan')
    expect(bridge.sent.map(item => item.text)).toEqual(['one', 'two'])
  })

  it('answers !status immediately while a run is busy', async () => {
    runner.threads.set('chan', 'thread-123')
    await deliver(message('m1', 'build the report'))
    await deliver(message('m2'))
    clock += 192_000
    await deliver(message('s1', '!status'))
    expect(runner.calls).toHaveLength(1)
    const reply = bridge.sent.find(item => item.replyTo === 's1')?.text ?? ''
    expect(reply).toContain('Running for 3m 12s: "build the report"')
    expect(reply).toContain('Queued: 1')
    expect(reply).toContain('thread-123')
    await vi.waitFor(() => expect(status('s1')).toBe('handled'))
  })

  it('!stop cancels the run, drops the queue, and does not report a failure', async () => {
    await deliver(message('m1'))
    await deliver(message('m2'))
    await deliver(message('x', '<@999> !stop'))
    await relay.whenIdle('chan')

    expect(runner.calls[0].options?.signal?.aborted).toBe(true)
    expect(runner.calls).toHaveLength(1)
    expect(bridge.sent.map(item => item.text)).toEqual([
      'Stopped the running Codex task and dropped 1 queued message(s).',
    ])
    expect(status('m1')).toBe('handled')
    expect(status('m2')).toBe('handled')
    expect(status('x')).toBe('handled')
    expect(bridge.unreactions).toEqual(['m2:⏳'])
  })

  it('!stop with nothing running says so', async () => {
    await deliver(message('x', '!stop'))
    await vi.waitFor(() => expect(bridge.sent[0]?.text).toBe('Nothing is running.'))
  })

  it('!new forgets the thread now and again after an in-flight run finishes', async () => {
    runner.threads.set('chan', 'thread-123')
    await deliver(message('m1'))
    await deliver(message('n', '!new'))
    expect(runner.forgets).toEqual(['chan'])
    await vi.waitFor(() => expect(bridge.sent[0]?.text).toContain('current task will finish'))

    runner.pending[0].resolve({ text: 'done', filePaths: [] })
    await relay.whenIdle('chan')
    expect(runner.forgets).toEqual(['chan', 'chan'])
  })

  it('!new explains when resume is off', async () => {
    relay = new RelayController(
      bridge,
      runner,
      paths,
      { resumeByChannel: false, replayMaxAgeMs: 0, downloadAttachments: true },
      { now: () => clock, log: () => {} },
    )
    await deliver(message('n', '!new'))
    expect(runner.forgets).toEqual([])
    await vi.waitFor(() => expect(bridge.sent[0]?.text).toContain('resume is off'))
  })

  it('passes downloaded attachments to the runner', async () => {
    bridge.downloads = [{ id: 'a1', name: 'pic.png', path: '/inbox/a1.png' }]
    const attachments = [{ id: 'a1', name: 'pic.png', size: 10, contentType: 'image/png' }]
    await deliver(message('m1', 'look', { attachments }))
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1))
    expect(runner.calls[0].options?.attachments).toEqual(bridge.downloads)
  })

  it('turns a failed download into per-attachment errors instead of failing the run', async () => {
    bridge.downloads = new Error('missing access')
    const attachments = [{ id: 'a1', name: 'pic.png', size: 10 }]
    await deliver(message('m1', 'look', { attachments }))
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1))
    expect(runner.calls[0].options?.attachments).toEqual([
      { id: 'a1', name: 'pic.png', error: 'missing access' },
    ])
  })

  it('skips attachment downloads when disabled', async () => {
    relay = new RelayController(
      bridge,
      runner,
      paths,
      { resumeByChannel: true, replayMaxAgeMs: 0, downloadAttachments: false },
      { now: () => clock, log: () => {} },
    )
    bridge.downloads = new Error('should not be called')
    await deliver(message('m1', 'look', { attachments: [{ id: 'a1', name: 'p', size: 1 }] }))
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1))
    expect(runner.calls[0].options?.attachments).toEqual([])
  })

  it('replays fresh pending messages and retires stale ones and old commands', async () => {
    const fresh = message('fresh')
    const cmd = message('cmd', '!stop')
    clock -= 3 * 60 * 60 * 1000
    const old = message('old')
    clock += 3 * 60 * 60 * 1000
    for (const item of [old, fresh, cmd]) await appendQueuedMessage(item, paths)

    await relay.replayPending([old, fresh, cmd])
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1))
    expect(runner.calls.map(call => call.message.id)).toEqual(['fresh'])
    expect(status('old')).toBe('handled')
    expect(status('cmd')).toBe('handled')
    expect(bridge.reactions).toEqual([])
  })

  it('shutdown cancels the run but leaves the message pending for replay', async () => {
    await deliver(message('m1'))
    await deliver(message('m2'))
    await relay.shutdown(1000)
    await relay.whenIdle('chan')
    expect(runner.calls[0].options?.signal?.aborted).toBe(true)
    expect(runner.calls).toHaveLength(1)
    expect(bridge.sent).toEqual([])
    expect(status('m1')).toBe('pending')
    expect(status('m2')).toBe('pending')
  })
})
