import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopAPI, PiRecord } from '../../packages/shared/desktop'
import type { TerminalTransport } from '../../packages/shared/terminal'
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('pi:invoke', method, args)
const onEvent = (listener: (record: PiRecord) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, record: PiRecord) => listener(record)
  ipcRenderer.on('pi:event', handler)
  return () => ipcRenderer.removeListener('pi:event', handler)
}
const terminal: TerminalTransport = {
  attach: (id) => invoke('terminalAttach', id),
  acknowledge: (id, sequence) => invoke('terminalAcknowledge', id, sequence),
  resize: (id, cols, rows) => invoke('terminalResize', id, cols, rows),
  write: (id, data) => invoke('terminalWrite', id, data),
  submit: (id, buffer) => invoke('terminalSubmit', id, buffer),
  complete: (id, buffer, cursor) => invoke('terminalComplete', id, buffer, cursor),
  setMode: (id, mode, buffer, cursor) => invoke('terminalMode', id, mode, buffer, cursor),
  interrupt: (id) => invoke('terminalInterrupt', id),
  onOutput: (listener) => onEvent((record) => {
    if (record.type === 'desktop_terminal_output') listener(record as unknown as Parameters<typeof listener>[0])
  }),
  copyText: (text) => invoke('copyText', text),
  pasteText: () => invoke('pasteText'),
}
const api: DesktopAPI = {
  checkUpdate: () => invoke('checkUpdate'),
  downloadUpdate: (version) => invoke('downloadUpdate', version),
  boot: () => invoke('boot'),
  enterBubble: () => invoke('enterBubble'),
  preferences: (patch) => invoke('preferences', patch),
  terminals: () => invoke('terminals'),
  createTerminal: (workspace, directory) => invoke('createTerminal', workspace, directory),
  renameTerminal: (id, name) => invoke('renameTerminal', id, name),
  closeTerminal: (id) => invoke('closeTerminal', id),
  terminal,
  addWorkspace: () => invoke('addWorkspace'),
  pinSession: (workspace, path, pinned) => invoke('pinSession', workspace, path, pinned),
  renameSession: (workspace, path, name) => invoke('renameSession', workspace, path, name),
  pinWorkspace: (path, pinned) => invoke('pinWorkspace', path, pinned),
  renameWorkspace: (path, name) => invoke('renameWorkspace', path, name),
  removeWorkspace: (path) => invoke('removeWorkspace', path),
  sessions: (workspace, query) => invoke('sessions', workspace, query),
  open: (workspace, session) => invoke('open', workspace, session),
  deleteSession: (workspace, session) => invoke('deleteSession', workspace, session),
  codexUsage: () => invoke('codexUsage'),
  plugins: (workspace) => invoke('plugins', workspace),
  runningSessions: () => invoke('runningSessions'),
  closeSession: (handle) => invoke('closeSession', handle),
  reload: (handle) => invoke('reload', handle),
  snapshot: (handle) => invoke('snapshot', handle),
  command: (type, args, handle) => invoke('command', type, args, handle),
  respond: (response) => invoke('respond', response),
  files: (path, handle) => invoke('files', path, handle),
  fileStamp: (path, handle) => invoke('fileStamp', path, handle),
  readPdfFile: (path, handle) => invoke('readPdfFile', path, handle),
  readImageFile: (path, handle) => invoke('readImageFile', path, handle),
  readFile: (path, handle) => invoke('readFile', path, handle),
  saveFile: (path, content, revision, handle) => invoke('saveFile', path, content, revision, handle),
  importAttachments: (handle, inputs) => invoke('importAttachments', handle, inputs),
  pasteAttachments: (handle) => invoke('pasteAttachments', handle),
  discardAttachment: (handle, id) => invoke('discardAttachment', handle, id),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openFileExternally: (handle, path) => invoke('openFileExternally', handle, path),
  copyFile: (handle, path) => invoke('copyFile', handle, path),
  copyIntoWorkspace: (workspace, directory, paths) =>
    invoke('copyIntoWorkspace', workspace, directory, paths),
  pasteFiles: (handle, directory) => invoke('pasteFiles', handle, directory),
  fileOperation: (handle, operation) => invoke('fileOperation', handle, operation),
  copyText: (text) => invoke('copyText', text),
  openExternal: (url) => invoke('openExternal', url),
  openLocalLink: (handle, href, baseDir) => invoke('openLocalLink', handle, href, baseDir),
  previewLocalImage: (handle, href, baseDir, requestApproval) => invoke('previewLocalImage', handle, href, baseDir, requestApproval),
  imageThumbnail: (data, mimeType, size) => invoke('imageThumbnail', data, mimeType, size),
  fileSizes: (handle, paths) => invoke('fileSizes', handle, paths),
  documentDirty: (dirty) => invoke('documentDirty', dirty),
  onEvent,
}
contextBridge.exposeInMainWorld('desktop', api)
