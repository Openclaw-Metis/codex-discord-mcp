import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildConfigSnippet,
  buildInviteUrl,
  formatDoctorReport,
  isDirectRun,
  type DoctorReport,
} from '../src/cli.js'
import { buildUnsafeBotModeWarning } from '../src/safety.js'
import { acquireProcessLock } from '../src/state.js'

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

describe('isDirectRun', () => {
  it('recognizes npm-linked CLI symlinks as direct runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-discord-mcp-'))
    try {
      const distDir = join(dir, 'dist')
      const binDir = join(dir, 'bin')
      mkdirSync(distDir)
      mkdirSync(binDir)

      const target = join(distDir, 'cli.js')
      const link = join(binDir, 'codex-discord-mcp')
      writeFileSync(target, '#!/usr/bin/env node\n')
      try {
        symlinkSync(target, link)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EACCES') return
        throw err
      }

      expect(isDirectRun(link, pathToFileURL(target).href)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

describe('acquireProcessLock', () => {
  it('refuses to acquire a lock held by a live process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-discord-mcp-'))
    try {
      const lockFile = join(dir, 'bot.pid')
      writeFileSync(lockFile, `${process.pid}\n`)

      expect(() => acquireProcessLock(lockFile, 'test relay')).toThrow(
        /test relay is already running/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces a stale lock and releases only its own pid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-discord-mcp-'))
    try {
      const lockFile = join(dir, 'bot.pid')
      writeFileSync(lockFile, 'not-a-pid\n')

      const lock = acquireProcessLock(lockFile, 'test relay', 12345)
      expect(lock.pid).toBe(12345)
      expect(lock.path).toBe(lockFile)

      writeFileSync(lockFile, `${process.pid}\n`)
      lock.release()
      expect(() => acquireProcessLock(lockFile, 'test relay', 12345)).toThrow(
        /test relay is already running/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
