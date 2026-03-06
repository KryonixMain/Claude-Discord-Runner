# Claude Runner

Automated multi-session executor for Claude CLI, controlled via Discord bot and web dashboard.

### Documentation

| Document | Description |
|---|---|
| [Getting Started](Docs/getting-started.md) | Step-by-step setup guide |
| [Architecture](Docs/architecture.md) | How components fit together |
| [Configuration](Docs/configuration.md) | Every setting documented |
| [Session Format](Docs/session-format.md) | Override block, prompt headers, dependency syntax |
| [Changelog](CHANGELOG.md) | Release history |

***

## Overview

Claude Runner is a Node.js automation system that executes a series of Claude CLI sessions sequentially, unattended. You write structured `Session*.md` files containing prompts, issue `/start` in Discord, and the runner works through all sessions automatically — pausing between them to respect rate limits, running a security fix pass at the end, and archiving all output.

**Architecture:**

| File | Role |
|---|---|
| `run-sessions.js` | Session executor — spawns Claude CLI, manages state, sends webhook notifications |
| `bot/client.js` | Discord slash-command bot — starts, stops, and monitors the runner |
| `discord-notify.js` | Stateless webhook client — pushes status messages to Discord |
| `dashboard/server.js` | Express web dashboard — live status page with command buttons |
| `index.js` | Entry point — boots bot + dashboard together |

***

## Prerequisites

- **Node.js 18+**
- **Claude CLI** installed globally:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
- **Active Claude subscription** — Pro ($20/mo), Max 5x ($100/mo), or Max 20x ($200/mo)
- **Discord application** with a bot token and webhook URL

### Claude CLI Resolution

The runner searches for the Claude binary in this order:

**Windows:**
1. **`where.exe claude`** — finds `claude.exe` or `claude.cmd` on PATH
2. **npm global prefix** — `npm config get prefix` → `<prefix>/claude.cmd`
3. **`%APPDATA%\npm\claude.cmd`** — Windows npm fallback
4. **`claude`** — bare command with `shell: true` (last resort)

**Unix (macOS/Linux):**
1. **`which claude`** — finds claude on PATH
2. **npm global prefix** — `npm config get prefix` → `<prefix>/bin/claude`
3. **Common paths** — `~/.npm-global/bin/claude`, `~/.local/bin/claude`, `/usr/local/bin/claude`
4. **`claude`** — bare command with `shell: true` (last resort)

If you have both `claude.exe` (standalone) and `claude` (npm), the standalone `.exe` is preferred because it avoids npm's shell wrapper overhead.

***

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

Create or edit `bot/settings.json`:

```json
{
  "bot": {
    "token": "YOUR_BOT_TOKEN",
    "clientId": "YOUR_CLIENT_ID",
    "channelId": "YOUR_CHANNEL_ID",
    "guildId": "",
    "webhookUrl": "YOUR_WEBHOOK_URL"
  },
  "runner": {
    "claudePlan": "max20",
    "workDir": "F:/path/to/your/project"
  }
}
```

Or set environment variables (take priority over settings.json):

```
DISCORD_BOT_TOKEN
DISCORD_CLIENT_ID
DISCORD_CHANNEL_ID
DISCORD_WEBHOOK_URL
```

### 3. Start the bot

```bash
node index.js
```

This boots both the Discord bot and the web dashboard. The bot registers slash commands (guild-scoped for instant sync) and the dashboard starts on the configured port.

### 4. Run `/setup` in Discord

```
/setup plan:Max 20x
```

This creates all required directories, a default `CLAUDE.md` with agent instructions and your working directory, a `Session1.md` template, and writes calculated timeout values based on your plan's token budget.

### 5. Write your session files

Edit `Sessions/Session1.md` with your prompts, then:

```
/validate-sessions
/start
```

***

## Directory Structure

