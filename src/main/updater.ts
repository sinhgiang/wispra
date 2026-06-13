import { autoUpdater } from 'electron-updater'
import { app, dialog, Notification } from 'electron'
import { broadcast, openSettingsWindow } from './windows'
import { setTrayTooltip } from './tray'
import { IPC } from '@shared/ipc'
import type { UpdateStatus } from '@shared/types'

let autoCheckTimer: ReturnType<typeof setInterval> | null = null
let initialized = false

export function initUpdater(autoUpdate: boolean): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  if (!initialized) {
    initialized = true

    autoUpdater.on('checking-for-update', () => {
      broadcast(IPC.UPDATE_STATUS, { status: 'checking' } satisfies UpdateStatus)
    })

    autoUpdater.on('update-available', (info) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'available', version: info.version } satisfies UpdateStatus)
      void promptDownload(info.version)
    })

    autoUpdater.on('update-not-available', () => {
      broadcast(IPC.UPDATE_STATUS, { status: 'idle' } satisfies UpdateStatus)
    })

    autoUpdater.on('download-progress', (p) => {
      const percent = Math.round(p.percent)
      broadcast(IPC.UPDATE_STATUS, { status: 'downloading', percent } satisfies UpdateStatus)
      setTrayTooltip(`Wispra — downloading update ${percent}%…`)
    })

    autoUpdater.on('update-downloaded', (info) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'downloaded', version: info.version } satisfies UpdateStatus)
      setTrayTooltip('Wispra — press the hotkey to dictate')
      notifyAndPromptInstall(info.version)
    })

    autoUpdater.on('error', (err) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'error', message: err.message } satisfies UpdateStatus)
      setTrayTooltip('Wispra — press the hotkey to dictate')
    })
  }

  setAutoUpdate(autoUpdate)
}

async function promptDownload(version: string): Promise<void> {
  const win = openSettingsWindow()
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update available — Wispra',
    message: `Wispra v${version} is available`,
    detail: 'A new version has been released. Download it now? It runs in the background.',
    buttons: ['Download now', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) {
    void autoUpdater.downloadUpdate()
  }
}

function notifyAndPromptInstall(version: string): void {
  // Windows notification — visible even if Settings is closed
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'Wispra update ready!',
      body: `v${version} has downloaded. Click to restart and apply.`,
      silent: false
    })
    n.on('click', () => autoUpdater.quitAndInstall())
    n.show()
  }

  // Also show dialog — open Settings first so it appears on top
  const win = openSettingsWindow()
  void dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update ready — Wispra',
    message: `✅ Wispra v${version} downloaded successfully!`,
    detail: 'Restart Wispra now to apply the update. It only takes a few seconds.',
    buttons: ['Restart & Install', 'Later'],
    defaultId: 0,
    cancelId: 1
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall()
  })
}

export function setAutoUpdate(enabled: boolean): void {
  if (!app.isPackaged) return
  if (enabled) {
    if (autoCheckTimer) return
    setTimeout(() => void silentCheck(), 8_000)
    autoCheckTimer = setInterval(() => void silentCheck(), 4 * 60 * 60 * 1000)
  } else {
    if (autoCheckTimer) { clearInterval(autoCheckTimer); autoCheckTimer = null }
  }
}

export async function checkForUpdatesNow(): Promise<void> {
  if (!app.isPackaged) {
    broadcast(IPC.UPDATE_STATUS, { status: 'error', message: 'Auto-update is only available in the installed app.' } satisfies UpdateStatus)
    return
  }
  await autoUpdater.checkForUpdates()
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}

async function silentCheck(): Promise<void> {
  try { await autoUpdater.checkForUpdates() } catch { /* network or config error */ }
}
