export interface ImageThumbnail {
  /** JPEG thumbnail, kept small enough to cross IPC and stay in memory. */
  dataUrl: string
  /** Dimensions of the original image, not the thumbnail. */
  width: number
  height: number
}

export interface ImageThumbnailSize {
  width: number
  height: number
}

export const MAX_THUMBNAIL_SIZE = 512
export const DEFAULT_THUMBNAIL_SIZE: ImageThumbnailSize = { width: 256, height: 156 }

/** Physical pixels for the actual card frame, capped at 3x density and 512px. */
export function thumbnailSize(width = 128, height = 78, density = 1): ImageThumbnailSize {
  const scale = Number.isFinite(density) && density > 0 ? Math.min(3, density) : 1
  const pixels = (value: number, fallback: number) =>
    Math.min(MAX_THUMBNAIL_SIZE, Math.max(1, Math.ceil((Number.isFinite(value) && value > 0 ? value : fallback) * scale)))
  return { width: pixels(width, 128), height: pixels(height, 78) }
}

/** Fit inside a rectangular bound without upscaling or changing the aspect ratio. */
export function fitImage(
  width: number,
  height: number,
  bound = 720,
  boundHeight = bound,
): { width: number; height: number } {
  if (![width, height, bound, boundHeight].every((value) => Number.isFinite(value) && value >= 1))
    return { width: 1, height: 1 }
  const scale = Math.min(1, bound / width, boundHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
