import { GROQ_API_BASE, LANGUAGES, OPENAI_API_BASE, WISPRA_API_BASE } from '@shared/constants'
import type { ContentPlatform, MeetingContentResult, Mode, SttProvider } from '@shared/types'

// Use capable models that handle Vietnamese diacritics correctly.
// llama-3.3-70b-versatile was retired by Groq (now 404s) — moved to gpt-oss-120b.
const GROQ_CHAT_MODEL = 'openai/gpt-oss-120b'
const OPENAI_CHAT_MODEL = 'gpt-4o-mini'
const TIMEOUT_MS = 30_000
const SUMMARY_TIMEOUT_MS = 30_000

const CRITICAL_RULES = `CRITICAL RULES:
- Return ONLY the corrected text. No explanation, no quotes, no preamble.
- NEVER remove content words or change the meaning.
- NEVER change the language.
- If the text is already correct, return it unchanged.`

const FILLER_INSTRUCTION = `- Remove filler words and sounds: "ừm", "ừ", "à", "ờ", "thì là", "ý là", "kiểu như", "kiểu", "như là", "đó là", "thì", "mà", "uh", "um", "erm", "like", "you know", "I mean", "so", "right", "basically", "literally", "actually" (only when used as meaningless fillers, not when they carry real meaning)`

function buildSystemPrompt(mode?: Mode, vocabulary?: string[], appContextHint?: string): string {
  const vocabLine =
    vocabulary && vocabulary.length > 0
      ? `- Preserve exact spelling of these proper nouns/terms: ${vocabulary.join(', ')}\n`
      : ''

  const contextLine = appContextHint
    ? `Context: ${appContextHint}\n\n`
    : ''

  if (mode?.prompt) {
    const extra = vocabLine ? `\n- ${vocabLine.trim()}` : ''
    return `${contextLine}${mode.prompt}${extra}\n\n${CRITICAL_RULES}`
  }

  const fillerLine = !mode || mode.removeFiller ? `${FILLER_INSTRUCTION}\n` : ''
  return `${contextLine}You are a transcription editor. Fix the raw speech-to-text output:
${fillerLine}${vocabLine}- Capitalize the first word of every sentence and all proper nouns (names of people, places, organizations)
- Add missing punctuation: period (.) at end of sentences, comma (,) between clauses and after introductory phrases, question mark (?) for questions
- Fix obvious spelling errors or misheard words
- Correct Vietnamese diacritics/tones if wrong

${CRITICAL_RULES}`
}

// Split long text into chunks to avoid LLM token limits
const MAX_CHUNK_WORDS = 350

function splitIntoChunks(text: string): string[] {
  const words = text.split(/\s+/)
  if (words.length <= MAX_CHUNK_WORDS) return [text]

  // Prefer splitting at sentence boundaries if present; fall back to word count
  const sentences = text.split(/(?<=[.!?…\n])\s+/)
  const hasSentenceBoundaries = sentences.length > 1

  if (hasSentenceBoundaries) {
    const chunks: string[] = []
    let current = ''
    let currentWords = 0
    for (const sentence of sentences) {
      const sw = sentence.split(/\s+/).length
      if (currentWords + sw > MAX_CHUNK_WORDS && current) {
        chunks.push(current.trim())
        current = sentence
        currentWords = sw
      } else {
        current = current ? `${current} ${sentence}` : sentence
        currentWords += sw
      }
    }
    if (current.trim()) chunks.push(current.trim())
    if (chunks.length > 0) return chunks
  }

  // Raw speech: no punctuation — split strictly by word count
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
    chunks.push(words.slice(i, i + MAX_CHUNK_WORDS).join(' '))
  }
  return chunks
}