```
Claude-discord-bot/             ← project root
├── index.js                    ← entry point (bot + dashboard)
├── run-sessions.js             ← session executor
├── discord-notify.js           ← webhook notification client
├── package.json
├── CHANGELOG.md
│
├── Docs/                       ← documentation
│   ├── getting-started.md
│   ├── architecture.md
│   ├── configuration.md
│   └── session-format.md
│
├── bot/                        ← Discord bot
│   ├── client.js               ← bot startup, command routing
│   ├── commands.js              ← slash command definitions
│   ├── process.js               ← process management (start/stop)
│   ├── state.js                 ← shared mutable state
│   ├── settings.json            ← configuration (not committed to git)
│   ├── handlers/                ← one file per command
│   └── lib/                     ← shared utilities
│       ├── plans.js             ← plan definitions, defaults, constants
│       ├── calculator.js        ← token/timeout math
│       ├── session-parser.js    ← parse prompts from .md files
│       ├── session-validator.js ← pre-run validation
│       ├── session-setup.js     ← directory/template creation
│       ├── settings.js          ← load/save config
│       ├── helpers.js           ← utilities
│       ├── paths.js             ← canonical path constants
│       ├── archive.js           ← archive/prune logic
│       └── claude-md-template.txt
│
├── dashboard/                   ← web dashboard
│   ├── server.js                ← Express API server
│   └── public/                  ← static frontend
│       ├── index.html
│       ├── style.css
│       └── app.js
│
├── CLAUDE.md                    ← global agent context (auto-generated)
├── .progress.json               ← run state (auto-managed)
│
├── Sessions/                    ← your prompt files
│   ├── Session1.md
│   └── Session2.md
├── Logs/                        ← run output and log files
├── Security/                    ← security reports
└── Archive/                     ← completed runs
    └── run-2026-03-01T10-30-00/
        ├── Logs/
        ├── Security/
        ├── Sessions/            ← snapshot of prompts used
        └── progress-*.json
```

***

## Working Directory (workDir)

By default, Claude operates in the project root (one level above `bot/`). If your bot and target project live in different locations, configure `runner.workDir`:

```json
{
  "runner": {
    "workDir": "F:/my-actual-project"
  }
}
```

When set:
- Claude's `cwd` and `--add-dir` point to your workDir
- `CLAUDE.md` includes a "Working Directory" section instructing Claude to target that path
- The setting is auto-populated on first `/setup` if empty
- Can be overridden per-run via `CLAUDE_WORK_DIR` environment variable

***

## Session File Format

### Basic Structure

```markdown
# Session 1 — Task Overview

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: `### PROMPT X COMPLETED`

---

## Prompt 1 — Implement user authentication

[FULLSTACK]

Create the login page component...

**Completion checklist:**
- [ ] Login component created at src/components/Login.tsx
- [ ] API route at src/routes/auth.ts
- [ ] Tests in src/components/Login.test.ts

---

## Prompt 2 — Create users table

[DATABASE]

Write the migration...

---

## Prompt 3 — Security audit

[SECURITY]

Review all files created in this session...

---

## Prompt 4 — Session summary

[MANAGER]

Review session output for completeness...

---
```

### Override Block (Optional)

Place at the very top of the file to control per-prompt model, turns, and timeout:

```markdown
<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 3600000,
    "defaultModel": "claude-opus-4-6"
  },
  "prompts": {
    "1": { "model": "claude-opus-4-6", "maxTurns": 80, "timeoutMs": 7200000 },
    "2": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 1800000 }
  }
}
-->
```

This block is stripped before sending to Claude. It only configures the CLI invocation.

### Validation Rules

Run `/validate-sessions` before every `/start`. The validator checks:

| Rule | Severity |
|---|---|
| `# Session N —` header present | Error |
| "Do NOT wait for user input" instruction present | Error |
| At least one `## Prompt N —` section | Error |
| Prompt numbers are sequential (1, 2, 3...) | Error |
| Each prompt ends with `---` separator | Warning |
| Each prompt body has 10+ characters | Warning |
| Override JSON is valid (if present) | Warning |
| At least one `[SECURITY]` prompt recommended | Warning |

***

## Prompt Assembly

### How prompts are built

Before each session, `run-sessions.js` assembles a single combined prompt:

