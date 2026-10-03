/**
 * Single source of truth for ALL IPC channel names.
 * Never hardcode channel strings anywhere else.
 */
export const IPC = {
  // main -> overlay renderer
  STATE_CHANGED: 'state:changed',
  RECORDING_START: 'recording:start',
  RECORDING_STOP: 'recording:stop',

  // overlay renderer -> main
  AUDIO_CAPTURED: 'recording:audio-captured',
  RECORDING_FAILED: 'recording:failed',
  TOGGLE_DICTATION: 'dictation:toggle',
  OPEN_SETTINGS: 'settings:open',

  // settings renderer <-> main
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  SETTINGS_CHANGED: 'settings:changed',
  APPLY_HOTKEY: 'settings:apply-hotkey',
  TEST_API_KEY: 'settings:test-api-key',
  // renderer -> main: try a Cloudflare account id + API token on Workers AI before they are saved; resolves ApiKeyTestResult
  TEST_CLOUDFLARE: 'settings:test-cloudflare',
  GET_HISTORY: 'history:get',
  CLEAR_HISTORY: 'history:clear',
  HISTORY_CHANGED: 'history:changed',
  // renderer -> main: user fixed the text of a History entry; resolves FixHistoryResult
  // (which word corrections Wispra learned from it) — see lexicon.ts
  HISTORY_FIX: 'history:fix',
  COPY_TEXT: 'clipboard:copy',

  // personal lexicon (learned vocabulary) — Learned tab in Settings
  LEXICON_GET: 'lexicon:get',
  LEXICON_ADD: 'lexicon:add',
  LEXICON_UPDATE: 'lexicon:update',
  LEXICON_DELETE: 'lexicon:delete',
  LEXICON_RESET: 'lexicon:reset',
  // main -> settings renderer: the lexicon changed (learned from a fix, edited, reset)
  LEXICON_CHANGED: 'lexicon:changed',

  // suggestions mined from History/Meeting text (candidates only — the user accepts or ignores each)
  // renderer -> main: compute the current list; resolves Suggestion[]
  SUGGESTIONS_GET: 'suggestions:get',
  // renderer -> main: add suggestion `id` to the lexicon; resolves the refreshed Suggestion[]
  SUGGESTIONS_ACCEPT: 'suggestions:accept',
  // renderer -> main: never show suggestion `id` again; resolves the refreshed Suggestion[]
  SUGGESTIONS_DISMISS: 'suggestions:dismiss',

  // vocabulary Wispra learned by itself from History/Meetings (a spelling bias for the recogniser, never a rewrite)
  // renderer -> main: resolves AutoTerm[] (empty while learning or automatic learning is off)
  AUTOVOCAB_GET: 'autovocab:get',
  // renderer -> main: make term `id` one of the user's own words; resolves the refreshed AutoTerm[]
  AUTOVOCAB_KEEP: 'autovocab:keep',
  // renderer -> main: never learn term `id` again; resolves the refreshed AutoTerm[]
  AUTOVOCAB_REMOVE: 'autovocab:remove',

  // writing style learned from the user's fixes (Learned tab)
  // renderer -> main: resolves the StyleProfile (notes + detected habits + example count)
  STYLE_GET: 'style:get',
  // renderer -> main: save the user's own style notes; resolves the refreshed StyleProfile
  STYLE_SET_NOTES: 'style:set-notes',
  // renderer -> main: switch one detected habit on/off; resolves the refreshed StyleProfile
  STYLE_SET_HABIT: 'style:set-habit',
  // renderer -> main: clear notes and switch every habit back on; resolves the refreshed StyleProfile
  STYLE_RESET: 'style:reset',

  // is learning helping? fix statistics over time (Learned tab)
  // renderer -> main: resolves the EvalReport
  EVAL_GET: 'eval:get',
  // renderer -> main: forget the statistics; resolves the (empty) EvalReport
  EVAL_RESET: 'eval:reset',

  // auto-update
  UPDATE_STATUS: 'update:status',
  CHECK_UPDATE: 'update:check',
  INSTALL_UPDATE: 'update:install',

  // file transcription
  TRANSCRIBE_FILE: 'transcribe:file',
  PICK_FILE: 'transcribe:pick-file',

  // post-injection feedback
  INJECTION_DONE: 'injection:done',
  PREVIEW_TEXT: 'preview:text',

  // undo
  UNDO_INJECTION: 'injection:undo',

  // statistics & export
  GET_STATS: 'stats:get',
  EXPORT_HISTORY: 'history:export',
  SUMMARIZE_TOPIC: 'history:summarize-topic',

  // overlay sound
  PLAY_SOUND: 'overlay:play-sound',

  // continuous mode
  CONTINUOUS_NEXT: 'dictation:continuous-next',

  // silence auto-stop (separate from manual toggle so continuous mode is not cancelled)
  SILENCE_STOP: 'dictation:silence-stop',

  // overlay drag repositioning
  MOVE_OVERLAY: 'overlay:move',

  // app info
  GET_APP_VERSION: 'app:version',

  // cloud auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATE: 'auth:state',
  GET_ACCOUNT_INFO: 'auth:account-info',
  // Wispra Cloud's monthly AI text allowance (see src/main/aiQuota.ts)
  // renderer -> main: resolves the current AiQuotaNotice, or null
  GET_AI_QUOTA: 'ai-quota:get',
  // main -> renderers: the allowance was just found used up (AiQuotaNotice), or is available again (null)
  AI_QUOTA_CHANGED: 'ai-quota:changed',

  // cloud sync — opt-in push of History/Meetings/Lexicon to Supabase (see src/main/sync.ts)
  // renderer -> main: trigger an immediate sync; resolves once the attempt finishes (success or failure)
  SYNC_NOW: 'sync:now',
  // renderer -> main: resolves the current SyncStatus
  GET_SYNC_STATUS: 'sync:get-status',
  // main -> settings renderer: pushed after every sync attempt (success or failure)
  SYNC_STATUS_CHANGED: 'sync:status-changed',

  // remote MCP connection — secret link (see src/main/mcpLink.ts) that lets ChatGPT/Claude.ai/
  // Grok/etc. read this user's synced_* data from wispra-web's /api/mcp/[token] route
  // renderer -> main: resolves the current McpLinkStatus
  MCP_GET_LINK: 'mcp:get-link',
  // renderer -> main: generate (first time) or rotate (replace) the link; takes an optional
  // expiresInDays (number | null, null = never expires); resolves McpLinkStatus
  MCP_GENERATE_LINK: 'mcp:generate-link',
  // renderer -> main: revoke the link so it stops working; resolves McpLinkStatus
  MCP_REVOKE_LINK: 'mcp:revoke-link',

  // meeting mode (long-form continuous recording) — fully separate from the channels above
  // main -> settings renderer: switch the Settings window to the Meeting tab (e.g. from tray)
  MEETING_OPEN_TAB: 'meeting:open-tab',
  // renderer -> main: user pressed Start/Pause/Resume/Stop in the meeting window
  MEETING_START: 'meeting:start',
  MEETING_PAUSE: 'meeting:pause',
  MEETING_RESUME: 'meeting:resume',
  MEETING_STOP: 'meeting:stop',
  // renderer -> main: user pressed "Discard" (between Pause and Stop) — cancels the
  // current session without saving/summarizing it. See meetingSessions.discard().
  MEETING_DISCARD: 'meeting:discard',
  // main -> meeting renderer: command to actually start/pause/resume/stop the mic capture
  MEETING_CAPTURE_START: 'meeting:capture-start',
  MEETING_CAPTURE_PAUSE: 'meeting:capture-pause',
  MEETING_CAPTURE_RESUME: 'meeting:capture-resume',
  MEETING_CAPTURE_STOP: 'meeting:capture-stop',
  MEETING_STATE_CHANGED: 'meeting:state-changed',
  // main -> meeting renderer: recording was auto-stopped by the silence safety net
  // (MEETING_SILENCE_AUTO_STOP_MS with no real transcribed speech), not a manual Stop —
  // arrives right before MEETING_CAPTURE_STOP so the renderer can show why it stopped.
  MEETING_AUTO_STOPPED: 'meeting:auto-stopped',
  // renderer -> main: current state, queried on mount so re-opening the tab mid-meeting shows the right screen
  MEETING_GET_STATE: 'meeting:get-state',
  // renderer -> main: one silence/hard-cap-bounded audio chunk is ready (carries the audio bytes)
  MEETING_CHUNK_CAPTURED: 'meeting:chunk-captured',
  // renderer -> main: mic could not be opened
  MEETING_CAPTURE_FAILED: 'meeting:capture-failed',
  // main -> meeting renderer: a chunk finished transcribing and is ready to render
  MEETING_SEGMENT_READY: 'meeting:segment-ready',
  MEETING_GET_SESSIONS: 'meeting:get-sessions',
  MEETING_GET_SESSION: 'meeting:get-session',
  MEETING_DELETE_SESSION: 'meeting:delete-session',
  // renderer -> main: user renamed a session from the sidebar (kebab menu)
  MEETING_RENAME_SESSION: 'meeting:rename-session',
  // renderer -> main: user filed/unfiled a session into a space from the sidebar (kebab menu)
  MEETING_MOVE_SESSION_TO_SPACE: 'meeting:move-session-to-space',
  // spaces (user-created groupings for organizing sessions, e.g. one per class) —
  // see MeetingSpace in shared/types.ts and meetingSpaces.ts
  MEETING_GET_SPACES: 'meeting:get-spaces',
  MEETING_CREATE_SPACE: 'meeting:create-space',
  MEETING_RENAME_SPACE: 'meeting:rename-space',
  // Deleting a space never deletes its sessions — they fall back to unfiled ("All").
  MEETING_DELETE_SPACE: 'meeting:delete-space',
  MEETING_EXPORT: 'meeting:export',
  // renderer -> main: generate (or return the cached) ready-to-post content for
  // one platform of a stopped session — see generateMeetingContent in postprocess.ts
  MEETING_GENERATE_CONTENT: 'meeting:generate-content',
  // main -> settings renderer: a content request is waiting for the provider's per-minute
  // limit, or gave up because of it (MeetingContentStatus)
  MEETING_CONTENT_STATUS: 'meeting:content-status',
  // renderer -> main: user pressed "Try again" on a stopped session's Summary tab
  // after the automatic post-Stop title/summary generation failed — see
  // regenerateSessionSummary in main/index.ts. Resolves true/false; the actual
  // title/summary update (on success) arrives via MEETING_SESSION_UPDATED below.
  MEETING_GENERATE_SUMMARY: 'meeting:generate-summary',
  // main -> settings renderer: the summary request is waiting for the provider's per-minute
  // limit, gave up on it, or stopped at its daily limit (MeetingSummaryStatus)
  MEETING_SUMMARY_STATUS: 'meeting:summary-status',
  // renderer -> main: the last such status of a session's summary (MeetingSummaryStatus | null) —
  // a summary made right after Stop may have failed before the Summary tab was open
  MEETING_GET_SUMMARY_STATUS: 'meeting:get-summary-status',
  // main -> settings renderer: a session's title/summary/status changed (e.g. the
  // AI-generated title finished after Stop) — carries the full updated MeetingSession
  MEETING_SESSION_UPDATED: 'meeting:session-updated',
  // renderer -> main: user asked the in-session AI chat a question about the transcript
  // (works while still recording or after Stop) — see askMeetingChat in postprocess.ts.
  // Resolves the assistant's MeetingChatMessage, or null on failure (nothing persisted).
  MEETING_CHAT_SEND: 'meeting:chat-send',
  // renderer -> main: build (or return the cached) mind map of a stopped session — see
  // generateMindMap in mindMap.ts. Takes an optional { regenerate, language }: regenerate
  // rebuilds a map that already exists, in `language` when given. Resolves the
  // MeetingMindMap, or null on failure (the previous map, if any, is kept).
  MEETING_GENERATE_MIND_MAP: 'meeting:generate-mind-map',
  // main -> settings renderer: a mind map job started, moved on, stopped or finished
  // (MindMapJobStatus) — sent for every session, whatever the window is showing
  MEETING_MIND_MAP_PROGRESS: 'meeting:mind-map-progress',
  // renderer -> main: every mind map job that is running, stopped part-way or finished
  // but not yet looked at (MindMapJobStatus[]) — asked when the Meeting page mounts
  MEETING_GET_MIND_MAP_JOBS: 'meeting:get-mind-map-jobs',
  // renderer -> main: the user has seen this session's finished map; forget its "done" status
  MEETING_ACK_MIND_MAP: 'meeting:ack-mind-map',
  // renderer -> main: save the mind map's PNG export (bytes + suggested file name) through
  // a Save dialog; resolves { ok, error? }
  MEETING_SAVE_MIND_MAP_PNG: 'meeting:save-mind-map-png',
  // renderer -> main: build (or return the cached) transcript outline of a stopped session
  // — topics, action items, speaker names; see generateOutline in outline.ts. Takes an
  // optional { regenerate }. Resolves the MeetingOutline, or null on failure (the previous
  // outline, if any, is kept). The main process also builds it by itself right after Stop.
  MEETING_GENERATE_OUTLINE: 'meeting:generate-outline',
  // main -> settings renderer: how far an outline generation is (OutlineProgress)
  MEETING_OUTLINE_PROGRESS: 'meeting:outline-progress',
  // renderer -> main: the user typed speaker names — (sessionId, { paragraphId: name }),
  // merged into the session's speakerNames ('' = no name for that paragraph)
  MEETING_SET_SPEAKER_NAMES: 'meeting:set-speaker-names'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
