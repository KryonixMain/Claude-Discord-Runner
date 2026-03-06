# Changelog

All notable changes to Claude Runner are documented here.

---

## [1.3.2] — 2026-03-04

### Fix: Duplicate Override Blocks on Every Start

The `SESSION OVERRIDE CONFIG` block in session files was being duplicated on every bot start. The root cause: `applyTimeoutsToSessionFile()` generated a new override block without preserving `dependsOn`/`waitForFile`, and only removed the first existing block (missing `g` flag on regex). This broke wave-based parallel execution — all sessions appeared in Wave 1.

**Root Cause:**
- `applyTimeoutsToSessionFile()` stripped only the first override block (non-global regex), then prepended a new one
- The new block lacked `dependsOn` and `waitForFile` from the original config
- Every `/start` command added another block, and the parser always read the first (incomplete) one

**Fix:**
- All override block regex replacements now use the global `g` flag to remove ALL blocks before prepending
- `applyTimeoutsToSessionFile()` now parses the existing override first and preserves `dependsOn`, `waitForFile`, and other custom properties
- Same fix applied to all locations across the codebase that read/write override blocks
- All `parseOverrideBlock()` / `parseSessionOverride()` functions now merge ALL found blocks instead of only reading the first — if duplicates exist despite the write-path fix, `dependsOn` and `waitForFile` are still preserved

**Affected files:**
- `bot/lib/session-setup.js` — `applyTimeoutsToSessionFile()` rewritten with preservation logic + global regex
- `bot/handlers/override.js` — global regex for block removal
- `bot/handlers/set-timeout.js` — `writeOverrideBlock()` uses global regex
- `bot/handlers/set-pause.js` — `writeOverrideBlock()` uses global regex
- `bot/handlers/set-security.js` — `writeOverrideBlock()` uses global regex
- `bot/handlers/get-timeout.js` — strip regex uses global flag (2 locations)
- `dashboard/server.js` — strip/replace regex uses global flag (3 locations)
- `run-sessions.js` — strip regex uses global flag (2 locations)

**Session files cleaned up:**
- All 8 session files (`Session1-8.md`) merged from duplicate blocks back to a single block each
- `dependsOn` and `waitForFile` preserved in the correct sessions

---

## [1.3.1] — 2026-03-04

### workDir as Central Data Hub

All bot runtime data (Sessions, Logs, Security, Archive) now lives inside the configured `runner.workDir` instead of the bot's own project directory. This makes `_workspace` the single source of truth for all files — both agent communication and bot output.

**Data Directory Relocation**
- `SESSION_DIR`, `LOG_DIR`, `SECURITY_DIR`, `ARCHIVE_DIR`, `STATE_FILE` now resolve against `runner.workDir`
- `bot/lib/paths.js` reads `workDir` from settings inline (avoids circular dependency with `settings.js`)
- `run-sessions.js` computes all data paths after `WORK_DIR` resolution
- `CLAUDE_MD` stays in the bot project directory (prepended to sessions as before)

**Claude CLI gets parent directory access**
- `--add-dir` now includes both the workspace dir AND its parent (e.g. `F:\Flowence`)
- Claude can access the full Flowence codebase via `../` relative paths
- Security fix process also adds the parent directory

**Workspace auto-initialization**
- On run start, ALL directories are created inside workDir before the startup check
- This includes both agent communication dirs (`tasks/`, `plans/`, `inbox/`, etc.) and bot data dirs (`Sessions/`, `Logs/`, etc.)
- `/setup` command also creates workspace dirs

**Session file path updates**
- All 4 session templates updated: `_workspace/` prefix removed from all paths
- Codebase references now use `../` (e.g. `../user_website/src/`, `../backend_v2/src/`)
- `waitForFile` path updated to `./status/shell3_schema.json`

**CLAUDE.md workspace section updated**
- Documents that workDir IS `_workspace` — no extra prefix needed
- Updated File-Ownership rules with correct relative paths
- Added `Agents/` directory to workspace structure

**Configuration**
- `runner.workDir`: `F:\Flowence\_workspace` (was `F:\Flowence`)

**Affected files:**
- `bot/lib/paths.js` — data dirs resolve from workDir
- `run-sessions.js` — data dirs, workspace init order, `--add-dir` parent
- `bot/process.js` — security fix `--add-dir` parent
- `bot/lib/session-setup.js` — workspace dir creation in `/setup`
- `bot/settings.json` — workDir updated
- `Sessions/Session1-4.md` — relative paths
- `CLAUDE.md` — workspace section
- `dashboard/public/index.html` — version footer