```
<!-- GLOBAL AGENT CONTEXT — CLAUDE.md -->
[contents of CLAUDE.md]

<!-- SESSION PROMPTS — execute all sequentially -->
[contents of Session*.md, with override block stripped]
```

This is piped to Claude via stdin. Claude reads `CLAUDE.md` first to internalize the agent roles, then works through each `## Prompt N` section sequentially.

### Security fix prompt

After all sessions complete, a separate Claude invocation processes security reports:

```
[CLAUDE.md]

## Task: Fix Security Violations
Go through ALL of the following security reports and fix every finding.
Work in order: CRITICAL → WARNING → INFO.

---
[all Security/*.md reports concatenated]
```

Output goes to `Security/fix-output-[timestamp].md`.

***

## Prompt Design Best Practices

### Structure each prompt clearly

```markdown
## Prompt 1 — Implement user profile page

[FULLSTACK]

Create a user profile page that displays the user's name, email, and avatar.

**Requirements:**
- Route: /profile/:userId
- Component: src/components/UserProfile.tsx
- API endpoint: GET /api/users/:id
- Must handle loading and error states
- Must validate userId parameter

**Completion checklist:**
- [ ] UserProfile.tsx component
- [ ] GET /api/users/:id route
- [ ] UserProfile.test.ts
- [ ] Error boundary for invalid userId
```

### Guidelines

1. **Tag every prompt** with its agent role: `[FULLSTACK]`, `[DATABASE]`, `[SECURITY]`, `[MANAGER]`
2. **Include a completion checklist** — Claude uses it to verify its own work
3. **Be specific about file paths** — reduces ambiguity and file bloat
4. **End every session with `[SECURITY]` + `[MANAGER]`** — catches issues while context is fresh
5. **Keep sessions focused** — 3-5 prompts per session, one logical feature per session
6. **Use lightweight keywords** for simple tasks — prompt titles containing "roadmap update", "section update", or "module update" auto-route to Sonnet (cheaper and faster)

### Anti-patterns

- Vague prompts ("make it better") — Claude needs concrete requirements
- Mixing unrelated features in one session — makes debugging and retries harder
- Skipping the Security prompt — CRITICAL issues compound across sessions
- Sessions with 10+ prompts — more likely to timeout or hit turn limits
- Missing `---` separators — merges prompts, breaks timeout calculations

***

## Agent Roles

The default `CLAUDE.md` defines four agent roles:

### Fullstack Agent `[FULLSTACK]`
Implements frontend components, pages, API routes. Follows existing conventions, writes tests, validates inputs.

### Database Agent `[DATABASE]`
Writes migrations (never mutates existing ones), uses parameterized queries, writes rollback migrations, documents schema.

### Security Agent `[SECURITY]`
**Review-only** — does not modify source files. Audits all layers and writes structured reports to `Security/security-report-*.md` with CRITICAL/WARNING/INFO severity levels.

### Manager Agent `[MANAGER]`
Reviews session output for completeness, writes summaries to `Logs/summary-SessionN.md`, creates follow-up prompts if gaps found.

### Universal Rules (all agents)
- Never request user input
- Never truncate output with "..." — write full files
- No new dependencies without documenting them
- All code must be production-ready

***

## Discord Commands

### Run Control

| Command | Description |
|---|---|
| `/setup [plan] [override]` | Create directories, CLAUDE.md, Session1.md template |
| `/start [reset]` | Start run-sessions.js — optionally reset progress |
| `/restart` | Resume from last completed session |
| `/stop` | Kill running process and/or security fix |
| `/reset confirm:yes` | Clear all progress |
| `/pause` | Pause after current session completes |
| `/resume` | Resume a paused run |
| `/retry session:N` | Re-run a single session |
| `/schedule time:HH:MM` | Schedule a run at a specific time |
| `/cancel-schedule` | Cancel a scheduled run |

### Monitoring

