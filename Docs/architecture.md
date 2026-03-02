# Architecture

How the bot, runner, dashboard, and webhook components fit together.

---

## Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Runner System                         │
│                                                                     │
│  ┌──────────────┐    spawns   ┌────────────────────┐                │
│  │  Discord Bot │ ──────────> │  run-sessions.js   │                │
│  │  (client.js) │             │  Session Executor  │                │
│  │              │ <────────── │                    │                │
│  │  Slash       │   exit code │  Spawns Claude CLI │                │
│  │  Commands    │             │  per session       │                │
│  └──────┬───────┘             └────────┬───────────┘                │
│         │                              │                            │
│         │ HTTP                         │ stdin/stdout               │
│         v                              v                            │
│  ┌──────────────┐             ┌──────────────────┐                  │
│  │  Dashboard   │             │    Claude CLI    │                  │
│  │  (Express)   │             │    (external)    │                  │
│  │              │             │                  │                  │
│  │  REST API +  │             │  Reads CLAUDE.md │                  │
│  │  Static UI   │             │  + Session*.md   │                  │
│  └──────────────┘             │  Writes code     │                  │
│                               └──────────────────┘                  │
│                                                                     │
│  ┌──────────────────┐                                               │
│  │  discord-notify  │  Webhook notifications for all events         │
│  │  (stateless)     │  Called by both bot and runner                │
│  └──────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## File Roles

| File | Role | Runs as |
|---|---|---|
| `index.js` | Entry point — boots bot + dashboard | Main process |
| `bot/client.js` | Discord bot — slash commands, event routing | Part of main process |
| `bot/commands.js` | Slash command definitions (SlashCommandBuilder) | Imported by client.js |
| `bot/process.js` | Process management — spawn/kill runner and security fix | Imported by handlers |
| `bot/state.js` | Shared mutable state (running process refs, pause flag) | Imported everywhere |
| `bot/handlers/*.js` | One handler per command (~30 files) | Called by client.js |
| `bot/lib/*.js` | Shared utilities (paths, settings, parser, calculator) | Imported by handlers |
| `run-sessions.js` | Session executor — spawns Claude CLI, manages state | Child process |
| `discord-notify.js` | Stateless webhook client | Imported by both |
| `dashboard/server.js` | Express REST API + static file server | Part of main process |

---

## Data Flow

### 1. Session Execution

```
User: /start
  │
  v
client.js → handleStart() → process.js → startRunProcess()
  │
  │  spawn("node", ["run-sessions.js"])
  v
run-sessions.js
  │
  ├── loadState()           ← .progress.json
  ├── loadSessions()        ← Sessions/Session*.md
  ├── resolveClaudePath()   ← find claude binary
  │
  │  for each session:
  │    ├── buildCombinedPrompt()   ← CLAUDE.md + Session*.md
  │    ├── spawn(claude, [...])    ← pipe prompt via stdin
  │    ├── collect stdout/stderr   ← Claude writes code + reports
  │    ├── saveState()             ← mark session complete
  │    ├── notifySessionSuccess()  ← webhook to Discord
  │    └── sleep(pauseMinutes)     ← rate-limit buffer
  │
  └── exit(0) on success, exit(1) on failure
```

### 2. Webhook Notifications

```
run-sessions.js                    discord-notify.js
  │                                    │
  │  notifySessionStart({...})         │
  │  ──────────────────────────>       │
  │                                    ├── SHA-256 dedup check
  │                                    ├── Build Discord embed
  │                                    ├── POST to webhook URL
  │                                    ├── Retry with backoff (3x)
  │                                    └── Handle 429 rate limits
```

### 3. Dashboard API

```
Browser: http://localhost:3000
  │
  v
dashboard/server.js
  │
  ├── GET /api/status     → read .progress.json + state.js
  ├── GET /api/logs       → read latest Logs/run-*.log
  ├── GET /api/sessions   → parse Sessions/*.md + estimates
  ├── GET /api/settings   → load settings (tokens redacted)
  ├── GET /api/security   → scan Security/*.md reports
  ├── GET /api/rate-limit → query Claude CLI api-status
  ├── GET /api/git-changes → git status --porcelain
  └── POST /api/command/:name → trigger start/stop/pause/resume
```

---

## State Management

### .progress.json

The primary state file tracking run progress:

```json
{
  "completedSessions": ["Session1", "Session2"],
  "startedAt": "2026-03-01T10:00:00.000Z",
  "finishedAt": "2026-03-01T18:00:00.000Z",
  "sessionDetails": {
    "Session1": {
      "durationMs": 3600000,
      "completedAt": "2026-03-01T11:00:00.000Z",
      "exitCode": 0,
      "promptsCompleted": 4,
      "totalPrompts": 4,
      "tokenUsage": {},
      "success": true
    }
  },
  "promptCheckpoints": {
    "Session1": {
      "1": { "completedAt": "...", "elapsedMs": 600000, "outputFile": "..." }
    }
  }
}
```

State writes are atomic (write to `.tmp` then rename) to prevent corruption.

### bot/state.js

In-memory state for the bot process:

- `runningProcess` — reference to the spawned run-sessions.js process
- `securityFixProcess` — reference to the security fix Claude process
- `paused` — boolean flag with EventEmitter-based unpause signaling
- `scheduledTimer` — reference to a setTimeout for scheduled runs

---

## Directory Layout

```
Claude-discord-bot/          ← PROJECT_DIR
├── CLAUDE.md                ← Agent instructions (auto-generated)
├── .progress.json           ← Run state (auto-managed)
├── Sessions/                ← Your prompt files
├── Logs/                    ← Run output and logs
├── Security/                ← Security audit reports
├── Archive/                 ← Completed run snapshots
│
├── bot/                     ← Discord bot code
│   ├── settings.json        ← Configuration (not committed)
│   ├── client.js            ← Bot startup + command routing
│   ├── commands.js          ← Slash command definitions
│   ├── process.js           ← Process management
│   ├── state.js             ← Shared state
│   ├── handlers/            ← Command handlers (~30 files)
│   └── lib/                 ← Shared utilities
│
├── dashboard/               ← Web dashboard
│   ├── server.js            ← Express API
│   └── public/              ← Static frontend (HTML/CSS/JS)
│
├── run-sessions.js          ← Session executor (standalone)
├── discord-notify.js        ← Webhook notification client
├── index.js                 ← Entry point
└── package.json
```

Runtime data (`Sessions/`, `Logs/`, `Security/`, `Archive/`, `.progress.json`, `CLAUDE.md`) lives at the project root, not inside `bot/`.

---

## Cross-Platform Support

The system runs on both Windows and Unix:

| Feature | Windows | Unix |
|---|---|---|
| Claude binary lookup | `where.exe claude` | `which claude` |
| npm fallback path | `%APPDATA%\npm\claude.cmd` | `~/.npm-global/bin/claude` |
| Shell flag | `.cmd`/`.ps1` → `shell: true` | Always `shell: false` |
| Disk space check | `os.freemem()` fallback | `df` command |

---

## Security Model

- The bot runs locally on the user's machine — no external server
- Discord channel restriction is the primary access control
- `settings.json` stores credentials in plaintext — protect with file permissions
- `--dangerously-skip-permissions` is configurable via `runner.skipPermissions`
- The web dashboard has no authentication — localhost only by design
- Webhook notifications use SHA-256 deduplication to prevent spam
