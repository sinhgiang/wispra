export type AppState = 'idle' | 'recording' | 'processing' | 'previewing' | 'done' | 'error'

export interface StatePayload {
  state: AppState
  /** Short user-facing message, set when state === 'error'. */
  message?: string
}

export type SttProvider = 'groq' | 'openai' | 'local' | 'proxy'

export interface Mode {
  id: string
  name: string
  /** Custom LLM system prompt. Empty string = use the built-in default prompt. */
  prompt: string
  /** ISO-639-1 code or "auto". Overrides the global language setting when active. */
  language: string
  removeFiller: boolean
  /** Built-in modes cannot be deleted, only edited. */
  builtIn?: boolean
}

/** A voice-triggered text expansion template. */
export interface Template {
  id: string
  /** Phrase to say that triggers this template (case-insensitive match). */
  keyword: string
  /** Text to inject when the keyword is matched. Supports [date] and [time] variables. */
  expansion: string
}

/** Maps an app process name pattern to a Mode and optional AI context hint. */
export interface AppContextRule {
  /** Lowercase substring matched against the process name (e.g. "outlook", "slack"). */
  appPattern: string
  /** Mode ID to use when this app is focused. Empty = don't switch mode. */
  modeId: string
  /** Extra hint appended to the AI system prompt for this app context. */
  contextHint: string
}

export interface Settings {
  provider: SttProvider
  groqApiKey: string
  openaiApiKey: string
  /** Cloudflare Workers AI, the last backup for AI text (see resolveBackupRoutes): account id and an API token with Workers AI permission. Never shown again once saved. */
  cloudflareAccountId: string
  cloudflareApiToken: string
  /** Electron accelerator string, e.g. "CommandOrControl+Shift+Space". */
  hotkey: string
  /** ISO-639-1 code ("vi", "en", ...) or "auto" for automatic detection. */
  language: string
  launchAtLogin: boolean
  /** Auto-stop recording after this many minutes. */
  autoStopMinutes: number
  autoUpdate: boolean
  aiPostProcess: boolean
  /** List of dictation modes. */
  modes: Mode[]
  /** ID of the currently active mode. */
  activeMode: string
  /** Custom words/phrases that must be spelled exactly as given. */
  vocabulary: string[]
  /** Base URL for the local STT/LLM server (e.g. Ollama, LocalAI, LM Studio). */
  localBaseUrl: string
  /** Model name for local speech-to-text (passed to /audio/transcriptions). */
  localSttModel: string
  /** Model name for local AI cleanup (passed to /chat/completions). */
  localLlmModel: string
  /** 'toggle' = press to start, press again to stop. 'auto-stop' = stops automatically on silence. */
  inputMode: 'toggle' | 'auto-stop'
  /** Play a system beep when recording starts / errors. */
  soundFeedback: boolean
  /** Show a text preview near the cursor for 2.5s before pasting. */
  previewBeforePaste: boolean
  /** Match spoken commands (new paragraph, delete that, etc.) instead of injecting. */
  voiceCommandsEnabled: boolean
  /** Auto-detect the focused app and adjust AI prompt accordingly. */
  contextAwareEnabled: boolean
  /** User-defined app → mode mapping for context-aware AI. */
  appContextRules: AppContextRule[]
  /** Voice-triggered text expansion templates. */
  templates: Template[]
  /** After injection, automatically start recording again for hands-free dictation. */
  continuousMode: boolean
  /** Learn from corrections made in History and apply what was learned (Learned tab). */
  learningEnabled: boolean
  /** Also learn recurring names/brands/terms from History and meetings by itself (Learned tab). Only meaningful while learningEnabled is on. */
  autoLearnVocabulary: boolean
  /** Opt-in: push History/Meetings/Lexicon to Supabase (see src/main/sync.ts). Requires being signed in. */
  cloudSyncEnabled: boolean
  /**
   * ISO time this install first ran a version that limits automatic AI to new recordings.
   * Only recordings made from then on get AI work started by itself (the Transcript's
   * topics and action items on first open, if Stop did not make them); older ones wait for
   * the user's "Create" button. Set once at startup, never changed after.
   */
  autoAiSince: string
  /** Incremented when defaults change, so migrations can upgrade old saved settings. */
  settingsVersion: number
}