| Command | Description |
|---|---|
| `/status` | Per-session completion status and durations |
| `/watch [action]` | Live-stream Claude output to Discord (auto-updating embed) |
| `/logs [lines]` | Last N lines of current log (default: 20, max: 50) |
| `/rate-limit` | Token usage vs. plan budget |
| `/detect-sessions` | Parse sessions, show prompt breakdown and token estimates |
| `/validate-sessions` | Validate all session files before a run |
| `/dry-run` | Validate + estimate tokens without executing |
| `/export-logs` | Export Logs/ as Discord file attachment |
| `/git-changes [file]` | Show files changed by Claude or diff for a specific file |

### Security

| Command | Description |
|---|---|
| `/security-status` | List all findings across security reports |
| `/start-resolve-security` | Manually trigger Claude security fix pass |

### Sessions & Settings

| Command | Description |
|---|---|
| `/new-session number [override]` | Create a new Session N.md from template |
| `/set-timeout session:N minutes:M` | Per-session timeout override |
| `/override session:N model:X` | Per-session model override |
| `/diff session:N` | Compare output between last two archived runs |
| `/dependency-graph` | Visualize session dependency relationships |
| `/settings show` | Display all current settings |
| `/settings set key value` | Change a setting (e.g. `runner.pauseMinutes 120`) |
| `/settings reset` | Restore all settings to defaults |

### Archive

| Command | Description |
|---|---|
| `/archive now` | Archive the current run immediately |
| `/archive list` | List all archived runs |
| `/archive prune [keep]` | Delete old archives, keeping the last N |

### Utilities

| Command | Description |
|---|---|
| `/help` | List all commands grouped by category |
| `/dashboard` | Show the web dashboard URL |
| `/setup-wizard` | Interactive setup — guides through plan, model, permissions |

***

## Web Dashboard

The dashboard starts automatically alongside the bot on the configured port (default: 3000).

**Features:**
- Live status cards (running state, progress, model, plan)
- Session progress table with token estimates
- Command buttons (Start, Stop, Pause, Resume, Restart, Security Fix) with smart enable/disable
- Auto-scrolling log viewer (5s refresh)
- Token budget visualization
- Security report summary
- Settings viewer (sensitive fields redacted)
- Git changes tracker

**Configuration:**

```json
{
  "dashboard": {
    "port": 3000
  }
}
```

Access at `http://localhost:3000` after starting the bot. Use `/dashboard` in Discord to get the URL.

**API Endpoints:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Running state, sessions, progress |
| `/api/logs?lines=50` | GET | Latest log lines |
| `/api/sessions` | GET | Session details with token estimates |
| `/api/settings` | GET | Current settings (tokens redacted) |
| `/api/security` | GET | Security findings summary |
| `/api/rate-limit` | GET | Token budget vs. plan |
| `/api/git-changes` | GET | Uncommitted file changes |
| `/api/command/:name` | POST | Execute a command (start, stop, pause, resume, restart, security-fix) |

***

## Settings Reference

### `bot.*`

| Key | Default | Description |
|---|---|---|
| `bot.token` | `""` | Discord bot token |
| `bot.clientId` | `""` | Discord application ID |
| `bot.channelId` | `""` | Channel to listen and post to |
| `bot.guildId` | `""` | Guild ID for instant command sync (auto-derived from channel if empty) |
| `bot.webhookUrl` | `""` | Primary webhook URL |
| `bot.locale` | `"en-US"` | Locale for date/time formatting |
| `bot.webhookUrls.default` | `""` | Override webhook for general notifications |
| `bot.webhookUrls.security` | `""` | Override webhook for security notifications |
| `bot.webhookUrls.progress` | `""` | Override webhook for progress notifications |

### `runner.*`

| Key | Default | Description |
|---|---|---|
| `runner.defaultModel` | `"claude-opus-4-6"` | Model when no override is set |
| `runner.maxTurns` | `200` | Max turns per session |
| `runner.pauseMinutes` | `360` | Pause between sessions (minutes) |
| `runner.claudePlan` | `"max20"` | Plan: `pro`, `max5`, or `max20` |
| `runner.skipPermissions` | `true` | Pass `--dangerously-skip-permissions` to Claude CLI |
| `runner.parallel` | `false` | Run independent sessions concurrently |
| `runner.autoSecurityFix` | `true` | Auto-run security fix after completion |
| `runner.archiveOnComplete` | `true` | Auto-archive after successful run |
| `runner.workDir` | `""` | Working directory for Claude (auto-set on /setup) |

