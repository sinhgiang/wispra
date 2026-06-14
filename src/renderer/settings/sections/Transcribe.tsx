import { useState, useRef } from 'react'
import { LANGUAGES } from '@shared/constants'
import type { Settings } from '@shared/types'

type Status = 'idle' | 'loading' | 'done' | 'error'

export function TranscribeSection({ settings }: { settings: Settings }): React.JSX.Element {
  const [fileName, setFileName] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [language, setLanguage] = useState(settings.language)
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  const hasKey = !!(settings.groqApiKey || settings.openaiApiKey)

  function pickFile(): void {
    void window.api.pickFile().then((path) => {
      if (!path) return
      setFilePath(path)
      setFileName(path.split(/[\\/]/).pop() ?? path)
      setStatus('idle')
      setResult(null)
      setError(null)
    })
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    // Electron drag-drop exposes the real path via file.path
    const path = (file as File & { path?: string }).path ?? file.name
    setFilePath(path)
    setFileName(file.name)
    setStatus('idle')
    setResult(null)
    setError(null)
  }

  async function transcribe(): Promise<void> {
    if (!filePath) return
    setStatus('loading')
    setResult(null)
    setError(null)
    const res = await window.api.transcribeFile(filePath, language)
    if (res.ok) {
      setResult(res.text)
      setStatus('done')
    } else {
      setError(res.error)
      setStatus('error')
    }
  }

  function copy(): void {
    if (!result) return
    void window.api.copyText(result)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="transcribe-page">
      <h2 className="transcribe-title">Transcribe a file</h2>
      <p className="hint">Upload an audio or video file and get a text transcript.</p>

      {!hasKey && (
        <p className="hint" style={{ color: 'var(--danger)' }}>
          Add an API key in Settings → API Key before transcribing.
        </p>
      )}

      <div
        ref={dropRef}
        className={`drop-zone${fileName ? ' has-file' : ''}`}
        onClick={pickFile}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {fileName ? (
          <>
            <FileIcon />
            <span className="drop-filename">{fileName}</span>
            <span className="drop-hint">Click to change file</span>
          </>
        ) : (
          <>
            <UploadIcon />
            <span className="drop-label">Drop a file or click to browse</span>
            <span className="drop-hint">MP3, MP4, WAV, M4A, FLAC, OGG, WebM…</span>
          </>
        )}
      </div>

      <div className="transcribe-controls">
        <select
          className="lang-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>

        <button
          className="primary"
          disabled={!filePath || !hasKey || status === 'loading'}
          onClick={() => void transcribe()}
        >
          {status === 'loading' ? 'Transcribing…' : 'Transcribe'}
        </button>
      </div>

      {status === 'error' && error && (
        <div className="status err" style={{ marginTop: '12px' }}>
          {error}
        </div>
      )}

      {status === 'done' && result && (
        <div className="transcribe-result">
          <div className="transcribe-result-head">
            <span className="transcribe-result-label">Result</span>
            <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="transcribe-result-text">{result}</p>
        </div>
      )}
    </div>
  )
}

function UploadIcon(): React.JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M14 18V8M10 12L14 8L18 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 20C5 21.1 5.9 22 7 22H21C22.1 22 23 21.1 23 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function FileIcon(): React.JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 2V8H20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
