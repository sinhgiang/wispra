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
  PICK_FILE: 'transcribe:pick-file'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