### `sessions.*` / `logging.*` / `dashboard.*`

| Key | Default | Description |
|---|---|---|
| `sessions.count` | `4` | Expected session count |
| `logging.keepLogs` | `10` | Log files to retain |
| `dashboard.port` | `3000` | Web dashboard port |

***

## Rate Limits & Token Budget

Claude enforces a rolling 5-hour token window. Approximate limits per plan:

| Plan | Output tokens / 5h | Prompts / 5h | Budget (80% safety) |
|---|---|---|---|
| Pro ($20/mo) | ~44,000 | ~40 | ~35,200 |
| Max 5x ($100/mo) | ~88,000 | ~225 | ~70,400 |
| Max 20x ($200/mo) | ~220,000 | ~900 | ~176,000 |

### Token estimation

The system estimates token usage to calculate timeouts and budget fit:

- **Input tokens** ≈ `character_count / 4`
- **Output tokens** ≈ `input_tokens × 0.35`
- **Safety margin**: 80% of plan budget (20% buffer)
- **Timeout**: `max(estimated_duration × 2.5, 2 minutes)`, capped at half the 5h window

### What happens when budget is exceeded

- `/start` and `/dry-run` warn you before execution
- `run-sessions.js` calculates how many 5h windows are needed
- Rate-limit retries: if Claude returns 429, the runner auto-pauses 5 minutes and retries (up to 2 times)
- Discord webhook notification on rate-limit warning

### Recommended pause times

| Plan | Sessions / window | Recommended pause |
|---|---|---|
| Pro | 1-2 | 360 min (default) |
| Max 5x | 2-4 | 60-120 min |
| Max 20x | 4-8+ | 30-60 min |

If your sessions are small and you have Max 20x, you can safely reduce `runner.pauseMinutes` to 30.

***

## Notification System

`discord-notify.js` sends webhook notifications for every significant event:

| Event | Trigger |
|---|---|
| Run start | All sessions begin |
| Session start/success/fail/skip | Per session |
| Prompt start/complete | Per prompt (with 200-char output preview) |
| Pause | Between sessions |
| Timeout warning | 80% of timeout elapsed |
| Rate limit warning | Token budget approaching limit |
| Security alert | CRITICAL/WARNING findings detected |
| Security fix start/complete | Fix pass lifecycle |
| Validation failed | Pre-run validation errors |
| Archived | Run archived successfully |

**Reliability features:**
- Exponential backoff (3 retries: 1s, 2s, 4s)
- 429 rate limit handling with retry-after
- Deduplication guard (10-second SHA-256 hash window)
- Per-category webhook routing
- Health check on bot startup

***

## Workflow

### Typical run

```
1. /setup plan:Max 20x          ← create dirs, CLAUDE.md, template
2. Edit Sessions/*.md            ← write your prompts
3. /validate-sessions            ← check format
4. /dry-run                      ← estimate tokens without executing
5. /start                        ← begin execution
   └─ run-sessions.js spawned
      ├─ Session 1 → Claude CLI → output + security report
      ├─ pause 360 min
      ├─ Session 2 → Claude CLI → output + security report
      ├─ ...
      └─ All done
6. Security fix (auto)           ← Claude fixes all findings
7. Archive (auto)                ← Logs/, Security/, Sessions/ → Archive/
```

### Resume after failure

```
/restart                         ← continues from last incomplete session
/retry session:3                 ← re-run only Session 3
/start reset:true                ← wipe progress, start from Session 1
```

### Scheduling

```
/schedule time:03:00             ← start run at 3:00 AM
/cancel-schedule                 ← cancel
```

### Monitoring during a run

