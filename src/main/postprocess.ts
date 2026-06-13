import { GROQ_API_BASE, OPENAI_API_BASE } from '@shared/constants'
import type { SttProvider } from '@shared/types'

const GROQ_CHAT_MODEL = 'llama-3.1-8b-instant'
const OPENAI_CHAT_MODEL = 'gpt-4o-mini'
const TIMEOUT_MS = 15_000

const SYSTEM_PROMPT = `You are a transcription editor. The input is raw speech-to-text output that may have:
- Missing or wrong punctuation (periods, commas, question marks, exclamation marks)
- Spelling errors or misheard words
- Missing Vietnamese diacritics or wrong tones

Your job: return the corrected text ONLY. No explanation, no quotes, no preamble. Keep the original language exactly.`

export async function postProcess(
  text: string,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string
): Promise<string> {
  if (!text.trim()) return text

  const apiKey = provider === 'openai' ? openaiKey : groqKey
  if (!apiKey) return text

  const base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
  const model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text }
        ],
        max_tokens: 4096,
        temperature: 0
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    if (!response.ok) return text

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const result = data.choices?.[0]?.message?.content?.trim()
    return result || text
  } catch {
    return text // always fall back to original on any error
  }
}
