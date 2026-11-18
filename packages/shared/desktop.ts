import type { CodexUsageSnapshot } from './codex-usage'
import type { TodoState } from './todo-state'
import type { Attachment, AttachmentInput, FileOperation } from './assets'
import type { ImageThumbnail, ImageThumbnailSize } from './images'
import type { TerminalInfo, TerminalTransport } from './terminal'
// The desktop projects native Pi records; it does not own an agent or session format.
export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  arguments?: unknown
  /** Native Pi image content: base64 bytes plus MIME type. */
  data?: string
  mimeType?: string
}
export interface Message {
  role: string
  content?: string | ContentBlock[]
  timestamp?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  errorMessage?: string
  stopReason?: string
  customType?: string
  command?: string
  output?: string
  summary?: string
  tokensBefore?: number
  display?: boolean
  details?: Record<string, any>
  usage?: { input: number; output: number; totalTokens: number; cost?: { total: number } }
}
export interface Model {
  id: string
  provider: string
  api?: string
  baseUrl?: string
  name?: string
  reasoning?: boolean
  input?: string[]
}
export interface Command {
  name: string
  description?: string
  source: string
  sourceInfo?: { path?: string; [key: string]: unknown }
}
export type SessionStatus = 'inactive' | 'active' | 'working'
export interface RunningSession {
  handle: string
  workspace: string
  path: string
  status: SessionStatus
}
export interface SessionInfo {
  status?: SessionStatus
  handle?: string
  id: string
  path: string
  name?: string
  firstMessage: string
  modified: string
  messageCount: number
}
export interface Workspace {
  path: string
  name: string
}
export interface Preferences {
  language?: import('./language').Language
  workspaces: Workspace[]
  activeWorkspace?: string
  activeSession?: string
  theme: 'system' | 'light' | 'dark'
  font?: 'default' | 'serif'
  enterToSend: boolean
  /** Automatic follows AI body size; explicit sizes are shared across temporary terminals. */
  terminalFontSize?: number | 'auto'
}
export interface SessionState {
  sessionFile?: string
  sessionName?: string
  sessionId?: string
  model?: Model
  thinkingLevel?: string
  isStreaming?: boolean
  isCompacting?: boolean
}
export interface ContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}
export interface Snapshot {
  subagents?: import('./subagents').SubagentStatus
  contextUsage?: ContextUsage
  todo?: TodoState
  queued?: { steering: string[]; followUp: string[] }
  handle: string
  ui?: PiRecord[]
  workspace: string
  state: SessionState
  messages: Message[]
  commands: Command[]
  models: Model[]
  levels: string[]
}
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}
// Extension/event payloads are versioned by the installed Pi, not this app.
export type PiRecord = { type: string; [key: string]: any }
export interface DesktopAPI {
  checkUpdate(): Promise<import('./updates').UpdateInfo>
  downloadUpdate(version: string): Promise<'saved' | 'canceled'>
  boot(): Promise<{ preferences: Preferences; runtime: string }>
  preferences(patch: Partial<Pick<Preferences, 'theme' | 'font' | 'enterToSend' | 'language' | 'terminalFontSize'>>): Promise<Preferences>
  terminals(): Promise<TerminalInfo[]>
  createTerminal(workspace: string): Promise<TerminalInfo>
  renameTerminal(id: string, name: string): Promise<void>
  closeTerminal(id: string): Promise<boolean>
  terminal: TerminalTransport
  addWorkspace(): Promise<Preferences>
  renameWorkspace(path: string, name: string): Promise<Preferences>
  removeWorkspace(path: string): Promise<Preferences>
  sessions(workspace: string): Promise<SessionInfo[]>
  open(workspace: string, session?: string): Promise<Snapshot>
  deleteSession(workspace: string, session: string): Promise<boolean>
  codexUsage(): Promise<CodexUsageSnapshot>
  plugins(workspace?: string): Promise<import('./plugins').PluginInventory>
  runningSessions(): Promise<RunningSession[]>
  closeSession(handle: string): Promise<void>
  reload(handle?: string): Promise<Snapshot>
  command(type: string, args?: Record<string, unknown>, handle?: string): Promise<any>
  snapshot(handle?: string): Promise<Snapshot>
  respond(response: PiRecord): Promise<void>
  files(path: string, handle?: string): Promise<FileEntry[]>
  readFile(path: string, handle?: string): Promise<{ content: string; revision: string }>
  saveFile(path: string, content: string, revision: string, handle?: string): Promise<string>
  importAttachments(handle: string, inputs: AttachmentInput[]): Promise<Attachment[]>
  pasteAttachments(handle: string): Promise<Attachment[]>
  discardAttachment(handle: string, id: string): Promise<void>
  pathForFile(file: File): string
  copyFile(handle: string, path: string): Promise<void>
  copyIntoWorkspace(workspace: string, directory: string, paths: string[]): Promise<void>
  pasteFiles(handle: string, directory: string): Promise<void>
  fileOperation(handle: string, operation: FileOperation): Promise<boolean>
  copyText(text: string): Promise<void>
  openExternal(url: string): Promise<void>
  openLocalLink(handle: string, href: string, baseDir?: string): Promise<void>
  previewLocalImage(handle: string, href: string, baseDir?: string, requestApproval?: boolean): Promise<import('./links').LocalImagePreview>
  imageThumbnail(data: string, mimeType?: string, size?: ImageThumbnailSize): Promise<ImageThumbnail | null>
  fileSizes(handle: string, paths: string[]): Promise<Record<string, number | null>>
  documentDirty(dirty: boolean): Promise<void>
  onEvent(listener: (record: PiRecord) => void): () => void
}