export async function postProcess(
  text: string,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  mode?: Mode,
  vocabulary?: string[],
  localBaseUrl?: string,
  localLlmModel?: string,
  appContextHint?: string,
  proxyToken?: string
): Promise<string> {
  if (!text.trim()) return text

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else if (provider === 'proxy') {
    // Route through Wispra Cloud — uses server-side Groq key
    if (!proxyToken) return text
    apiKey = proxyToken
    base = `${WISPRA_API_BASE}/api`
    model = GROQ_CHAT_MODEL
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) return text
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }

  const systemPrompt = buildSystemPrompt(mode, vocabulary, appContextHint)

  // For long texts, process in parallel chunks to avoid token limit truncation
  const chunks = splitIntoChunks(text)
  const results = await Promise.all(chunks.map((chunk) => processChunk(chunk, base, apiKey, model, systemPrompt, provider === 'proxy')))
  return results.join(' ')
}

async function processChunk(
  text: string,
  base: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  isProxy: boolean
): Promise<string> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (isProxy) {
      headers['Authorization'] = `Bearer ${apiKey}`
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        max_tokens: 8192,
        temperature: 0
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    if (!response.ok) return text

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const result = data.choices?.[0]?.message?.content?.trim()
    if (!result) return text

    // Safety: if model returned near-empty or extremely long output, it likely failed
    const ratio = result.length / text.length
    if (ratio < 0.1 || ratio > 8) return text

    return result
  } catch {
    return text
  }
}

export async function summarizeTexts(
  texts: string[],
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  localBaseUrl?: string,
  localLlmModel?: string
): Promise<string> {
  const combined = texts.slice(0, 50).map((t, i) => `[${i + 1}] ${t}`).join('\n\n')

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) throw new Error('No API key configured — add one in Settings.')
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a productivity assistant. Summarize the following dictated notes into a clear, concise summary. Group related points. Preserve key details like names, dates, and numbers. Use bullet points where helpful. Return only the summary, no preamble.'
        },
        { role: 'user', content: combined }
      ],
      max_tokens: 1024,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
  })

  if (!response.ok) throw new Error(`AI error (HTTP ${response.status})`)
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const result = data.choices?.[0]?.message?.content?.trim()
  if (!result) throw new Error('Empty response from AI')
  return result
}

export interface MeetingTitleResult {
  title: string
  /** Empty string if the model returned a title but no usable summary. */
  summary: string
}

const MEETING_TITLE_TIMEOUT_MS = 30_000
// Very long meetings could blow the model's context window — cap what we send.
const MAX_TRANSCRIPT_CHARS = 20_000

/** Human-readable name for an ISO-639-1 code, for embedding in a prompt sentence. Falls back to the raw code if it's not in the known list. */
function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code
}

/**
 * Every title/summary/content prompt below defaults to "write in the SAME
 * language as the transcript" — the only behavior before per-session language
 * choices existed. When the user picks an explicit target language (anything
 * but "auto") on the Start-recording screen, swap that instruction for a fixed
 * one so the output language is decoupled from whatever language was spoken.
 */
function withTargetLanguage(prompt: string, targetLanguage: string | undefined): string {
  if (!targetLanguage || targetLanguage === 'auto') return prompt
  return prompt.replace('the SAME language as the transcript', languageName(targetLanguage))
}

/**
 * Some models occasionally double-escape newlines/tabs inside a JSON string
 * value (writing "\\n" instead of "\n"), which JSON.parse then decodes to a
 * literal two-character "\n" in the string instead of an actual line break —
 * visible to the user as raw "\n"/"\t" text sprinkled through the rendered
 * output and copy-to-clipboard text. Normalizes those back into real
 * newlines/tabs. Safe to run on already-clean text (no-op).
 */
