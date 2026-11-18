import { createHash } from 'node:crypto'
import { nativeImage } from 'electron'
import { imageSize } from 'image-size'
import { imageMime } from './workspace-assets'
import {
  DEFAULT_THUMBNAIL_SIZE, MAX_THUMBNAIL_SIZE, fitImage,
  type ImageThumbnail, type ImageThumbnailSize,
} from '../../../packages/shared/images'

const MAX_BASE64 = 24 * 1024 * 1024
const MAX_DIMENSION = 16384
const MAX_PIXELS = 16_000_000
const MAX_CACHE = 120
// Conservative retained-string estimate, not a cap on decode bitmaps or app RSS.
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const CACHE = new Map<string, { value: ImageThumbnail | null; bytes: number }>()
let cacheBytes = 0
let queue: Promise<unknown> = Promise.resolve()

function cached(key: string): ImageThumbnail | null | undefined {
  const entry = CACHE.get(key)
  if (!entry) return
  CACHE.delete(key)
  CACHE.set(key, entry)
  return entry.value
}

function remember(key: string, value: ImageThumbnail | null): void {
  const bytes = key.length * 2 + (value?.dataUrl.length || 0) * 2 + 32
  if (bytes > MAX_CACHE_BYTES) return
  CACHE.set(key, { value, bytes })
  cacheBytes += bytes
  while (CACHE.size > MAX_CACHE || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = CACHE.keys().next().value!
    cacheBytes -= CACHE.get(oldest)!.bytes
    CACHE.delete(oldest)
  }
}

function requestedSize(value: unknown): ImageThumbnailSize | null {
  if (value === undefined) return DEFAULT_THUMBNAIL_SIZE
  if (!value || typeof value !== 'object') return null
  const { width, height } = value as ImageThumbnailSize
  if (![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_THUMBNAIL_SIZE))
    return null
  return { width, height }
}

const supported = (mimeType: unknown): mimeType is string =>
  typeof mimeType === 'string' && /^image\/(?:png|jpe?g|webp|gif)$/i.test(mimeType)

/** Bounded raster input only. Decode dimensions and reject oversized bitmaps first. */
function prepare(data: unknown, mimeType: unknown): Buffer | null {
  if (
    typeof data !== 'string' ||
    !supported(mimeType) ||
    data.length > MAX_BASE64 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    return null
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || !imageMime(bytes)) return null
  let dimensions: { width?: number; height?: number }
  try {
    dimensions = imageSize(bytes)
  } catch {
    return null
  }
  const width = dimensions.width,
    height = dimensions.height
  if (
    !width ||
    !height ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    return null
  return bytes
}

function decode(bytes: Buffer, bounds: ImageThumbnailSize): ImageThumbnail | null {
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (!width || !height) return null
  const target = fitImage(width, height, bounds.width, bounds.height)
  const preview =
    target.width === width && target.height === height
      ? image
      : image.resize({ width: target.width, height: target.height, quality: 'good' })
  const jpeg = preview.toJPEG(80)
  if (!jpeg.length) return null
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width,
    height,
  }
}

/**
 * Display-only thumbnails. The renderer never mounts these until a disclosure is
 * open; the main-process cache avoids decoding the same native image twice.
 */
export function imageThumbnail(
  data: unknown,
  mimeType?: unknown,
  size?: unknown,
): Promise<ImageThumbnail | null> {
  const bounds = requestedSize(size)
  if (!bounds) return Promise.resolve(null)
  const bytes = prepare(data, mimeType)
  if (!bytes) return Promise.resolve(null)
  const key = `${(mimeType as string).toLowerCase()}:${bounds.width}x${bounds.height}:${createHash('sha256').update(bytes).digest('hex')}`
  const hit = cached(key)
  if (hit !== undefined) return Promise.resolve(hit)
  const run = queue.then(() => {
    const hit = cached(key)
    if (hit !== undefined) return hit
    const value = decode(bytes, bounds)
    remember(key, value)
    return value
  })
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run.catch(() => null)
}
