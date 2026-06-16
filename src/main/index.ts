import { app, clipboard, dialog, ipcMain, Notification, screen, session } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type { AccountInfo, ApiKeyTestResult, FileTranscribeResult, HotkeyResult, Settings, StatePayload } from '@shared/types'
import { DONE_DISPLAY_MS, FREE_LIMIT_SECONDS, OVERLAY_SIZE, POLAR_CHECKOUT_URL, PREVIEW_DELAY_MS, WISPRA_API_BASE } from '@shared/constants'
import { controller } from './state'
import { store } from './store'
import { history } from './history'
import { transcribe, testApiKey } from './transcribe'
import { postProcess, summarizeTexts } from './postprocess'
import { detectTopic } from './topics'
import { injectText, captureTargetContext, undoLastInjection } from './inject'
import { matchVoiceCommand } from './commands'
import { computeStats, formatHistoryAsTxt, formatHistoryAsMd, formatHistoryAsCsv } from './stats'
import { registerHotkey, unregisterAll, isHotkeyRegistered } from './hotkey'
import { createTray, updateTray, updateTrayMenu } from './tray'
import { initUpdater, setAutoUpdate, checkForUpdatesNow, installUpdate } from './updater'
import {
  broadcast,
  createOverlayWindow,
  getOverlayWindow,
  hideOverlay,
  openSettingsWindow,
  showOverlayAt
} from './windows'
import { auth } from './auth'

// macOS: open-url fires when the OS hands us a wispra:// URL (must register before ready)
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (url.startsWith('wispra://')) {
    void auth.handleCallback(url).then((ok) => {
      if (ok) onAuthSuccess()
    })
  }
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    const authUrl = commandLine.find((arg) => arg.startsWith('wispra://'))
    if (authUrl) {
      void auth.handleCallback(authUrl).then((ok) => {
        if (ok) onAuthSuccess()
      })
    } else {
      openSettingsWindow()
    }
  })
  void main()
}

function onAuthSuccess(): void {
  const s = auth.getState()
  if (!s) return
  broadcast(IPC.AUTH_STATE, s)
  // Auto-switch to proxy if the user has no BYOK key configured
  const settings = store.get()
  if (!settings.groqApiKey && !settings.openaiApiKey && settings.provider !== 'local') {
    store.set({ provider: 'proxy' })
    broadcast(IPC.SETTINGS_CHANGED, store.get())
  }
  openSettingsWindow()
  notify('Wispra', `Signed in as ${s.email}`)
}

async function main(): Promise<void> {
  await app.whenReady()

  store.load()
  history.load()
  auth.load()

  // Register wispra:// custom protocol for OAuth callback
  if (!app.isPackaged) {
    app.setAsDefaultProtocolClient('wispra', process.execPath, [app.getAppPath()])
  } else {
    app.setAsDefaultProtocolClient('wispra')
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  wireController()
  wireIpc()

  createTray({
    onToggle: toggleDictation,
    onOpenSettings: openSettingsWindow,
    onSetActiveMode: (id) => {
      store.set({ activeMode: id })
      broadcast(IPC.SETTINGS_CHANGED, store.get())
    }
  })
  const initial = store.get()
  updateTrayMenu(initial.modes, initial.activeMode)
  createOverlayWindow()
  applyHotkeyFromSettings()
  // Some startup apps (IME, system tools) briefly hold hotkeys during login — retry silently after 3s.
  setTimeout(() => { if (!isHotkeyRegistered()) applyHotkeyFromSettings(true) }, 3_000)
  syncLaunchAtLogin(store.get())
  store.onChange(syncLaunchAtLogin)
  store.onChange((s) => updateTrayMenu(s.modes, s.activeMode))
  initUpdater(store.get().autoUpdate)
  store.onChange((s) => setAutoUpdate(s.autoUpdate))

  checkJustUpdated()

  const { groqApiKey, openaiApiKey, provider } = store.get()
  const wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin

  if (!groqApiKey && !openaiApiKey && provider !== 'local') {
    // No API key: always show Settings with welcome message.
    openSettingsWindow()
    notify('Welcome to Wispra', 'Add your free Groq API key in Settings to start dictating.')
  } else if (!wasOpenedAtLogin) {
    // Launched manually (install, double-click, etc.): open Settings so user knows app is running.
    openSettingsWindow()
  }

  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })
  app.on('will-quit', () => unregisterAll())
}

function toggleDictation(): void {
  // Manual toggle (hotkey or overlay click): always cancel any pending continuous restart.
  if (controller.getState() === 'recording') manualStopRequested = true
  controller.toggle(store.get().autoStopMinutes * 60_000)
}

