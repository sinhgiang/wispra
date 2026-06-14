import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'path'
import type { AppState, Mode } from '@shared/types'

let tray: Tray | null = null

let _handlers: {
  onToggle: () => void
  onOpenSettings: () => void
  onSetActiveMode: (id: string) => void
} | null = null

function trayIcon(state: AppState): Electron.NativeImage {
  const name = state === 'recording' ? 'recording' : state === 'processing' ? 'processing' : 'idle'
  const image = nativeImage.createFromPath(
    join(app.getAppPath(), 'resources', `tray-${name}.png`)
  )
  return image.resize({ width: 16, height: 16 })
}

function buildMenu(modes: Mode[], activeMode: string): Electron.Menu {
  if (!_handlers) return Menu.buildFromTemplate([])
  const { onToggle, onOpenSettings, onSetActiveMode } = _handlers

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Start / Stop Dictation', click: onToggle },
    { type: 'separator' }
  ]

  if (modes.length > 0) {
    items.push({
      label: 'Mode',
      submenu: modes.map((m) => ({
        label: m.name,
        type: 'radio' as const,
        checked: m.id === activeMode,
        click: () => onSetActiveMode(m.id)
      }))
    })
    items.push({ type: 'separator' })
  }

  items.push(
    { label: 'Settings…', click: onOpenSettings },
    { type: 'separator' },
    { label: 'Quit Wispra', click: () => app.quit() }
  )

  return Menu.buildFromTemplate(items)
}

export function createTray(handlers: {
  onToggle: () => void
  onOpenSettings: () => void
  onSetActiveMode: (id: string) => void
}): void {
  _handlers = handlers
  tray = new Tray(trayIcon('idle'))
  tray.setToolTip('Wispra — press the hotkey to dictate')
  tray.setContextMenu(buildMenu([], ''))
  tray.on('double-click', handlers.onOpenSettings)
}

export function updateTray(state: AppState): void {
  tray?.setImage(trayIcon(state))
}

export function updateTrayMenu(modes: Mode[], activeMode: string): void {
  if (!tray) return
  tray.setContextMenu(buildMenu(modes, activeMode))
  const active = modes.find((m) => m.id === activeMode)
  tray.setToolTip(active ? `Wispra · ${active.name}` : 'Wispra — press the hotkey to dictate')
}

export function setTrayTooltip(text: string): void {
  tray?.setToolTip(text)
}
