import { describe, expect, it } from 'vitest'
import { formatDuration, parseControlCommand, partitionReplay } from '../src/control.js'
import type { QueuedMessage } from '../src/types.js'

describe('parseControlCommand', () => {
  it('recognizes bare ! and / commands, case-insensitively', () => {
    expect(parseControlCommand('!status')).toBe('status')
    expect(parseControlCommand('/STOP')).toBe('stop')
    expect(parseControlCommand('  !new  ')).toBe('new')
    expect(parseControlCommand('!help')).toBe('help')
  })

  it('maps aliases', () => {
    expect(parseControlCommand('!cancel')).toBe('stop')
    expect(parseControlCommand('!reset')).toBe('new')
  })

  it('ignores leading user and role mentions', () => {
    expect(parseControlCommand('<@123456789> !stop')).toBe('stop')
    expect(parseControlCommand('<@!123456789><@&42> /status')).toBe('status')
  })

  it('treats anything longer than the bare command as a normal prompt', () => {
    expect(parseControlCommand('!stop the server please')).toBeUndefined()
    expect(parseControlCommand('status')).toBeUndefined()
    expect(parseControlCommand('!unknown')).toBeUndefined()
    expect(parseControlCommand('hello <@1> !stop')).toBeUndefined()
    expect(parseControlCommand('')).toBeUndefined()
  })
})

describe('partitionReplay', () => {
  const now = Date.parse('2026-11-14T12:00:00Z')
  const msg = (id: string, receivedAt: string): QueuedMessage => ({
    id,
    chatId: 'c',
    messageId: id,
    userId: 'u',
    user: 'user',
    content: 'hi',
    createdAt: receivedAt,
    receivedAt,
    source: 'discord',
    attachments: [],
    status: 'pending',
  })

  it('replays recent messages and drops stale or undated ones', () => {
    const { replay, stale } = partitionReplay(
      [
        msg('fresh', '2026-11-14T11:30:00Z'),
        msg('old', '2026-11-14T09:00:00Z'),
        msg('bad', 'not-a-date'),
      ],
      now,
      60 * 60 * 1000,
    )
    expect(replay.map(m => m.id)).toEqual(['fresh'])
    expect(stale.map(m => m.id)).toEqual(['old', 'bad'])
  })

  it('disables replay when maxAge is 0', () => {
    const { replay, stale } = partitionReplay([msg('fresh', '2026-11-14T11:59:59Z')], now, 0)
    expect(replay).toEqual([])
    expect(stale).toHaveLength(1)
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(4_200)).toBe('4s')
    expect(formatDuration(192_000)).toBe('3m 12s')
    expect(formatDuration(3_900_000)).toBe('1h 5m')
    expect(formatDuration(-5)).toBe('0s')
  })
})
