import { useEffect, useRef, useState, useCallback } from 'react'
import type { Settings, StatePayload } from '@shared/types'
import { SILENCE_THRESHOLD, SILENCE_DURATION_MS } from '@shared/constants'
import { Recorder } from './recorder'
import './overlay.css'

export function App(): React.JSX.Element {
  const [payload, setPayload] = useState<StatePayload>({ state: 'idle' })
  const [level, setLevel] = useState(0)
  const [modeLabel, setModeLabel] = useState<string | null>(null)
  const [justDone, setJustDone] = useState(false)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [inputMode, setInputMode] = useState<'toggle' | 'auto-stop'>('toggle')
  const recorderRef = useRef<Recorder>(new Recorder())
  const initializedRef = useRef(false)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Auto-stop on silence: when inputMode === 'auto-stop' and recording,
  // stop after SILENCE_DURATION_MS of continuous low level.
  useEffect(() => {
    if (inputMode !== 'auto-stop' || payload.state !== 'recording') {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }
      return
    }

    if (level > SILENCE_THRESHOLD) {
      // Voice detected — reset silence timer.
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }
    } else if (!silenceTimerRef.current) {
      // Start silence countdown — use silenceStop so continuous mode can still restart.
      silenceTimerRef.current = setTimeout(() => {
        silenceTimerRef.current = null
        window.api.silenceStop()
      }, SILENCE_DURATION_MS)
    }
  }, [level, inputMode, payload.state])

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    window.api.onStateChanged(setPayload)
    window.api.onRecordingStart(handleStart)
    window.api.onRecordingStop(handleStop)

    // Sound feedback via Web Audio API.
    window.api.onPlaySound(playSound)

    // Done animation: show green check for a moment after successful injection.
    window.api.onInjectionDone(() => {
      setJustDone(true)
      setPreviewText(null)
      setTimeout(() => setJustDone(false), 1400)
    })

    // Preview text: show transcribed text for a moment before pasting.
    window.api.onPreviewText((text) => {
      setPreviewText(text)
    })

    function syncSettings(s: Settings): void {
      // Mode label
      if (s.aiPostProcess && s.activeMode !== 'general') {
        const m = s.modes.find((m) => m.id === s.activeMode)
        setModeLabel(m?.name ?? null)
      } else {
        setModeLabel(null)
      }
      // Input mode
      setInputMode(s.inputMode ?? 'toggle')
    }

    void window.api.getSettings().then(syncSettings)
    window.api.onSettingsChanged(syncSettings)
  }, [handleStart, handleStop])

  const { state } = payload
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>): void {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false }
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>): void {
    if (!dragRef.current) return
    const dx = e.screenX - dragRef.current.startX
    const dy = e.screenY - dragRef.current.startY
    if (!dragRef.current.moved && Math.hypot(dx, dy) < 4) return
    dragRef.current.moved = true
    dragRef.current.startX = e.screenX
    dragRef.current.startY = e.screenY
    window.api.moveOverlay(dx, dy)
  }

  function onPointerUp(): void {
    const wasDrag = dragRef.current?.moved ?? false
    dragRef.current = null
    if (!wasDrag && state === 'recording') window.api.toggleDictation()
  }

  const showModeBadge = modeLabel && (state === 'recording' || state === 'processing') && !justDone
  const showPreview = previewText && state === 'processing' && !justDone

  return (
    <div className="wrap">
      <button
        type="button"
        className={`bubble ${justDone ? 'done' : state}`}
        style={state === 'recording' && !justDone ? { transform: `scale(${1 + level * 0.22})` } : undefined}
        aria-label={state === 'recording' ? 'Stop recording' : state}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {justDone ? (
          <DoneIcon />
        ) : state === 'processing' ? (
          <span className="spinner" />
        ) : state === 'error' ? (
          <span className="glyph">!</span>
        ) : (
          <MicIcon />
        )}
      </button>

      {showModeBadge && (
        <span className="mode-badge">{modeLabel}</span>
      )}

      {showPreview && (
        <span className="preview-badge">
          {previewText.length > 40 ? previewText.slice(0, 37) + '…' : previewText}
        </span>
      )}
    </div>
  )
}

function playSound(type: 'start' | 'error'): void {
  try {
    const ctx = new AudioContext()
    void ctx.resume().then(() => {
      const now = ctx.currentTime
      if (type === 'start') {
        // Crisp rising "tick" — 880 Hz → 1100 Hz, 110 ms
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.setValueAtTime(880, now)
        osc.frequency.exponentialRampToValueAtTime(1100, now + 0.06)
        gain.gain.setValueAtTime(0.28, now)
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11)
        osc.start(now)
        osc.stop(now + 0.11)
        osc.onended = () => void ctx.close()
      } else {
        // Two descending tones for error
        for (let i = 0; i < 2; i++) {
          const t = now + i * 0.22
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain)
          gain.connect(ctx.destination)
          osc.type = 'sine'
          osc.frequency.setValueAtTime(440, t)
          osc.frequency.exponentialRampToValueAtTime(330, t + 0.12)
          gain.gain.setValueAtTime(0.22, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
          osc.start(t)
          osc.stop(t + 0.16)
        }
        setTimeout(() => void ctx.close(), 700)
      }
    })
  } catch { /* AudioContext unavailable */ }
}

function MicIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="white" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
      <path d="M18 11a1 1 0 1 0-2 0 4 4 0 1 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.92V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08A6 6 0 0 0 18 11z" />
    </svg>
  )
}

function DoneIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