function normalizeEscapes(text: string): string {
  return text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

const TRANSLATE_TIMEOUT_MS = 15_000

/**
 * A general chat LLM asked to "translate the following text" will sometimes, when
 * the input is empty/near-empty/garbled (e.g. a near-silent meeting-audio chunk that
 * still produced a scrap of low-confidence STT text), respond conversationally
 * instead — asking for the content to translate — rather than returning nothing.
 * That meta-response would otherwise get appended to the transcript as if it were
 * real translated speech. Matched against the RESPONSE only (never the user's own
 * source text, which legitimately can contain any of these words), in both
 * languages this proxy model is actually asked to translate into.
 */
const TRANSLATION_REFUSAL_MARKERS = [
  'cung cấp bản ghi',
  'cung cấp đoạn',
  'cung cấp nội dung',
  'vui lòng cung cấp',
  'bạn có thể cung cấp',
  'không có nội dung',
  'provide the transcript',
  'provide the text',
  'provide the audio',
  'provide the content',
  'please provide',
  'no text to translate',
  'no content to translate',
  'nothing to translate',
]

function looksLikeTranslationRefusal(result: string): boolean {
  const normalized = result.toLowerCase()
  return TRANSLATION_REFUSAL_MARKERS.some((m) => normalized.includes(m))
}

/**
 * Translates one already-transcribed meeting segment into a different language
 * than it was spoken in — used when the user picks a "Transcript" output
 * language different from "Spoken (input)" on the Start-recording screen.
 *
 * Deliberately a separate LLM call rather than trying to make Whisper's STT
 * step itself translate: Whisper's `language` param is only a decoding hint
 * for the audio it hears, not a translate-to instruction, so forcing it to a
 * language that doesn't match the audio produces unreliable/garbled text —
 * that mismatch was the original "spoke English, got Vietnamese" bug this
 * per-session language config replaced. A dedicated translation call after a
 * clean same-language transcription is slower and pricier than one Whisper
 * call, but it is the only reliable way to get an accurate different-language
 * transcript. Returns the original text on any failure or if translation
 * isn't supported for the given provider/config, so a network hiccup never
 * loses a segment.
 */
export async function translateSegment(
  text: string,
  targetLanguage: string,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  localBaseUrl?: string,
  localLlmModel?: string,
  proxyToken?: string
): Promise<string> {
  if (!text.trim()) return text

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else if (provider === 'proxy') {
    if (!proxyToken) return text
    apiKey = proxyToken
    base = `${WISPRA_API_BASE}/api`
    model = GROQ_CHAT_MODEL
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) return text
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }

  const systemPrompt = `Translate the following speech transcript into ${languageName(targetLanguage)}. Return ONLY the translated text — no explanation, no quotes, no preamble. Keep the same tone and meaning; keep proper nouns and technical terms as-is where translating them would be wrong or ambiguous.`

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        max_tokens: 2048,
        temperature: 0
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
    })
    if (!response.ok) return text

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const result = data.choices?.[0]?.message?.content?.trim()
    if (!result) return text
    if (looksLikeTranslationRefusal(result)) return text
    return result
  } catch {
    return text
  }
}

const MEETING_TITLE_PROMPT = `You are analyzing a meeting/voice-memo transcript. Read the whole thing and respond with ONLY a JSON object (no markdown, no code fences, no explanation) in this exact shape:
{"title": "...", "summary": "..."}

- "title": a short, specific, memorable title describing what the meeting was actually about — its topic or subject, not generic words like "Meeting" or "Recording". Keep it as tight as possible, ideally under 40 characters (roughly 3-6 words) — it is shown in a narrow sidebar and gets truncated if longer. Do NOT include any date or time in it, that is tracked separately.
- "summary": a well-structured write-up, like a short report with an opening, a body, and a closing — not one dense paragraph. Use this exact plain-text layout (it is rendered as-is, not as markdown):
  - One short opening sentence stating what the discussion was about.
  - A blank line, then the key points as a bulleted list, one point per line, each line starting with "- ".
  - A blank line, then one short closing sentence (outcome, decision, or next step) if the transcript supports one; omit it if there isn't one.
- Write both in the SAME language as the transcript.
- If the transcript is too short or unclear to summarize meaningfully, still produce your best-guess short title and a one-sentence summary (no bullets needed for a one-sentence summary).`

/**
 * Reads a finished meeting's full transcript and asks the LLM for a short topic
 * title + summary (one call covers both). Called once, after Stop, from
 * index.ts. Returns null on any failure (offline, no key/token, bad response)
 * so the caller can fall back to the existing default date/time title —
 * this must never throw and never block a session from reaching 'stopped'.
 */
