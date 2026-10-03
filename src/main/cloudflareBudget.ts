import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/**
 * Keeps Wispra's use of Cloudflare Workers AI inside the FREE daily allocation, so an
 * account on the Workers Paid plan (where use past the allocation is billed) is never
 * charged because of Wispra.
 *
 * Cloudflare counts "neurons" per UTC day; 10,000 a day are free on both plans
 * (https://developers.cloudflare.com/workers-ai/platform/pricing/, viewed 2026-10-03).
 * For @cf/openai/gpt-oss-120b the same page prices 1,000,000 input tokens at 31,818
 * neurons and 1,000,000 output tokens at 68,182 neurons, so a request costs
 *
 *   neurons = prompt_tokens × 31,818 / 1,000,000 + completion_tokens × 68,182 / 1,000,000
 *
 * Before each request the most it can cost is reserved: its input estimated at one token
 * per 2 characters (on the high side — Vietnamese text takes more tokens per character than
 * English), plus its max_tokens of output. If that would take the day past the
 * allocation, the request is not sent and a daily-limit answer is returned instead (the
 * same wording Groq uses, so the rest of the app treats it like any daily limit). After an
 * answer, the cost is recomputed from the token counts Cloudflare reports in "usage"
 * (or estimated the same way when it reports none) and added to the day's total.
 *
 * This is an estimate of Cloudflare's own count, kept on this computer only: other apps
 * on the same Cloudflare account (other Workers) use the same allocation without Wispra
 * knowing, so it errs on the safe side — the limit Wispra stops at is a little below the
 * allocation.
 */

export const CLOUDFLARE_FREE_NEURONS_PER_DAY = 10_000
/** Wispra stops this far below the allocation: a margin for estimating and rounding. */
const SAFETY_MARGIN_NEURONS = 500
export const CLOUDFLARE_NEURONS_PER_INPUT_TOKEN = 31_818 / 1_000_000
export const CLOUDFLARE_NEURONS_PER_OUTPUT_TOKEN = 68_182 / 1_000_000
/** Characters per token when estimating — low on purpose, so estimates come out high. */
const CHARS_PER_TOKEN = 2

/** Workers AI's OpenAI-compatible endpoint (see cloudflareAiBase in constants.ts). */
export function isCloudflareAi(url: string): boolean {
  return /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai\//.test(url)
}

/** Neurons for a request's token counts on @cf/openai/gpt-oss-120b. */
export function neuronsFor(promptTokens: number, completionTokens: number): number {
  return promptTokens * CLOUDFLARE_NEURONS_PER_INPUT_TOKEN + completionTokens * CLOUDFLARE_NEURONS_PER_OUTPUT_TOKEN
}

interface DayCount {
  /** UTC day, "YYYY-MM-DD" — Cloudflare resets the allocation at 00:00 UTC. */
  day: string
  neurons: number
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function nextUtcMidnight(ms: number): number {
  const next = new Date(ms)
  next.setUTCHours(24, 0, 0, 0)
  return next.getTime()
}

/** "5h3m2s" — the form Groq writes its waits in, which parseRateLimit reads. */
function waitText(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`
}

export class CloudflareBudget {
  private count: DayCount | null = null

  constructor(
    /** Where the day's count is kept (survives a restart); none = in memory only. */
    private file?: string,
    private now: () => number = Date.now,
    private allocation = CLOUDFLARE_FREE_NEURONS_PER_DAY
  ) {}

  /** Neurons counted so far today (UTC). */
  usedToday(): number {
    const today = utcDay(this.now())
    if (!this.count && this.file) {
      try {
        this.count = JSON.parse(readFileSync(this.file, 'utf8')) as DayCount
      } catch {
        this.count = null
      }
    }
    if (!this.count || this.count.day !== today) this.count = { day: today, neurons: 0 }
    return this.count.neurons
  }

  /** The most neurons Wispra lets itself use today. */
  limit(): number {
    return this.allocation - SAFETY_MARGIN_NEURONS
  }

  private add(neurons: number): void {
    const used = this.usedToday()
    this.count = { day: utcDay(this.now()), neurons: used + neurons }
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.count))
    } catch (err) {
      console.error('[cloudflare] could not save the day\'s neuron count:', err)
    }
  }

  /** Sends a Workers AI request unless it could take the day past the free allocation; counts what it used. */
  async fetch(url: string, init: RequestInit, send: (url: string, init: RequestInit) => Promise<Response>): Promise<Response> {
    let body: { messages?: Array<{ content?: unknown }>; max_tokens?: number } = {}
    try {
      body = JSON.parse(String(init.body ?? '{}'))
    } catch {
      /* not a chat request — counted as input only */
    }
    const inputChars = (body.messages ?? []).reduce((n, m) => n + String(m.content ?? '').length, 0)
    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
    const reserve = neuronsFor(inputTokens, body.max_tokens ?? 4096)
    const used = this.usedToday()
    if (used + reserve > this.limit()) {
      const wait = waitText(nextUtcMidnight(this.now()) - this.now())
      const message = `Estimated daily free allocation reached for Cloudflare Workers AI (neurons per day): Limit ${CLOUDFLARE_FREE_NEURONS_PER_DAY}, Used ${Math.round(used)}. Wispra stops before the free allocation is used up, so a paid account is not charged. Please try again in ${wait}.`
      return new Response(JSON.stringify({ error: { message, code: 'wispra_cloudflare_daily_budget' } }), { status: 429 })
    }
    const response = await send(url, init)
    if (response.ok) {
      let prompt = inputTokens
      let completion = body.max_tokens ?? 0
      try {
        const data = (await response.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { content?: string } }> }
        if (typeof data.usage?.prompt_tokens === 'number') prompt = data.usage.prompt_tokens
        completion =
          typeof data.usage?.completion_tokens === 'number'
            ? data.usage.completion_tokens
            : Math.ceil(String(data.choices?.[0]?.message?.content ?? '').length / CHARS_PER_TOKEN)
      } catch {
        /* unreadable answer: counted at its reserve */
      }
      this.add(neuronsFor(prompt, completion))
    }
    return response
  }
}

/** The app's budget; index.ts points it at a file in the user data folder at startup. */
export let cloudflareBudget = new CloudflareBudget()

export function useCloudflareBudgetFile(file: string): void {
  cloudflareBudget = new CloudflareBudget(file)
}