export interface TranscriptEntry {
  id: string
  /** What the user ended up with: the typed text, or their own version after a History fix. */
  text: string
  /** ISO timestamp. */
  createdAt: string
  /** Detected or pinned language code, if known. */
  language?: string
  durationSeconds?: number
  /** Auto-detected topic: 'Email' | 'Meeting' | 'Tasks' | 'Notes' | 'Message' | 'General' */
  topic?: string
  /** Speech-to-text output before any learned replacement or AI cleanup. Absent on older entries and template expansions. */
  rawText?: string
  /** Lowercased process name of the app that was focused when the text was typed (e.g. "chrome"), when known. */
  app?: string
  /** What Wispra originally typed. Set only once the user has fixed the entry — `text` then holds their version. */
  originalText?: string
  /** Id of the mode whose cleanup prompt was used, when the AI cleanup ran. Lets writing examples be matched by context. */
  mode?: string
  /** Whether "Learn my words" was on when this was dictated (unset on entries from before it was tracked). */
  learning?: boolean
}

/**
 * One thing Wispra has learned about the user's vocabulary: a term spelled the way the user wants
 * it, plus the wrong forms the speech-to-text step is known to produce for it.
 */
export interface LexiconEntry {
  id: string
  /** The correct form, exactly as the user wants it written ("Claude Code"). */
  term: string
  /** Wrong forms speech-to-text produces for this term ("Cloud Code"). May be empty for a plain term. */
  heardAs: string[]
  /** How many times the user has confirmed this entry (each repeated correction adds one). */
  count: number
  /** Off entries are kept but never applied. */
  enabled: boolean
  /** Pinned = trusted: always replaced without a hint round-trip, and first in line for the STT prompt. */
  pinned: boolean
  /** 'manual' = typed in the Learned tab; 'correction' = learned from a History fix. */
  source: 'manual' | 'correction'
  createdAt: string
  lastSeen: string
}

/** A mishearing → correction pair, as shown to the user right after a History fix. */
export interface LearnedPair {
  heardAs: string
  term: string
}

export interface FixHistoryResult {
  ok: boolean
  error?: string
  /** Pairs added to (or reinforced in) the lexicon by this fix. */
  learned: LearnedPair[]
  /** False when the fix was saved but learning is switched off in the Learned tab. */
  learning: boolean
}

/**
 * A candidate for the lexicon that Wispra found by reading the user's own History and Meeting
 * transcripts. Never applied on its own — it only becomes an entry when the user accepts it.
 *  - 'variant': a spelling that keeps turning up and looks like a mishearing of a term the user
 *               already keeps ("Cloud Code" ≈ "Claude Code")
 *  - 'term':    a name/brand that keeps turning up but is not in the user's word lists yet
 */
export type SuggestionKind = 'variant' | 'term'

export interface Suggestion {
  /** Stable across recomputations, so an ignored suggestion stays ignored. */
  id: string
  kind: SuggestionKind
  /** The spelling to keep ("Claude Code"). */
  term: string
  /** 'variant' only: the form found in the text ("Cloud Code"). */
  heardAs?: string
  /** How many times the found form (variant) or the term (term) occurs. */
  count: number
  /** In how many separate dictations/meetings it occurs. */
  sources: number
  /** A short piece of the user's own text around one occurrence. */
  example: string
}

/**
 * A term Wispra learned by itself from the user's History and meetings — no correction needed.
 * It is only ever offered to the speech recogniser as a spelling to prefer (never used to rewrite
 * text), and the user can keep it as one of their own words or remove it for good.
 */
