import { app, clipboard, desktopCapturer, dialog, ipcMain, Notification, screen, session } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type {
  AccountInfo,
  ApiKeyTestResult,
  ContentPlatform,
  FileTranscribeResult,
  HotkeyResult,
  MeetingAudioSource,
  MeetingContent,
  MeetingContentResult,
  MeetingLanguageConfig,
  MeetingSession,
  MeetingState,
  Settings,
  StatePayload
} from '@shared/types'
import {
  DONE_DISPLAY_MS,
  FREE_LIMIT_SECONDS,
  MEETING_SILENCE_AUTO_STOP_MS,
  OVERLAY_SIZE,
  PREVIEW_DELAY_MS,
  WISPRA_API_BASE
} from '@shared/constants'
import { controller } from './state'
import { meetingController } from './meetingController'
import { meetingSessions } from './meetingSessions'
import { store } from './store'
import { history } from './history'
import { transcribe, testApiKey } from './transcribe'
import { postProcess, summarizeTexts, generateMeetingTitle, generateMeetingContent, translateSegment } from './postprocess'
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
  setMeetingCloseGuard,
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

  // Meeting Mode's "System audio" / "Both" capture modes (recorder.ts) get loopback
  // audio via getDisplayMedia() instead of a real screen-share, so auto-grant it with
  // no interactive "choose what to share" dialog — there's nothing for the user to
  // pick, we always want the whole desktop's audio. `audio: 'loopback'` is WASAPI
  // loopback capture, which is reliable on Windows; the video track it forces along
  // is discarded immediately by recorder.ts (only the audio track is kept).
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        if (sources.length === 0) {
          callback({})
          return
        }
        callback({ video: sources[0], audio: 'loopback' })
      })
      .catch(() => callback({}))
  }, { useSystemPicker: false })

  wireController()
  wireMeetingController()
  wireIpc()

  createTray({
    onToggle: toggleDictation,
    onOpenSettings: openSettingsWindow,
    onSetActiveMode: (id) => {
      store.set({ activeMode: id })
      broadcast(IPC.SETTINGS_CHANGED, store.get())
    },
    onOpenMeeting: () => {
      openSettingsWindow('meeting')
      broadcast(IPC.MEETING_OPEN_TAB)
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
  // Proxy provider is "ready" when the user is already signed in (token persisted from last session)
  const isProxyReady = provider === 'proxy' && auth.isLoggedIn()

  if (!isProxyReady && !groqApiKey && !openaiApiKey && provider !== 'local') {
    // No credentials configured: open Settings and explain what to do.
    openSettingsWindow()
    if (provider === 'proxy') {
      notify('Welcome to Wispra', 'Sign in with Google in Settings to start dictating.')
    } else {
      notify('Welcome to Wispra', 'Add your free Groq API key in Settings to start dictating.')
    }
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

/**
 * Wall-clock time of the most recent real (non-empty) transcribed Meeting Mode
 * segment, or of the recording starting/resuming — reset in wireMeetingController()'s
 * event handlers below. Drives the silence auto-stop safety net; meaningless while
 * not actively recording.
 */
let lastMeetingSpeechAt = 0

function wireMeetingController(): void {
  meetingController.on('state-changed', (state: MeetingState) => {
    broadcast(IPC.MEETING_STATE_CHANGED, state)
  })
  meetingController.on('start-capture', () => {
    lastMeetingSpeechAt = Date.now()
    broadcast(IPC.MEETING_CAPTURE_START)
  })
  meetingController.on('pause-capture', () => broadcast(IPC.MEETING_CAPTURE_PAUSE))
  meetingController.on('resume-capture', () => {
    // Don't count time spent paused against the silence budget.
    lastMeetingSpeechAt = Date.now()
    broadcast(IPC.MEETING_CAPTURE_RESUME)
  })
  meetingController.on('stop-capture', () => broadcast(IPC.MEETING_CAPTURE_STOP))

  meetingSessions.onSegment((segment, sessionId) => {
    lastMeetingSpeechAt = Date.now()
    broadcast(IPC.MEETING_SEGMENT_READY, segment, sessionId)
  })
  meetingSessions.onMeta((session) => {
    broadcast(IPC.MEETING_SESSION_UPDATED, session)
  })

  // Meeting Mode's mic capture lives in the Settings window's renderer, so closing that
  // window would otherwise silently kill an in-progress recording with no save/warning.
  setMeetingCloseGuard({
    activeWarning: () => {
      const state = meetingController.getState()
      if (state !== 'recording' && state !== 'paused') return null
      return 'Closing this window will stop the recording. The transcript captured so far will be saved.'
    },
    forceStop: () => {
      meetingController.stop()
      stopMeetingSession()
    }
  })

  // Silence auto-stop safety net: a recording left running (or set to Mic-only while
  // only background/computer audio plays) with no real transcribed speech at all for
  // MEETING_SILENCE_AUTO_STOP_MS stops itself exactly like a manual Stop. Checked on a
  // low-frequency timer for the app's lifetime rather than a per-session timeout, so
  // pause/resume/discard never need to manage it explicitly — it simply no-ops whenever
  // the state isn't 'recording'.
  setInterval(() => {
    if (meetingController.getState() !== 'recording') return
    if (Date.now() - lastMeetingSpeechAt < MEETING_SILENCE_AUTO_STOP_MS) return
    broadcast(IPC.MEETING_AUTO_STOPPED)
    meetingController.stop()
    stopMeetingSession()
  }, 15_000)
}

/**
 * Stops the active meeting session and, if it captured any speech, kicks off
 * AI title/summary generation in the background (meetingSessions.stop() has
 * already flipped it to 'summarizing'). Shared by all three places a meeting
 * can end (manual Stop, mic failure, window-close guard) so they behave
 * identically instead of duplicating this chain three times.
 */
function stopMeetingSession(): void {
  void meetingSessions.stop().then((session) => {
    if (session) void finalizeMeetingSession(session)
  })
}

/**
 * Cancels the active meeting session outright — the "Discard" button's
 * handler. Unlike stopMeetingSession(), never finalizes or kicks off AI
 * title/summary generation: the session's JSON file (written incrementally
 * as it recorded) is deleted immediately via meetingSessions.discard().
 */
function discardMeetingSession(): void {
  meetingSessions.discard()
}

/**
 * Asks the LLM for a short topic title + summary for the given session's
 * current transcript and, on success, applies it via finishSummary — shared by
 * finalizeMeetingSession (automatic, right after Stop) and
 * regenerateSessionSummary (the Summary tab's manual "Try again"). Returns
 * true on success, false on any failure (offline, no key/token, bad response,
 * truncated/unparseable JSON) so callers can tell "never generated" apart from
 * "tried and failed". Must never throw.
 */
async function requestMeetingSummary(session: MeetingSession): Promise<boolean> {
  try {
    const { provider, groqApiKey, openaiApiKey, localBaseUrl, localLlmModel } = store.get()
    const proxyToken = provider === 'proxy' ? (await auth.getValidToken()) ?? undefined : undefined
    const transcript = session.segments.map((s) => s.text).join(' ')
    const result = await generateMeetingTitle(
      transcript, provider, groqApiKey, openaiApiKey, localBaseUrl, localLlmModel, proxyToken,
      session.languageConfig?.summary
    )
    if (!result) return false
    meetingSessions.finishSummary(session.id, { title: result.title, summary: result.summary })
    return true
  } catch (err) {
    console.error('[meeting] title generation failed:', err)
    return false
  }
}

/**
 * Reads the full transcript of a just-stopped session and asks the LLM for a
 * short topic title + summary, then applies it. Always resolves the session
 * out of 'summarizing' — on any failure finishSummary() is called with an
 * empty patch, which just falls back to the existing default date/time title.
 * Must never throw and never leave a session stuck in 'summarizing'.
 */
async function finalizeMeetingSession(session: MeetingSession): Promise<void> {
  if (session.status !== 'summarizing') return
  const ok = await requestMeetingSummary(session)
  if (!ok) meetingSessions.finishSummary(session.id, {})
}

/**
 * Manual retry, triggered by the "Try again" button on a stopped session's
 * Summary tab when the automatic post-Stop generation above failed (e.g. the
 * session was very long and the model's response got cut off before finishing
 * the JSON — see the max_tokens comment in generateMeetingTitle). Unlike
 * finalizeMeetingSession this never touches session.status (already
 * 'stopped') or any existing segments/content — a pure additive title/summary
 * update on success, a no-op on failure. Returns false if the session no
 * longer exists.
 */
async function regenerateSessionSummary(id: string): Promise<boolean> {
  const session = meetingSessions.get(id)
  if (!session) return false
  return requestMeetingSummary(session)
}

/**
 * On-demand generation of one platform's ready-to-post content, triggered
 * when the renderer first opens that platform's tab for a stopped session.
 * Mirrors finalizeMeetingSession's provider/key resolution. Returns null on
 * any failure (offline, no key/token, bad response) so the renderer can show
 * a "couldn't generate, try again" state — never throws.
 */
async function generateSessionContent(
  id: string,
  platform: ContentPlatform
): Promise<MeetingContentResult | null> {
  const session = meetingSessions.get(id)
  if (!session) return null
  const transcript = session.segments.map((s) => s.text).join(' ')
  try {
    const { provider, groqApiKey, openaiApiKey, localBaseUrl, localLlmModel } = store.get()
    const proxyToken = provider === 'proxy' ? (await auth.getValidToken()) ?? undefined : undefined
    const result = await generateMeetingContent(
      platform, transcript, provider, groqApiKey, openaiApiKey, localBaseUrl, localLlmModel, proxyToken,
      session.languageConfig?.[platform]
    )
    if (!result) return null

    let patch: Partial<MeetingContent>
    if (result.platform === 'website') {
      patch = { website: { title: result.title, metaDescription: result.metaDescription, body: result.body } }
    } else if (result.platform === 'facebook') patch = { facebook: result.posts }
    else if (result.platform === 'instagram') patch = { instagram: result.posts }
    else if (result.platform === 'linkedin') patch = { linkedin: result.posts }
    else patch = { twitter: result.posts }

    meetingSessions.setContent(id, patch)
    return result
  } catch (err) {
    console.error('[meeting] content generation failed:', err)
    return null
  }
}

function wireIpc(): void {
  ipcMain.on(IPC.TOGGLE_DICTATION, () => toggleDictation())
  // Silence auto-stop: does NOT set manualStopRequested so continuous mode can restart.
  ipcMain.on(IPC.SILENCE_STOP, () => controller.toggle(store.get().autoStopMinutes * 60_000))
  ipcMain.on(IPC.OPEN_SETTINGS, () => openSettingsWindow())

  // --- meeting mode (step 3: real transcription per chunk, pause/resume, persistence) ---
  ipcMain.on(
    IPC.MEETING_START,
    (_event, languageConfig: MeetingLanguageConfig, audioSource: MeetingAudioSource) => {
      meetingSessions.start(audioSource ?? 'mic', languageConfig)
      meetingController.start()
    }
  )
  ipcMain.on(IPC.MEETING_PAUSE, () => meetingController.pause())
  ipcMain.on(IPC.MEETING_RESUME, () => meetingController.resume())
  ipcMain.on(IPC.MEETING_STOP, () => {
    meetingController.stop()
    stopMeetingSession()
  })
  ipcMain.on(IPC.MEETING_DISCARD, () => {
    meetingController.stop()
    discardMeetingSession()
  })
  ipcMain.on(IPC.MEETING_CAPTURE_FAILED, (_event, message: string) => {
    meetingController.captureFailed(message)
    stopMeetingSession()
  })
  ipcMain.handle(IPC.MEETING_GET_STATE, (): MeetingState => meetingController.getState())
  ipcMain.handle(IPC.MEETING_GET_SESSIONS, () => meetingSessions.list())
  ipcMain.handle(IPC.MEETING_GET_SESSION, (_event, id: string) => meetingSessions.get(id))
  ipcMain.handle(IPC.MEETING_DELETE_SESSION, (_event, id: string) => meetingSessions.delete(id))
  ipcMain.handle(IPC.MEETING_RENAME_SESSION, (_event, id: string, title: string) => {
    const trimmed = title.trim().slice(0, 200)
    if (trimmed) meetingSessions.rename(id, trimmed)
  })
  ipcMain.handle(IPC.MEETING_GENERATE_CONTENT, (_event, id: string, platform: ContentPlatform) =>
    generateSessionContent(id, platform)
  )
  ipcMain.handle(IPC.MEETING_GENERATE_SUMMARY, (_event, id: string) => regenerateSessionSummary(id))
  ipcMain.on(
    IPC.MEETING_CHUNK_CAPTURED,
    (
      _event,
      audio: ArrayBuffer,
      meta: { startMs: number; endMs: number; startedAt: string; mimeType: string }
    ) => {
      const { provider, groqApiKey, openaiApiKey, localBaseUrl, localSttModel, localLlmModel, vocabulary } = store.get()
      // The session's own language choices (set on the Start-recording screen), NOT the
      // global Dictate language — Meeting Mode is often used in a different language than
      // the hotkey/overlay flow, and forcing the wrong one here made Whisper mistranscribe
      // (or drift into translating) chunks recorded in another language entirely.
      const sessionLangConfig = meetingSessions.getCurrent()?.languageConfig
      const inputLanguage = sessionLangConfig?.input ?? 'auto'
      const transcriptLanguage = sessionLangConfig?.transcript ?? 'auto'
      const bytes = new Uint8Array(audio)
      const durationSeconds = Math.max(0, Math.round((meta.endMs - meta.startMs) / 1000))
      meetingSessions.enqueueChunk(meta, async () => {
        const proxyToken = provider === 'proxy' ? (await auth.getValidToken()) ?? undefined : undefined
        const { text, detectedLanguage } = await transcribe(
          bytes, provider, groqApiKey, openaiApiKey, inputLanguage,
          meta.mimeType || 'audio/webm', localBaseUrl, localSttModel,
          durationSeconds, proxyToken, vocabulary
        )
        if (!text) return null
        // Transcript language ("auto" = same as spoken) is independent of the target
        // languages for Summary/Website/etc — translate the plain transcription itself
        // only when the user explicitly picked a transcript language that actually
        // differs from what was spoken. Skips a redundant same-language "translation"
        // call (e.g. spoken Vietnamese + transcript set to Vietnamese) that wastes a
        // request and adds a chance for the LLM to mangle/refuse an already-fine chunk
        // for no benefit — checked against both the explicit input-language setting and
        // Whisper's own per-chunk detection, so it's skipped correctly whether "Spoken"
        // was set explicitly or left on "auto".
        if (
          transcriptLanguage === 'auto' ||
          transcriptLanguage === inputLanguage ||
          transcriptLanguage === detectedLanguage
        ) {
          return text
        }
        return translateSegment(
          text, transcriptLanguage, provider, groqApiKey, openaiApiKey,
          localBaseUrl, localLlmModel, proxyToken
        )
      })
    }
  )

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
        durationSeconds, proxyToken, vocabulary
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
    // Without this, toggling "Launch at login" only takes effect the next time the
    // app happens to start on its own (syncLaunchAtLogin at startup, below) — so a
    // user who checks the box and doesn't manually relaunch right after ends up with
    // the setting saved but never actually registered with the OS.
    if (partial.launchAtLogin !== undefined) syncLaunchAtLogin(updated)
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

  ipcMain.handle(IPC.GET_APP_VERSION, () => app.getVersion())
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
        const { provider, groqApiKey, openaiApiKey, vocabulary } = store.get()
        const buf = readFileSync(filePath)
        const { text } = await transcribe(
          new Uint8Array(buf), provider, groqApiKey, openaiApiKey, language, detectMime(filePath),
          undefined, undefined, undefined, undefined, vocabulary
        )
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
        return { email: state.email, avatarUrl: state.avatarUrl, plan: 'free', usageSeconds: 0, limitSeconds: FREE_LIMIT_SECONDS, subscribeUrl: null }
      }
      const data = (await response.json()) as { plan: string; usageSeconds: number; limitSeconds: number | null; subscribeUrl: string | null }
      return {
        email: state.email,
        avatarUrl: state.avatarUrl,
        plan: data.plan === 'pro' ? 'pro' : 'free',
        usageSeconds: data.usageSeconds ?? 0,
        limitSeconds: data.limitSeconds,
        subscribeUrl: data.subscribeUrl ?? null,
      }
    } catch {
      return { email: state.email, avatarUrl: state.avatarUrl, plan: 'free', usageSeconds: 0, limitSeconds: FREE_LIMIT_SECONDS, subscribeUrl: null }
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
