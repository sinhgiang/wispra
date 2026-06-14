import { useEffect, useRef, useState, useCallback } from 'react'
import type { StatePayload } from '@shared/types'
import { Recorder } from './recorder'
import './overlay.css'

export function App(): React.JSX.Element {
  const [payload, setPayload] = useState<StatePayload>({ state: 'idle' })
  const [level, setLevel] = useState(0)
  const [modeLabel, setModeLabel] = useState<string | null>(null)
  const recorderRef = useRef<Recorder>(new Recorder())
  const initializedRef = useRef(false)

  const handleStart = useCallback(() => {
    const recorder = recorderRef.current
    recorder.start(setLevel).catch(() => {
      recorder.abort()
      window.api.recordingFailed('Microphone access denied or unavailable')
    })
  }, [])

  const handleStop = useCallback(() => {
    const recorder = recorderRef.current
    void recorder.stop().then((result) => {
      setLevel(0)
      if (result) window.api.sendAudio(result.audio, result.durationSeconds, result.mimeType)
      else window.api.recordingFailed('Recording produced no audio')
    })
  }, [])

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    window.api.onStateChanged(setPayload)
    window.api.onRecordingStart(handleStart)
    window.api.onRecordingStop(handleStop)

    function syncMode(s: { aiPostProcess: boolean; modes: { id: string; name: string }[]; activeMode: string }): void {
      if (s.aiPostProcess && s.activeMode !== 'general') {
        const m = s.modes.find((m) => m.id === s.activeMode)
        setModeLabel(m?.name ?? null)
      } else {
        setModeLabel(null)
      }
    }

    void window.api.getSettings().then(syncMode)
    window.api.onSettingsChanged(syncMode)
  }, [handleStart, handleStop])

  const { state } = payload

  function handleClick(): void {
    if (state === 'recording') window.api.toggleDictation()
  }

  return (
    <div className="wrap">
      <button
        type="button"
        className={`bubble ${state}`}
        style={state === 'recording' ? { transform: `scale(${1 + level * 0.22})` } : undefined}
        aria-label={state === 'recording' ? 'Stop recording' : state}
        onClick={handleClick}
      >
        {state === 'processing' ? (
          <span className="spinner" />
        ) : state === 'error' ? (
          <span className="glyph">!</span>
        ) : (
          <MicIcon />
        )}
      </button>
      {modeLabel && (state === 'recording' || state === 'processing') && (
        <span className="mode-badge">{modeLabel}</span>
      )}
    </div>
  )
}

function MicIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="white" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
      <path d="M18 11a1 1 0 1 0-2 0 4 4 0 1 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.92V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08A6 6 0 0 0 18 11z" />
    </svg>
  )
}