---

## [1.3.0] — 2026-03-04

### Multi-Agent Workflow Support (Flowence PM Suite)

The bot can now orchestrate the full Flowence PM Suite multi-agent workflow with 4 shells (Manager, Fullstack, Database, Reviewer) communicating via a shared `_workspace/` filesystem.

**Prompt-Level `waitForFile` Polling**
- New override field `waitForFile` per prompt in the session override config
- Before a session starts, the runner collects all `waitForFile` entries from session and prompt overrides
- Polls for each required file at configurable intervals until found or timeout
- Supports: `path` (relative to workDir or absolute), `timeoutMs` (default: 15min), `pollIntervalMs` (default: 30s)
- If a file is not found after timeout, the session continues with a warning (no hard failure)
- This enables cross-shell synchronization: e.g. Session 2 (Backend) waits for `shell3_schema.json` written by Session 3 (Database)

**Example override config:**
```json
{
  "prompts": {
    "3": {
      "waitForFile": {
        "path": "_workspace/status/shell3_schema.json",
        "timeoutMs": 900000,
        "pollIntervalMs": 30000
      }
    }
  }
}
```

**Workspace Directory Auto-Initialization**
- On run start, `_workspace/` subdirectories are automatically created in the work directory
- Directories: `tasks/`, `plans/`, `inbox/`, `status/`, `logs/`, `review/`, `locks/`, `Learnings/`
- Ensures the shared filesystem communication hub is always available

**CLAUDE.md — Workspace Integration**
- New "Workspace" section with full `_workspace/` directory structure documentation
- "IMMER zuerst lesen" instruction: every session reads `_workspace/Learnings/` before starting
- Agent definition references: sessions load role instructions from `_workspace/Agents/`
- Status file writing protocol with JSON format specification
- File-ownership rules for parallel mode (Shell 2 → frontend/backend, Shell 3 → database)

**Pre-Built Workflow Session Templates**
- `Session1.md` — Manager: TaskPlanner → FullstackManager → DatabaseManager → ReviewManager
- `Session2.md` — Fullstack: FrontendPlanner → FrontendDeveloper → BackendPlanner → BackendDeveloper
- `Session3.md` — Database: DatabasePlanner → DatabaseDeveloper
- `Session4.md` — Reviewer: QA Review → Security Audit
- All sessions include proper `dependsOn` configuration for wave-based parallel execution
- Session 2 includes `waitForFile` for `shell3_schema.json` on Prompt 3 (BackendPlanner)

**Configuration Changes**
- `runner.workDir` now set to `F:\Flowence` (project root, previously `F:\Flowence\Claude`)
- `runner.parallel` set to `true` for wave-based parallel session execution
- Execution flow: Session 1 → Session 2 + Session 3 (parallel) → Session 4

**Affected files:**
- `run-sessions.js` — `waitForFile()` polling function, workspace dir init, integration in `executeSession()`
- `CLAUDE.md` — workspace section, learnings, agent references, file-ownership rules
- `bot/settings.json` — workDir and parallel mode configuration
- `Sessions/Session1-4.md` — pre-built workflow templates
- `package.json` — version bump to 1.3.0

---

## [1.2.5] — 2026-03-02

### Live Claude Output & Prompt Progress Tracking

Real-time visibility into what Claude is doing during a run. The dashboard now shows live output and prompt-level progress.

**Live Progress Panel** (Overview tab)
- Animated panel appears when a session is actively running
- Shows: session name, model, current prompt label (e.g. "Prompt 2 — Database Migration (1/5 done)")
- Progress bar visualizing prompt completion
- Elapsed time counter and output size tracker
- Auto-hides when no session is active

**Claude Output Viewer** (Overview tab)
- New "Claude Output" section displays Claude's raw stdout in real-time
- Auto-scrolls to bottom, polled every 5 seconds
- Shows the output from the last session even after completion
- Separate from the runner log — this is Claude's actual response text

**Technical Implementation:**
- `run-sessions.js` now writes two live tracking files during execution:
  - `Logs/.live-session.json` — current session progress (throttled to max 1 write per 2s)
  - `Logs/.live-output.txt` — Claude's raw stdout (appended in real-time)
- Live status JSON includes: session name, model, prompt labels, completed prompts, elapsed time, output bytes
- On session completion, `.live-session.json` is cleared; `.live-output.txt` is preserved for review