export interface AutoTerm {
  /** "term:<lowercased term>" — the same ids as Suggestion, so removing one also hides the matching suggestion. */
  id: string
  /** The spelling to prefer ("Claude Code"). */
  term: string
  /** How many times it occurs (via 'seen') or was fixed this way (via 'fixed'). */
  count: number
  /** In how many separate dictations/meetings. */
  sources: number
  /**
   * 'seen'  — a name/brand that keeps turning up in what the user dictates
   * 'fixed' — the AI cleanup keeps changing a look-alike spelling into this one
   */
  via: 'seen' | 'fixed'
  /** 'fixed' only: the spelling that keeps being corrected ("Cloud"). */
  heardAs?: string
}

/**
 * One writing habit Wispra noticed in the user's own fixes (e.g. "drops the final full stop").
 * Habits are derived from History on demand — the user can only switch them on or off.
 */
export interface StyleHabit {
  /** Stable across recomputations ("no-final-stop", "drop:kiểu như"). */
  id: string
  /** The instruction given to the AI cleanup step. */
  text: string
  /** Why Wispra thinks so, in the user's terms ("Applied in 4 of 5 fixes"). */
  evidence: string
  enabled: boolean
}

/** What Wispra knows about how the user writes — shown in the Learned tab, all of it editable. */
export interface StyleProfile {
  /** The user's own description of their style; sent to the AI cleanup step as-is. */
  notes: string
  habits: StyleHabit[]
  /** How many of the user's own fixed dictations can be shown to the AI as examples. */
  exampleCount: number
}

/** Fix statistics for a group of dictations. `rate` = word edits per 100 dictated words (null while nothing was dictated). */
export interface EvalTotals {
  dictations: number
  words: number
  /** Dictations the user fixed at least once. */
  edited: number
  /** Words changed by the user's fixes. */
  edits: number
  rate: number | null
}

export interface EvalWeek extends EvalTotals {
  /** First day of the week (Monday), YYYY-MM-DD. */
  start: string
}

/** Is learning helping? Fewer fixes per 100 words over time, and with learning on vs off. */
export interface EvalReport {
  /** Oldest first; the last entry is the current week. */
  weeks: EvalWeek[]
  /** Dictations made while "Learn my words" was on / off. */
  on: EvalTotals
  off: EvalTotals
  all: EvalTotals
}

export interface HotkeyResult {
  ok: boolean
  /** Set when ok === false, e.g. the hotkey is taken by another app. */
  error?: string
}

export interface ApiKeyTestResult {
  ok: boolean
  error?: string
}

/** Wispra cloud account info (returned when user is signed in). */
export interface AccountInfo {
  email: string
  plan: 'free' | 'pro'
  /** Seconds used this month. */
  usageSeconds: number
  /** Monthly limit in seconds, or null if unlimited (Pro). */
  limitSeconds: number | null
  /** Polar.sh checkout URL for upgrading. */
  subscribeUrl: string | null
  /** Google profile photo URL. */
  avatarUrl?: string
  /**
   * This month's AI text allowance (dictation cleanup, summaries, content tabs, chat, mind
   * map) as the server reports it. Absent when the server does not send it yet.
   */
  aiTokensUsed?: number
  aiTokensLimit?: number
  /** ISO timestamp of the next reset. */
  aiTokensResetAt?: string
}

/**
 * The server said this month's Wispra Cloud AI text allowance is used up (HTTP 402,
 * code "ai_quota_exceeded" — see src/main/aiQuota.ts). Only ever set for Cloud users.
 */
export interface AiQuotaNotice {
  plan: 'free' | 'pro'
  limitTokens: number
  usedTokens: number
  /** ISO timestamp when the allowance resets. */
  resetAt: string
  /** When the app got this answer (ms since epoch) — lets a caller tell "my call just failed for this reason" from an older notice. */
  seenAt: number
}

