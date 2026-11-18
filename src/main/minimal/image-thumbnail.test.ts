import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const image = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 1600, height: 900 })),
    resize: vi.fn(),
    toJPEG: vi.fn(() => Buffer.from([1, 2, 3])),
  }
  image.resize.mockReturnValue(image)
  return { image, createFromBuffer: vi.fn(() => image) }
})
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: electron.createFromBuffer } }))
let imageThumbnail: typeof import('./image-thumbnail').imageThumbnail

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII='
function pngWithDimensions(width: number, height = 1) {
  const bytes = Buffer.from(PNG, 'base64')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}
const pngWithWidth = (width: number) => pngWithDimensions(width)

beforeEach(async () => {
  vi.resetModules() // Isolate the module-owned cache and serialized queue.
  vi.clearAllMocks()
  electron.image.isEmpty.mockReturnValue(false)
  electron.image.getSize.mockReturnValue({ width: 1600, height: 900 })
  electron.image.resize.mockReturnValue(electron.image)
  electron.image.toJPEG.mockReturnValue(Buffer.from([1, 2, 3]))
  ;({ imageThumbnail } = await import('./image-thumbnail'))
})

describe('imageThumbnail', () => {
  it('decodes once, fits the default Retina card rectangle, and returns original dimensions', async () => {
    const data = pngWithWidth(2)
    expect(await imageThumbnail(data, 'image/png')).toEqual({
      dataUrl: 'data:image/jpeg;base64,AQID', width: 1600, height: 900,
    })
    expect(electron.image.resize).toHaveBeenCalledWith({ width: 256, height: 144, quality: 'good' })
    await imageThumbnail(data, 'image/png')
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by physical frame size and deduplicates concurrent requests', async () => {
    const data = pngWithWidth(2), size = { width: 128, height: 78 }
    await Promise.all([imageThumbnail(data, 'image/png', size), imageThumbnail(data, 'image/png', size)])
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(1)
    expect(electron.image.resize).toHaveBeenLastCalledWith({ width: 128, height: 72, quality: 'good' })
    await imageThumbnail(data, 'image/png', { width: 256, height: 156 })
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(2)
    await imageThumbnail(data, 'image/png', size)
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(2)
  })

  it('fits portrait images and never upscales small originals', async () => {
    electron.image.getSize.mockReturnValue({ width: 900, height: 2700 })
    await imageThumbnail(pngWithWidth(2), 'image/png')
    expect(electron.image.resize).toHaveBeenLastCalledWith({ width: 52, height: 156, quality: 'good' })
    electron.image.getSize.mockReturnValue({ width: 32, height: 18 })
    electron.image.resize.mockClear()
    await imageThumbnail(pngWithWidth(3), 'image/png')
    expect(electron.image.resize).not.toHaveBeenCalled()
  })

  it('evicts by a conservative 8MiB encoded-string budget, not only entry count', async () => {
    electron.image.toJPEG.mockReturnValue(Buffer.alloc(2 * 1024 * 1024))
    const a = pngWithWidth(2), b = pngWithWidth(3)
    await imageThumbnail(a, 'image/png')
    await imageThumbnail(b, 'image/png')
    await imageThumbnail(a, 'image/png')
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(3)
  })

  it('returns a valid over-budget preview without retaining it', async () => {
    electron.image.toJPEG.mockReturnValue(Buffer.alloc(4 * 1024 * 1024))
    expect(await imageThumbnail(PNG, 'image/png')).not.toBeNull()
    await imageThumbnail(PNG, 'image/png')
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(2)
  })

  it('keeps at most 120 entries and updates recency on hits', async () => {
    for (let i = 1; i <= 120; i++) await imageThumbnail(pngWithWidth(i), 'image/png')
    await imageThumbnail(pngWithWidth(1), 'image/png')
    await imageThumbnail(pngWithWidth(121), 'image/png')
    await imageThumbnail(pngWithWidth(1), 'image/png')
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(121)
    await imageThumbnail(pngWithWidth(2), 'image/png')
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(122)
  })

  it('rejects unsupported formats and invalid base64 without decoding', async () => {
    expect(await imageThumbnail(PNG, 'image/svg+xml')).toBeNull()
    expect(await imageThumbnail('not base64!', 'image/png')).toBeNull()
    expect(await imageThumbnail(PNG, 'image/png')).not.toBeNull()
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized dimensions and pixel counts before decoding', async () => {
    expect(await imageThumbnail(pngWithWidth(20000), 'image/png')).toBeNull()
    expect(await imageThumbnail(pngWithDimensions(5000, 5000), 'image/png')).toBeNull()
    expect(electron.createFromBuffer).not.toHaveBeenCalled()
  })

  it('rejects invalid or excessive output bounds before decoding', async () => {
    for (const size of [null, {}, { width: 1000, height: 78 }, { width: 128, height: 0 }, { width: 128, height: Infinity }, { width: 2.5, height: 78 }]) {
      expect(await imageThumbnail(PNG, 'image/png', size)).toBeNull()
    }
    expect(electron.createFromBuffer).not.toHaveBeenCalled()
  })

  it('returns null when nativeImage cannot decode', async () => {
    electron.image.isEmpty.mockReturnValue(true)
    expect(await imageThumbnail(pngWithWidth(3), 'image/png')).toBeNull()
    expect(electron.createFromBuffer).toHaveBeenCalled()
  })
})
