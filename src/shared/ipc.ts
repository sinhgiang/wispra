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

  // cloud auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATE: 'auth:state',
  GET_ACCOUNT_INFO: 'auth:account-info'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
