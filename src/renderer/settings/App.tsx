import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { HotkeySection } from './sections/Hotkey'
import { LanguageSection } from './sections/Language'
import { GeneralSection } from './sections/General'
import { UpdatesSection } from './sections/Updates'
import { HistorySection } from './sections/History'
import { OnboardingBanner } from './sections/Onboarding'
import { ModesSection } from './sections/Modes'
import { VocabularySection } from './sections/Vocabulary'
import { TranscribeSection } from './sections/Transcribe'
import { AccountSection } from './sections/Account'
import { TemplatesSection } from './sections/Templates'
import { StatisticsSection } from './sections/Statistics'
import { MeetingPanel } from '../meeting/App'
import './settings.css'
import '../meeting/meeting.css'

type Tab = 'settings' | 'transcribe' | 'history' | 'account' | 'meeting'

function initialTab(): Tab {
  const t = new URLSearchParams(window.location.search).get('tab')
  return t === 'meeting' ? 'meeting' : 'settings'
}

function PersonIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  )
}

function MicIcon(): React.JSX.Element {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" fill="none">
      <rect x="4" y="0.5" width="6" height="9" rx="3" fill="white" />
      <path d="M1.5 8C1.5 11.038 4.014 13 7 13C9.986 13 12.5 11.038 12.5 8" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="7" y1="13" x2="7" y2="15.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="4" y1="15.5" x2="10" y2="15.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [authEmail, setAuthEmail] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    window.api.onSettingsChanged(setSettings)
    // Tray (or another entry point) can ask an already-open Settings window to
    // jump straight to the Meeting tab.
    window.api.onOpenMeetingTab(() => setTab('meeting'))
    void window.api.getAccountInfo().then((info) => {
      setAuthEmail(info?.email ?? null)
      setAvatarUrl(info?.avatarUrl ?? null)
    })
    window.api.onAuthStateChanged((state) => {
      setAuthEmail(state ? (state as { email?: string }).email ?? null : null)
      if (state) void window.api.getAccountInfo().then((info) => {
        setAuthEmail(info?.email ?? null)
        setAvatarUrl(info?.avatarUrl ?? null)
      })
      else setAvatarUrl(null)
    })
  }, [])

  if (!settings) return <div className="app loading">Loading…</div>

  return (
    <div className={tab === 'meeting' ? 'app app--meeting' : 'app'}>
      <header>
        <div className="wordmark">
          <div className="wordmark-badge">
            <MicIcon />
          </div>
          <h1>Wispra</h1>
        </div>
        <nav className="tab-nav">
          {/* "Dictate" = the always-on hotkey/overlay flow (speak anywhere, text is typed
              live into whatever app is focused). Kept as the "settings" tab value internally
              (unchanged routing/query-param key) — only the label + nav position changed, so
              it reads as the twin of "Meeting" (long-form recorded session) rather than a
              generic settings screen. See "Transcribe" for the third, distinct STT feature:
              transcribing an existing audio/video file (no live typing). */}
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Dictate
          </button>
          <button className={tab === 'meeting' ? 'active' : ''} onClick={() => setTab('meeting')}>
            Meeting <span className="tab-beta">BETA</span>
          </button>
          <button className={tab === 'transcribe' ? 'active' : ''} onClick={() => setTab('transcribe')}>
            Transcribe
          </button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            History
          </button>
          <button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>
            Account
          </button>
        </nav>

        <button
          className={authEmail ? 'header-avatar' : 'header-avatar header-avatar--guest'}
          title={authEmail ?? 'Sign in to Wispra Cloud'}
          onClick={() => setTab('account')}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} referrerPolicy="no-referrer" />
          ) : authEmail ? (
            authEmail[0].toUpperCase()
          ) : (
            <PersonIcon />
          )}
        </button>
      </header>

      {tab === 'settings' ? (
        <main key="settings">
          <OnboardingBanner settings={settings} />
          <HotkeySection settings={settings} />
          <LanguageSection settings={settings} />
          <GeneralSection settings={settings} />
          <ModesSection settings={settings} />
          <VocabularySection settings={settings} />
          <TemplatesSection settings={settings} />
          <UpdatesSection settings={settings} />
        </main>
      ) : tab === 'transcribe' ? (
        <main key="transcribe">
          <TranscribeSection settings={settings} />
        </main>
      ) : tab === 'history' ? (
        <main key="history">
          <StatisticsSection />
          <HistorySection />
        </main>
      ) : tab === 'meeting' ? (
        <main key="meeting">
          <MeetingPanel />
        </main>
      ) : (
        <main key="account">
          <AccountSection />
        </main>
      )}
    </div>
  )
}