export async function generateMeetingTitle(
  transcript: string,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  localBaseUrl?: string,
  localLlmModel?: string,
  proxyToken?: string,
  /** Target language for the summary, from the session's languageConfig.summary — "auto" or undefined mirrors the transcript's own language (prior behavior). */
  summaryLanguage?: string
): Promise<MeetingTitleResult | null> {
  const trimmed = transcript.trim()
  if (!trimmed) return null

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else if (provider === 'proxy') {
    if (!proxyToken) return null
    apiKey = proxyToken
    base = `${WISPRA_API_BASE}/api`
    model = GROQ_CHAT_MODEL
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) return null
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }

  // Long transcripts: the topic is usually established early and wrapped up at the
  // end, so sample both ends rather than truncating to just the beginning.
  const content =
    trimmed.length <= MAX_TRANSCRIPT_CHARS
      ? trimmed
      : `${trimmed.slice(0, MAX_TRANSCRIPT_CHARS / 2)}\n\n[...]\n\n${trimmed.slice(-MAX_TRANSCRIPT_CHARS / 2)}`

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: withTargetLanguage(MEETING_TITLE_PROMPT, summaryLanguage) },
          { role: 'user', content }
        ],
        // gpt-oss-120b spends a chunk of this budget on its own hidden reasoning
        // (returned separately in message.reasoning) before it writes the JSON
        // content — too low a cap here can starve the actual output. Bumped from
        // 1500: a long, dense transcript (e.g. a multi-hour class recording)
        // pushes the model toward more hidden reasoning and a longer summary,
        // and 1500 was observed to risk truncating the JSON mid-string, which
        // silently fails the whole title+summary call (see the JSON.parse
        // catch below) — bumped with margin, mirroring CONTENT_MAX_TOKENS below.
        max_tokens: 3000,
        temperature: 0.3,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(MEETING_TITLE_TIMEOUT_MS)
    })
    if (!response.ok) {
      console.error(`[meeting] title generation: HTTP ${response.status} — ${(await response.text().catch(() => '')).slice(0, 500)}`)
      return null
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = data.choices?.[0]?.message?.content?.trim()
    if (!raw) {
      console.error('[meeting] title generation: empty response content')
      return null
    }

    // Some models add a code fence around JSON despite instructions not to — strip it.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(cleaned) as { title?: string; summary?: string }
    const title = parsed.title?.trim()
    if (!title) {
      console.error('[meeting] title generation: response JSON had no title field')
      return null
    }
    return { title: normalizeEscapes(title), summary: normalizeEscapes(parsed.summary?.trim() || '') }
  } catch (err) {
    console.error('[meeting] title generation failed:', err)
    return null
  }
}

// ── Per-platform publish-ready content (Website / Facebook / Instagram / LinkedIn) ──
// Generated on demand (the first time the user opens that platform's tab), not
// automatically after every meeting — see generateMeetingContent below.

const ANTI_FABRICATION_RULE =
  '- Base everything only on what is actually said in the transcript. NEVER invent facts, numbers, statistics, quotes, or claims that are not present in it — if the transcript lacks specifics, stay general rather than making something up.'

// Longer outputs (esp. the website article) need more time than the title call.
const CONTENT_TIMEOUT_MS: Record<ContentPlatform, number> = {
  website: 60_000,
  facebook: 30_000,
  instagram: 30_000,
  linkedin: 40_000,
  twitter: 30_000
}

// gpt-oss-120b spends part of this budget on hidden reasoning before writing
// the visible JSON content (see generateMeetingTitle above) — sized generously
// for the website article, which can run 1200-2000 words plus a meta description
// and an FAQ section.
// Verified against the live API: the longer, more detailed 2026-best-practice
// prompts push gpt-oss-120b's hidden reasoning higher than before, and 2000
// tokens was observed to truncate before the JSON finished — bumped with margin.
const CONTENT_MAX_TOKENS: Record<ContentPlatform, number> = {
  website: 5000,
  facebook: 3000,
  instagram: 3000,
  linkedin: 3000,
  twitter: 2500
}

// Grounded in 2026 platform research (see project notes): ideal lengths, hook
// placement ahead of each platform's truncation point, and what drives reach
// on each platform today.
// Phrases that make AI-written copy read as generic/dry ("khô khan") — banned
// across every prompt below so output reads like it has a real voice.
const AI_SLOP_RULE =
  '- Never use generic AI-sounding filler: phrases like "in today\'s fast-paced world", "in the ever-evolving landscape of", "unlock the power of", "dive into"/"delve into", "it\'s important to note that", "in conclusion", "whether you\'re a beginner or an expert", or similar throat-clearing. Write like a specific, confident person — pull concrete details straight from the transcript, vary sentence length, and get to the point.'

