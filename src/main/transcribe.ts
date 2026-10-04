import {
  CLOUD_UPLOAD_MAX_BYTES,
  GROQ_API_BASE,
  GROQ_STT_MODEL,
  OPENAI_API_BASE,
  OPENAI_STT_MODEL,
  STT_PROMPT_MAX_TERMS,
  TRANSCRIBE_RETRIES,
  TRANSCRIBE_TIMEOUT_MS,
  WISPRA_API_BASE
} from '@shared/constants'
import type { ApiKeyTestResult, SttProvider } from '@shared/types'
import { providerMessage } from './rateLimit'
import { splitWav } from './wavSplit'

interface ProviderConfig {
  base: string
  model: string
  apiKey: string
}

interface VerboseSegment {
  text: string
  no_speech_prob: number
  /** Average log-probability the model assigned to its own tokens for this segment (0 = certain, very negative = guessing). */
  avg_logprob?: number
}

interface VerboseResponse {
  text?: string
  language?: string
  segments?: VerboseSegment[]
}

/** Discard segments where Whisper is >50% confident there is no real speech (hallucination guard). */
const NO_SPEECH_THRESHOLD = 0.5

/**
 * Discard segments the model itself was guessing at, independent of no_speech_prob. This is a
 * distinct failure mode from silence hallucination: there IS speech (no_speech_prob stays low),
 * but it was too unclear/mumbled/fast for Whisper to actually make out, so it fills the segment
 * with low-confidence noise — for Vietnamese this typically comes out as a run of bare initial
 * consonants with the vowels and tone marks guessed away ("C ph th nh t kh…"), never a real word.
 * -1.0 is the same default OpenAI's own reference Whisper implementation uses to flag a segment
 * as unreliable (`logprob_threshold` in whisper's transcribe.py).
 */
const LOW_CONFIDENCE_LOGPROB = -1.0

/** A segment is kept only if Whisper both thinks there's real speech AND was confident about the words it produced. */
function isReliableSegment(s: VerboseSegment): boolean {
  return s.no_speech_prob < NO_SPEECH_THRESHOLD && (s.avg_logprob === undefined || s.avg_logprob >= LOW_CONFIDENCE_LOGPROB)
}

/**
 * Phrases Whisper hallucinates from its training data (mostly YouTube outros) when
 * audio is near-silent or contains only ambient noise/trailing silence after real
 * speech. These appear even with low no_speech_prob because the model is
 * "confident" it heard something — but it's always wrong. Matched as a substring
 * against each individual SENTENCE (see filterKnownHallucinations below), not the
 * whole transcript, so one hallucinated sentence tacked onto real speech doesn't
 * wipe out the real part with it.
 */
const HALLUCINATION_PHRASES = [
  // English YouTube outros
  'like and subscribe',
  'like, share and subscribe',
  'like, comment and subscribe',
  'please like and subscribe',
  'please subscribe',
  "don't forget to subscribe",
  'subscribe to my channel',
  'thank you for watching',
  'thanks for watching',
  'see you in the next video',
  'see you next time',
  // Vietnamese YouTube outros — Whisper's Vietnamese training data is saturated
  // with these (e.g. "Ghiền Mì Gõ", a real VN YouTube channel that shows up as a
  // hallucination constantly, regardless of what the user actually watches).
  'cảm ơn các bạn đã theo dõi',
  'cảm ơn các bạn đã xem',
  'cảm ơn mọi người đã xem',
  'cảm ơn quý vị đã theo dõi',
  'cảm ơn bạn đã theo dõi',
  'hẹn gặp lại các bạn',
  'hẹn gặp lại trong video',
  'hẹn gặp lại ở video',
  'hãy subscribe',
  'nhớ subscribe',
  'nhớ like',
  'đăng ký kênh',
  'like và subscribe',
  'đừng quên đăng ký',
  'không bỏ lỡ những video',
  'không bỏ lỡ video',
  'video hấp dẫn',
  'ghiền mì gõ',
]

/**
 * Hallucinations that are only ever safe to drop when they are the WHOLE sentence — unlike
 * HALLUCINATION_PHRASES these are matched by equality, not substring, because each could
 * legitimately open a real sentence ("Kết thúc video này, chúng ta sẽ…"). Compared after
 * normalisation (lowercase, no end punctuation).
 */
