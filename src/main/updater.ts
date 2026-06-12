import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import { broadcast } from './windows'
import { IPC } from '@shared/ipc'
import type { UpdateStatus } from '@shared/types'

let autoCheckTimer: ReturnType<typeof setInterval> | null = null
let initialized = false

export function initUpdater(autoUpdate: boolean): void {
  if (!app.isPackaged) return // skip in dev mode

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  if (!initialized) {
    initialized = true

    autoUpdater.on('checking-for-update', () => {
      broadcast(IPC.UPDATE_STATUS, { status: 'checking' } satisfies UpdateStatus)
    })
    autoUpdater.on('update-available', (info) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'available', version: info.version } satisfies UpdateStatus)
    })
    autoUpdater.on('update-not-available', () => {
      broadcast(IPC.UPDATE_STATUS, { status: 'idle' } satisfies UpdateStatus)
    })
    autoUpdater.on('download-progress', (p) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'downloading', percent: Math.round(p.percent) } satisfies UpdateStatus)
    })
    autoUpdater.on('update-downloaded', (info) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'downloaded', version: info.version } satisfies UpdateStatus)
    })
    autoUpdater.on('error', (err) => {
      broadcast(IPC.UPDATE_STATUS, { status: 'error', message: err.message } satisfies UpdateStatus)
    })
  }

  setAutoUpdate(autoUpdate)
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
