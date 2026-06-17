import { describe, expect, it } from 'vitest'
import {
  channelGateDecision,
  channelSendAllowed,
  evaluateDmPolicy,
} from '../src/discord.js'

describe('evaluateDmPolicy', () => {
  it('drops everyone when DMs are disabled, even allowlisted users', () => {
    expect(evaluateDmPolicy({ dmPolicy: 'disabled', allowUsers: ['u1'] }, 'u1')).toBe('drop')
  })

  it('delivers an allowlisted user regardless of policy', () => {
    expect(evaluateDmPolicy({ dmPolicy: 'allowlist', allowUsers: ['u1'] }, 'u1')).toBe('deliver')
    expect(evaluateDmPolicy({ dmPolicy: 'pairing', allowUsers: ['u1'] }, 'u1')).toBe('deliver')
  })

  it('drops an unknown user under the allowlist policy', () => {
    expect(evaluateDmPolicy({ dmPolicy: 'allowlist', allowUsers: [] }, 'stranger')).toBe('drop')
  })

  it('routes an unknown user to pairing under the pairing policy', () => {
    expect(evaluateDmPolicy({ dmPolicy: 'pairing', allowUsers: [] }, 'stranger')).toBe('pairing')
  })
})

describe('channelGateDecision', () => {
  it('drops a channel that is not allowlisted', () => {
    expect(channelGateDecision({ channels: {} }, 'c1', 'u1')).toBe('drop')
  })

  it('passes an allowlisted channel with no per-channel user restriction', () => {
    const access = { channels: { c1: { requireMention: true, allowUsers: [] } } }
    expect(channelGateDecision(access, 'c1', 'anyone')).toBe('pass')
  })

  it('drops a sender not in the per-channel user allowlist', () => {
    const access = { channels: { c1: { requireMention: false, allowUsers: ['u1'] } } }
    expect(channelGateDecision(access, 'c1', 'u2')).toBe('drop')
  })

  it('passes a sender in the per-channel user allowlist', () => {
    const access = { channels: { c1: { requireMention: false, allowUsers: ['u1'] } } }
    expect(channelGateDecision(access, 'c1', 'u1')).toBe('pass')
  })
})

describe('channelSendAllowed', () => {
  const access = {
    allowUsers: ['u1'],
    channels: { c1: { requireMention: true, allowUsers: [] } },
  }

  it('allows a DM to an allowlisted recipient', () => {
    expect(channelSendAllowed(access, { isDm: true, recipientUserId: 'u1' })).toBe(true)
  })

  it('blocks a DM when the recipient is unknown', () => {
    expect(channelSendAllowed(access, { isDm: true, recipientUserId: undefined })).toBe(false)
    expect(channelSendAllowed(access, { isDm: true, recipientUserId: 'u2' })).toBe(false)
  })

  it('allows a guild send to an allowlisted channel', () => {
    expect(channelSendAllowed(access, { isDm: false, channelId: 'c1' })).toBe(true)
  })

  it('blocks a guild send to a non-allowlisted channel', () => {
    expect(channelSendAllowed(access, { isDm: false, channelId: 'c2' })).toBe(false)
  })
})