const HALLUCINATION_SENTENCES = new Set(['kết thúc video'])

/**
 * Whisper's optional "prompt" field: only the user's names and terms, as a plain list
 * ("Sơn, Kima API, Wispra."), so the model recognises them while transcribing. Never a
 * sentence of instructions: Whisper reads the prompt as text that came before the audio,
 * and on silence or noise it writes that text out again as if it had been said — the
 * earlier prompts ("Đây là bản ghi âm tiếng Việt, có dấu…", "Các từ/tên riêng cần giữ
 * nguyên: …") came back in meetings and dictations as "Các từ và các nội dung cần giữ
 * nguyên." Nothing the speaker did not say may reach the text. The `language` field (sent
 * separately) already tells Whisper the language. Kept short — Whisper only attends to
 * roughly the last 224 tokens of it.
 */
export function buildSttPrompt(_language: string, vocabulary?: string[]): string | undefined {
  const terms = (vocabulary ?? []).map((t) => t.trim()).filter(Boolean).slice(0, STT_PROMPT_MAX_TERMS)
  return terms.length > 0 ? `${terms.join(', ')}.` : undefined
}

/**
 * Sentences earlier versions of the prompt were echoed as, in the forms Whisper wrote them
 * ("Các từ và các nội dung cần giữ nguyên.", "Đây là bản ghi âm tiếng Việt, có dấu đầy đủ…").
 * The prompt no longer contains them; these stay as a last net, matched as whole sentences.
 */
const OLD_PROMPT_ECHOES = [
  /^các từ\s.{0,60}cần giữ nguyên(?!\p{L})/u,
  /^đây là bản ghi âm tiếng việt(?!\p{L})/u,
  /^keep these terms spelled exactly(?!\p{L})/u
]

/**
 * A sentence that is nothing but terms from the prompt's list ("Kima API, Wispra.") — what
 * Whisper writes when it echoes a term list on silence. Needs at least two words.
 */
function isTermListEcho(sentence: string, promptTokens: Set<string>): boolean {
  if (promptTokens.size === 0) return false
  const words = wordTokens(sentence)
  return words.length >= 2 && words.every((w) => promptTokens.has(w))
}

/** Splits on sentence-ending punctuation or newlines, keeping each piece trimmed. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Words 4+ characters long, lowercased — short function words are skipped since they'd coincidentally overlap with plenty of unrelated real speech too. */
function distinctiveWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[.,!?:;"…]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4)
  )
}

/**
 * Catches a distinct Whisper failure mode from the one HALLUCINATION_PHRASES
 * targets: given the `prompt` param (buildSttPrompt) as prior "context",
 * unclear/near-silent audio sometimes makes the model just continue or
 * paraphrase that context instead of admitting it heard nothing, rather than
 * looping a training-data phrase. Caught the same way real plagiarism
 * detectors work — not an exact-substring match (the model paraphrases, it
 * doesn't quote), but a sentence that reuses most of the prompt's own
 * distinctive wording is never something a real speaker produces by
 * coincidence.
 */
function isPromptEcho(sentence: string, promptWords: Set<string>): boolean {
  if (promptWords.size === 0) return false
  const words = [...distinctiveWords(sentence)]
  if (words.length < 3) return false
  const overlap = words.filter((w) => promptWords.has(w)).length
  return overlap / words.length >= 0.5
}

