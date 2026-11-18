export interface Attachment {
  id: string
  name: string
  path: string
  size: number
  mimeType?: string
  preview?: string
}
export type AttachmentInput = { path: string } | { name: string; bytes: Uint8Array }
export type FileOperation =
  | { type: 'create'; directory: string; name: string; folder: boolean }
  | { type: 'rename'; path: string; name: string }
  | { type: 'trash'; path: string }
  | { type: 'copy'; paths: string[]; directory: string }