const CONTENT_PROMPTS: Record<ContentPlatform, string> = {
  website: `You are a content strategist with 10+ years of hands-on SEO experience, writing in 2026 when search results blend classic organic ranking with AI Overviews and answer engines (AEO/GEO) — content earns visibility by directly answering real questions, not by keyword-stuffing. Turn the meeting/voice-memo transcript into a publish-ready blog/website article. Read the whole transcript and respond with ONLY a JSON object (no markdown, no code fences, no explanation) in this exact shape:
{"title": "...", "metaDescription": "...", "body": "..."}

- "title": an SEO title tag, 50-60 characters long, with the main topic/keyword appearing within the first 30-40 characters. Written to earn clicks, not just describe the topic — but never clickbait or exaggerate beyond what the transcript supports.
- "metaDescription": a meta description tag, 150-160 characters, that summarizes the specific value of the article and ends with a soft call to action — it must add information beyond the title, not just restate it, since it is what shows under the title in search results.
- "body": the full article as plain text (rendered as-is, not markdown), laid out like this:
  - A short intro paragraph (2-4 sentences) that hooks the reader with something specific from the transcript (a real detail, tension, or claim — not a generic opener) and states what the article covers. Answer the reader's core question in this intro rather than saving it for the end — 2026 search/AI-overview visibility rewards giving the answer up front, then backing it up.
  - A blank line, then a "## Key takeaways" section: 3-5 "- " bullet points, each a single self-contained sentence that could stand alone as a snippet answer.
  - A blank line, then the body split into further sections. Each section starts with a one-line heading on its own line prefixed with "## " (e.g. "## Why it matters"), followed by a blank line, then 2-4 sentences of paragraph text or a "- " bulleted list. Open each section by directly answering the question its heading implies, then elaborate. Leave a blank line between sections. Weave in related/secondary terms naturally where the transcript supports them — never force or repeat the exact keyword.
  - A blank line, then a "## FAQ" section with 2-4 "- " bullet points, each phrased as "Question? Answer." using only questions the transcript actually gives enough material to answer honestly.
  - A blank line, then a short closing paragraph with a takeaway or call to action.
  - Aim for roughly 1200-2000 words of substantive content when the transcript has enough material to support it (2026 SEO favors in-depth, search-intent-satisfying articles over hitting an exact word count) — but NEVER pad with repetition, filler, or fabricated content just to reach that length. A shorter, complete, accurate article beats a longer padded one.
- Every heading in the article — "Key takeaways", "FAQ", and every other "## " section heading — must be written in the same language as the rest of the article's body text. "Key takeaways", "Why it matters" and "FAQ" above are only English placeholder labels showing the format; translate them (and every heading you write) into that language. Never leave any heading in English while the body around it is in another language.
${ANTI_FABRICATION_RULE}
${AI_SLOP_RULE}
- Write in the SAME language as the transcript.`,

  facebook: `You are one of the top 1% Facebook copywriters — 10+ years writing viral, high-engagement native text posts — turning a meeting/voice-memo transcript into ready-to-post Facebook content. Follow 2026 Facebook mechanics: short personal-style posts under ~80 characters get the highest engagement rate; business posts' sweet spot is 150-250 characters; Facebook truncates behind "See More" around 477 characters on desktop (sooner on mobile), so the hook must land before that cutoff; leading with a question, a bold claim, or a pattern-interrupt line outperforms a slow windup; posts broken into short, scannable lines with blank lines between beats consistently out-engage a dense single paragraph. Read the whole transcript and respond with ONLY a JSON object (no markdown, no explanation):
{"posts": ["...", "...", "..."]}

Write exactly 3 distinct ready-to-post variants (plain post text only — no labels, no explanation, no "Version 1:" prefixes):
1. An ultra-short, punchy post (roughly 40-80 characters) — one sharp line that hooks attention on its own. A single line is correct here; don't pad it with extra lines.
2. A medium business-style post (roughly 150-250 characters) formatted as 2-3 short lines separated by blank lines: a bold hook line, then the key point, then a light call to action on its own line — never one dense paragraph.
3. A longer post (under 400 characters) shaped like a real high-performing Facebook post: a scroll-stopping hook line, a blank line, then 2-3 short lines of context (use a couple of "✅"/"👉"/"🔥"-prefixed lines instead of a paragraph when the content is naturally a list), a blank line, then a call to action or a question inviting comments, on its own line.
${ANTI_FABRICATION_RULE}
${AI_SLOP_RULE}
- Write in the SAME language as the transcript. Emoji are fine if they fit naturally; don't force them.`,

  instagram: `You are one of the top 1% Instagram caption writers — 10+ years turning ideas into scroll-stopping captions — turning a meeting/voice-memo transcript into ready-to-post Instagram captions. Follow 2026 Instagram mechanics: short punchy captions (under ~125 characters, the point where feed captions get cut to "more") tend to win on raw reach; medium storytelling captions (roughly 150-220 words) get the highest comment rates on carousel/educational posts; the key message must land before the "more" cutoff; hashtags should be just 3-5 highly relevant ones placed at the end, not long hashtag strings (the 2026 algorithm favors keywords woven into the caption text itself over hashtags). Read the whole transcript and respond with ONLY a JSON object (no markdown, no explanation):
{"posts": ["...", "...", "..."]}

Write exactly 3 distinct ready-to-post caption variants (plain caption text only — no labels, no explanation). Analyze and write these differently from Facebook — more visual/personal voice, short line breaks, hashtags at the end — not the same copy reused:
1. A short, punchy caption (under ~125 characters) with a strong hook, ending with 3-5 relevant hashtags.
2. A medium storytelling caption (roughly 150-220 words) using short line breaks between thoughts for readability, ending with a call to action then 3-5 relevant hashtags.
3. A quick-tip/list-style caption: a short hook line, then 3-4 short lines of value separated by line breaks (not "-" bullets), ending with a call to action then 3-5 relevant hashtags.
${ANTI_FABRICATION_RULE}
${AI_SLOP_RULE}
- Write in the SAME language as the transcript. Emoji are fine if they fit naturally; don't force them.`,

  linkedin: `You are one of the top 1% LinkedIn writers — 10+ years building reach and authority through native text posts — turning a meeting/voice-memo transcript into ready-to-post LinkedIn content. Follow 2026 LinkedIn mechanics: ideal length is 1200-2000 characters (roughly 200-330 words, a 60-90 second read); the hook must land within the first ~140 characters shown before the "see more" cutoff; posts broken into many short paragraphs (1-3 sentences each) consistently outperform dense blocks; simple, direct language beats jargon; hashtags are largely ignored by the 2026 algorithm and should be skipped or limited to 1-2 truly relevant ones at the very end, never a long list; ending with a genuine question invites replies and boosts reach. Read the whole transcript and respond with ONLY a JSON object (no markdown, no explanation):
{"posts": ["...", "...", "..."]}

Write exactly 3 distinct ready-to-post variants (plain post text only — no labels, no explanation), each following this structure: a hook line, a one-line value proposition, then the substance broken into short paragraphs (1-3 sentences each, separated by blank lines), ending with one clear call-to-action or question. Vary the angle across the 3 (e.g. a lesson learned, a specific insight, a behind-the-scenes take) rather than repeating the same opening.
${ANTI_FABRICATION_RULE}
${AI_SLOP_RULE}
- Write in the SAME language as the transcript. Keep language simple and direct; avoid corporate jargon.`,

  twitter: `You are one of the top 1% X (Twitter) writers — 10+ years turning ideas into high-reach posts — turning a meeting/voice-memo transcript into ready-to-post X content. Follow 2026 X mechanics: the algorithm weights replies and reposts far more than likes, so a post that invites a reply outperforms one that doesn't; the feed shows only the first line or two before "Show more", so the hook must be the very first sentence; hashtags now read as spammy and mostly hurt reach — use none, or at most one only if it is a real, specific term; a short thread (a numbered chain of short posts) remains the best format for building on one idea, with each post standing as a complete thought on its own. Read the whole transcript and respond with ONLY a JSON object (no markdown, no explanation):
{"posts": ["...", "...", "..."]}

Write exactly 3 distinct ready-to-post variants (plain post text only — no labels, no explanation):
1. A single punchy post (under 280 characters) — one sharp, standalone insight or claim from the discussion. No hashtags.
2. A single reply-bait post (under 280 characters) that opens with a bold or contrarian claim and ends with a direct, easy-to-answer question, designed to invite replies rather than just likes.
3. A short thread as one ready-to-post block: number each post "1/", "2/", "3/" etc. on its own line with a blank line between them — a hook post first, then 2-4 posts each carrying one specific point from the transcript (each under 250 characters so it stands alone as a real post), ending with a closing post that invites a reply or repost.
${ANTI_FABRICATION_RULE}
${AI_SLOP_RULE}
- Write in the SAME language as the transcript. Keep the voice direct and confident.`
}

