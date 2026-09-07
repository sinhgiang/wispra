/**
 * Single source of truth for ALL IPC channel names.
 * Never hardcode channel strings anywhere else.
 */
export const IPC = {
  // main -> overlay renderer
  STATE_CHANGED: 'state:changed',
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',

  // overlay renderer -> main
  AUDIO_CAPTURED: 'recording:audio-captured',
  RECORDING_FAILED: 'recording:failed',
  TOGGLE_DICTATION: 'dictation:toggle',
  OPEN_SETTINGS: 'settings:open',

  // settings renderer <-> main
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  SETTINGS_CHANGED: 'settings:changed',
  APPLY_HOTKEY: 'settings:apply-hotkey',
  TEST_API_KEY: 'settings:test-api-key',
  GET_HISTORY: 'history:get',
  CLEAR_HISTORY: 'history:clear',
  HISTORY_CHANGED: 'history:changed',
  COPY_TEXT: 'clipboard:copy',

  // auto-update
  UPDATE_STATUS: 'update:status',
  CHECK_UPDATE: 'update:check',
  INSTALL_UPDATE: 'update:install',

  // file transcription
  TRANSCRIBE_FILE: 'transcribe:file',
  PICK_FILE: 'transcribe:pick-file',

  // post-injection feedback
  INJECTION_DONE: 'injection:done',
  PREVIEW_TEXT: 'preview:text',

  // undo
  UNDO_INJECTION: 'injection:undo',

  // statistics & export
  GET_STATS: 'stats:get',
  EXPORT_HISTORY: 'history:export',
  SUMMARIZE_TOPIC: 'history:summarize-topic',

  // overlay sound
  PLAY_SOUND: 'overlay:play-sound',

  // continuous mode
  CONTINUOUS_NEXT: 'dictation:continuous-next',

  // silence auto-stop (separate from manual toggle so continuous mode is not cancelled)
  SILENCE_STOP: 'dictation:silence-stop',

  // overlay drag repositioning
  MOVE_OVERLAY: 'overlay:move',

  // app info
  GET_APP_VERSION: 'app:version',

  // cloud auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATE: 'auth:state',
  GET_ACCOUNT_INFO: 'auth:account-info',

  // meeting mode (long-form continuous recording) — fully separate from the channels above
  // main -> settings renderer: switch the Settings window to the Meeting tab (e.g. from tray)
  MEETING_OPEN_TAB: 'meeting:open-tab',
  // renderer -> main: user pressed Start/Pause/Resume/Stop in the meeting window
  MEETING_START: 'meeting:start',
  MEETING_PAUSE: 'meeting:pause',
  MEETING_RESUME: 'meeting:resume',
  MEETING_STOP: 'meeting:stop',
  // renderer -> main: user pressed "Discard" (between Pause and Stop) — cancels the
  // current session without saving/summarizing it. See meetingSessions.discard().
  MEETING_DISCARD: 'meeting:discard',
  // main -> meeting renderer: command to actually start/pause/resume/stop the mic capture
  MEETING_CAPTURE_START: 'meeting:capture-start',
  MEETING_CAPTURE_PAUSE: 'meeting:capture-pause',
  MEETING_CAPTURE_RESUME: 'meeting:capture-resume',
  MEETING_CAPTURE_STOP: 'meeting:capture-stop',
  MEETING_STATE_CHANGED: 'meeting:state-changed',
  // main -> meeting renderer: recording was auto-stopped by the silence safety net
  // (MEETING_SILENCE_AUTO_STOP_MS with no real transcribed speech), not a manual Stop —
  // arrives right before MEETING_CAPTURE_STOP so the renderer can show why it stopped.
  MEETING_AUTO_STOPPED: 'meeting:auto-stopped',
  // renderer -> main: current state, queried on mount so re-opening the tab mid-meeting shows the right screen
  MEETING_GET_STATE: 'meeting:get-state',
  // renderer -> main: one silence/hard-cap-bounded audio chunk is ready (carries the audio bytes)
  MEETING_CHUNK_CAPTURED: 'meeting:chunk-captured',
  // renderer -> main: mic could not be opened
  MEETING_CAPTURE_FAILED: 'meeting:capture-failed',
  // main -> meeting renderer: a chunk finished transcribing and is ready to render
  MEETING_SEGMENT_READY: 'meeting:segment-ready',
  MEETING_GET_SESSIONS: 'meeting:get-sessions',
  MEETING_GET_SESSION: 'meeting:get-session',
  MEETING_DELETE_SESSION: 'meeting:delete-session',
  // renderer -> main: user renamed a session from the sidebar (kebab menu)
  MEETING_RENAME_SESSION: 'meeting:rename-session',
  MEETING_EXPORT: 'meeting:export',
  // renderer -> main: generate (or return the cached) ready-to-post content for
  // one platform of a stopped session — see generateMeetingContent in postprocess.ts
  MEETING_GENERATE_CONTENT: 'meeting:generate-content',
  // renderer -> main: user pressed "Try again" on a stopped session's Summary tab
  // after the automatic post-Stop title/summary generation failed — see
  // regenerateSessionSummary in main/index.ts. Resolves true/false; the actual
  // title/summary update (on success) arrives via MEETING_SESSION_UPDATED below.
  MEETING_GENERATE_SUMMARY: 'meeting:generate-summary',
  // main -> settings renderer: a session's title/summary/status changed (e.g. the
  // AI-generated title finished after Stop) — carries the full updated MeetingSession
  MEETING_SESSION_UPDATED: 'meeting:session-updated'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
