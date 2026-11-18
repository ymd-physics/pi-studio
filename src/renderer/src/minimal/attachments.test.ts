import { describe, expect, it } from 'vitest'
import type { Message } from '../../../../packages/shared/desktop'
import {
  attachmentExtension,
  attachmentName,
  formatBytes,
  imageBytes,
  splitAttachmentBlock,
  toolResultImages,
  userMessageView,
  visibleMessageText,
} from './attachments'

const image = (data = 'AA==', mimeType = 'image/png') => ({ type: 'image', data, mimeType })

describe('user attachment projection', () => {
  it('strips the native path block and pairs image paths with image blocks', () => {
    const message: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Compare these.\nAttached workspace files (use native file tools when needed):\n".pi/attachments/a.png"\n".pi/attachments/report.pdf"\n".pi/attachments/b.csv"\n".pi/attachments/c.jpg"',
        },
        image('AAAA'),
        image('BBBB'),
      ],
    }
    const view = userMessageView(message)
    expect(view.text).toBe('Compare these.')
    expect(view.images.map((image) => image.name)).toEqual(['a.png', 'c.jpg'])
    expect(view.files.map((file) => file.name)).toEqual(['report.pdf', 'b.csv'])
  })

  it('leaves text alone when the trailing block is not a JSON path list', () => {
    const text = 'Attached workspace files (use native file tools when needed):\nnot a path'
    expect(splitAttachmentBlock(text)).toBeNull()
    expect(userMessageView({ role: 'user', content: text }).text).toBe(text)
  })

  it('ignores Pi image dimensions appended after the attachment paths', () => {
    const message: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Compare.\nAttached workspace files (use native file tools when needed):\n".pi/attachments/a.png"\n[Image: original 2320x1640, displayed at 2000x1414. Multiply coordinates by 1.16 to map to original image.]',
        },
        image('AAAA'),
      ],
    }
    const view = userMessageView(message)
    expect(view.text).toBe('Compare.')
    expect(view.images[0].name).toBe('a.png')
    expect(view.files).toEqual([])
  })

  it('treats formats the native image pipeline does not support as files', () => {
    const message: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Look.\nAttached workspace files (use native file tools when needed):\n".pi/attachments/scan.avif"\n".pi/attachments/shot.png"',
        },
        image('AAAA'),
      ],
    }
    const view = userMessageView(message)
    expect(view.images[0].name).toBe('shot.png')
    expect(view.files.map((file) => file.name)).toEqual(['scan.avif'])
  })

  it('strips the attachment block from visible message text for branch/tree surfaces', () => {
    const message: Message = {
      role: 'user',
      content:
        'Fork me\nAttached workspace files (use native file tools when needed):\n".pi/attachments/report.pdf"',
    }
    expect(visibleMessageText(message)).toBe('Fork me')
  })

  it('does not require a body before the attachment block', () => {
    const message: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '\nAttached workspace files (use native file tools when needed):\n".pi/attachments/a.png"',
        },
        image('AAAA'),
      ],
    }
    const view = userMessageView(message)
    expect(view.text).toBe('')
    expect(view.images[0].name).toBe('a.png')
    expect(view.files).toEqual([])
  })

  it('keeps unmatched image paths as file cards', () => {
    const message: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Attached workspace files (use native file tools when needed):\n".pi/attachments/a.png"\n".pi/attachments/b.png"',
        },
        image('AAAA'),
      ],
    }
    const view = userMessageView(message)
    expect(view.images).toHaveLength(1)
    expect(view.files.map((file) => file.name)).toEqual(['b.png'])
  })
})

describe('image and tool metadata', () => {
  it('formats native image bytes and file extensions', () => {
    expect(imageBytes(image('AAAA'))).toBe(3)
    expect(imageBytes(image('AAA='))).toBe(2)
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(attachmentExtension('.pi/a/report.PDF')).toBe('PDF')
    expect(attachmentExtension('README')).toBe('FILE')
    expect(
      attachmentName(
        '.pi/attachments/2026-11-15T06-16-25-292Z-aaf16bca-cb05-46cc-b57c-8aa0c5826f04-pasted-image.png',
      ),
    ).toBe('pasted-image.png')
  })

  it('keeps keys unique across tool calls and duplicate attachment paths', () => {
    const calls = [
      { type: 'toolCall', id: '', name: 'read', arguments: { path: 'a.png' } },
      { type: 'toolCall', id: '', name: 'read', arguments: { path: 'b.png' } },
    ]
    const results = new Map<string, Message>([
      ['', { role: 'toolResult', content: [image('AAAA'), image('BBBB')] }],
    ])
    expect(toolResultImages(calls, results).map((image) => image.key)).toEqual([
      'read:0:0',
      'read:0:1',
      'read:1:0',
      'read:1:1',
    ])
  })

  it('collects at most four images from each tool result and uses the call path', () => {
    const call = {
      type: 'toolCall',
      id: 'call-1',
      name: 'read',
      arguments: { path: '/workspace/shot.png' },
    }
    const results = new Map<string, Message>([
      [
        'call-1',
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          content: [image('AAAA'), image('BBBB'), image('CCCC'), image('DDDD'), image('EEEE')],
        },
      ],
    ])
    const images = toolResultImages([call], results)
    expect(images).toHaveLength(4)
    expect(images[0].name).toBe('shot.png')
    expect(images[3].total).toBe(5)
    expect(images[0].key).toBe('call-1:0:0')
  })
})
