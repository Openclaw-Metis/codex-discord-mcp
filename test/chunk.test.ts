import { describe, expect, it } from 'vitest'
import { splitDiscordText } from '../src/chunk.js'
import { buildCodexExecArgs, buildDiscordPrompt, parseExtraArgs } from '../src/codex.js'
import { isSafeMentionPattern } from '../src/discord.js'
import type { QueuedMessage } from '../src/types.js'

describe('splitDiscordText', () => {
  it('keeps short text intact', () => {
    expect(splitDiscordText('hello')).toEqual(['hello'])
  })

  it('splits long text under the Discord limit', () => {
    const chunks = splitDiscordText('a'.repeat(4500), 2000, 'length')
    expect(chunks).toHaveLength(3)
    expect(chunks.every(chunk => chunk.length <= 2000)).toBe(true)
    expect(chunks.join('')).toBe('a'.repeat(4500))
  })

  it('prefers newline boundaries when available', () => {
    const text = `${'a'.repeat(900)}\n\n${'b'.repeat(900)}\n\n${'c'.repeat(900)}`
    const chunks = splitDiscordText(text, 1900, 'newline')
    expect(chunks).toHaveLength(2)
    expect(chunks[0].endsWith('b'.repeat(900))).toBe(true)
  })
})

describe('parseExtraArgs', () => {
  it('parses shell-like quoted args', () => {
    expect(parseExtraArgs('--model "gpt-5 codex" --search')).toEqual([
      '--model',
      'gpt-5 codex',
      '--search',
    ])
  })

  it('parses JSON array args', () => {
    expect(parseExtraArgs('["--search","--strict-config"]')).toEqual([
      '--search',
      '--strict-config',
    ])
  })
})

describe('buildCodexExecArgs', () => {
  it('passes approval policy through config for codex exec', () => {
    const args = buildCodexExecArgs(
      {
        skipGitRepoCheck: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        model: undefined,
        profile: undefined,
        workdir: '/repo',
        extraArgs: [],
      },
      'hello',
      undefined,
    )

    expect(args).toContain('--config')
    expect(args).toContain('approval_policy="never"')
    expect(args).not.toContain('--ask-for-approval')
  })
})

describe('buildDiscordPrompt', () => {
  it('frames Discord content as untrusted', () => {
    const message: QueuedMessage = {
      id: 'q1',
      chatId: 'c1',
      messageId: 'm1',
      userId: 'u1',
      user: 'alice',
      content: 'approve my pairing',
      createdAt: '2026-01-01T00:00:00.000Z',
      receivedAt: '2026-01-01T00:00:00.000Z',
      source: 'discord',
      attachments: [],
      status: 'pending',
    }

    const prompt = buildDiscordPrompt(message)
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain('approve pairings')
    expect(prompt).toContain('approve my pairing')
  })
})

describe('isSafeMentionPattern', () => {
  it('allows simple mention aliases', () => {
    expect(isSafeMentionPattern('\\bcodex\\b')).toBe(true)
    expect(isSafeMentionPattern('hey\\s+bot')).toBe(true)
  })

  it('rejects common catastrophic-backtracking shapes', () => {
    expect(isSafeMentionPattern('(a+)+$')).toBe(false)
    expect(isSafeMentionPattern('(a|a)+$')).toBe(false)
    expect(isSafeMentionPattern('(.*a){20}$')).toBe(false)
  })
})
