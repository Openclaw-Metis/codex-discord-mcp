import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getStatePaths, loadAccess } from '../src/state.js'

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
