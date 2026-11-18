import type { ContentBlock, Message } from '../../../../packages/shared/desktop'
import { messageText } from './transcript'

const MARKER = 'Attached workspace files (use native file tools when needed):'
const IMAGE_EXTENSION = /\.(?:gif|jpe?g|png|webp)$/i

export interface FileAttachment {
  path: string
  name: string
  extension: string
}

export interface MessageImage {
  key: string
  block: ContentBlock
  path?: string
  name: string
  index: number
  total: number
}

export interface UserMessageView {
  text: string
  images: MessageImage[]
  files: FileAttachment[]
}

export type ToolImage = MessageImage

export function isImageBlock(block: ContentBlock): boolean {
  return block.type === 'image' && typeof block.data === 'string' && block.data.length > 0
}

export function imageDataUrl(block: ContentBlock): string {
  const mime = block.mimeType && /^image\//i.test(block.mimeType) ? block.mimeType : 'image/png'
  return `data:${mime};base64,${block.data || ''}`
}

export function imageBytes(block: ContentBlock): number {
  const data = block.data || ''
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`
}

export function attachmentName(path: string): string {
  const base = path.split(/[\\/]/).pop() || path
  // Imported attachments are timestamp + UUID + safe original name.
  const imported = path.includes('.pi/attachments/')
  if (!imported) return base
  const uuid = base.match(
    /^.*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i,
  )
  return uuid ? uuid[1] : base
}

export function attachmentExtension(path: string): string {
  const name = attachmentName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 5) : 'FILE'
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION.test(path)
}

/** Parse the native text block added by the desktop composer, never model output. */
export function splitAttachmentBlock(text: string): { text: string; paths: string[] } | null {
  const marker = text.lastIndexOf(MARKER)
  if (marker < 0) return null
  const after = text.slice(marker + MARKER.length)
  if (after && !after.startsWith('\n')) return null
  const paths: string[] = []
  for (const line of after.split('\n')) {
    const value = line.trim()
    if (!value) continue
    // Pi appends a display hint after image attachments. It is not a path.
    if (/^\[Image: .*\]$/.test(value)) continue
    let path: unknown
    try {
      path = JSON.parse(value)
    } catch {
      return null
    }
    if (typeof path !== 'string' || !path || path.includes('\0')) return null
    paths.push(path)
  }
  if (!paths.length) return null
  return { text: text.slice(0, marker).replace(/\s+$/, ''), paths }
}

export function visibleMessageText(message: Message): string {
  const text = messageText(message)
  return splitAttachmentBlock(text)?.text ?? text
}

export function userMessageView(message: Message): UserMessageView {
  const body = messageText(message)
  const parsed = splitAttachmentBlock(body)
  const blocks = Array.isArray(message.content) ? message.content.filter(isImageBlock) : []
  const paths = parsed?.paths || []
  const imageIndices = paths
    .map((path, index) => (isImagePath(path) ? index : -1))
    .filter((index) => index >= 0)
  const used = new Set(imageIndices.slice(0, blocks.length))
  const images = blocks.map((block, index) => {
    const path = paths[imageIndices[index]]
    return {
      key: `${path || 'image'}:${index}`,
      block,
      path,
      name: path ? attachmentName(path) : `Image ${index + 1}`,
      index,
      total: blocks.length,
    }
  })
  const files = paths
    .map((path, index) => ({ path, index }))
    .filter(({ index }) => !used.has(index))
    .map(({ path }) => ({
      path,
      name: attachmentName(path),
      extension: attachmentExtension(path),
    }))
  return { text: parsed?.text ?? body, images, files }
}

function callPath(call: ContentBlock): string | undefined {
  const args = (call.arguments && typeof call.arguments === 'object' ? call.arguments : {}) as Record<
    string,
    unknown
  >
  const value = args.path ?? args.file_path
  return typeof value === 'string' && value ? value : undefined
}

/** Four thumbnails per tool result is enough to identify a contact sheet. */
export function toolResultImages(
  calls: ContentBlock[],
  results: Map<string, Message>,
  cap = 4,
): ToolImage[] {
  const images: ToolImage[] = []
  calls.forEach((call, callIndex) => {
    const result = results.get(call.id || '')
    if (!Array.isArray(result?.content)) return
    const blocks = result.content.filter(isImageBlock)
    const path = callPath(call)
    const name = path ? attachmentName(path) : call.name || 'tool'
    for (let index = 0; index < Math.min(blocks.length, cap); index++) {
      images.push({
        key: `${call.id || call.name || 'tool'}:${callIndex}:${index}`,
        block: blocks[index],
        path,
        name,
        index,
        total: blocks.length,
      })
    }
  })
  return images
}