/** Cloud sync state (see src/main/sync.ts) — surfaced in Settings > Account. */
export interface SyncStatus {
  enabled: boolean
  syncing: boolean
  /** ISO timestamp of the last successful sync, or null if never synced. */
  lastSyncedAt: string | null
  /** Message from the last failed attempt, or null if the last attempt succeeded (or none happened yet). */
  lastError: string | null
}

/**
 * Remote MCP connection link (see src/main/mcpLink.ts) — a secret URL, pasted as-is into
 * ChatGPT/Claude.ai/Grok/etc., that lets that client read this user's synced cloud data.
 * Unlike the reference "shown once" UX, Wispra persists the plaintext URL locally so the
 * user can come back and copy it again — surfaced in Settings > Account, masked by default.
 */
export interface McpLinkStatus {
  /** The full connection URL, or null if never generated (or revoked). */
  url: string | null
  createdAt: string | null
  lastUsedAt: string | null
  /** When this link stops working, or null if it never expires. Enforced server-side. */
  expiresAt: string | null
  /** Message from the last failed attempt to reach wispra-web, or null otherwise. */
  lastError: string | null
}

export interface UsageStats {
  totalDictations: number
  totalMinutes: number
  totalWords: number
  thisWeekDictations: number
  thisWeekMinutes: number
  streak: number
  mostActiveDay: string
}

export type FileTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

// ── Meeting mode (long-form continuous recording) ────────────────────────────
// Fully additive — separate from the short-dictate flow above (AppState, TranscriptEntry, etc).

/** Which audio to capture: microphone only, system/loopback audio only, or both mixed together. */
export type MeetingAudioSource = 'mic' | 'system' | 'both'

/**
 * Per-session language choices, picked once on the "Start recording" screen and
 * carried for the session's whole lifetime (content tabs read it back even when
 * generated long after the recording stopped). Each field is an ISO-639-1 code
 * from LANGUAGES in constants.ts, or "auto":
 * - input: STT hint for every audio chunk. "auto" lets Whisper detect per chunk
 *   instead of forcing one language — this is what fixes speaking English while
 *   the global Dictate language is pinned to Vietnamese (or vice versa).
 * - transcript: language the live transcript is displayed/saved in. "auto" =
 *   same as spoken (plain transcription, the default and cheapest path). Any
 *   other value runs each segment through a translation call after STT — e.g.
 *   speak English, read the transcript in Vietnamese.
 * - summary/website/facebook/instagram/linkedin/twitter: target language for
 *   that piece of AI-generated output. "auto" = same language as the transcript
 *   (the prior, only behavior). Independent per field — e.g. summary in
 *   Vietnamese while the Website article is generated in English.
 */
export interface MeetingLanguageConfig {
  input: string
  transcript: string
  summary: string
  website: string
  facebook: string
  instagram: string
  linkedin: string
  twitter: string
}

export type MeetingState = 'idle' | 'recording' | 'paused' | 'stopping' | 'error'

/** One paragraph of a meeting transcript, built from one or more transcribed audio chunks. */
export interface MeetingSegment {
  id: string
  text: string
  /** Milliseconds along the session's active (non-paused) timeline. */
  startMs: number
  endMs: number
  /** ISO wall-clock timestamp captured when this segment's audio started recording — shown to the user as "at 14:05". */
  startedAt: string
  /** True if this segment starts a new paragraph (word-count threshold or detected topic shift). */
  isNewParagraph: boolean
  topicLabel?: string
  /**
   * Who was talking, as far as the audio levels tell: 'me' = the microphone was clearly
   * louder, 'others' = the computer's audio was. Only set for audio recorded in "Both"
   * mode, and only when one side clearly dominated (see voiceOf in meeting/voice.ts).
   */
  voice?: 'me' | 'others'
}