let targetWindow: string | null = null
let targetProcessName: string | null = null
let pendingContinuousRestart = false
let pendingDoneAnimation = false
// Set to true when user manually clicks/hotkeys to stop — prevents continuous-mode restart.
let manualStopRequested = false

function wireController(): void {
  controller.on('state-changed', (payload: StatePayload) => {
    updateTray(payload.state)
    broadcast(IPC.STATE_CHANGED, payload)

    const { soundFeedback } = store.get()

    if (payload.state === 'recording') {
      // Capture the focused window and process name before showing the overlay.
      void captureTargetContext().then((ctx) => {
        targetWindow = ctx?.hwnd ?? null
        targetProcessName = ctx?.processName ?? null
      })
      const { x, y } = screen.getCursorScreenPoint()
      showOverlayAt(x, y)
      if (soundFeedback) broadcast(IPC.PLAY_SOUND, 'start')
    } else if (payload.state === 'idle') {
      if (pendingContinuousRestart) {
        pendingContinuousRestart = false
        // Don't hide overlay — restart recording immediately.
        setTimeout(() => toggleDictation(), 200)
      } else if (pendingDoneAnimation) {
        pendingDoneAnimation = false
        // Keep overlay visible briefly so the done animation plays, then hide.
        setTimeout(hideOverlay, DONE_DISPLAY_MS)
      } else {
        hideOverlay()
      }
    }

    if (payload.state === 'error') {
      if (soundFeedback) broadcast(IPC.PLAY_SOUND, 'error')
      if (payload.message) notify('Wispra', payload.message)
    }
  })
  controller.on('start-recording', () => broadcast(IPC.RECORDING_START))
  controller.on('stop-recording', () => broadcast(IPC.RECORDING_STOP))
}