/** Lowercased letter/digit tokens. Splits on "/" and punctuation too, so the prompt's "từ/tên" becomes "từ", "tên". */
function wordTokens(text: string): string[] {
  return text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Length of the longest common subsequence of two word lists (order-preserving, gaps allowed). */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Second prompt-echo check, for what isPromptEcho cannot see. That one only looks at words of
 * 4+ characters, but Vietnamese syllables are mostly 2–3 characters ("các từ … cần giữ nguyên"),
 * so a garbled echo of the prompt's vocabulary line — real case: the prompt says "Các từ/tên
 * riêng cần giữ nguyên: Github." and Whisper answered silence with "Các từ vài chữ khác cần giữ
 * nguyên." — slipped straight through.
 *
 * Here a sentence is an echo when it shares an ordered run of at least 4 words with ONE prompt
 * sentence AND that run makes up at least half of BOTH sentences. Requiring it of both sides is
 * what keeps real speech safe: "Đây là bản ghi âm cuộc họp hôm qua" opens like the prompt's first
 * sentence, but those 5 words are a small part of the 23-word prompt sentence, so it is kept.
 */
function isGarbledPromptEcho(sentence: string, promptSentences: string[][]): boolean {
  const words = wordTokens(sentence)
  if (words.length < 4) return false
  return promptSentences.some((prompt) => {
    if (prompt.length < 4) return false
    const common = lcsLength(words, prompt)
    return common >= 4 && common / words.length >= 0.5 && common / prompt.length >= 0.5
  })
}

/**
 * A word/syllable with no vowel at all, once diacritics are stripped, is a strong gibberish
 * signal: every Vietnamese syllable requires a vowel nucleus, and real English words are
 * essentially never vowel-less except a handful of capitalized acronyms/abbreviations
 * (exempted below). NFD-normalizing and stripping the combining marks turns any accented
 * Vietnamese vowel ("ừ", "ệ", "ượ"…) back into a plain a/e/i/o/u/y without having to
 * enumerate every precomposed character by hand.
 */
function looksLikeGibberishToken(token: string): boolean {
  if (!/^[\p{L}]+$/u.test(token)) return false
  if (token.length >= 2 && token === token.toUpperCase()) return false // acronym, e.g. "ALT", "CEO"
  const base = token.normalize('NFD').replace(/[̀-ͯ]/g, '')
  return !/[aeiouy]/i.test(base)
}

/** One whitespace-delimited chunk of a sentence, kept verbatim for reconstruction, plus whether its stripped form reads as gibberish. */
interface GibberishToken {
  raw: string
  isGibberish: boolean
}

function tokenizeForGibberish(sentence: string): GibberishToken[] {
  return sentence
    .normalize('NFC')
    .split(/\s+/)
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const stripped = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      const isGibberish = stripped.length > 0 && !/^\d+$/.test(stripped) && looksLikeGibberishToken(stripped)
      return { raw, isGibberish }
    })
}

/**
 * Catches a third Whisper failure mode, distinct from both isPromptEcho and the avg_logprob
 * check above: real speech that was too unclear for Whisper to actually make out, where the
 * model — instead of guessing a whole wrong word — fills the gap with the bare initial
 * consonant of each syllable and drops the vowel/tone entirely ("C n m l nh v th t th c th
 * terminal…"). Each individual fragment can still score a merely-average confidence (the model
 * is "sure" of the one letter it committed to), so this needs its own check independent of
 * avg_logprob.
 *
 * Built by GROWING RUNS from individually-flagged gibberish tokens, not a single whole-sentence
 * or windowed ratio. Real bug seen in production: Vietnamese dictation often runs long clauses
 * together with commas instead of full stops, so a garbled run tacked onto an otherwise-clean
 * clause ("...làm việc trong 1 của sổ màn hình thôi, L th nh Th lai t khi t m d c gi th di chuy c
 * terminal tr. Thay vì...") shares one punctuation-delimited "sentence" with a long real prefix —
 * a whole-sentence ratio gets diluted well under the threshold and the garbage survives
 * untouched. A naive sliding-window density check fixes that but overshoots the other way: a
 * window straddling the boundary between real and garbled text can cross the density threshold
 * while still covering a few real words at its edge, deleting them along with the garbage
 * (observed deleting "màn hình thôi," from the sentence above).
 *
 * Instead: start only from tokens individually flagged by looksLikeGibberishToken, and grow each
 * run by bridging across up to GIBBERISH_BRIDGE_GAP consecutive non-flagged tokens to the next
 * flagged one — this is what pulls in short vowel-bearing fragments sitting inside a garbled run
 * (e.g. "gi", "khi", "di" each contain a vowel and aren't individually flagged) without ever
 * extending past the first/last actually-flagged token in the run, so real text adjacent to the
 * run is never touched. A run only becomes a zone once it has accumulated at least
 * GIBBERISH_MIN_RUN individually-flagged tokens — real prose essentially never has that many
 * non-acronym vowel-less "words" clustered this close together.
 */