export interface MeetingSession {
  id: string
  /** AI-generated short title (like ChatGPT auto-naming a conversation). Defaults to a date/time label until generated. */
  title: string
  /** AI-generated summary of the whole session, written once recording stops. Undefined until generation finishes (or if it fails, e.g. offline). */
  summary?: string
  /** ISO timestamp. */
  createdAt: string
  durationMs: number
  audioSource: MeetingAudioSource
  segments: MeetingSegment[]
  /** 'summarizing' = recording just stopped, title/summary generation in flight. */
  status: 'recording' | 'summarizing' | 'stopped'
  /** Ready-to-post content per platform, generated on demand (see generateMeetingContent in postprocess.ts) the first time the user opens that platform's tab. Undefined per-field until generated. */
  content?: MeetingContent
  /** Language choices picked on the "Start recording" screen. Undefined for sessions recorded before this field existed — treated the same as all-"auto". */
  languageConfig?: MeetingLanguageConfig
  /** Which space (see MeetingSpace) this session is filed under, if any. Undefined = unfiled, still shown under "All". */
  spaceId?: string
  /** Q&A chat with AI about this session's own transcript (see askMeetingChat in postprocess.ts) — works both while still recording and after Stop. Undefined = no chat yet, same "treated as absent" pattern as languageConfig/content. */
  chat?: MeetingChatMessage[]
  /** Topics, action items and speaker names for the Transcript tab's columns (see generateOutline in outline.ts), built right after Stop or the first time the session is opened, and cached here. Undefined until generated. */
  outline?: MeetingOutline
  /** Speaker names the user typed, by paragraph (the id of the paragraph's first segment). Wins over the outline's names; an empty string means "no name here". */
  speakerNames?: Record<string, string>
  /** Summary and Website / social posts written by a backup model (main model at its daily limit) — that model's name, per item. */
  backupModels?: Partial<Record<'summary' | ContentPlatform, string>>
  /** AI-generated mind map of the whole recording (see generateMindMap in mindMap.ts), built the first time the Mind map tab is opened and cached here. Undefined until generated. */
  mindMap?: MeetingMindMap
}

/**
 * What a main branch of a mind map holds: 'topic' branches follow the recording in
 * time order; the other three collect outcomes from the whole recording.
 */
export type MindMapBranchKind = 'topic' | 'decisions' | 'actions' | 'questions'

/** One node of a session's mind map — see MeetingMindMap. */
export interface MindMapNode {
  /** A few words, shown on the node. */
  label: string
  /** One or two sentences shown in the node's detail card. */
  note?: string
  /** First and last segment ids this node is about (inclusive range) — "Show in
   * transcript" highlights that stretch, same mechanism as MeetingChatMessage.
   * Both present or both absent — never just one. */
  startSegmentId?: string
  endSegmentId?: string
  /** Main branches only. */
  kind?: MindMapBranchKind
  /** Action items only, and only when the recording names them. */
  owner?: string
  due?: string
  children: MindMapNode[]
}

/**
 * Mind map of a finished meeting session. All of its text (title, labels, notes) is
 * written in `language`, which follows the session's "Website & social posts"
 * language choice — not the spoken language, and not the Summary language the
 * session title is written in (which is why the map carries its own centre title).
 */
export interface MeetingMindMap {
  /** Centre of the map. */
  title: string
  /** Some of the map was written by this backup model, after the main model reached its daily limit. */
  backupModel?: string
  note?: string
  /** Main branches: topics in time order, then Decisions / Action items / Open questions when the recording has them. */
  branches: MindMapNode[]
  /** ISO-639-1 code the map was written in, or "auto" (same language as the transcript). */
  language: string
  /** ISO timestamp. */
  generatedAt: string
}

/**
 * What the Transcript tab's columns are built from, besides the transcript itself. All
 * ranges are inclusive segment-id ranges, like MindMapNode's. Titles and action texts
 * are written in `language`, which follows the session's "Summary" language choice.
 */
