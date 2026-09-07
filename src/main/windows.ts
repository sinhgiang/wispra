import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { OVERLAY_SIZE } from '@shared/constants'

let overlayWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

interface MeetingCloseGuard {
  /** Returns a detail message if a meeting is currently recording/paused, else null (nothing to guard). */
  activeWarning: () => string | null
  /** Called once the user confirms closing anyway — should stop and finalize the meeting. */
  forceStop: () => void
}
let meetingCloseGuard: MeetingCloseGuard | null = null

/**
 * Registers the predicate/action the Settings window's close handler uses to
 * avoid silently killing an in-progress meeting recording (it lives in the
 * renderer process, so closing the window would otherwise just end it with no
 * warning). Kept as an injected interface rather than importing
 * meetingController directly, so this window-management module doesn't take
 * on a business-logic dependency — index.ts wires the real implementation.
 */
export function setMeetingCloseGuard(guard: MeetingCloseGuard): void {
  meetingCloseGuard = guard
}

function pageUrl(win: BrowserWindow, page: 'overlay' | 'settings', extraQuery?: Record<string, string>): void {
  const query: Record<string, string> = { page, ...extraQuery }
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}?${new URLSearchParams(query).toString()}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
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
  // Track destruction so showOverlayAt() can recreate when needed.
  overlayWindow.on('closed', () => { overlayWindow = null })
  // If the renderer process crashes (GPU error, memory pressure after long use),
  // the window object survives but the content disappears. Destroy and let
  // showOverlayAt() recreate it on the next recording.
  overlayWindow.webContents.on('render-process-gone', () => {
    overlayWindow?.destroy()
    overlayWindow = null
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Re-apply alwaysOnTop each time the overlay is shown — Windows can strip it
  // when a full-screen app launches or focus moves across monitors.
  overlayWindow.on('show', () => {
    overlayWindow?.setAlwaysOnTop(true, 'screen-saver')
  })
  // Do NOT auto-show — overlay is shown only when recording starts via showOverlayAt()
  pageUrl(overlayWindow, 'overlay')
  return overlayWindow
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

export function showOverlayAt(x: number, y: number): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    // Overlay window was destroyed (renderer crash, GPU error, etc.) — recreate it.
    const win = createOverlayWindow()
    win.once('ready-to-show', () => showOverlayAt(x, y))
    return
  }
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

/**
 * Opens (or focuses) the single Settings window. `initialTab` only affects a freshly
 * created window (passed through as a `?tab=` query param the renderer reads on
 * mount); if the window is already open, the caller is responsible for switching
 * tabs via IPC (see IPC.MEETING_OPEN_TAB) since the renderer is already mounted.
 */
export function openSettingsWindow(initialTab?: string): BrowserWindow {
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
      nodeIntegration: false,
      // Meeting Mode lives in this window as a tab and can record for hours while
      // the user works elsewhere, so it's routinely minimized/occluded/unfocused.
      // Without this, Chromium throttles timers/rAF in the background and the
      // meeting recorder's chunk-cut timing drifts or stalls.
      backgroundThrottling: false
    }
  })
  settingsWindow.on('closed', () => { settingsWindow = null })

  // Electron shows no context menu by default. Wire a minimal one so users can
  // right-click to copy selected text anywhere (e.g. a Meeting transcript) or
  // cut/copy/paste/select-all in editable fields (e.g. the meeting title rename input).
  settingsWindow.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText) {
      items.push({ label: 'Copy', role: 'copy' })
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup()
  })

  // Guard against silently losing an in-progress meeting recording: it runs
  // entirely in this window's renderer, so a plain close would kill it with
  // no save and no warning.
  let forceClosing = false
  settingsWindow.on('close', (event) => {
    if (forceClosing) return
    const detail = meetingCloseGuard?.activeWarning()
    if (!detail) return
    event.preventDefault()
    const win = settingsWindow
    if (!win) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Stop and close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'A meeting recording is in progress',
      detail
    })
    if (choice === 0) {
      forceClosing = true
      meetingCloseGuard?.forceStop()
      win.close()
    }
  })

  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  settingsWindow.webContents.once('did-finish-load', () => settingsWindow?.webContents.closeDevTools())
  pageUrl(settingsWindow, 'settings', initialTab ? { tab: initialTab } : undefined)
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