const GIBBERISH_BRIDGE_GAP = 2
const GIBBERISH_MIN_RUN = 4

function findGibberishZones(flags: boolean[]): boolean[] {
  const inZone = new Array<boolean>(flags.length).fill(false)
  let i = 0
  while (i < flags.length) {
    if (!flags[i]) {
      i++
      continue
    }
    let end = i
    let count = 1
    let j = i + 1
    while (j < flags.length) {
      if (flags[j]) {
        end = j
        count++
        j++
        continue
      }
      let k = j
      while (k < flags.length && !flags[k] && k - end <= GIBBERISH_BRIDGE_GAP) k++
      if (k < flags.length && flags[k]) {
        end = k
        count++
        j = k + 1
      } else {
        break
      }
    }
    if (count >= GIBBERISH_MIN_RUN) {
      for (let p = i; p <= end; p++) inZone[p] = true
    }
    i = end + 1
  }
  return inZone
}

/**
 * Strips any garbled run out of a sentence (see findGibberishZones) and returns what's left, or
 * '' if the whole sentence was garbled or too little real content survives to be worth keeping.
 * Punctuation/casing of surviving words is untouched — the AI cleanup pass (postprocess.ts)
 * re-punctuates whatever this leaves behind.
 */
function stripGibberish(sentence: string): string {
  const tokens = tokenizeForGibberish(sentence)
  const zones = findGibberishZones(tokens.map((t) => t.isGibberish))
  if (!zones.some(Boolean)) return sentence
  const cleaned = tokens
    .filter((_, i) => !zones[i])
    .map((t) => t.raw)
    .join(' ')
    .trim()
  return wordTokens(cleaned).length >= 2 ? cleaned : ''
}

/**
 * Drops sentences matching a known hallucination phrase or echoing the STT prompt itself, strips
 * out any bare-consonant-fragment run (see stripGibberish), and collapses a sentence repeated 3+
 * times verbatim — Whisper's other common failure mode on silence/noise is looping the same line
 * over and over regardless of wording.
 */
export function filterKnownHallucinations(text: string, sttPrompt?: string): string {
  const seen = new Map<string, number>()
  const kept: string[] = []
  const promptWords = sttPrompt ? distinctiveWords(sttPrompt) : new Set<string>()
  const promptSentences = sttPrompt ? splitSentences(sttPrompt).map(wordTokens) : []
  const promptTokens = new Set(sttPrompt ? wordTokens(sttPrompt) : [])

  for (const rawSentence of splitSentences(text)) {
    const sentence = stripGibberish(rawSentence)
    if (!sentence) continue
    const normalized = sentence.normalize('NFC').toLowerCase().replace(/[.,!?。，！？]+/g, '').trim()
    if (!normalized) continue
    if (HALLUCINATION_SENTENCES.has(normalized)) continue
    if (HALLUCINATION_PHRASES.some((p) => normalized.includes(p))) continue
    if (isPromptEcho(normalized, promptWords) || isGarbledPromptEcho(normalized, promptSentences)) continue
    if (isTermListEcho(normalized, promptTokens) || OLD_PROMPT_ECHOES.some((re) => re.test(normalized))) continue

    const count = (seen.get(normalized) ?? 0) + 1
    seen.set(normalized, count)
    if (count > 2) continue

    kept.push(sentence)
  }

  return kept.join(' ').trim()
}

function getConfig(
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  localBaseUrl: string,
  localSttModel: string
): ProviderConfig {
  if (provider === 'openai') return { base: OPENAI_API_BASE, model: OPENAI_STT_MODEL, apiKey: openaiKey }
  if (provider === 'local') return { base: localBaseUrl, model: localSttModel, apiKey: 'local' }
  return { base: GROQ_API_BASE, model: GROQ_STT_MODEL, apiKey: groqKey }
}

export interface TranscribeResult {
  text: string
  /** ISO 639-1 code detected by Whisper, e.g. "vi", "en". Undefined for local provider. */
  detectedLanguage?: string
}