function wireIpc(): void {
  ipcMain.on(IPC.TOGGLE_DICTATION, () => toggleDictation())
  // Silence auto-stop: does NOT set manualStopRequested so continuous mode can restart.
  ipcMain.on(IPC.SILENCE_STOP, () => controller.toggle(store.get().autoStopMinutes * 60_000))
  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettingsWindow())

  ipcMain.on(IPC.AUDIO_CAPTURED, (_event, audio: ArrayBuffer, durationSeconds: number, mimeType: string) => {
    const {
      provider, groqApiKey, openaiApiKey, language, aiPostProcess,
      modes, activeMode, vocabulary, localBaseUrl, localSttModel, localLlmModel,
      voiceCommandsEnabled, templates, previewBeforePaste, continuousMode,
      contextAwareEnabled, appContextRules
    } = store.get()

    void controller.handleAudio(async () => {
      const mode = modes.find((m) => m.id === activeMode)
      const effectiveLang = mode?.language && mode.language !== 'auto' ? mode.language : language
      const proxyToken = provider === 'proxy' ? await auth.getValidToken() ?? undefined : undefined

      const { text: rawText, detectedLanguage } = await transcribe(
        new Uint8Array(audio), provider, groqApiKey, openaiApiKey,
        effectiveLang, mimeType || 'audio/webm', localBaseUrl, localSttModel,
        durationSeconds, proxyToken
      )
      if (!rawText) throw new Error('No speech detected')
      let text = rawText

      // 1. Template matching — replaces raw transcription with user-defined expansion.
      if (templates.length > 0) {
        const normalized = text.trim().toLowerCase().replace(/[.!?,;:]+$/, '').trim()
        const tpl = templates.find((t) => t.keyword.toLowerCase() === normalized)
        if (tpl) {
          const now = new Date()
          const expansion = tpl.expansion
            .replace(/\[date\]/gi, now.toLocaleDateString())
            .replace(/\[time\]/gi, now.toLocaleTimeString())
          await injectText(expansion, targetWindow)
          history.add(expansion, language === 'auto' ? undefined : language, durationSeconds)
          broadcast(IPC.INJECTION_DONE)
          pendingDoneAnimation = true
          if (continuousMode && !manualStopRequested) pendingContinuousRestart = true
          manualStopRequested = false
          return
        }
      }

      // 2. Voice command matching — intercepts spoken commands before injection.
      const cmd = matchVoiceCommand(text, voiceCommandsEnabled)
      if (cmd) {
        if (cmd.type === 'inject' && cmd.value !== undefined) {
          await injectText(cmd.value, targetWindow)
          broadcast(IPC.INJECTION_DONE)
          pendingDoneAnimation = true
        } else if (cmd.type === 'undo') {
          await undoLastInjection(targetWindow)
        }
        // 'cancel' type: return to idle silently without injecting.
        if (continuousMode && !manualStopRequested && cmd.type !== 'cancel') pendingContinuousRestart = true
        manualStopRequested = false
        return
      }

      // 3. AI cleanup with smart mode routing (language → app → user rules).
      if (aiPostProcess) {
        let effectiveMode = mode
        let appContextHint: string | undefined

        // Layer 1 — Language routing: Vietnamese → Vietnamese mode.
        // Triggers when user pinned 'vi' OR when auto-detect found Vietnamese.
        if (detectedLanguage === 'vi' || language === 'vi') {
          const viMode = modes.find((m) => m.id === 'vietnamese')
          if (viMode) effectiveMode = viMode
        }

        // Layer 2 — App routing: Zalo or email client in focus → matching mode.
        // Always active, overrides language routing.
        const APP_MODE_ROUTES: [string, string][] = [
          ['zalo', 'zalo'],
          ['outlook', 'email'],
          ['thunderbird', 'email'],
        ]
        if (targetProcessName) {
          for (const [appKey, modeId] of APP_MODE_ROUTES) {
            if (targetProcessName.toLowerCase().includes(appKey)) {
              const routedMode = modes.find((m) => m.id === modeId)
              if (routedMode) { effectiveMode = routedMode; break }
            }
          }
        }

        // Layer 3 — User context-aware rules (highest priority).
        if (contextAwareEnabled && targetProcessName) {
          const rule = appContextRules.find((r) =>
            r.appPattern && targetProcessName!.includes(r.appPattern.toLowerCase())
          )
          if (rule) {
            appContextHint = rule.contextHint || undefined
            const ruleMode = modes.find((m) => m.id === rule.modeId)
            if (ruleMode) effectiveMode = ruleMode
          } else {
            // Built-in context hints for remaining apps (no mode switch, just prompt hint).
            const APP_HINTS: [string, string][] = [
              ['slack', 'Instant messaging. Keep it concise. Emoji OK.'],
              ['discord', 'Chat message. Casual tone OK.'],
              ['code', 'Code editor (VS Code). Preserve technical terms, variable names, and code exactly.'],
              ['word', 'Word processor. Use full punctuation and paragraph structure.'],
              ['excel', 'Spreadsheet. Short, data-oriented phrasing.'],
              ['chrome', 'Web browser. General writing context.'],
              ['notepad', 'Plain text editor. No special formatting.'],
            ]
            for (const [key, hint] of APP_HINTS) {
              if (targetProcessName.includes(key)) { appContextHint = hint; break }
            }
          }
        }

        text = await postProcess(
          text, provider, groqApiKey, openaiApiKey,
          effectiveMode, vocabulary, localBaseUrl, localLlmModel, appContextHint,
          proxyToken
        )
      }

      // 4. Preview before paste — show notification then wait.
      if (previewBeforePaste) {
        const preview = text.length > 120 ? text.slice(0, 117) + '…' : text
        broadcast(IPC.PREVIEW_TEXT, preview)
        notify('Wispra — pasting in 3 seconds…', preview)
        await delay(PREVIEW_DELAY_MS)
      }

      // 5. Inject text.
      await injectText(text, targetWindow)
      history.add(text, language === 'auto' ? undefined : language, durationSeconds, detectTopic(text))

      // 6. Post-injection signals.
      broadcast(IPC.INJECTION_DONE)
      pendingDoneAnimation = true
      if (continuousMode && !manualStopRequested) pendingContinuousRestart = true
      manualStopRequested = false
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
    (_event, provider: string, apiKey: string, localBaseUrl?: string): Promise<ApiKeyTestResult> => {
      const p = provider === 'openai' ? 'openai' : provider === 'local' ? 'local' : 'groq'
      return testApiKey(p, apiKey, localBaseUrl)
    }
  )

  ipcMain.handle(IPC.GET_HISTORY, () => history.list())
  ipcMain.handle(IPC.CLEAR_HISTORY, () => {
    history.clear()
    broadcast(IPC.HISTORY_CHANGED, history.list())
  })
  ipcMain.on(IPC.COPY_TEXT, (_event, text: string) => clipboard.writeText(text))

  ipcMain.handle(IPC.CHECK_UPDATE, () => checkForUpdatesNow())
  ipcMain.on(IPC.INSTALL_UPDATE, () => installUpdate())

  ipcMain.handle(IPC.PICK_FILE, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Select audio or video file',
      filters: [
        { name: 'Audio / Video', extensions: ['mp3', 'mp4', 'wav', 'm4a', 'ogg', 'flac', 'webm', 'mov', 'mkv'] }
      ],
      properties: ['openFile']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    IPC.TRANSCRIBE_FILE,
    async (_event, filePath: string, language: string): Promise<FileTranscribeResult> => {
      try {
        const { provider, groqApiKey, openaiApiKey } = store.get()
        const buf = readFileSync(filePath)
        const { text } = await transcribe(new Uint8Array(buf), provider, groqApiKey, openaiApiKey, language, detectMime(filePath))
        if (!text) return { ok: false, error: 'No speech detected in the file.' }
        return { ok: true, text }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Transcription failed.' }
      }
    }
  )

  // Undo last injection
  ipcMain.on(IPC.UNDO_INJECTION, () => {
    void undoLastInjection(targetWindow)
  })

  // Usage statistics
  ipcMain.handle(IPC.GET_STATS, () => computeStats(history.list()))

  // Export history
  ipcMain.handle(IPC.EXPORT_HISTORY, async (_event, format: 'txt' | 'md' | 'csv') => {
    const entries = history.list()
    if (entries.length === 0) return { ok: false, error: 'No history to export.' }

    const ext = format === 'md' ? 'md' : format === 'csv' ? 'csv' : 'txt'
    const result = await dialog.showSaveDialog({
      title: 'Export Dictation History',
      defaultPath: `wispra-history.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, error: 'Cancelled.' }

    try {
      let content: string
      if (format === 'md') content = formatHistoryAsMd(entries)
      else if (format === 'csv') content = formatHistoryAsCsv(entries)
      else content = formatHistoryAsTxt(entries)
      writeFileSync(result.filePath, content, 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Write failed.' }
    }
  })

  ipcMain.handle(IPC.SUMMARIZE_TOPIC, async (_event, texts: string[]) => {
    const { provider, groqApiKey, openaiApiKey, localBaseUrl, localLlmModel } = store.get()
    try {
      const summary = await summarizeTexts(texts, provider, groqApiKey, openaiApiKey, localBaseUrl, localLlmModel)
      return { ok: true, summary }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Summary failed.' }
    }
  })

  history.onChange((entries) => broadcast(IPC.HISTORY_CHANGED, entries))

  // ── Auth ────────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.AUTH_LOGIN, () => {
    auth.openLoginBrowser()
  })

  ipcMain.handle(IPC.AUTH_LOGOUT, () => {
    auth.logout()
    // Reset to BYOK provider (will show onboarding if no key)
    const settings = store.get()
    if (settings.provider === 'proxy') {
      store.set({ provider: 'groq' })
      broadcast(IPC.SETTINGS_CHANGED, store.get())
    }
    broadcast(IPC.AUTH_STATE, null)
  })

  ipcMain.handle(IPC.GET_ACCOUNT_INFO, async (): Promise<AccountInfo | null> => {
    const token = await auth.getValidToken()
    if (!token) return null
    const state = auth.getState()
    if (!state) return null
    try {
      const response = await fetch(`${WISPRA_API_BASE}/api/usage`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) {
        return { email: state.email, plan: 'free', usageSeconds: 0, limitSeconds: FREE_LIMIT_SECONDS, subscribeUrl: POLAR_CHECKOUT_URL }
      }
      const data = (await response.json()) as { plan: string; usageSeconds: number; limitSeconds: number | null; subscribeUrl: string | null }
      return {
        email: state.email,
        avatarUrl: state.avatarUrl,
        plan: data.plan === 'pro' ? 'pro' : 'free',
        usageSeconds: data.usageSeconds ?? 0,
        limitSeconds: data.limitSeconds,
        subscribeUrl: data.subscribeUrl ?? POLAR_CHECKOUT_URL,
      }
    } catch {
      return { email: state.email, avatarUrl: state.avatarUrl, plan: 'free', usageSeconds: 0, limitSeconds: FREE_LIMIT_SECONDS, subscribeUrl: POLAR_CHECKOUT_URL }
    }
  })

  // Overlay drag — move window by delta while keeping it within work area
  ipcMain.on(IPC.MOVE_OVERLAY, (_event, dx: number, dy: number) => {
    const win = getOverlayWindow()
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const { x: ax, y: ay, width, height } = screen.getDisplayNearestPoint({ x, y }).workArea
    const [w, h] = win.getSize()
    const nx = Math.max(ax, Math.min(x + Math.round(dx), ax + width - w))
    const ny = Math.max(ay, Math.min(y + Math.round(dy), ay + height - h))
    win.setPosition(nx, ny)
  })

  // Overlay window size management for preview text
  ipcMain.on(IPC.PREVIEW_TEXT, () => {
    const win = getOverlayWindow()
    if (win && !win.isDestroyed()) {
      win.setSize(OVERLAY_SIZE, 160)
    }
  })
}

function applyHotkeyFromSettings(silent = false): void {
  const { hotkey } = store.get()
  const result = registerHotkey(hotkey, toggleDictation)
  if (!result.ok && !silent) {
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

function detectMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav',
    m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
    webm: 'audio/webm', mov: 'video/quicktime', mkv: 'video/x-matroska'
  }
  return map[ext] ?? 'audio/mpeg'
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