**New API Endpoint:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/live-output` | GET | Live session status + last N lines of Claude's output |

---

## [1.2.4] — 2026-03-02

### Save Generated Prompts

New setting `runner.saveGeneratedPrompts` — when enabled, the combined prompt (CLAUDE.md + session content) is saved to `Logs/generated-prompts/` before each session execution.

**Setting:**
- `runner.saveGeneratedPrompts` (default: `false`) — toggle via `settings.json`, dashboard, or API

**Dashboard — Prompts Tab (NEW)**
- New "Prompts" tab in the dashboard
- Toggle switch to enable/disable prompt saving
- File list with size and timestamp
- Click "View" to display the full combined prompt in a read-only viewer
- Refresh button for immediate update

**New API Endpoints:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/generated-prompts` | GET | List all saved generated prompts |
| `/api/generated-prompts/:name` | GET | Read a specific generated prompt file |
| `/api/generated-prompts/toggle` | POST | Enable/disable prompt saving |

**Other:**
- Translated all remaining German UI text in the dashboard to English (timeouts tab hints, summary labels, global pause section)

---

## [1.2.3] — 2026-03-02

### Archive & Security Fix — Trigger Fix

The `archiveOnComplete` and `autoSecurityFix` settings were not triggering because the completion check compared against a static `sessions.count` config value instead of the actual number of session files. This has been fixed.

**Root cause:** `allDone` in `bot/process.js` compared `completedSessions.length` against `getSetting("sessions", "count")` (a static config, default 4). If the real session file count differed, `allDone` was never true, preventing both archive and security fix from running.

**Fix:** Now uses `detectSessions().sessions.length` for the actual session file count.

### Per-Session Security Fix Toggle

New command `/set-security` and dashboard toggle to skip the auto security fix for individual sessions.

**`/set-security session:N enabled:true|false`**
- Enable or disable the security fix pass for a specific session
- Writes `session.skipSecurityFix` to the session override block
- Skipped sessions are excluded from the combined security fix prompt

**Dashboard — Security Toggle**
- Checkbox per session in the Timeouts tab to enable/disable security fix
- Visual "Security: Off" badge for sessions with security fix disabled
- Save button sends both timeout and security toggle in parallel

**New API Endpoints:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/security-toggle/:session` | POST | Toggle security fix per session |

**Affected files:**
- `bot/process.js` — fixed `allDone` check, added `getSkippedSessions()`, filtered security reports
- `bot/handlers/set-security.js` — new command handler
- `bot/commands.js` — registered `/set-security`
- `bot/client.js` — added handler mapping
- `bot/handlers/help.js` — added to help
- `dashboard/server.js` — new endpoint + `skipSecurityFix` in timeouts response
- `dashboard/public/app.js` — security toggle UI
- `dashboard/public/style.css` — security toggle styles

---

## [1.2.2] — 2026-03-02

### Git commands now use `runner.workDir`

All git commands now operate on the configured work directory (`runner.workDir` in `settings.json`) instead of the runner's own project root.

**Affected files:**
- `bot/handlers/git-changes.js` — `/git-changes` now shows changes in the work directory (previously: runner repo)
- `dashboard/server.js` — `/api/git-changes` endpoint now uses `getWorkDir()` (previously: `PROJECT_DIR`)

**Behavior:**
- When `runner.workDir` is set (e.g. `F:\Flowence\Claude`), all git operations target that directory
- When `runner.workDir` is empty, the runner project root is used as fallback
- All other git locations (health.js, rollback.js, blast-radius.js, run-sessions.js) already used `getWorkDir()` correctly

---

## [1.2.1] — 2026-03-02

### Per-Prompt Timeout & Session Pause Configuration

**`/set-timeout` — Per-Prompt Timeout Support**
- New optional parameter `prompt`: Sets the timeout for a single prompt within a session
- Syntax: `/set-timeout session:1 minutes:30 prompt:3` — sets only Prompt 3 to 30 minutes
- Without the `prompt` parameter, the session-wide default is still set
- Priority: Prompt Override > Session Override > Default

**`/set-pause` — New Command**
- `/set-pause minutes:M` — Sets the global pause between all sessions
- `/set-pause minutes:M session:N` — Sets the pause only after a specific session
- Per-session overrides take precedence over the global default
- Per-session: writes `session.pauseAfterMs` to the override block
- Global: writes `runner.pauseMinutes` to `settings.json`

**Dashboard — Per-Prompt Timeout Editing**
- Each prompt now has its own timeout input field in the Timeouts tab
- Per-prompt values are displayed alongside the effective timeout and source
- Save button sends both session-level and per-prompt overrides in a single request

**Dashboard — Global Pause Configuration**
- New section in the Timeouts tab: "Global Pause Configuration"
- Input field for `runner.pauseMinutes` with direct save to backend
- Value is loaded from current settings on tab switch

### New API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/pause-config` | POST | Set global pause (`runner.pauseMinutes`) |

