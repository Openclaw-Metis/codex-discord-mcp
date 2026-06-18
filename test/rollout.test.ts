import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractImagesFromRolloutText,
  imageExt,
  newestRolloutFile,
  recoverGeneratedImages,
} from '../src/rollout.js'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Synthetic image bytes: real PNG signature + a distinguishing tag byte.
// imageExt validates by magic bytes, so this is sufficient for unit tests.
function pngBase64(tag: number, len = 64): string {
  const buf = Buffer.alloc(len)
  Buffer.from(PNG_SIG).copy(buf)
  buf[8] = tag
  return buf.toString('base64')
}

function imageCall(id: string, status: string, prompt: string, result: string): string {
  return JSON.stringify({
    timestamp: '2026-06-18T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'image_generation_call', id, status, revised_prompt: prompt, result },
  })
}

const NON_IMAGE_LINE = JSON.stringify({
  timestamp: '2026-06-18T00:00:00.000Z',
  type: 'response_item',
  payload: { type: 'message', text: 'hello' },
})

describe('imageExt', () => {
  it('detects PNG by magic bytes', () => {
    expect(imageExt(Buffer.from([...PNG_SIG, 0, 0, 0, 0]))).toBe('png')
  })
  it('detects JPEG', () => {
    expect(imageExt(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpg')
  })
  it('returns undefined for non-image bytes', () => {
    expect(imageExt(Buffer.from('not an image at all'))).toBeUndefined()
  })
})

describe('extractImagesFromRolloutText', () => {
  it('extracts image_generation_call results oldest-first, dedups, ignores non-images', () => {
    const img1 = pngBase64(1)
    const img2 = pngBase64(2)
    const text = [
      imageCall('ig_1', 'completed', 'cat', img1),
      NON_IMAGE_LINE,
      imageCall('ig_1_dup', 'completed', 'cat-again', img1), // duplicate content -> dropped
      imageCall('ig_2', 'completed', 'dog', img2),
    ].join('\n')

    const images = extractImagesFromRolloutText(text)
    expect(images).toHaveLength(2)
    expect(images.map(i => i.revisedPrompt)).toEqual(['cat', 'dog'])
    expect(images.every(i => i.ext === 'png')).toBe(true)
  })

  it('skips lines whose result is not a valid image', () => {
    const text = imageCall('ig_bad', 'completed', 'junk', Buffer.from('x'.repeat(40)).toString('base64'))
    expect(extractImagesFromRolloutText(text)).toHaveLength(0)
  })

  it('tolerates a truncated final line', () => {
    const good = imageCall('ig_1', 'completed', 'cat', pngBase64(1))
    const text = `${good}\n{"payload":{"type":"image_generation_call","result":"`
    expect(extractImagesFromRolloutText(text)).toHaveLength(1)
  })
})

describe('newestRolloutFile', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the most recently modified rollout under the tree', () => {
    const older = join(dir, 'rollout-old.jsonl')
    const newer = join(dir, 'rollout-new.jsonl')
    writeFileSync(older, '{}')
    writeFileSync(newer, '{}')
    const past = new Date(Date.now() - 60_000)
    utimesSync(older, past, past)
    expect(newestRolloutFile(dir)).toBe(newer)
  })

  it('ignores non-rollout files and returns undefined when none exist', () => {
    writeFileSync(join(dir, 'notes.jsonl'), '{}')
    writeFileSync(join(dir, 'rollout-x.txt'), '{}')
    expect(newestRolloutFile(dir)).toBeUndefined()
  })
})

describe('recoverGeneratedImages', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-recover-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the most recent image and returns its path', () => {
    const rollout = join(dir, 'rollout-1.jsonl')
    const outDir = join(dir, 'out')
    const img2 = pngBase64(2)
    writeFileSync(
      rollout,
      [imageCall('ig_1', 'completed', 'cat', pngBase64(1)), imageCall('ig_2', 'completed', 'dog', img2)].join('\n'),
    )

    const { rolloutFile, images } = recoverGeneratedImages({ sessionFile: rollout, outDir, count: 1 })
    expect(rolloutFile).toBe(rollout)
    expect(images).toHaveLength(1)
    expect(images[0].revisedPrompt).toBe('dog')
    expect(images[0].path.startsWith(outDir)).toBe(true)
    expect(readFileSync(images[0].path).toString('base64')).toBe(img2)
  })

  it('can return multiple most-recent images', () => {
    const rollout = join(dir, 'rollout-1.jsonl')
    const outDir = join(dir, 'out')
    writeFileSync(
      rollout,
      [imageCall('a', 'completed', 'p1', pngBase64(1)), imageCall('b', 'completed', 'p2', pngBase64(2)), imageCall('c', 'completed', 'p3', pngBase64(3))].join('\n'),
    )
    const { images } = recoverGeneratedImages({ sessionFile: rollout, outDir, count: 2 })
    expect(images).toHaveLength(2)
    expect(images.map(i => i.revisedPrompt)).toEqual(['p2', 'p3'])
  })

  it('returns no images when the rollout has none', () => {
    const rollout = join(dir, 'rollout-empty.jsonl')
    writeFileSync(rollout, [NON_IMAGE_LINE, NON_IMAGE_LINE].join('\n'))
    const { images } = recoverGeneratedImages({ sessionFile: rollout, outDir: join(dir, 'out') })
    expect(images).toHaveLength(0)
  })
})
