import { useEffect, useState } from 'react'
import type { Settings, SttProvider } from '@shared/types'

const CLOUD_PROVIDERS: {
  value: 'groq' | 'openai'
  label: string
  price: string
  hint: string
  keyUrl: string
  placeholder: string
}[] = [
  {
    value: 'openai',
    label: 'OpenAI Whisper',
    price: '~$0.006 / min',
    hint: 'Sign in at platform.openai.com/api-keys with your ChatGPT account.',
    keyUrl: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-…'
  },
  {
    value: 'groq',
    label: 'Groq',
    price: 'Free tier · ~$0.001 / min',
    hint: 'Free tier available. Create a key at console.groq.com/keys.',
    keyUrl: 'https://console.groq.com/keys',
    placeholder: 'gsk_…'
  }
]

function CheckIcon(): React.JSX.Element {
  return (
    <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
      <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ApiKeySection({ settings }: { settings: Settings }): React.JSX.Element {
  const [provider, setProvider] = useState<SttProvider>(settings.provider)
  const [key, setKey] = useState(
    settings.provider === 'openai' ? settings.openaiApiKey : settings.groqApiKey
  )
  const [localUrl, setLocalUrl] = useState(settings.localBaseUrl)
  const [localStt, setLocalStt] = useState(settings.localSttModel)
  const [localLlm, setLocalLlm] = useState(settings.localLlmModel)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null)

  useEffect(() => {
    setProvider(settings.provider)
    setKey(settings.provider === 'openai' ? settings.openaiApiKey : settings.groqApiKey)
    setLocalUrl(settings.localBaseUrl)
    setLocalStt(settings.localSttModel)
    setLocalLlm(settings.localLlmModel)
  }, [settings.provider, settings.openaiApiKey, settings.groqApiKey, settings.localBaseUrl, settings.localSttModel, settings.localLlmModel])

  function handleProviderChange(next: SttProvider): void {
    setProvider(next)
    if (next !== 'local') setKey(next === 'openai' ? settings.openaiApiKey : settings.groqApiKey)
    setStatus(null)
    void window.api.setSettings({ provider: next })
  }

  async function saveAndTest(): Promise<void> {
    setStatus({ kind: 'busy', text: provider === 'local' ? 'Connecting…' : 'Testing key…' })

    if (provider === 'local') {
      await window.api.setSettings({ localBaseUrl: localUrl, localSttModel: localStt, localLlmModel: localLlm })
      const result = await window.api.testApiKey('local', '', localUrl)
      setStatus(result.ok
        ? { kind: 'ok', text: 'Connected — server is reachable' }
        : { kind: 'err', text: result.error ?? 'Connection failed' })
      return
    }

    const trimmed = key.trim()
    const result = await window.api.testApiKey(provider, trimmed)
    if (result.ok) {
      const patch = provider === 'openai' ? { openaiApiKey: trimmed } : { groqApiKey: trimmed }
      await window.api.setSettings(patch)
      setStatus({ kind: 'ok', text: 'Key saved and verified' })
    } else {
      setStatus({ kind: 'err', text: result.error ?? 'Key test failed.' })
    }
  }

  const cloudInfo = CLOUD_PROVIDERS.find((p) => p.value === provider)

  return (
    <section>
      <h2>Speech Recognition</h2>

      <div className="provider-cards" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {CLOUD_PROVIDERS.map((p) => (
          <button
            key={p.value}
            className={`provider-card ${provider === p.value ? 'selected' : ''}`}
            onClick={() => handleProviderChange(p.value)}
          >
            <div className="provider-check"><CheckIcon /></div>
            <div className="provider-name">{p.label}</div>
            <div className="provider-price">{p.price}</div>
          </button>
        ))}
        <button
          className={`provider-card ${provider === 'local' ? 'selected' : ''}`}
          onClick={() => handleProviderChange('local')}
        >
          <div className="provider-check"><CheckIcon /></div>
          <div className="provider-name">Local</div>
          <div className="provider-price">Ollama · LocalAI · LM Studio</div>
        </button>
      </div>

      {provider === 'local' ? (
        <>
          <p className="hint">
            Connect to a local OpenAI-compatible server. Requires a server that supports{' '}
            <code>/audio/transcriptions</code> for dictation (e.g.{' '}
            <a href="https://localai.io" target="_blank" rel="noreferrer">LocalAI</a> or{' '}
            <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">LM Studio</a>).
            Ollama can handle AI cleanup but not transcription.
          </p>
          <div className="local-fields">
            <div className="form-group">
              <label className="form-label">Server URL</label>
              <input
                type="text"
                value={localUrl}
                placeholder="http://localhost:11434/v1"
                onChange={(e) => { setLocalUrl(e.target.value); setStatus(null) }}
                spellCheck={false}
              />
            </div>
            <div className="local-models">
              <div className="form-group">
                <label className="form-label">STT model</label>
                <input
                  type="text"
                  value={localStt}
                  placeholder="whisper"
                  onChange={(e) => setLocalStt(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="form-group">
                <label className="form-label">LLM model</label>
                <input
                  type="text"
                  value={localLlm}
                  placeholder="llama3.2"
                  onChange={(e) => setLocalLlm(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
          </div>
          <div className="input-row" style={{ marginTop: '10px' }}>
            <button onClick={() => void saveAndTest()} disabled={status?.kind === 'busy'}>
              Save &amp; Test connection
            </button>
          </div>
        </>
      ) : cloudInfo ? (
        <>
          <p className="hint">
            {cloudInfo.hint}{' '}
            <a href={cloudInfo.keyUrl} target="_blank" rel="noreferrer">
              Get your API key ↗
            </a>
          </p>
          <div className="input-row">
            <input
              type="password"
              value={key}
              placeholder={cloudInfo.placeholder}
              onChange={(e) => { setKey(e.target.value); setStatus(null) }}
              spellCheck={false}
            />
            <button onClick={() => void saveAndTest()} disabled={status?.kind === 'busy'}>
              Save &amp; Test
            </button>
          </div>
        </>
      ) : null}

      {status && <p className={`status ${status.kind}`}>{status.text}</p>}
    </section>
  )
}
