import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AccountInfo,
  ApiKeyTestResult,
  ContentPlatform,
  EvalReport,
  FileTranscribeResult,
  FixHistoryResult,
  HotkeyResult,
  LexiconEntry,
  MeetingAudioSource,
  MeetingChatMessage,
  MeetingContentResult,
  MeetingLanguageConfig,
  MeetingSegment,
  MeetingSession,
  MeetingSessionSummary,
  MeetingSpace,
  MeetingState,
  Settings,
  StatePayload,
  StyleProfile,
  Suggestion,
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
  /** Returns an unsubscribe function; callers that live as long as the window can ignore it. */
  onHistoryChanged: (cb: (entries: TranscriptEntry[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, entries: TranscriptEntry[]): void => cb(entries)
    ipcRenderer.on(IPC.HISTORY_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.HISTORY_CHANGED, listener)
    }
  },
  copyText: (text: string): void => ipcRenderer.send(IPC.COPY_TEXT, text),
  fixHistoryEntry: (id: string, text: string): Promise<FixHistoryResult> =>
    ipcRenderer.invoke(IPC.HISTORY_FIX, id, text),

  // --- personal lexicon (Learned tab) ---
  getLexicon: (): Promise<LexiconEntry[]> => ipcRenderer.invoke(IPC.LEXICON_GET),
  addLexiconEntry: (term: string, heardAs: string[]): Promise<boolean> =>
    ipcRenderer.invoke(IPC.LEXICON_ADD, term, heardAs),
  updateLexiconEntry: (
    id: string,
    patch: Partial<Pick<LexiconEntry, 'enabled' | 'pinned' | 'heardAs'>>
  ): Promise<boolean> => ipcRenderer.invoke(IPC.LEXICON_UPDATE, id, patch),
  deleteLexiconEntry: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.LEXICON_DELETE, id),
  resetLexicon: (): Promise<void> => ipcRenderer.invoke(IPC.LEXICON_RESET),
  /** Returns an unsubscribe function, so a section can stop listening when it unmounts. */
  onLexiconChanged: (cb: (entries: LexiconEntry[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, entries: LexiconEntry[]): void => cb(entries)
    ipcRenderer.on(IPC.LEXICON_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.LEXICON_CHANGED, listener)
    }
  },

  // --- suggestions mined from History + Meetings (Learned tab) ---
  getSuggestions: (): Promise<Suggestion[]> => ipcRenderer.invoke(IPC.SUGGESTIONS_GET),
  acceptSuggestion: (id: string): Promise<Suggestion[]> => ipcRenderer.invoke(IPC.SUGGESTIONS_ACCEPT, id),
  dismissSuggestion: (id: string): Promise<Suggestion[]> => ipcRenderer.invoke(IPC.SUGGESTIONS_DISMISS, id),

  // --- writing style + "is learning helping?" statistics (Learned tab) ---
  getStyle: (): Promise<StyleProfile> => ipcRenderer.invoke(IPC.STYLE_GET),
  setStyleNotes: (notes: string): Promise<StyleProfile> => ipcRenderer.invoke(IPC.STYLE_SET_NOTES, notes),
  setStyleHabit: (id: string, enabled: boolean): Promise<StyleProfile> =>
    ipcRenderer.invoke(IPC.STYLE_SET_HABIT, id, enabled),
  resetStyle: (): Promise<StyleProfile> => ipcRenderer.invoke(IPC.STYLE_RESET),
  getEval: (): Promise<EvalReport> => ipcRenderer.invoke(IPC.EVAL_GET),
  resetEval: (): Promise<EvalReport> => ipcRenderer.invoke(IPC.EVAL_RESET),

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
  meetingStart: (
    languageConfig: MeetingLanguageConfig,
    audioSource: MeetingAudioSource,
    spaceId?: string
  ): void => ipcRenderer.send(IPC.MEETING_START, languageConfig, audioSource, spaceId),
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
  // Files (or unfiles, when spaceId is null) a session under a space — sidebar kebab menu.
  moveMeetingSessionToSpace: (id: string, spaceId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.MEETING_MOVE_SESSION_TO_SPACE, id, spaceId),
  // --- meeting spaces ---
  getMeetingSpaces: (): Promise<MeetingSpace[]> => ipcRenderer.invoke(IPC.MEETING_GET_SPACES),
  createMeetingSpace: (name: string): Promise<MeetingSpace | null> =>
    ipcRenderer.invoke(IPC.MEETING_CREATE_SPACE, name),
  renameMeetingSpace: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MEETING_RENAME_SPACE, id, name),
  // Never deletes the sessions filed under it — they fall back to unfiled ("All").
  deleteMeetingSpace: (id: string): Promise<void> => ipcRenderer.invoke(IPC.MEETING_DELETE_SPACE, id),
  // On-demand: generates (or returns the already-cached) ready-to-post content
  // for one platform. Resolves null if generation failed (offline, bad key, etc).
  generateMeetingContent: (id: string, platform: ContentPlatform): Promise<MeetingContentResult | null> =>
    ipcRenderer.invoke(IPC.MEETING_GENERATE_CONTENT, id, platform),
  // On-demand retry for a stopped session whose title/summary generation failed —
  // resolves true on success, false on failure. On success the actual title/summary
  // update arrives separately via onMeetingSessionUpdated.
  generateMeetingSummary: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.MEETING_GENERATE_SUMMARY, id),
  // In-session AI chat: ask a question about this session's own transcript (works
  // while still recording or after Stop). Resolves the assistant's MeetingChatMessage,
  // or null on failure — the caller persists nothing and shows a transient error.
  sendMeetingChatMessage: (id: string, question: string): Promise<MeetingChatMessage | null> =>
    ipcRenderer.invoke(IPC.MEETING_CHAT_SEND, id, question),
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
