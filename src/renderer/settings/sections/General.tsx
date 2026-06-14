import type { Settings } from '@shared/types'

export function GeneralSection({ settings }: { settings: Settings }): React.JSX.Element {
  return (
    <section>
      <h2>General</h2>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.launchAtLogin}
          onChange={(e) => void window.api.setSettings({ launchAtLogin: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Launch at login</span>
          <span className="toggle-desc">Start Wispra automatically when you sign in</span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.aiPostProcess}
          onChange={(e) => void window.api.setSettings({ aiPostProcess: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">AI cleanup</span>
          <span className="toggle-desc">Fix spelling &amp; add punctuation after transcription</span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.soundFeedback ?? true}
          onChange={(e) => void window.api.setSettings({ soundFeedback: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Sound feedback</span>
          <span className="toggle-desc">Play a beep when recording starts or an error occurs</span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.voiceCommandsEnabled ?? true}
          onChange={(e) => void window.api.setSettings({ voiceCommandsEnabled: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Voice commands</span>
          <span className="toggle-desc">
            Say "new paragraph", "new line", "delete that", "comma", "period", etc. to insert symbols or undo
          </span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.contextAwareEnabled ?? false}
          onChange={(e) => void window.api.setSettings({ contextAwareEnabled: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Context-aware AI</span>
          <span className="toggle-desc">
            Auto-detect the focused app (Outlook, Slack, VS Code…) and adjust AI cleanup accordingly
          </span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.previewBeforePaste ?? false}
          onChange={(e) => void window.api.setSettings({ previewBeforePaste: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Preview before paste</span>
          <span className="toggle-desc">
            Show a notification with the transcribed text for 2.5 s before it is typed
          </span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={settings.continuousMode ?? false}
          onChange={(e) => void window.api.setSettings({ continuousMode: e.target.checked })}
        />
        <div className="toggle-info">
          <span className="toggle-label">Continuous mode</span>
          <span className="toggle-desc">
            Automatically start a new recording after each paste — ideal for long dictation sessions
          </span>
        </div>
        <div className="toggle-switch" />
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={(settings.inputMode ?? 'toggle') === 'auto-stop'}
          onChange={(e) =>
            void window.api.setSettings({ inputMode: e.target.checked ? 'auto-stop' : 'toggle' })
          }
        />
        <div className="toggle-info">
          <span className="toggle-label">Auto-stop on silence</span>
          <span className="toggle-desc">
            Stop recording automatically when you pause speaking for ~1.5 s (push-to-talk feel)
          </span>
        </div>
        <div className="toggle-switch" />
      </label>

      <div className="autostop-row">
        <span className="autostop-label">Auto-stop recording after</span>
        <select
          className="autostop-select"
          value={settings.autoStopMinutes}
          onChange={(e) => void window.api.setSettings({ autoStopMinutes: Number(e.target.value) })}
        >
          {[1, 2, 5, 10].map((m) => (
            <option key={m} value={m}>{m} min</option>
          ))}
        </select>
      </div>
    </section>
  )
}
