import { LANGUAGES } from '@shared/constants'
import type { Settings } from '@shared/types'

export function LanguageSection({ settings }: { settings: Settings }): React.JSX.Element {
  return (
    <section>
      <h2>Language</h2>
      <p className="hint">
        Auto-detect recognizes any language you speak. Pin one language for better accuracy when
        you always dictate in the same language.
      </p>
      <select
        className="lang-select"
        value={settings.language}
        onChange={(e) => void window.api.setSettings({ language: e.target.value })}
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </section>
  )
}