/**
 * Reads a finished meeting's transcript and asks the LLM to write publish-ready
 * content for one platform (website article, or 3 social-post variants).
 * Generated on demand — called once per platform, the first time the user
 * opens that tab, then cached on the session (see setContent in
 * meetingSessions.ts). Returns null on any failure so the caller can show a
 * "couldn't generate, try again" state instead of throwing.
 */
export async function generateMeetingContent(
  platform: ContentPlatform,
  transcript: string,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  localBaseUrl?: string,
  localLlmModel?: string,
  proxyToken?: string,
  /** Target language for this platform, from the session's languageConfig[platform] — "auto" or undefined mirrors the transcript's own language (prior behavior). */
  targetLanguage?: string
): Promise<MeetingContentResult | null> {
  const trimmed = transcript.trim()
  if (!trimmed) return null

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else if (provider === 'proxy') {
    if (!proxyToken) return null
    apiKey = proxyToken
    base = `${WISPRA_API_BASE}/api`
    model = GROQ_CHAT_MODEL
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) return null
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }

  // Same long-transcript sampling strategy as generateMeetingTitle — the
  // discussion's substance is usually established early and wrapped up at the end.
  const content =
    trimmed.length <= MAX_TRANSCRIPT_CHARS
      ? trimmed
      : `${trimmed.slice(0, MAX_TRANSCRIPT_CHARS / 2)}\n\n[...]\n\n${trimmed.slice(-MAX_TRANSCRIPT_CHARS / 2)}`

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: withTargetLanguage(CONTENT_PROMPTS[platform], targetLanguage) },
          { role: 'user', content }
        ],
        max_tokens: CONTENT_MAX_TOKENS[platform],
        temperature: 0.5,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS[platform])
    })
    if (!response.ok) {
      console.error(`[meeting] ${platform} content generation: HTTP ${response.status} — ${(await response.text().catch(() => '')).slice(0, 500)}`)
      return null
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = data.choices?.[0]?.message?.content?.trim()
    if (!raw) {
      console.error(`[meeting] ${platform} content generation: empty response content`)
      return null
    }

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

    if (platform === 'website') {
      const parsed = JSON.parse(cleaned) as { title?: string; metaDescription?: string; body?: string }
      const title = parsed.title?.trim()
      const body = parsed.body?.trim()
      if (!title || !body) {
        console.error('[meeting] website content generation: response JSON missing title/body')
        return null
      }
      return {
        platform: 'website',
        title: normalizeEscapes(title),
        metaDescription: normalizeEscapes(parsed.metaDescription?.trim() ?? ''),
        body: normalizeEscapes(body)
      }
    }

    const parsed = JSON.parse(cleaned) as { posts?: string[] }
    const posts = (parsed.posts ?? []).map((p) => normalizeEscapes(p.trim())).filter(Boolean)
    if (posts.length === 0) {
      console.error(`[meeting] ${platform} content generation: response JSON had no posts`)
      return null
    }
    return { platform, posts }
  } catch (err) {
    console.error(`[meeting] ${platform} content generation failed:`, err)
    return null
  }
}
