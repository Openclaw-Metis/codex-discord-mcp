import { describe, expect, it } from 'vitest'
import {
  buildConfigSnippet,
  buildInviteUrl,
  formatDoctorReport,
  type DoctorReport,
} from '../src/cli.js'
import { buildUnsafeBotModeWarning } from '../src/safety.js'

describe('buildConfigSnippet', () => {
  it('prints an npx-compatible MCP config', () => {
    const snippet = buildConfigSnippet({ useNpx: true })

    expect(snippet).toContain('command = "npx"')
    expect(snippet).toContain('args = ["-y", "codex-discord-mcp", "mcp"]')
  })
})

describe('buildInviteUrl', () => {
  it('prints a Discord OAuth bot invite URL', () => {
    const url = new URL(buildInviteUrl('123456789012345678'))

    expect(url.origin).toBe('https://discord.com')
    expect(url.pathname).toBe('/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('123456789012345678')
    expect(url.searchParams.get('scope')).toContain('bot')
    expect(url.searchParams.get('scope')).toContain('applications.commands')
  })
})

describe('formatDoctorReport', () => {
  it('formats JSON output for machine readers', () => {
    const report: DoctorReport = {
      ok: false,
      checks: {
        node: { ok: true, value: 'v20.0.0' },
        discordToken: { ok: false, value: 'missing' },
      },
    }

    const parsed = JSON.parse(formatDoctorReport(report, true))
    expect(parsed.ok).toBe(false)
    expect(parsed.checks.node.ok).toBe(true)
    expect(parsed.checks.discordToken.value).toBe('missing')
  })
})

describe('buildUnsafeBotModeWarning', () => {
  it('warns for unattended writable bot mode', () => {
    const warning = buildUnsafeBotModeWarning({
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })

    expect(warning).toContain('WARNING')
    expect(warning).toContain('CODEX_SANDBOX=workspace-write')
    expect(warning).toContain('CODEX_APPROVAL_POLICY=never')
  })

  it('does not warn for read-only bot mode or explicit suppression', () => {
    expect(
      buildUnsafeBotModeWarning({
        sandbox: 'read-only',
        approvalPolicy: 'never',
      }),
    ).toBeUndefined()

    expect(
      buildUnsafeBotModeWarning(
        {
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
        },
        { CODEX_DISCORD_ASSUME_YES: 'true' },
      ),
    ).toBeUndefined()
  })
})
