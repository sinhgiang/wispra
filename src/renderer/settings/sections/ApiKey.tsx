import { useEffect, useState } from 'react'
import type { Settings, SttProvider } from '@shared/types'

const PROVIDERS: { value: SttProvider; label: string; hint: string; keyUrl: string; placeholder: string }[] = [
  {
    value: 'openai',
    label: 'OpenAI Whisper',
    hint: 'Sign in with your ChatGPT account at platform.openai.com/api-keys. Costs ~$0.006/min.',
    keyUrl: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-…'
  },
  {
    value: 'groq',
    label: 'Groq (faster & cheaper)',
    hint: 'Free tier available. Create a key at console.groq.com/keys. Costs ~$0.001/min.',
    keyUrl: 'https://console.groq.com/keys',
    placeholder: 'gsk_…'
  }
]

export function ApiKeySection({ settings }: { settings: Settings }): React.JSX.Element {
  const [provider, setProvider] = useState<SttProvider>(settings.provider)
  const [key, setKey] = useState(provider === 'openai' ? settings.openaiApiKey : settings.groqApiKey)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null)

  const info = PROVIDERS.find((p) => p.value === provider)!

  // Sync local key when provider or settings change from outside.
  useEffect(() => {
    setProvider(settings.provider)
    setKey(settings.provider === 'openai' ? settings.openaiApiKey : settings.groqApiKey)
  }, [settings.provider, settings.openaiApiKey, settings.groqApiKey])

  function handleProviderChange(next: SttProvider): void {
    setProvider(next)
    setKey(next === 'openai' ? settings.openaiApiKey : settings.groqApiKey)
    setStatus(null)
    void window.api.setSettings({ provider: next })
  }

  async function saveAndTest(): Promise<void> {
    setStatus({ kind: 'busy', text: 'Testing key…' })
    const trimmed = key.trim()
    const result = await window.api.testApiKey(provider, trimmed)
    if (result.ok) {
      const patch = provider === 'openai' ? { openaiApiKey: trimmed } : { groqApiKey: trimmed }
      await window.api.setSettings(patch)
      setStatus({ kind: 'ok', text: 'Key is valid and saved ✓' })
    } else {
      setStatus({ kind: 'err', text: result.error ?? 'Key test failed.' })
    }
  }

  return (
    <section>
      <h2>Speech Recognition</h2>

      <div className="provider-tabs">
        {PROVIDERS.map((p) => (
          <button
            key={p.value}
            className={`tab ${provider === p.value ? 'active' : ''}`}
            onClick={() => handleProviderChange(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <p className="hint">
        {info.hint}{' '}
        <a href={info.keyUrl} target="_blank" rel="noreferrer">
          Get your API key ↗
        </a>
      </p>

      <div className="row">
        <input
          type="password"
          value={key}
          placeholder={info.placeholder}
          onChange={(e) => { setKey(e.target.value); setStatus(null) }}
          spellCheck={false}
        />
        <button onClick={() => void saveAndTest()} disabled={status?.kind === 'busy'}>
          Save &amp; Test
        </button>
      </div>
      {status && <p className={`status ${status.kind}`}>{status.text}</p>}
    </section>
  )
}