export async function transcribe(
  audio: Uint8Array,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  language: string,
  mimeType = 'audio/webm',
  localBaseUrl = 'http://localhost:11434/v1',
  localSttModel = 'whisper',
  durationSeconds = 0,
  proxyToken?: string,
  vocabulary?: string[]
): Promise<TranscribeResult> {
  // Wispra cloud proxy provider
  if (provider === 'proxy') {
    if (!proxyToken) throw noRetry('Not signed in — open Account settings to log in')
    const token = proxyToken
    const once = async (part: Uint8Array, seconds: number): Promise<TranscribeResult> => {
      let lastError: Error = new Error('Transcription failed')
      for (let attempt = 0; attempt <= TRANSCRIBE_RETRIES; attempt++) {
        try {
          return await requestViaProxy(part, token, language, mimeType, seconds, vocabulary)
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (lastError.name === 'NoRetryError') throw lastError
        }
      }
      throw lastError
    }
    if (audio.length <= CLOUD_UPLOAD_MAX_BYTES) return once(audio, durationSeconds)
    // Too big for one request (Vercel's 4.5 MB): send it in parts, cut at pauses, and join the text.
    const parts = splitWav(audio, CLOUD_UPLOAD_MAX_BYTES)
    if (!parts) throw noRetry(tooLargeForCloud(audio.length))
    const texts: string[] = []
    let detectedLanguage: string | undefined
    for (const part of parts) {
      const result = await once(part.audio, part.seconds)
      if (result.text) texts.push(result.text)
      detectedLanguage ??= result.detectedLanguage
    }
    return { text: texts.join(' ').trim(), detectedLanguage }
  }

  const config = getConfig(provider, groqKey, openaiKey, localBaseUrl, localSttModel)
  if (provider !== 'local' && !config.apiKey) {
    const name = provider === 'openai' ? 'OpenAI' : 'Groq'
    throw new Error(`No ${name} API key set — open Settings and add your key`)
  }

  let lastError: Error = new Error('Transcription failed')
  for (let attempt = 0; attempt <= TRANSCRIBE_RETRIES; attempt++) {
    try {
      return await requestTranscription(audio, config, language, mimeType, vocabulary)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (lastError.name === 'NoRetryError') throw lastError
    }
  }
  throw lastError
}

