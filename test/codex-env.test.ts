import { describe, expect, it } from 'vitest'
import { buildCodexChildEnv } from '../src/codex.js'

describe('buildCodexChildEnv', () => {
  it('strips the Discord bot token from the Codex child environment', () => {
    const env = buildCodexChildEnv({
      DISCORD_BOT_TOKEN: 'super-secret',
      PATH: '/usr/bin',
    })
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it("preserves Codex's own credentials", () => {
    const env = buildCodexChildEnv({
      DISCORD_BOT_TOKEN: 'super-secret',
      OPENAI_API_KEY: 'sk-test',
      CODEX_HOME: '/home/me/.codex',
    })
    expect(env.OPENAI_API_KEY).toBe('sk-test')
    expect(env.CODEX_HOME).toBe('/home/me/.codex')
  })

  it('does not mutate the source environment', () => {
    const source = { DISCORD_BOT_TOKEN: 'super-secret' }
    buildCodexChildEnv(source)
    expect(source.DISCORD_BOT_TOKEN).toBe('super-secret')
  })
})
