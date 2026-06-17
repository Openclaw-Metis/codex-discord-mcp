import { describe, expect, it } from 'vitest'
import { join, sep } from 'node:path'
import { attachmentRootCandidates, isPathInsideOrEqual } from '../src/discord.js'

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

describe('attachmentRootCandidates', () => {
  const inbox = join(sep, 'state', 'inbox')
  const imageDir = join(sep, 'home', '.codex', 'generated_images')

  it('uses cwd, CODEX_WORKDIR, inbox, and the image dir by default', () => {
    const roots = attachmentRootCandidates(inbox, {
      CODEX_WORKDIR: join(sep, 'work'),
      CODEX_HOME: join(sep, 'home', '.codex'),
    })
    expect(roots).toContain(process.cwd())
    expect(roots).toContain(join(sep, 'work'))
    expect(roots).toContain(inbox)
    expect(roots).toContain(imageDir)
  })

  it('replaces cwd/workdir with configured roots but always keeps inbox + image dir', () => {
    const exportsDir = join(sep, 'home', 'ubuntu', 'exports')
    const roots = attachmentRootCandidates(inbox, {
      CODEX_DISCORD_ATTACHMENT_ROOTS: exportsDir,
      CODEX_WORKDIR: join(sep, 'work'),
      CODEX_HOME: join(sep, 'home', '.codex'),
    })
    expect(roots).toContain(exportsDir)
    expect(roots).toContain(inbox)
    expect(roots).toContain(imageDir)
    expect(roots).not.toContain(join(sep, 'work'))
    expect(roots).not.toContain(process.cwd())
  })
})