```
/status                          ← progress overview
/logs 50                         ← tail the log
/rate-limit                      ← budget check
http://localhost:3000             ← web dashboard
```

***

## Archive Behavior

When a run completes (or on `/archive now`):

| Source | Destination | Action |
|---|---|---|
| `Logs/*` | `Archive/run-<ts>/Logs/` | **Moved** (cleaned up) |
| `Security/*` | `Archive/run-<ts>/Security/` | **Moved** (cleaned up) |
| `Sessions/Session*.md` | `Archive/run-<ts>/Sessions/` | **Copied** (originals kept) |
| `Sessions/*` (other files) | `Archive/run-<ts>/Sessions/` | **Moved** |
| `.progress.json` | `Archive/run-<ts>/progress-<ts>.json` | **Moved** |

Session definition files are **copied** (not moved) so they remain available for the next run. Everything else is moved to clean up for a fresh run.

By default, the last 5 archives are kept. Configure with `/archive prune keep:10`.

***

## Security Warnings

### `--dangerously-skip-permissions`

When `runner.skipPermissions` is `true` (default), this flag is passed to every Claude invocation. Claude CLI will execute file operations, run commands, and write files **without asking for confirmation**. Claude has write access to the entire working directory. Set `runner.skipPermissions` to `false` to disable this (not recommended for automated runs).

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude can modify/delete any file in workDir | Use a dedicated directory, never point at production |
| Session files control Claude's behavior | Only use session files you wrote yourself |
| Security fix writes code automatically | Review `Security/fix-output-*.md` before deploying |
| Discord bot has no auth beyond channel restriction | Restrict channel access to authorized users |
| `settings.json` stores bot token in plaintext | Protect directory with file system permissions |
| Web dashboard has no auth | Only accessible on localhost by default |

### Recommendations

- **Never** point `runner.workDir` at a directory with production secrets or live infrastructure config
- **Always** review generated code before merging to production branches
- **Always** use `/validate-sessions` before `/start`
- **Keep** the Discord channel private — anyone with access can control the bot
- **Don't** commit `settings.json` to git (it contains your bot token)

***

## Gotchas

**Timeout sizing** — Default per-prompt timeout is 2 hours. If Claude does heavy code generation, it may expire. Monitor `/logs` and increase `timeoutMs` in the override block.

**Progress file** — `.progress.json` prevents sessions from re-running. Don't delete it mid-run. If corrupted, use `/reset confirm:yes`.

**Session encoding** — Save as UTF-8 without BOM. Windows editors sometimes add BOM, breaking the override parser.

**Prompt separators** — Each prompt must end with `---`. Missing separators merge prompts, breaking calculations.

**CLAUDE.md scope** — Prepended to every session. Keep it focused on universal rules. Session-specific instructions belong in the session file.

**Output buffering** — Claude's stdout is buffered in memory. Very long sessions generating massive output can exceed limits. Split large sessions.

**Guild commands** — Commands sync instantly via guild-scoped registration. The bot auto-derives the guild ID from your channel. Old global commands are cleared automatically.

**Startup message** — The bot checks for an existing startup embed in the channel and skips sending a duplicate.

***

## CLI Usage (without Discord)

You can run sessions directly without the Discord bot:

```bash
# Run all sessions
node run-sessions.js

# Reset progress and start fresh
node run-sessions.js --reset

# Dry run — validate and estimate without executing
node run-sessions.js --dry-run

# Run only Session 2
node run-sessions.js --session 2

# Override work directory
CLAUDE_WORK_DIR=/path/to/project node run-sessions.js
```

***

## Example Session File

A complete, production-ready session for implementing a feature:

```markdown
<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 1800000,
    "defaultModel": "claude-opus-4-6"
  },
  "prompts": {
    "1": { "model": "claude-opus-4-6", "maxTurns": 80, "timeoutMs": 7200000 },
    "2": { "model": "claude-opus-4-6", "maxTurns": 60, "timeoutMs": 5400000 },
    "3": { "model": "claude-opus-4-6", "maxTurns": 40, "timeoutMs": 3600000 },
    "4": { "model": "claude-sonnet-4-5", "maxTurns": 25, "timeoutMs": 1800000 }
  }
}
-->

# Session 1 — User Authentication Feature

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: `### PROMPT X COMPLETED`