export interface MeetingOutline {
  /** Some of it was written by this backup model, after the main model reached its daily limit. */
  backupModel?: string
  /** Sections of the transcript, in order, contiguous and covering all of it. */
  topics: Array<{ title: string; startSegmentId: string; endSegmentId: string }>
  /** Tasks stated in the recording, each pointing at the paragraph where it is said. Empty when there are none. */
  actions: Array<{ text: string; owner?: string; due?: string; startSegmentId: string; endSegmentId: string }>
  /** Who speaks where — only where the transcript itself says so (a self-introduction, or being introduced). */
  speakers: Array<{ name: string; startSegmentId: string; endSegmentId: string }>
  /** ISO-639-1 code the outline was written in, or "auto" (same language as the transcript). */
  language: string
  /** ISO timestamp. */
  generatedAt: string
  /**
   * Set while the outline is not finished: the paragraph (its first segment) where the
   * part still to be named begins. The topics above cover the transcript up to there
   * only. A recording in progress always has one (see liveOutline.ts); after Stop the
   * rest is named and this is removed — or kept, when that failed, until "Try again".
   */
  openFromSegmentId?: string
}

/** How naming the topics of a recording in progress is going (see liveOutline.ts). */
export interface LiveOutlineStatus {
  sessionId: string
  /** A finished part of the recording is being named right now. */
  working: boolean
  /** The provider's daily limit was reached: nothing more is named while this recording runs. */
  dailyLimit?: DailyLimitInfo
  /** Naming stopped for this recording after repeated failures; the rest is named after Stop. */
  failed?: boolean
  /** The backup model now answering, after the main model reached its daily limit. */
  backupModel?: string
}

/**
 * The AI provider's DAILY limit was reached (Groq: tokens or requests per day). Unlike the
 * per-minute limit it is not waited out — it can take hours — so the UI says so with the
 * numbers. See parseRateLimit in rateLimit.ts.
 */
export interface DailyLimitInfo {
  /** Groq counts tokens or requests per day; Cloudflare Workers AI counts "neurons". */
  unit: 'tokens' | 'requests' | 'neurons'
  used?: number
  limit?: number
  /** When the provider says it accepts requests again (ms since epoch). */
  resetAt: number
  /** The limit is Wispra Cloud's (its server's key), not the user's own key. */
  viaCloud: boolean
}

/** Progress of one mind map generation: a long recording is outlined part by part, then the parts are merged. */
export interface MindMapProgress {
  sessionId: string
  phase: 'outline' | 'merge'
  /** Parts outlined so far / parts in total. */
  done: number
  total: number
  /** Set while the run is holding back for the AI provider's per-minute limit: when it goes on (ms since epoch). */
  waitingUntil?: number
  /** Set when the run stopped at the provider's daily limit (mind map: with reason "daily-limit"; transcript outline: before it reports failure). */
  dailyLimit?: DailyLimitInfo
  /** The main model reached its daily limit and the run goes on with this backup (e.g. "Groq gpt-oss-20b"). */
  backupModel?: string
}

/**
 * Why a mind map job stopped without a map:
 * - interrupted: the app was closed while it ran
 * - time-limit: the whole run took longer than MIND_MAP_TOTAL_TIME_LIMIT_MS
 * - rate-limit: one part spent its whole time budget waiting for the provider's per-minute limit
 * - daily-limit: the provider's daily limit is reached — see dailyLimit on the status
 * - timeout: the provider did not answer in time
 * - offline: the provider could not be reached
 * - no-key: no API key / not signed in
 * - bad-answer: the AI's answer could not be used (broken or empty JSON), retries and smaller parts included
 * - refused: the provider rejected the request (bad key, no access)
 * - quota: Wispra Cloud's monthly AI allowance is used up (see aiQuota.ts)
 * - failed: anything else (server error, unusable answer)
 */
export type MindMapStopReason = 'interrupted' | 'time-limit' | 'rate-limit' | 'daily-limit' | 'timeout' | 'offline' | 'no-key' | 'bad-answer' | 'refused' | 'quota' | 'failed'

