# wispra-mcp

A local [MCP](https://modelcontextprotocol.io) server that exposes **read-only** access to the data
Wispra (the [Wispra](../) dictation app) already stores on your machine: dictation history, meeting
sessions, your confirmed vocabulary, and usage stats. It talks to MCP clients over stdio — no
network, no cloud, nothing leaves your machine.

It has no write or delete tools, never triggers a recording, and never changes any Wispra setting —
it only reads the same local JSON files the desktop app writes to.

## Build

```bash
cd mcp-server
npm install
npm run build
```

This compiles `src/` to `dist/index.js` (plain CommonJS, run with `node`).

## Configure your MCP client

The server is a single executable: `node <path-to-repo>/mcp-server/dist/index.js`.

### Claude Code

Project-scoped config (already present at the repo root as `.mcp.json`):

```json
{
  "mcpServers": {
    "wispra": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"]
    }
  }
}
```

Restart your Claude Code session (or run `/mcp`) to pick it up.

### Cursor

Add to `~/.cursor/mcp.json` (or a project-local `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "wispra": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/mcp-server/dist/index.js"]
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.wispra]
command = "node"
args = ["<absolute-path-to-repo>/mcp-server/dist/index.js"]
```

## Tools

| Tool | Input | Returns |
|---|---|---|
| `get_usage_stats` | — | Total dictations, minutes, words, this week's counts, streak, most active day |
| `list_meetings` | `limit?` (default 20, max 50) | Recent meeting sessions (title, date, duration, status), newest first |
| `get_meeting` | `id` | One meeting session in full, including transcript segments |
| `search_meetings` | `query`, `limit?` (default 10, max 30) | Meetings matching the query in title, summary, or transcript text |
| `search_history` | `query`, `limit?` (default 20, max 50) | Dictation history entries matching the query, newest first |
| `get_history_entry` | `id` | One dictation history entry in full |
| `get_vocabulary` | — | Your confirmed lexicon (Learned tab), each term labeled `replace`/`hint`/`spelling`/`off` |

All list/search results are capped and sorted newest-first — no tool ever dumps the full dataset.
`get_vocabulary` reads only the confirmed lexicon (`learning/lexicon.json`); it never includes
auto-learned/unconfirmed vocabulary.

## Data location

By default the server auto-detects Wispra's `userData` directory for your OS (matching Electron's
`app.getPath('userData')`):

- Windows: `%APPDATA%\wispra`
- macOS: `~/Library/Application Support/wispra`
- Linux: `$XDG_CONFIG_HOME/wispra` or `~/.config/wispra`

Override it with the `WISPRA_USERDATA_DIR` environment variable if your setup is non-standard, e.g.
in a client config:

```json
{
  "mcpServers": {
    "wispra": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": { "WISPRA_USERDATA_DIR": "/custom/path/to/wispra" }
    }
  }
}
```
