import { describe, expect, it } from 'vitest'
import { buildDiscordPrompt, runCodexProcess } from '../src/codex.js'
import type { QueuedMessage } from '../src/types.js'

const node = process.execPath
const opts = { cwd: process.cwd(), timeoutMs: 20_000 }

describe('runCodexProcess', () => {
  it('parses the thread id and final agent message from --json events', async () => {
    const script = [
      `console.log(JSON.stringify({ type: 'thread.started', thread_id: 'abc-123' }))`,
      `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }))`,
      `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }))`,
    ].join(';')
    await expect(runCodexProcess(node, ['-e', script], opts)).resolves.toEqual({
      text: 'final answer',
      threadId: 'abc-123',
    })
  })

  it('rejects with stderr on a non-zero exit', async () => {
    const script = `process.stderr.write('bad things'); process.exit(3)`
    await expect(runCodexProcess(node, ['-e', script], opts)).rejects.toThrow(
      /codex exited with code 3: bad things/,
    )
  })

  it('kills the process and rejects promptly when aborted', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const run = runCodexProcess(node, ['-e', 'setTimeout(() => {}, 60_000)'], {
      ...opts,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort('stop'), 150)
    await expect(run).rejects.toThrow(/cancelled/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort('stop')
    await expect(
      runCodexProcess(node, ['-e', 'process.exit(0)'], { ...opts, signal: controller.signal }),
    ).rejects.toThrow(/before it started/)
  })

  it('times out long runs', async () => {
    await expect(
      runCodexProcess(node, ['-e', 'setTimeout(() => {}, 60_000)'], { ...opts, timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200ms/)
  })
})

describe('buildDiscordPrompt attachments', () => {
  const message: QueuedMessage = {
    id: 'm',
    chatId: 'c',
    messageId: 'm',
    userId: 'u',
    user: 'user',
    content: 'what is in these?',
    createdAt: '2026-11-14T00:00:00Z',
    receivedAt: '2026-11-14T00:00:00Z',
    source: 'discord',
    attachments: [
      { id: 'a1', name: 'pic.png', contentType: 'image/png', size: 2048 },
      { id: 'a2', name: 'huge.zip', size: 30 * 1024 * 1024 },
    ],
    status: 'pending',
  }

  it('lists local paths and download errors next to each attachment', () => {
    const prompt = buildDiscordPrompt(message, {
      attachments: [
        { id: 'a1', name: 'pic.png', path: '/inbox/1-a1.png' },
        { id: 'a2', name: 'huge.zip', error: 'attachment too large: 30MB' },
      ],
    })
    expect(prompt).toContain('- pic.png (image/png, 2KB, id: a1) — saved locally at /inbox/1-a1.png')
    expect(prompt).toContain('id: a2) — download failed: attachment too large: 30MB')
    expect(prompt).toContain('read them from the local paths')
  })

  it('keeps the plain listing when nothing was downloaded', () => {
    const prompt = buildDiscordPrompt(message)
    expect(prompt).toContain('- pic.png (image/png, 2KB, id: a1)\n')
    expect(prompt).not.toContain('saved locally')
    expect(prompt).not.toContain('read them from the local paths')
  })
})