### Improvements
- `POST /api/timeout/:session` now accepts a `promptTimeouts` object for per-prompt overrides
- Dashboard footer shows version 1.2.1
- Timeouts tab shows effective values including source (default/session/prompt) per prompt
- Improved hint texts in the dashboard with per-prompt timeout explanation

---

## [1.2.0] — 2026-03-02

### Dashboard — Complete Overhaul

The web dashboard has been expanded from a simple status page to a full management interface with tab navigation, analytics, archive browser, and live timeout configuration.

**Tab Navigation**
- 6 tabs: Overview, Timeouts, Analytics, Archives, Audit Log, Settings
- Lazy-loading: Data is only fetched when a tab is activated
- Active tab is automatically refreshed on each slow poll

**Overview (expanded)**
- Sessions table now shows token usage from `sessionDetails`
- Combined Security + Git Changes column instead of separate sections
- Improved button controls with correct state management

**Timeouts Tab — NEW**
- Complete timeout overview for all sessions
- Per-prompt breakdown with source (default / session override / prompt override)
- **Inline editing**: Change timeout and pause directly in the dashboard
- Immediate persistence to session override blocks
- Summary: Max execution time, total pause time, max total runtime
- Visual badges: Override status, done status, timeout/pause values

**Analytics Tab — NEW**
- Aggregated statistics across all archived runs
- 6 KPI cards: Total Runs, Total Sessions, Success Rate, Avg. Duration, Input/Output Tokens
- **Success/Failure Bar Chart**: Visualizes success/failure rate per run (last 15 runs)
- **Duration Bar Chart**: Runtime trend across all runs
- Run history table with details per archived run
- Data from current `.progress.json` + all archive manifests

**Archives Tab — NEW**
- Browsable list of all archived runs
- Collapsible detail view per archive with:
  - Per-session result (Success/Failure, Duration, Token Usage)
  - Settings snapshot (Plan, Model, Pause, MaxTurns)
  - File count and timestamps
- Status badges: Completed / Failed / Unknown

**Audit Log Tab — NEW**
- Tabular view of all command executions (newest first)
- Columns: Timestamp, Command, Actor, Args, Outcome
- Color-coded outcomes (green = ok, red = error)
- Refresh button for immediate update

**Settings Tab**
- JSON view of current configuration
- Sensitive fields remain redacted

### New API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/timeouts` | GET | Timeout and pause configuration for all sessions |
| `/api/timeout/:session` | POST | Change session timeout and/or pause live |
| `/api/analytics` | GET | Aggregated statistics from all archives |
| `/api/history` | GET | Session execution history from all archives |

### Improvements
- `GET /api/status` now returns `tokenUsage`, `durationMs`, `success` per session
- `GET /api/status` returns `startedAt` of the current run
- Dashboard footer shows version 1.2.0
- Responsive design: Tabs and cards adapt on mobile devices
- CSS custom properties for consistent theming

---

## [1.1.0] — 2026-03-02

### New Features

**`/get-timeout` — Show Timeout Quota**
- Shows the timeout quota for a single session or all sessions as an overview
- Per-prompt breakdown with source (default / session override / prompt override)
- Clear separation: **Timeout** (execution time) vs. **Pause** (wait time between sessions)
- Total runtime calculation including all pauses
- Status display: completed, running, or pending

**`/set-timeout` — Extended with Pause Configuration**
- New parameter `pause`: Sets the wait time after a session (in minutes)
- `minutes` and `pause` are now independently configurable
- Clearer labeling: Timeout != Pause
- Session timeout override now actually applies to prompt timeouts (bugfix)

**Timeout vs. Pause — Clear Separation**
- **Timeout** = maximum execution time per prompt/session (process is killed on exceed)
- **Pause** = wait time between sessions/prompts (rate-limit buffer, configurable per session)
- `session.timeoutMs` override is now correctly applied to all prompts (previously had no effect)

### Bugfixes
- `session.timeoutMs` from the override block is now used in `parsePrompts()` as fallback for all prompt timeouts (previously ignored)

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
