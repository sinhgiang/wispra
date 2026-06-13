import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'path'
import type { AppState } from '@shared/types'

let tray: Tray | null = null

function trayIcon(state: AppState): Electron.NativeImage {
  const name = state === 'recording' ? 'recording' : state === 'processing' ? 'processing' : 'idle'
  const image = nativeImage.createFromPath(
    join(app.getAppPath(), 'resources', `tray-${name}.png`)
  )
  return image.resize({ width: 16, height: 16 })
}

export function createTray(handlers: {
  onToggle: () => void
  onOpenSettings: () => void
}): void {
  tray = new Tray(trayIcon('idle'))
  tray.setToolTip('Wispra — press the hotkey to dictate')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Start / Stop Dictation', click: handlers.onToggle },
      { type: 'separator' },
      { label: 'Settings…', click: handlers.onOpenSettings },
      { type: 'separator' },
      { label: 'Quit Wispra', click: () => app.quit() }
    ])
  )
  tray.on('double-click', handlers.onOpenSettings)
}

export function updateTray(state: AppState): void {
  tray?.setImage(trayIcon(state))
}

export function setTrayTooltip(text: string): void {
  tray?.setToolTip(text)
}
