import { app, clipboard, ipcMain, Notification, screen, session } from 'electron'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type { ApiKeyTestResult, HotkeyResult, Settings, StatePayload } from '@shared/types'
import { controller } from './state'
import { store } from './store'
import { history } from './history'
import { transcribe, testApiKey } from './transcribe'
import { injectText, captureTargetWindow } from './inject'
import { registerHotkey, unregisterAll } from './hotkey'
import { createTray, updateTray } from './tray'
import { initUpdater, setAutoUpdate, checkForUpdatesNow, installUpdate } from './updater'
import {
  broadcast,
  createOverlayWindow,
  hideOverlay,
  openSettingsWindow,
  showOverlayAt
} from './windows'

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => openSettingsWindow())
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()

  store.load()
  history.load()

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  wireController()
  wireIpc()

  createTray({
    onToggle: toggleDictation,
    onOpenSettings: openSettingsWindow
  })
  createOverlayWindow()
  applyHotkeyFromSettings()
  syncLaunchAtLogin(store.get())
  store.onChange(syncLaunchAtLogin)
  initUpdater(store.get().autoUpdate)
  store.onChange((s) => setAutoUpdate(s.autoUpdate))

  checkJustUpdated()

  if (!store.get().groqApiKey) {
    openSettingsWindow()
    notify('Welcome to Wispra', 'Add your free Groq API key in Settings to start dictating.')
  }

  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })
  app.on('will-quit', () => unregisterAll())
}

function toggleDictation(): void {
  controller.toggle(store.get().autoStopMinutes * 60_000)
}

let targetWindow: string | null = null

function wireController(): void {
  controller.on('state-changed', (payload: StatePayload) => {
    updateTray(payload.state)
    broadcast(IPC.STATE_CHANGED, payload)

    if (payload.state === 'recording') {
      // Capture the focused window BEFORE showing the overlay, so we know where to paste later.
      void captureTargetWindow().then((hwnd) => { targetWindow = hwnd })
      // Show the status bubble right next to the cursor.
      const { x, y } = screen.getCursorScreenPoint()
      showOverlayAt(x, y)
    } else if (payload.state === 'idle') {
      hideOverlay()
    }
    // Keep showing during 'processing' (spinner) and 'error'.
    // Error auto-returns to idle via state machine, which will hide it.

    if (payload.state === 'error' && payload.message) {
      notify('Wispra', payload.message)
    }
  })
  controller.on('start-recording', () => broadcast(IPC.RECORDING_START))
  controller.on('stop-recording', () => broadcast(IPC.RECORDING_STOP))
}

function wireIpc(): void {
  ipcMain.on(IPC.TOGGLE_DICTATION, () => toggleDictation())
  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettingsWindow())

  ipcMain.on(IPC.AUDIO_CAPTURED, (_event, audio: ArrayBuffer, durationSeconds: number, mimeType: string) => {
    const { provider, groqApiKey, openaiApiKey, language } = store.get()
    void controller.handleAudio(async () => {
      const text = await transcribe(new Uint8Array(audio), provider, groqApiKey, openaiApiKey, language, mimeType || 'audio/webm')
      if (!text) throw new Error('No speech detected')
      await injectText(text, targetWindow)
      history.add(text, language === 'auto' ? undefined : language, durationSeconds)
    })
  })

  ipcMain.on(IPC.RECORDING_FAILED, (_event, message: string) => {
    controller.recordingFailed(message || 'Recording failed')
  })

  ipcMain.handle(IPC.GET_SETTINGS, (): Settings => store.get())
  ipcMain.handle(IPC.SET_SETTINGS, (_event, partial: Partial<Settings>): Settings => {
    const updated = store.set(partial)
    broadcast(IPC.SETTINGS_CHANGED, updated)
    return updated
  })

  ipcMain.handle(IPC.APPLY_HOTKEY, (_event, accelerator: string): HotkeyResult => {
    const result = registerHotkey(accelerator, toggleDictation)
    if (result.ok) {
      store.set({ hotkey: accelerator })
      broadcast(IPC.SETTINGS_CHANGED, store.get())
    } else {
      applyHotkeyFromSettings()
    }
    return result
  })

  ipcMain.handle(
    IPC.TEST_API_KEY,
    (_event, provider: string, apiKey: string): Promise<ApiKeyTestResult> =>
      testApiKey(provider === 'openai' ? 'openai' : 'groq', apiKey)
  )

  ipcMain.handle(IPC.GET_HISTORY, () => history.list())
  ipcMain.handle(IPC.CLEAR_HISTORY, () => {
    history.clear()
    broadcast(IPC.HISTORY_CHANGED, history.list())
  })
  ipcMain.on(IPC.COPY_TEXT, (_event, text: string) => clipboard.writeText(text))

  ipcMain.handle(IPC.CHECK_UPDATE, () => checkForUpdatesNow())
  ipcMain.on(IPC.INSTALL_UPDATE, () => installUpdate())

  history.onChange((entries) => broadcast(IPC.HISTORY_CHANGED, entries))
}

function applyHotkeyFromSettings(): void {
  const { hotkey } = store.get()
  const result = registerHotkey(hotkey, toggleDictation)
  if (!result.ok) {
    notify('Wispra hotkey problem', result.error ?? 'Could not register the hotkey.')
    openSettingsWindow()
  }
}

function syncLaunchAtLogin(settings: Settings): void {
  if (process.platform === 'linux') return
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
}

function checkJustUpdated(): void {
  const flagPath = join(app.getPath('userData'), 'just-updated.json')
  if (!existsSync(flagPath)) return
  try {
    const { version } = JSON.parse(readFileSync(flagPath, 'utf8')) as { version: string }
    unlinkSync(flagPath)
    openSettingsWindow()
    notify(`Wispra updated to v${version}!`, 'Your app is now up to date. Enjoy the new features!')
  } catch {
    try { unlinkSync(flagPath) } catch { /* ignore */ }
  }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show()
  }
}