---

## Prompt 1 — Implement login page and auth API

[FULLSTACK]

Build a complete login flow:

1. Create `src/components/Login.tsx` — email/password form with validation
2. Create `src/routes/auth.ts` — POST /api/auth/login endpoint
3. Add JWT token handling in `src/lib/auth.ts`
4. Create `src/components/Login.test.ts`

**Completion checklist:**
- [ ] Login.tsx renders email + password form
- [ ] POST /api/auth/login returns JWT on valid credentials
- [ ] Invalid credentials return 401 with error message
- [ ] Tests cover happy path and error cases

---

## Prompt 2 — Create users table and auth queries

[DATABASE]

1. Write migration `db/migrations/20260301_create_users.sql`
   - id (UUID, PK), email (unique), password_hash, created_at, updated_at
2. Write rollback migration
3. Create `src/db/queries/users.ts` with findByEmail, createUser
4. Update `src/types/db.ts`

**Completion checklist:**
- [ ] Forward migration creates users table with all columns
- [ ] Rollback migration drops the table
- [ ] Query helpers use parameterized statements
- [ ] TypeScript types match schema

---

## Prompt 3 — Security audit

[SECURITY]

Review ALL files created or modified in Prompts 1 and 2.
Focus on: SQL injection, XSS, missing auth guards, exposed secrets.
Write the report to Security/security-report-Session1-auth.md

---

## Prompt 4 — Session summary

[MANAGER]

Review the output of this entire session.
Write summary to Logs/summary-Session1.md
Update ROADMAP.md with authentication status.
If any items from the checklists are incomplete, write follow-up prompts.

---
```

***

## Lightweight Prompt Routing

Prompt titles containing specific keywords are automatically routed to Sonnet (cheaper, faster):

| Keyword | Model | Max Turns | Timeout |
|---|---|---|---|
| "roadmap update" | claude-sonnet-4-5 | 25 | 45 min |
| "section update" | claude-sonnet-4-5 | 25 | 45 min |
| "module update" | claude-sonnet-4-5 | 25 | 45 min |

All other prompts default to:

| | Default |
|---|---|
| Model | claude-opus-4-6 |
| Max Turns | 80 |
| Timeout | 2 hours |

To add custom lightweight keywords, edit `LIGHTWEIGHT_KEYWORDS` in `run-sessions.js`.

***

## Workflow Diagram

```
Discord: /start
        |
        v
bot/client.js
  [validate all Session*.md files]
        |
        | validation failed → block start, notify
        |
        v
  [spawn run-sessions.js]
        |
        v
run-sessions.js
  [read .progress.json]
  [startup check: claude binary, CLAUDE.md, rate-limit budget]
        |
        v
  ┌─────────────────────────────────────────────────────┐
  │  Session loop                                       │
  │                                                     │
  │  already completed? → skip + notify                 │
  │                                                     │
  │  Build combined prompt:                             │
  │    CLAUDE.md + Session*.md (override stripped)       │
  │    → piped to claude --print via stdin              │
  │                                                     │
  │  Claude CLI                                         │
  │    [FULLSTACK] → writes code                        │
  │    [DATABASE]  → writes migrations                  │
  │    [SECURITY]  → writes report                      │
  │    [MANAGER]   → writes summary                     │
  │                                                     │
  │  success → save to .progress.json + notify          │
  │  failure → notify + exit(1) → resume with /restart  │
  │  rate-limit → auto-retry 2x after 5min pause       │
  │                                                     │
  │  if more sessions → sleep pauseMinutes              │
  └─────────────────────────────────────────────────────┘
        |
        v (all sessions done)
  autoSecurityFix → Claude fixes all CRITICAL/WARNING/INFO
        |
        v
  archiveOnComplete → move to Archive/run-<timestamp>/
        |
        v
  Discord embed: "Run archived"
```
