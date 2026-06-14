import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { OVERLAY_SIZE } from '@shared/constants'

let overlayWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

function pageUrl(win: BrowserWindow, page: 'overlay' | 'settings'): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}?page=${page}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { page }
    })
  }
}

export function createOverlayWindow(): BrowserWindow {
  overlayWindow = new BrowserWindow({
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE + 44,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Do NOT auto-show — overlay is shown only when recording starts via showOverlayAt()
  pageUrl(overlayWindow, 'overlay')
  return overlayWindow
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

export function showOverlayAt(x: number, y: number): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const offset = 16
  const winW = OVERLAY_SIZE
  const winH = OVERLAY_SIZE + 44
  const { x: ax, y: ay, width, height } = screen.getDisplayNearestPoint({ x, y }).workArea

  // Try placing bottom-right of cursor; flip to left/up if it would go off-screen.
  let px = x + offset
  let py = y + offset
  if (px + winW > ax + width) px = x - winW - offset
  if (py + winH > ay + height) py = y - winH - offset
  // Final clamp so it never goes outside work area.
  px = Math.max(ax, Math.min(px, ax + width - winW))
  py = Math.max(ay, Math.min(py, ay + height - winH))

  overlayWindow.setPosition(px, py)
  overlayWindow.showInactive()
}

export function hideOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.hide()
}

export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }
  settingsWindow = new BrowserWindow({
    width: 780,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    title: 'Wispra Settings',
    autoHideMenuBar: true,
    show: true,
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  settingsWindow.on('closed', () => { settingsWindow = null })
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  settingsWindow.webContents.once('did-finish-load', () => settingsWindow?.webContents.closeDevTools())
  pageUrl(settingsWindow, 'settings')
  return settingsWindow
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}
