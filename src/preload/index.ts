import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  ApiKeyTestResult,
  HotkeyResult,
  Settings,
  StatePayload,
  TranscriptEntry,
  UpdateStatus
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
  testApiKey: (provider: string, apiKey: string): Promise<ApiKeyTestResult> =>
    ipcRenderer.invoke(IPC.TEST_API_KEY, provider, apiKey),
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
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC.CHECK_UPDATE),
  installUpdate: (): void => ipcRenderer.send(IPC.INSTALL_UPDATE),
  onUpdateStatus: (cb: (status: UpdateStatus) => void): void => {
    ipcRenderer.on(IPC.UPDATE_STATUS, (_e, status: UpdateStatus) => cb(status))
  }
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)
