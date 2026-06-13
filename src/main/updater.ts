import { autoUpdater } from 'electron-updater'
import { app, dialog, Notification } from 'electron'
import { broadcast } from './windows'
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
      setTrayTooltip('Wispra — checking for updates…')
    })

    autoUpdater.on('update-available', (info) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'available', version: info.version } satisfies UpdateStatus)
      setTrayTooltip('Wispra — press the hotkey to dictate')
      void promptDownload(info.version)
    })

    autoUpdater.on('update-not-available', () => {
      broadcast(IPC.UPDATE_STATUS, { status: 'idle' } satisfies UpdateStatus)
      setTrayTooltip('Wispra — press the hotkey to dictate')
    })

    autoUpdater.on('download-progress', (p) => {
      const percent = Math.round(p.percent)
      broadcast(IPC.UPDATE_STATUS, { status: 'downloading', percent } satisfies UpdateStatus)
      setTrayTooltip(`Wispra — downloading update ${percent}%…`)
    })

    autoUpdater.on('update-downloaded', (info) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'downloaded', version: info.version } satisfies UpdateStatus)
      setTrayTooltip('Wispra — update ready, restart to apply')
      void promptInstall(info.version)
    })

    autoUpdater.on('error', (err) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'error', message: err.message } satisfies UpdateStatus)
      setTrayTooltip('Wispra — press the hotkey to dictate')
    })
  }

  setAutoUpdate(autoUpdate)
}

async function promptDownload(version: string): Promise<void> {
  // Show Windows notification first (always visible)
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'Wispra update available',
      body: `v${version} is ready to download. Open Settings to update.`,
      silent: false
    })
    n.show()
  }

  // Standalone dialog — no parent window, always appears on top
  const { response } = await dialog.showMessageBox({
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

async function promptInstall(version: string): Promise<void> {
  // Windows notification
  if (Notification.isSupported()) {
    const n = new Notification({
      title: '✅ Wispra update ready!',
      body: `v${version} downloaded. Click to restart and apply.`,
      silent: false
    })
    n.on('click', () => autoUpdater.quitAndInstall())
    n.show()
  }

  // Standalone dialog — no parent, always on top
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update ready — Wispra',
    message: `✅ Wispra v${version} downloaded successfully!`,
    detail: 'Restart Wispra now to apply the update. It only takes a few seconds.',
    buttons: ['Restart & Install', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) {
    autoUpdater.quitAndInstall()
  }
}

export function setAutoUpdate(enabled: boolean): void {
  if (!app.isPackaged) return
  if (enabled) {
    if (autoCheckTimer) return
    // First check after 3 seconds
    setTimeout(() => void silentCheck(), 3_000)
    // Then every 4 hours
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
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    broadcast(IPC.UPDATE_STATUS, { status: 'error', message: msg } satisfies UpdateStatus)
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}

async function silentCheck(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // network or config error — silent
  }
}
