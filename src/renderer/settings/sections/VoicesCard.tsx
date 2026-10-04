import { useEffect, useState } from 'react'
import type { VoiceRecognitionState } from '@shared/types'

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
}

/**
 * "Recognise speakers by voice" (Learned tab). On by default (the owner's decision, 2026-10-04):
 * a Meeting speaker who was named once — the user typed the name, or the person said it in the
 * recording — is labelled by voice in later meetings. The user can turn it off here. The list
 * shows every remembered voice (never its data) with "Forget", and "Forget all voices" removes
 * everything this feature keeps.
 */
export function VoicesCard(): React.JSX.Element {
  const [state, setState] = useState<VoiceRecognitionState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getVoiceRecognition().then(setState)
    return window.api.onVoiceRecognitionChanged(setState)
  }, [])

  if (!state) return <></>

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      setState(await window.api.setVoiceRecognition(!state.enabled))
    } finally {
      setBusy(false)
    }
  }
  const forget = (id: string, name: string): void => {
    if (!window.confirm(`Forget the voice of "${name}"? Wispra will no longer label it by itself.`)) return
    void window.api.forgetVoice(id)
  }
  const forgetAll = (): void => {
    if (!window.confirm('Forget all voices? Every remembered voice and the voice data kept with your meetings are deleted.')) return
    void window.api.forgetAllVoices()
  }

  const status =
    state.model === 'downloading'
      ? 'Downloading the voice model (about 28 MB, once)…'
      : state.model === 'failed'
        ? `The voice model could not be downloaded: ${state.error ?? 'unknown error'} Turn the switch off and on to try again.`
        : null

  return (
    <div className="voices-card">
      <div className="learned-head">
        <h3 className="learned-sub">Speakers&apos; voices</h3>
      </div>
      <label className={`toggle-row${state.available ? '' : ' disabled'}`}>
        <input type="checkbox" checked={state.enabled} disabled={busy || !state.available} onChange={() => void toggle()} />
        <div className="toggle-info">
          <span className="toggle-label">Recognise speakers by voice</span>
          <span className="toggle-desc">
            In Meeting, a speaker you name once — or who says their name in the recording — is labelled by voice in
            later meetings. Wispra keeps a numeric description of each voice (not the audio), encrypted, only on this
            computer — nothing is sent anywhere. A voice is personal biometric data: let the people you record know,
            or turn this off.
          </span>
        </div>
        <div className="toggle-switch" />
      </label>
      {!state.available && <p className="voices-note">Speaker recognition is not available on this computer.</p>}
      {status && <p className="voices-note">{status}</p>}
      {state.voices.length > 0 ? (
        <>
          <ul className="voices-list">
            {state.voices.map((v) => (
              <li key={v.id} className="voices-item">
                <span className="voices-name">{v.name}</span>
                <span className="voices-meta">
                  learned from {v.samples} {v.samples === 1 ? 'passage' : 'passages'} · updated {formatDate(v.updatedAt)}
                  {v.lastMatchedAt ? ` · last recognised ${formatDate(v.lastMatchedAt)}` : ''}
                </span>
                <button type="button" className="voices-forget" onClick={() => forget(v.id, v.name)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="voices-forget-all" onClick={forgetAll}>
            Forget all voices
          </button>
        </>
      ) : (
        state.enabled && <p className="voices-note">No voices yet. Name a speaker in a meeting&apos;s Transcript to teach one.</p>
      )}
    </div>
  )
}