/**
 * A session's mind map job as the renderer sees it (see mindMapJobs.ts). The job runs in
 * the main process whatever the window shows; "stopped" keeps the parts already
 * outlined, so starting it again continues instead of starting over; "done" stays until
 * the user has opened the finished map.
 */
export interface MindMapJobStatus extends MindMapProgress {
  state: 'running' | 'stopped' | 'done'
  reason?: MindMapStopReason
  /** The provider's own words for the failure (short, may be empty). */
  detail?: string
  /** ISO timestamp of when this attempt started. */
  startedAt: string
}

/** Progress of one transcript outline generation — same shape as the mind map's. */
export type OutlineProgress = MindMapProgress

/**
 * One question/answer exchange in a session's chat with AI about its own transcript
 * — see askMeetingChat in postprocess.ts and the chat panel in meeting/App.tsx.
 */
export interface MeetingChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp. */
  createdAt: string
  /** First and last segment ids the answer is about (inclusive range), used to highlight
   * that stretch of the transcript. Both present or both absent — never just one. */
  startSegmentId?: string
  endSegmentId?: string
}

/**
 * A user-created grouping for meeting sessions (e.g. one per class/course), so the
 * sidebar can be filtered down to just that space's sessions instead of one flat
 * list. Purely organizational — deleting a space never deletes the sessions filed
 * under it, it just clears their spaceId back to unfiled (see meetingSpaces.ts).
 */
export interface MeetingSpace {
  id: string
  name: string
  /** ISO timestamp. */
  createdAt: string
}

/** Which platform's ready-to-post content to generate/show for a stopped meeting session. */
export type ContentPlatform = 'website' | 'facebook' | 'instagram' | 'linkedin' | 'twitter'

/**
 * A Website / social content request that hit the AI provider's per-minute limit (HTTP
 * 429): it waits and goes again at `waitingUntil` (ms since epoch), or — `rateLimited` —
 * it gave up because the limit was still reached after waiting (see generateMeetingContent).
 */
/** The Summary's request hit the provider's limit — same fields as MeetingContentStatus, for the title + summary. */
export interface MeetingSummaryStatus {
  sessionId: string
  waitingUntil?: number
  rateLimited?: boolean
  dailyLimit?: DailyLimitInfo
}

export interface MeetingContentStatus {
  sessionId: string
  platform: ContentPlatform
  waitingUntil?: number
  rateLimited?: boolean
  /** The request stopped at the provider's daily limit — not waited out. */
  dailyLimit?: DailyLimitInfo
}

/** Ready-to-post content generated from a meeting transcript, one field per platform. Cached on the session once generated so re-opening a tab doesn't re-call the LLM. */
export interface MeetingContent {
  /** SEO blog/website article — a single piece, not variants. */
  website?: { title: string; metaDescription: string; body: string }
  /** 3 distinct ready-to-post variants per platform (see CONTENT_PROMPTS in postprocess.ts for what each variant is). */
  facebook?: string[]
  instagram?: string[]
  linkedin?: string[]
  /** Internal key kept as "twitter" (the platform's long-standing name in code/APIs); shown to the user as "X". */
  twitter?: string[]
}

/** Result of one generateMeetingContent() call — tagged by platform since website's shape differs from the social platforms' variant-list shape. */
export type MeetingContentResult =
  | { platform: 'website'; title: string; metaDescription: string; body: string }
  | { platform: 'facebook' | 'instagram' | 'linkedin' | 'twitter'; posts: string[] }

/** Lightweight entry for the session list (sidebar) — avoids loading full segment text for every row. */
export interface MeetingSessionSummary {
  id: string
  title: string
  createdAt: string
  durationMs: number
  audioSource: MeetingAudioSource
  status: 'recording' | 'summarizing' | 'stopped'
  /** Which space this session is filed under, if any — see MeetingSpace. */
  spaceId?: string
}
