import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AccountInfo,
  ApiKeyTestResult,
  ContentPlatform,
  FileTranscribeResult,
  HotkeyResult,
  MeetingAudioSource,
  MeetingContentResult,
  MeetingLanguageConfig,
  MeetingSegment,
  MeetingSession,
  MeetingSessionSummary,
  MeetingState,
  Settings,
  StatePayload,
  TranscriptEntry,
  UpdateStatus,
  UsageStats
} from '@shared/types'

/** The only API surface renderers can touch. */
const api = {
  // --- dictation / overlay ---
  toggleDictation: (): void => ipcRenderer.send(IPC.TOGGLE_DICTATION),
  openSettings: (): void => ipcRenderer.send(IPC.OPEN_SETTINGS),
  sendAudio: (audio: ArrayBuffer, durationSeconds: number, mimeType: string): void =>
    ipcRenderer.send(IPC.AUDIO_CAPTURED, audio, durationSeconds, mimeType),
  recordingFailed: (message: string): void => ipcRenderer.send(IPC.RECORDING_FAILED, message),
  onStateChanged: (cb: (payload: StatePayload) => void): void => {
    ipcRenderer.on(IPC.STATE_CHANGED, (_e, payload: StatePayload) => cb(payload))
  },
  onRecordingStart: (cb: () => void): void => {
    ipcRenderer.on(IPC.RECORDING_START, () => cb())
  },
  onRecordingStop: (cb: () => void): void => {
    ipcRenderer.on(IPC.RECORDING_STOP, () => cb())
  },

  // --- settings ---
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (partial: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.SET_SETTINGS, partial),
  applyHotkey: (accelerator: string): Promise<HotkeyResult> =>
    ipcRenderer.invoke(IPC.APPLY_HOTKEY, accelerator),
  testApiKey: (provider: string, apiKey: string, localBaseUrl?: string): Promise<ApiKeyTestResult> =>
    ipcRenderer.invoke(IPC.TEST_API_KEY, provider, apiKey, localBaseUrl),
  onSettingsChanged: (cb: (settings: Settings) => void): void => {
    ipcRenderer.on(IPC.SETTINGS_CHANGED, (_e, settings: Settings) => cb(settings))
  },

  // --- history ---
  getHistory: (): Promise<TranscriptEntry[]> => ipcRenderer.invoke(IPC.GET_HISTORY),
  clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC.CLEAR_HISTORY),
  onHistoryChanged: (cb: (entries: TranscriptEntry[]) => void): void => {
    ipcRenderer.on(IPC.HISTORY_CHANGED, (_e, entries: TranscriptEntry[]) => cb(entries))
  },
  copyText: (text: string): void => ipcRenderer.send(IPC.COPY_TEXT, text),

  // --- updates ---
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.GET_APP_VERSION),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC.CHECK_UPDATE),
  installUpdate: (): void => ipcRenderer.send(IPC.INSTALL_UPDATE),
  onUpdateStatus: (cb: (status: UpdateStatus) => void): void => {
    ipcRenderer.on(IPC.UPDATE_STATUS, (_e, status: UpdateStatus) => cb(status))
  },

  // --- file transcription ---
  pickFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.PICK_FILE),
  transcribeFile: (filePath: string, language: string): Promise<FileTranscribeResult> =>
    ipcRenderer.invoke(IPC.TRANSCRIBE_FILE, filePath, language),

  // --- silence auto-stop (does NOT cancel continuous mode loop) ---
  silenceStop: (): void => ipcRenderer.send(IPC.SILENCE_STOP),

  // --- overlay drag ---
  moveOverlay: (dx: number, dy: number): void => ipcRenderer.send(IPC.MOVE_OVERLAY, dx, dy),

  // --- sound feedback ---
  onPlaySound: (cb: (type: 'start' | 'error') => void): void => {
    ipcRenderer.on(IPC.PLAY_SOUND, (_e, type: 'start' | 'error') => cb(type))
  },

  // --- post-injection feedback ---
  onInjectionDone: (cb: () => void): void => {
    ipcRenderer.on(IPC.INJECTION_DONE, () => cb())
  },
  onPreviewText: (cb: (text: string) => void): void => {
    ipcRenderer.on(IPC.PREVIEW_TEXT, (_e, text: string) => cb(text))
  },

  // --- undo ---
  undoInjection: (): void => ipcRenderer.send(IPC.UNDO_INJECTION),

  // --- cloud auth ---
  loginWithGoogle: (): Promise<void> => ipcRenderer.invoke(IPC.AUTH_LOGIN),
  logout: (): Promise<void> => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  getAccountInfo: (): Promise<AccountInfo | null> => ipcRenderer.invoke(IPC.GET_ACCOUNT_INFO),
  onAuthStateChanged: (cb: (state: { email: string } | null) => void): void => {
    ipcRenderer.on(IPC.AUTH_STATE, (_e, state: { email: string } | null) => cb(state))
  },

  // --- statistics & export ---
  getStats: (): Promise<UsageStats> => ipcRenderer.invoke(IPC.GET_STATS),
  exportHistory: (format: 'txt' | 'md' | 'csv'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.EXPORT_HISTORY, format),
  summarizeTopic: (texts: string[]): Promise<{ ok: boolean; summary?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.SUMMARIZE_TOPIC, texts),

  // --- meeting mode ---
  meetingStart: (languageConfig: MeetingLanguageConfig, audioSource: MeetingAudioSource): void =>
    ipcRenderer.send(IPC.MEETING_START, languageConfig, audioSource),
  meetingPause: (): void => ipcRenderer.send(IPC.MEETING_PAUSE),
  meetingResume: (): void => ipcRenderer.send(IPC.MEETING_RESUME),
  meetingStop: (): void => ipcRenderer.send(IPC.MEETING_STOP),
  // Cancels the current session without saving it — see meetingSessions.discard().
  meetingDiscard: (): void => ipcRenderer.send(IPC.MEETING_DISCARD),
  meetingCaptureFailed: (message: string): void => ipcRenderer.send(IPC.MEETING_CAPTURE_FAILED, message),
  meetingChunkCaptured: (
    audio: ArrayBuffer,
    meta: { startMs: number; endMs: number; startedAt: string; mimeType: string }
  ): void => ipcRenderer.send(IPC.MEETING_CHUNK_CAPTURED, audio, meta),
  getMeetingState: (): Promise<MeetingState> => ipcRenderer.invoke(IPC.MEETING_GET_STATE),
  getMeetingSessions: (): Promise<MeetingSessionSummary[]> => ipcRenderer.invoke(IPC.MEETING_GET_SESSIONS),
  getMeetingSession: (id: string): Promise<MeetingSession | null> =>
    ipcRenderer.invoke(IPC.MEETING_GET_SESSION, id),
  deleteMeetingSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.MEETING_DELETE_SESSION, id),
  renameMeetingSession: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MEETING_RENAME_SESSION, id, title),
  // On-demand: generates (or returns the already-cached) ready-to-post content
  // for one platform. Resolves null if generation failed (offline, bad key, etc).
  generateMeetingContent: (id: string, platform: ContentPlatform): Promise<MeetingContentResult | null> =>
    ipcRenderer.invoke(IPC.MEETING_GENERATE_CONTENT, id, platform),
  // On-demand retry for a stopped session whose title/summary generation failed —
  // resolves true on success, false on failure. On success the actual title/summary
  // update arrives separately via onMeetingSessionUpdated.
  generateMeetingSummary: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.MEETING_GENERATE_SUMMARY, id),
  onMeetingStateChanged: (cb: (state: MeetingState) => void): void => {
    ipcRenderer.on(IPC.MEETING_STATE_CHANGED, (_e, state: MeetingState) => cb(state))
  },
  onMeetingCaptureStart: (cb: () => void): void => {
    ipcRenderer.on(IPC.MEETING_CAPTURE_START, () => cb())
  },
  onMeetingCapturePause: (cb: () => void): void => {
    ipcRenderer.on(IPC.MEETING_CAPTURE_PAUSE, () => cb())
  },
  onMeetingCaptureResume: (cb: () => void): void => {
    ipcRenderer.on(IPC.MEETING_CAPTURE_RESUME, () => cb())
  },
  onMeetingCaptureStop: (cb: () => void): void => {
    ipcRenderer.on(IPC.MEETING_CAPTURE_STOP, () => cb())
  },
  // Arrives right before onMeetingCaptureStop when the silence safety net (not the
  // user) ended the recording — lets the renderer explain why it stopped.
  onMeetingAutoStopped: (cb: () => void): void => {
    ipcRenderer.on(IPC.MEETING_AUTO_STOPPED, () => cb())
  },
  onMeetingSegmentReady: (cb: (segment: MeetingSegment, sessionId: string) => void): void => {
    ipcRenderer.on(IPC.MEETING_SEGMENT_READY, (_e, segment: MeetingSegment, sessionId: string) =>
      cb(segment, sessionId)
    )
  },
  // main -> settings renderer: a session's title/summary/status changed (e.g. the
  // AI-generated title finished after Stop)
  onMeetingSessionUpdated: (cb: (session: MeetingSession) => void): void => {
    ipcRenderer.on(IPC.MEETING_SESSION_UPDATED, (_e, session: MeetingSession) => cb(session))
  },
  // main -> settings renderer: tray (or another entry point) asked to switch to the Meeting tab
  onOpenMeetingTab: (cb: () => void): void => {
    ipcRenderer.on(IPC.MEETING_OPEN_TAB, () => cb())
  }
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)
