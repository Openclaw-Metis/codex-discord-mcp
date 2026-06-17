import { describe, expect, it } from 'vitest'
import { join, sep } from 'node:path'
import { isPathInsideOrEqual } from '../src/discord.js'

// Build paths with join/sep so the assertions hold on both POSIX and Windows.
const root = join(sep, 'srv', 'repo')

describe('isPathInsideOrEqual', () => {
  it('accepts the root itself', () => {
    expect(isPathInsideOrEqual(root, root)).toBe(true)
  })

  it('accepts nested paths under the root', () => {
    expect(isPathInsideOrEqual(join(root, 'sub', 'file.txt'), root)).toBe(true)
  })

  it('rejects a sibling directory that shares a name prefix', () => {
    // The critical boundary: /srv/repo must NOT contain /srv/repo-evil.
    expect(isPathInsideOrEqual(join(sep, 'srv', 'repo-evil', 'secret'), root)).toBe(false)
  })

  it('rejects the parent directory', () => {
    expect(isPathInsideOrEqual(join(sep, 'srv'), root)).toBe(false)
  })

  it('rejects an unrelated path', () => {
    expect(isPathInsideOrEqual(join(sep, 'etc', 'passwd'), root)).toBe(false)
  })
})