async function requestViaProxy(
  audio: Uint8Array,
  token: string,
  language: string,
  mimeType: string,
  durationSeconds: number,
  vocabulary?: string[]
): Promise<TranscribeResult> {
  const ext = mimeToExt(mimeType)
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart], { type: mimeType }), `audio.${ext}`)
  form.append('model', GROQ_STT_MODEL)
  // verbose_json gives per-segment no_speech_prob so we can filter hallucinations
  form.append('response_format', 'verbose_json')
  if (language && language !== 'auto') form.append('language', language)
  // Note: only takes effect once the proxy backend (wispra-web) relays "prompt" to Groq.
  const sttPrompt = buildSttPrompt(language, vocabulary)
  if (sttPrompt) form.append('prompt', sttPrompt)

  let response: Response
  try {
    response = await fetch(`${WISPRA_API_BASE}/api/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // Only a length that is known: the server counts it toward the monthly minutes.
        ...(durationSeconds > 0 ? { 'X-Audio-Duration-Seconds': String(Math.ceil(durationSeconds)) } : {}),
      },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('Transcription timed out — check your connection')
    }
    throw new Error('Network error — check your connection')
  }

  if (!response.ok) {
    const detail = await safeErrorDetail(response)
    if (response.status === 401) throw noRetry('Session expired — sign in again in Account settings')
    if (response.status === 402) throw noRetry(detail || 'Monthly free limit reached — upgrade to Pro in Account settings')
    if (response.status === 413) throw noRetry(tooLargeForCloud(audio.length))
    throw new Error(detail ? `Wispra Cloud: ${detail}` : `Transcription failed (HTTP ${response.status})`)
  }

  const data = (await response.json()) as VerboseResponse
  const raw = data.language?.toLowerCase()
  const detectedLanguage = raw === 'vietnamese' ? 'vi' : raw === 'english' ? 'en' : raw

  // Filter silence/hallucination segments — same threshold as direct Groq path
  let text: string
  if (data.segments && data.segments.length > 0) {
    const speechSegments = data.segments.filter(isReliableSegment)
    text = speechSegments.map(s => s.text).join('').trim()
  } else {
    text = (data.text ?? '').trim()
  }

  // Block known Whisper training-data hallucinations (YouTube phrases etc.) and prompt-echo.
  text = filterKnownHallucinations(text, sttPrompt)

  return { text, detectedLanguage }
}

function mimeToExt(mime: string): string {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('webm')) return 'webm'
  return 'webm'
}

async function requestTranscription(
  audio: Uint8Array,
  config: ProviderConfig,
  language: string,
  mimeType: string,
  vocabulary?: string[]
): Promise<TranscribeResult> {
  const ext = mimeToExt(mimeType)
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart], { type: mimeType }), `audio.${ext}`)
  form.append('model', config.model)
  form.append('response_format', 'verbose_json')
  if (language && language !== 'auto') form.append('language', language)
  const sttPrompt = buildSttPrompt(language, vocabulary)
  if (sttPrompt) form.append('prompt', sttPrompt)

  let response: Response
  try {
    response = await fetch(`${config.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('Transcription timed out — check your connection')
    }
    throw new Error('Network error — check your connection')
  }

  if (!response.ok) {
    const detail = await safeErrorDetail(response)
    if (response.status === 401) throw noRetry('Invalid API key — check Settings')
    if (response.status === 413) throw noRetry('Recording too long — try a shorter dictation')
    if (response.status === 429) throw new Error('Rate limited — wait a moment and try again')
    throw new Error(detail || `Transcription failed (HTTP ${response.status})`)
  }

  const data = (await response.json()) as VerboseResponse
  const raw = data.language?.toLowerCase()
  const detectedLanguage = raw === 'vietnamese' ? 'vi' : raw === 'english' ? 'en' : raw

  // Filter out segments Whisper flagged as likely silence/hallucination
  let text: string
  if (data.segments && data.segments.length > 0) {
    const speechSegments = data.segments.filter(isReliableSegment)
    text = speechSegments.map(s => s.text).join('').trim()
  } else {
    text = (data.text ?? '').trim()
  }

  // Block known Whisper training-data hallucinations (YouTube phrases etc.) and prompt-echo.
  text = filterKnownHallucinations(text, sttPrompt)

  return { text, detectedLanguage }
}

export async function testApiKey(
  provider: SttProvider,
  apiKey: string,
  localBaseUrl?: string
): Promise<ApiKeyTestResult> {
  if (provider === 'local') {
    const base = localBaseUrl ?? 'http://localhost:11434/v1'
    try {
      const response = await fetch(`${base}/models`, {
        headers: { Authorization: 'Bearer local' },
        signal: AbortSignal.timeout(5_000)
      })
      if (response.ok) return { ok: true }
      return { ok: false, error: `Server responded with HTTP ${response.status}` }
    } catch {
      return { ok: false, error: 'Cannot connect — make sure your local server is running' }
    }
  }

  if (!apiKey) return { ok: false, error: 'API key is empty' }
  const base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, error: 'Invalid API key' }
    return { ok: false, error: `Unexpected response (HTTP ${response.status})` }
  } catch {
    return { ok: false, error: 'Network error — check your connection' }
  }
}

/** What the user is told when a recording cannot go to Wispra Cloud in one request. */
function tooLargeForCloud(bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1)
  return `This recording is too large for Wispra Cloud (${mb} MB; it accepts up to 4.5 MB per request). Dictate in shorter parts, or choose "Use my own Groq API key" on the Account tab.`
}

function noRetry(message: string): Error {
  const err = new Error(message)
  err.name = 'NoRetryError'
  return err
}

/**
 * The reason in an error answer, whatever its shape: {"error": {"message": "…"}} (Groq,
 * OpenAI), {"error": "…"} (Wispra Cloud, which may wrap Groq's own JSON in that string),
 * or plain text (Vercel's own errors, e.g. "Request Entity Too Large"). Null when empty.
 */
async function safeErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = await response.text()
    const message = providerMessage(body).trim()
    if (!message) return null
    // Plain-text pages: the first line is the reason ("Request Entity Too Large").
    return message.split('\n')[0].trim().slice(0, 300) || null
  } catch {
    return null
  }
}
