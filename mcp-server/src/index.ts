import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveUserDataPath } from './userDataPath'
import { readHistory } from './readers/history'
import { listMeetingSummaries, getMeeting, listAllMeetings } from './readers/meetings'
import { readLexicon } from './readers/vocabulary'
import { computeStats } from './stats'
import { lexiconMode } from './lexiconMode'

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  return Math.max(1, Math.min(value, max))
}

const server = new McpServer({
  name: 'wispra-mcp',
  version: '0.1.0'
})

const userDataPath = resolveUserDataPath()

server.registerTool(
  'get_usage_stats',
  {
    description:
      'Get the local dictation usage stats: total dictations, total minutes, total words, this week\'s counts, current streak, and most active day.'
  },
  async () => {
    const stats = computeStats(readHistory(userDataPath))
    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }]
    }
  }
)

server.registerTool(
  'list_meetings',
  {
    description: 'List recent meeting sessions (title, date, duration, status), newest first.',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Max sessions to return (default 20, max 50)')
    }
  },
  async ({ limit }: { limit?: number }) => {
    const summaries = listMeetingSummaries(userDataPath).slice(0, clamp(limit, 20, 50))
    return { content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }] }
  }
)

server.registerTool(
  'get_meeting',
  {
    description: 'Get one meeting session in full, including its transcript segments.',
    inputSchema: {
      id: z.string().describe('The meeting session id')
    }
  },
  async ({ id }: { id: string }) => {
    const session = getMeeting(userDataPath, id)
    if (!session) {
      return { content: [{ type: 'text', text: `No meeting found with id "${id}".` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] }
  }
)

server.registerTool(
  'search_meetings',
  {
    description: 'Search meeting sessions by title, summary, or transcript text. Case-insensitive substring match.',
    inputSchema: {
      query: z.string().describe('Text to search for'),
      limit: z.number().int().positive().optional().describe('Max sessions to return (default 10, max 30)')
    }
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    const needle = query.toLowerCase()
    const matches = listAllMeetings(userDataPath)
      .filter((session) => {
        if (session.title.toLowerCase().includes(needle)) return true
        if (session.summary?.toLowerCase().includes(needle)) return true
        return session.segments.some((seg) => seg.text.toLowerCase().includes(needle))
      })
      .slice(0, clamp(limit, 10, 30))
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        durationMs: session.durationMs,
        status: session.status,
        summary: session.summary
      }))
    return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] }
  }
)

server.registerTool(
  'search_history',
  {
    description:
      'Search dictation history by transcript text. Case-insensitive substring match against both the final text and the raw (pre-cleanup) text, newest first.',
    inputSchema: {
      query: z.string().describe('Text to search for'),
      limit: z.number().int().positive().optional().describe('Max entries to return (default 20, max 50)')
    }
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    const needle = query.toLowerCase()
    const matches = readHistory(userDataPath)
      .filter((entry) => {
        if (entry.text.toLowerCase().includes(needle)) return true
        return entry.rawText?.toLowerCase().includes(needle) ?? false
      })
      .slice(0, clamp(limit, 20, 50))
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        createdAt: entry.createdAt,
        app: entry.app,
        topic: entry.topic
      }))
    return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] }
  }
)

server.registerTool(
  'get_history_entry',
  {
    description: 'Get one dictation history entry in full by id.',
    inputSchema: {
      id: z.string().describe('The history entry id')
    }
  },
  async ({ id }: { id: string }) => {
    const entry = readHistory(userDataPath).find((e) => e.id === id)
    if (!entry) {
      return { content: [{ type: 'text', text: `No history entry found with id "${id}".` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] }
  }
)

server.registerTool(
  'get_vocabulary',
  {
    description:
      "Get the user's confirmed vocabulary (the Learned tab's lexicon): custom terms and corrected mishearings, each labeled with its mode (replace/hint/spelling/off). Does not include auto-learned/unconfirmed vocabulary."
  },
  async () => {
    const entries = readLexicon(userDataPath).map((e) => ({
      term: e.term,
      heardAs: e.heardAs,
      mode: lexiconMode(e),
      count: e.count,
      pinned: e.pinned,
      source: e.source,
      lastSeen: e.lastSeen
    }))
    return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] }
  }
)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('[wispra-mcp] fatal error:', error)
  process.exit(1)
})
