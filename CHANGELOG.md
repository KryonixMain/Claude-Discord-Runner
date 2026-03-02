# Changelog

All notable changes to Claude Runner are documented here.

---

## [1.0.1] — 2026-03-02

Initial public release of Claude Runner — a Discord bot that orchestrates sequential Claude CLI sessions with monitoring, security audits, and a web dashboard.

### Core System
- **Session executor** (`run-sessions.js`) — spawns Claude CLI per session, manages state, sends webhook notifications
- **Discord bot** (`bot/client.js`) — slash-command interface with 40+ commands
- **Web dashboard** (`dashboard/server.js`) — Express-based live status page with REST API and command buttons
- **Webhook notifications** (`discord-notify.js`) — stateless webhook client with retry, backoff, SHA-256 dedup
- **CLAUDE.md agent framework** — four agent roles (Fullstack, Database, Security, Manager) with strict rules

### Discord Commands (40+)

**Run Control:**
`/setup`, `/setup-wizard`, `/start`, `/restart`, `/stop`, `/reset`, `/pause`, `/resume`, `/retry`, `/retry-prompt`, `/schedule`, `/cancel-schedule`

**Monitoring:**
`/status`, `/watch`, `/logs`, `/rate-limit`, `/detect-sessions`, `/validate-sessions`, `/dry-run`, `/export-logs`, `/git-changes`, `/info`

**Security:**
`/security-status`, `/start-resolve-security`

**Sessions & Settings:**
`/new-session`, `/set-timeout`, `/override`, `/diff`, `/dependency-graph`, `/settings show`, `/settings set`, `/settings reset`

**Archive:**
`/archive now`, `/archive list`, `/archive prune`

**AI & Templates:**
`/create-session`, `/generate-template`, `/estimate`, `/health`

**Git & Comparison:**
`/rollback`, `/compare-sessions`

**Utilities:**
`/help`, `/dashboard`

### Features
- **Parallel session execution** — independent sessions run concurrently via `runner.parallel` setting, wave-based scheduling with dependency resolution
- **Session dependencies** — `dependsOn` field in override block, sessions wait for prerequisites to complete
- **Session dependency graph** — `/dependency-graph` visualizes relationships as a text tree
- **Live log streaming** — `/watch` auto-updates an embed every 5s with the latest log output
- **Interactive setup wizard** — `/setup-wizard` guides through plan, model, and permissions with select menus and buttons
- **Auto-update check** — on startup, compares local version against GitHub repo and offers one-click update
- **Per-session override config** — model, maxTurns, timeoutMs configurable per prompt via HTML comment block
- **Lightweight prompt routing** — prompts with keywords like "roadmap update" auto-route to Sonnet
- **Post-session verification** — run custom commands (lint, test, build) after each session
- **Blast-radius protection** — configurable limits on changed/deleted files with optional auto-abort
- **Rate-limit handling** — auto-retry on 429 with 5-minute cooldown, budget estimation, multi-window calculation
- **Security fix pass** — auto-run Claude to fix all CRITICAL/WARNING/INFO findings after sessions complete
- **Archive system** — auto-archive Logs/Security/Sessions after runs, with pruning
- **Token budget estimation** — calculate input/output tokens, timeout sizing, plan budget fit
- **Prompt checkpoint tracking** — per-prompt progress saved to `.progress.json`
- **Output diffing** — compare session output against previous archived runs
- **Scheduled runs** — `/schedule time:HH:MM` for off-hours execution
- **Configurable permissions** — `runner.skipPermissions` controls `--dangerously-skip-permissions` flag

### Settings (15 configurable keys)
`runner.defaultModel`, `runner.maxTurns`, `runner.pauseMinutes`, `runner.claudePlan`, `runner.skipPermissions`, `runner.parallel`, `runner.autoSecurityFix`, `runner.archiveOnComplete`, `runner.workDir`, `sessions.count`, `logging.keepLogs`, `dashboard.port`, `bot.channelId`, `bot.webhookUrl`, `bot.locale`

### Web Dashboard
- Live status cards (running state, progress, model, plan)
- Session progress table with token estimates
- Command buttons (Start, Stop, Pause, Resume, Restart, Security Fix)
- Auto-scrolling log viewer (5s refresh)
- Token budget visualization
- Security report summary
- Settings viewer (sensitive fields redacted)
- Git changes tracker
- REST API with 8 endpoints

### Cross-Platform Support
- Claude binary resolution: `where.exe` (Windows) / `which` (Unix)
- npm prefix and common path fallbacks for both platforms
- `os` module for system health checks instead of PowerShell
- Atomic state file writes (tmp + rename)

### Documentation
- `Docs/getting-started.md` — step-by-step setup guide
- `Docs/architecture.md` — component diagram, data flow, state management
- `Docs/configuration.md` — every setting with type, default, example
- `Docs/session-format.md` — override block, prompt headers, dependency syntax
- Comprehensive `README.md` with all commands, settings, workflow, examples

### Security
- EventEmitter-based pause/unpause (no polling)
- SHA-256 deduplication in webhook client
- Configurable `--dangerously-skip-permissions`
- Channel-restricted command execution
- Bot token not committed to git (`.gitignore` + `settings.example.json`)
- Config validation on startup
- Audit logging for all commands
