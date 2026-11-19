import { checkRelease, saveDmg } from './updates'
import { uiText } from '../../../packages/shared/language'
import { app, net, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage } from 'electron'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellEnv } from 'shell-env'
import { mergeLoginShellEnvironment } from '../login-shell-environment'
import { DesktopService } from './service'
import { studioProfilePath } from './app-identity'
import { TerminalService } from './terminal-service'
import { CodexUsageService } from './codex-usage'
import { copyFilePaths, pastedFilePaths } from './file-clipboard'
import { resolveLocalLink, readLocalImage } from './local-links'
import { imageThumbnail } from './image-thumbnail'
import type { Attachment, AttachmentInput } from '../../../packages/shared/assets'

const here = dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | undefined
const t = (text: string) => uiText(service?.preferences.language)(text)
let service: DesktopService
let codexUsage: CodexUsageService | undefined
let terminals: TerminalService | undefined
const retiringTerminals = new Set<TerminalService>()
let quitting = false
let checkingQuit = false
let confirmedShutdown = false
let documentDirty = false
// Keep the existing packaged/dev profiles and single-instance lock across the
// display-name change. Never migrate, copy or reset the user's native Pi data.
app.setPath('userData', studioProfilePath(app.getPath('appData'), process.env.PI_DESKTOP_DATA_DIR))
app.setName('Pi Studio')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })
  app
    .whenReady()
    .then(async () => {
      if (process.platform !== 'win32') {
        try {
          process.env = mergeLoginShellEnvironment({
            launchEnvironment: process.env,
            loginShellEnvironment: await shellEnv(),
            pathDelimiter: delimiter,
          })
        } catch {
          /* preserve launch environment */
        }
      }
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      )
      service = new DesktopService(
        app.getPath('userData'),
        (record) => {
          if (window && !window.isDestroyed()) window.webContents.send('pi:event', record)
        },
        (path) => shell.trashItem(path),
        (needed) => {
          if (needed) codexUsage?.start()
          else codexUsage?.stop()
        },
      )
      const createTerminalService = () => new TerminalService(
        (record) => { if (window && !window.isDestroyed()) window.webContents.send('pi:event', record) },
        () => service.preferences.workspaces,
        process.env,
        app.getVersion(),
        join(app.getAppPath().replace(/\.asar$/, '.asar.unpacked'), 'resources/terminal/zsh-integration.zsh'),
      )
      terminals = createTerminalService()
      const terminalService = () => {
        if (!terminals || confirmedShutdown) throw new Error('Terminal service is restarting or stopping')
        return terminals
      }
      codexUsage = new CodexUsageService({
        changed: (usage) => {
          if (window && !window.isDestroyed())
            window.webContents.send('pi:event', { type: 'desktop_codex_usage', usage })
        },
      })
      const attach = async (handle: string, inputs: AttachmentInput[]) => {
        if (!inputs.length) return []
        const workspace = service.workspace(handle)
        const attachments = await service.importAttachments(handle, inputs)
        return Promise.all(
          attachments.map(async (attachment: Attachment) => {
            if (!attachment.mimeType) return attachment
            const data = await service.assets.bytes(workspace, handle, attachment.id)
            const image = nativeImage.createFromBuffer(data)
            if (image.isEmpty()) return attachment
            return {
              ...attachment,
              preview: image.resize({ width: 120, height: 90, quality: 'good' }).toDataURL(),
            }
          }),
        )
      }
      // Serialize decoding; Markdown may contain many images in a long transcript.
      let imageReads: Promise<unknown> = Promise.resolve()
      const localTarget = (handle: string, href: string, baseDir?: string) => {
        if (typeof handle !== 'string' || !handle) throw new Error('A live originating session is required')
        return resolveLocalLink(service.workspace(handle), href, baseDir)
      }
      let boot: ReturnType<DesktopService['boot']> | undefined
      let offered: Awaited<ReturnType<typeof checkRelease>>['asset']
      let downloading = false
      const handlers: Record<string, (...args: any[]) => any> = {
        boot: () =>
          (boot ||= service
            .boot()
            .catch((error) => {
              boot = undefined
              throw error
            })),
        checkUpdate: async () => {
          offered = undefined
          const release = await checkRelease(app.getVersion(), process.platform, process.arch, (url, init) => net.fetch(url, init))
          offered = release.asset
          return release.info
        },
        downloadUpdate: async (version) => {
          const asset = offered
          if (!asset || asset.version !== version || downloading) throw new Error('Update unavailable or download in progress')
          downloading = true
          try {
            const choice = await dialog.showSaveDialog(window!, {
              defaultPath: join(app.getPath('downloads'), asset.name), filters: [{ name: 'DMG', extensions: ['dmg'] }],
            })
            if (choice.canceled || !choice.filePath) return 'canceled'
            await saveDmg(asset, choice.filePath, (url, init) => net.fetch(url, init))
            return 'saved'
          } finally { downloading = false }
        },
        codexUsage: () => codexUsage!.snapshot(),
        plugins: (workspace) => service.plugins(workspace),
        preferences: (patch) => service.updatePreferences(patch || {}),
        terminals: () => terminals?.list() || [],
        createTerminal: (workspace) => terminalService().create(workspace),
        renameTerminal: (id, name) => terminalService().rename(id, name),
        closeTerminal: async (id) => {
          const info = terminalService().list().find((item) => item.id === id)
          if (!info) { await terminalService().close(id); return true }
          const choice = await dialog.showMessageBox(window!, {
            type: 'warning', message: t('Close this terminal?'),
            detail: `${info.name}\n\n${t('Its shell and managed tasks will be stopped. The terminal entry and output will be discarded; workspace files and shell-managed command history will not be deleted.')}`,
            buttons: [t('Cancel'), t('Close terminal')], defaultId: 0, cancelId: 0,
          })
          if (choice.response !== 1) return false
          await terminalService().close(id)
          return true
        },
        terminalAttach: (id) => terminalService().attach(id),
        terminalAcknowledge: (id, sequence) => terminalService().acknowledge(id, sequence),
        terminalResize: (id, cols, rows) => terminalService().resize(id, cols, rows),
        terminalWrite: (id, data) => terminalService().write(id, data),
        terminalSubmit: (id, buffer) => terminalService().submit(id, buffer),
        terminalComplete: (id, buffer, cursor) => terminalService().complete(id, buffer, cursor),
        terminalMode: (id, mode, buffer, cursor) => terminalService().setMode(id, mode, buffer, cursor),
        terminalInterrupt: (id) => terminalService().interrupt(id),
        pasteText: () => {
          const text = clipboard.readText()
          if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Clipboard text exceeds the terminal paste limit (64 KiB)')
          return text
        },
        addWorkspace: async () => {
          const answer = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] })
          if (answer.canceled) return service.preferences
          const trust = await dialog.showMessageBox(window!, {
            type: 'warning',
            title: t('Trust this workspace?'),
            message: t('Pi can run tools and load project extensions in this directory. Terminals can run commands with your user permissions.'),
            detail: answer.filePaths[0],
            buttons: [t('Cancel'), t('Trust workspace')],
            defaultId: 0,
            cancelId: 0,
          })
          return trust.response === 1 ? service.addWorkspace(answer.filePaths[0]) : service.preferences
        },
        renameWorkspace: (path, name) => service.renameWorkspace(path, name),
        removeWorkspace: async (path) => {
          const choice = await dialog.showMessageBox(window!, {
            type: 'warning',
            message: t('Close this workspace?'),
            detail:
              t('All Pi sessions and terminals in this workspace will be stopped and closed. Terminal entries and output will be discarded. Workspace files, saved Pi history and shell-managed command history will not be deleted.'),
            buttons: [t('Cancel'), t('Stop sessions and close workspace')],
            defaultId: 0,
            cancelId: 0,
          })
          if (choice.response !== 1) return service.preferences
          return terminalService().removeWorkspace(path, () => service.removeWorkspace(path, true))
        },
        sessions: (workspace, query) => service.sessions(workspace, query),
        open: (workspace, session) => service.open(workspace, session),
        deleteSession: async (workspace, path) => {
          const choice = await dialog.showMessageBox(window!, {
            type: 'warning',
            message: t('Move this Pi session to Trash?'),
            detail: `${t('Any running work in this session will be aborted before removal. This removes the shared session from both Pi Studio and terminal Pi. Separate forks and clones are kept. You can restore the file from Trash.')}\n\n${path}`,
            buttons: [t('Cancel'), t('Move to Trash')],
            defaultId: 0,
            cancelId: 0,
          })
          if (choice.response !== 1) return false
          await service.deleteSession(workspace, path, true)
          return true
        },
        runningSessions: () => service.runningSessions(),
        closeSession: (handle) => service.closeSession(handle),
        snapshot: (handle) => service.snapshot(handle),
        documentDirty: (dirty) => {
          documentDirty = dirty === true
        },
        reload: (handle) => service.reload(handle),
        command: (type, args, handle) => service.command(type, args, handle),
        respond: (record) => service.respond(record),
        files: (path, handle) => service.files(path, handle),
        readFile: (path, handle) => service.readFile(path, handle),
        saveFile: (path, content, revision, handle) => service.saveFile(path, content, revision, handle),
        importAttachments: attach,
        discardAttachment: (handle, id) => service.discardAttachment(handle, id),
        pasteAttachments: async (handle) => {
          const paths = await pastedFilePaths()
          if (paths.length)
            return attach(
              handle,
              paths.map((path) => ({ path })),
            )
          const image = clipboard.readImage()
          return image.isEmpty() ? [] : attach(handle, [{ name: 'pasted-image.png', bytes: image.toPNG() }])
        },
        copyFile: async (handle, path) => copyFilePaths([await service.filePath(handle, path)]),
        copyIntoWorkspace: (workspace, directory, paths) =>
          service.copyIntoWorkspace(workspace, directory, paths),
        pasteFiles: async (handle, directory) => {
          const paths = await pastedFilePaths()
          if (!paths.length) throw new Error('Copy files in Finder or the file panel first')
          await service.fileOperation(handle, { type: 'copy', paths, directory })
        },
        fileOperation: async (handle, operation) => {
          if (operation?.type === 'trash') {
            const path = await service.filePath(handle, operation.path)
            const choice = await dialog.showMessageBox(window!, {
              type: 'warning',
              message: t('Move to Trash?'),
              detail: path,
              buttons: [t('Cancel'), t('Move to Trash')],
              defaultId: 0,
              cancelId: 0,
            })
            if (choice.response !== 1) return false
          }
          await service.fileOperation(handle, operation)
          return true
        },
        copyText: (text) => {
          if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024)
            throw new Error('Clipboard text must be a string no larger than 16 MiB')
          // Main-frame-only native clipboard; browser clipboard permissions stay denied.
          clipboard.writeText(text)
        },
        openLocalLink: async (handle, href, baseDir) => {
          const target = await localTarget(handle, href, baseDir)
          const choice = await dialog.showMessageBox(window!, {
            type: 'warning', message: t('Open this local file or folder?'),
            detail: `${target.path}\n\n${t('macOS will open it with the associated application. Only open files you trust.')}`,
            buttons: [t('Cancel'), t('Open original')], defaultId: 0, cancelId: 0,
          })
          if (choice.response !== 1) return
          const current = await localTarget(handle, href, baseDir)
          if (current.path !== target.path || current.root !== target.root) throw new Error('Link target changed; try again')
          const error = await shell.openPath(current.path)
          if (error) throw new Error(error)
        },
        imageThumbnail: (data, mimeType, size) => imageThumbnail(data, mimeType, size),
        fileSizes: (handle, paths) => service.fileSizes(handle, paths),
        previewLocalImage: async (handle, href, baseDir, requestApproval = false) => {
          const target = await localTarget(handle, href, baseDir)
          if (!target.insideWorkspace) {
            if (requestApproval !== true) return { needsApproval: true }
            const choice = await dialog.showMessageBox(window!, {
              type: 'warning', message: t('Preview an image outside this workspace?'), detail: target.path,
              buttons: [t('Cancel'), t('Load image')], defaultId: 0, cancelId: 0,
            })
            if (choice.response !== 1) return { needsApproval: true }
          }
          const read = imageReads.then(async () => {
            const current = await localTarget(handle, href, baseDir)
            if (current.path !== target.path || current.root !== target.root) throw new Error('Image path changed; try again')
            const image = nativeImage.createFromBuffer(await readLocalImage(current))
            if (image.isEmpty()) throw new Error('Image could not be decoded')
            const { width, height } = image.getSize()
            const scale = Math.min(1, 1200 / width, 900 / height)
            const preview = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }) : image
            return { dataUrl: preview.toDataURL() }
          })
          imageReads = read.catch(() => {})
          return read
        },
        openExternal: async (url) => {
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
            throw new Error('Only HTTP(S) links can be opened')
          const choice = await dialog.showMessageBox(window!, {
            message: t('Open link in your browser?'),
            detail: url,
            buttons: [t('Cancel'), t('Open')],
            defaultId: 0,
            cancelId: 0,
          })
          if (choice.response === 1) await shell.openExternal(url)
        },
      }
      ipcMain.handle('pi:invoke', (event, method: string, args: unknown[]) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
          throw new Error('Untrusted IPC sender')
        if (!Object.hasOwn(handlers, method) || !Array.isArray(args))
          throw new Error('Unknown desktop operation')
        return handlers[method](...args)
      })
      window = new BrowserWindow({
        title: 'Pi',
        width: 1160,
        height: 820,
        minWidth: 680,
        minHeight: 500,
        backgroundColor: '#ffffff',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
          preload: join(here, '../preload/index.cjs'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      })
      window.webContents.on('render-process-gone', () => {
        const previous = terminals
        terminals = undefined
        if (!previous) return
        retiringTerminals.add(previous)
        void previous.shutdown().then(() => {
          retiringTerminals.delete(previous)
          if (!confirmedShutdown && !quitting && window && !window.isDestroyed()) terminals = createTerminalService()
        }).catch((error) => {
          // Keep failed cleanup reachable for confirmed quit/retry; do not silently
          // replace the owner of possibly live terminal processes after a crash.
          dialog.showErrorBox(t('Terminal cleanup needs attention'), String(error))
        })
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      )
      if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
      else await window.loadFile(join(here, '../renderer/index.html'))
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault()
          app.quit()
        }
      })
      window.on('closed', () => {
        window = undefined
        app.quit()
      })
    })
    .catch((error) => {
      dialog.showErrorBox(t('Pi Studio could not start'), String(error))
      app.quit()
    })
  app.on('before-quit', (event) => {
    if (quitting || !service) return
    event.preventDefault()
    if (checkingQuit) return
    checkingQuit = true
    void (async () => {
      if (window && !window.isDestroyed()) {
        const choice = await dialog.showMessageBox(window, {
          type: 'warning',
          message: t('Quit Pi Studio?'),
          detail: `${t('All running Pi sessions, terminals and queued messages will be stopped. Terminal entries and output will be discarded; saved Pi history and shell-managed command history are kept. No managed sessions will be left running in the background.')}${documentDirty ? '\n' + t('Unsaved file edits will be discarded.') : ''}`,
          buttons: [t('Cancel'), documentDirty ? t('Discard changes and quit') : t('Stop sessions and quit')],
          defaultId: 0,
          cancelId: 0,
        })
        if (choice.response !== 1) {
          checkingQuit = false
          return
        }
      }
      confirmedShutdown = true
      codexUsage?.stop()
      await Promise.all([service.shutdown(), terminals?.shutdown(), ...[...retiringTerminals].map((previous) => previous.shutdown())])
      retiringTerminals.clear()
      quitting = true
      app.quit()
    })().catch((error) => {
      checkingQuit = false
      confirmedShutdown = false
      dialog.showErrorBox(t('Could not close Pi'), String(error))
    })
  })
  app.on('window-all-closed', () => app.quit())
}
