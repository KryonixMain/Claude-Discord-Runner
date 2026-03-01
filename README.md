# Claude Runner

Automated multi-session executor for Claude CLI, controlled via a Discord bot.

***

## Overview

Claude Runner is a Node.js automation system that executes a series of Claude CLI sessions sequentially, unattended. It consists of three files that work together:

- **`run-sessions.js`** — the actual executor that spawns Claude CLI, manages session state, and sends webhook notifications
- **`discord-bot.js`** — a Discord slash-command bot that starts, stops, and monitors `run-sessions.js` as a child process
- **`discord-notify.js`** — a stateless webhook client used by both files to push status messages to Discord

A typical run looks like this: you write one or more `Session*.md` files containing structured prompts, issue `/start` in Discord, and the runner works through all sessions automatically, pausing between them to respect Claude's rate limits, running a security fix pass at the end, and archiving all output.

***

## Directory Structure

```
Claude/                     <- BASE_DIR (location of all three .js files)
  run-sessions.js
  discord-bot.js
  discord-notify.js
  settings.json             <- auto-created on first /setup
  CLAUDE.md                 <- global agent context, prepended to every session
  .progress.json            <- persisted run state (auto-managed)

  Sessions/
    Session1.md
    Session2.md
    ...

  Logs/                     <- per-run logs and session output files
  Security/                 <- security reports written by Claude
  Archive/                  <- completed runs are moved here
```

***

## Prerequisites

- Node.js 18 or later
- Claude CLI installed globally: `npm install -g @anthropic-ai/claude-code`
- An active Claude subscription (Pro, Max 5x, or Max 20x)
- A Discord application with a bot token and a webhook URL

***

## Setup

### 1. Install dependencies

```bash
npm i
```

### 2. Configure credentials

Open `discord-bot.js` and fill in or set these via environment variables:

```
DISCORD_BOT_TOKEN    — your bot token from the Discord Developer Portal
DISCORD_CLIENT_ID    — your application's client ID
DISCORD_CHANNEL_ID   — the channel ID the bot should listen and post to
DISCORD_WEBHOOK_URL  — a webhook URL for the same channel (for run-sessions.js notifications)
```

You can also store all four values in `settings.json` under `bot.token`, `bot.clientId`, `bot.channelId`, and `bot.webhookUrl`. Environment variables take priority.

### 3. Start the bot

```bash
node discord-bot.js
```

```bash
npm run bot
```

The bot registers its slash commands on startup and sends a status embed to the configured channel.

### 4. Run /setup in Discord

Issue `/setup plan:Max 20x` (or whichever plan you have) in the configured channel. This creates:

- All required directories (`Sessions/`, `Logs/`, `Security/`, `Archive/`)
- A default `CLAUDE.md` with base agent instructions
- A `Session1.md` template
- Calculated timeout and pause values written into the session file override block, based on your plan's token budget

### 5. Write your session files

Each session file follows this structure:

```markdown
# Session 1 — Task Overview

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: ### PROMPT X COMPLETED

---

## Prompt 1 - {Description}

{Your Prompt}

---

## Prompt 2 — {Description}

{Your Prompt}

---

## Prompt 3 — {Description}

{Your Prompt}

---

<!-- And so on -->
```

Optionally, an override block at the top of the file controls per-prompt model, turn count, and timeout:

```
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 3600000,
    "defaultModel": "claude-opus-4-5"
  },
  "prompts": {
    "1": { "model": "claude-opus-4-5", "maxTurns": 80, "timeoutMs": 7200000 },
    "2": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 1800000 }
  }
}

```

This block is stripped before the prompt is sent to Claude.

### 6. Validate and start

```
/validate-sessions
/start
```

***

## How Prompts Are Assembled

### Session Prompts

Before each session is sent to Claude, `run-sessions.js` builds a single combined prompt from two sources and pipes it to Claude via stdin. The structure is always:

```
[CLAUDE.md content]
[Session*.md content — with override block stripped]
```

Concretely, the assembled string looks like this:

```
<!-- GLOBAL AGENT CONTEXT — CLAUDE.md                          -->
<!-- These rules apply to ALL prompts in this session           -->

...contents of CLAUDE.md...

<!-- SESSION PROMPTS — execute all sequentially                 -->

# Session 1 — Task Overview

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
...

## Prompt 1 — Implement user authentication

...your prompt text...

---

## Prompt 2 — Write unit tests

...your prompt text...

---
```

Claude receives the full combined text as a single stdin input. It reads `CLAUDE.md` first to internalize the agent roles, rules, and conventions, then works through each `## Prompt N` section sequentially without pausing for user input. The `--max-turns` flag passed to the CLI is the sum of all prompt `maxTurns` values, giving Claude enough turns to complete the entire session in one invocation.

The override block is never sent to Claude — it is only read by `run-sessions.js` to configure the CLI call itself (model, turns, timeout).

***

### Security Fix Prompt

After all sessions complete, `discord-bot.js` runs a separate Claude invocation for the security fix pass. This prompt is assembled differently — it is built entirely in memory by `startSecurityFix()` and never comes from a session file.

The structure is:

```
[CLAUDE.md content]

## Task: Fix Security Violations

Go through ALL of the following security reports and fix every finding.
Work in order: CRITICAL -> WARNING -> INFO.
For each fixed item: mark it in the report with FIXED.
Do not skip any item — complete all of them.

---

### Report: security-report-Session1.md

...full contents of Security/security-report-Session1.md...

---

### Report: security-report-Session2.md

...full contents of Security/security-report-Session2.md...

---
```

All `.md` files present in `Security/` at the time of the fix pass are concatenated into a single prompt. Claude processes every report in one invocation, applying fixes directly to source files and marking each resolved finding with `FIXED`. The output transcript is written to `Security/fix-output-[timestamp].md` for review.

This means the security fix prompt grows linearly with the number of sessions and the verbosity of each report. For runs with many sessions, monitor the combined report size. If the total exceeds roughly 80,000 characters, consider splitting the fix pass by running `/start-resolve-security` manually after archiving older reports, or breaking reports into batches by editing `startSecurityFix()` to process one report per invocation.

The key difference between the two prompt types:

| | Session prompt | Security fix prompt |
|---|---|---|
| Source | `CLAUDE.md` + `Session*.md` | `CLAUDE.md` + all `Security/*.md` |
| Built by | `run-sessions.js` | `discord-bot.js` |
| Comes from files | Yes — session files on disk | No — assembled in memory at runtime |
| Override block | Stripped before sending | Not applicable |
| Output written to | `Logs/SessionN.output.md` | `Security/fix-output-*.md` |
| Triggered by | `/start` or `/restart` | Auto after run, or `/start-resolve-security` |

***

## Example CLAUDE.md with Four Agents

The following is a production-ready `CLAUDE.md` for a full-stack web application project. Claude reads this before every session and uses it to decide which role to apply to each prompt.

```markdown
# Claude Runner — Global Agent Context

You are an automated coding assistant operating in a multi-agent framework.
Each prompt in a session designates which agent role is active.
Read the role designation at the top of each prompt and apply its rules strictly.
Complete every prompt fully without requesting user input.
Mark each completed prompt with: ### PROMPT X COMPLETED
On errors: document what failed, attempt a fix, and continue to the next prompt.

---

## Agent Roles

### Fullstack Agent

Activate when a prompt is tagged: [FULLSTACK]

Responsibilities:
- Implement frontend components, pages, and API routes
- Write clean, typed TypeScript/JavaScript — no any types
- Follow the existing file structure and naming conventions exactly
- Every new component must have a corresponding .test.ts file
- Use the existing UI component library — do not introduce new dependencies
- API routes must validate all inputs and return consistent error shapes
- Do not leave TODO comments — implement fully or document the gap in a findings file

Conventions:
- Components: PascalCase in src/components/
- API routes: kebab-case in src/routes/
- Shared types: src/types/index.ts
- Environment variables: always read from process.env, never hardcode

---

### Database Agent

Activate when a prompt is tagged: [DATABASE]

Responsibilities:
- Write and apply database migrations — never mutate existing migrations
- Design schemas with explicit foreign keys, indexes, and constraints
- All queries must use parameterized statements — no string interpolation
- Write a rollback migration for every forward migration
- Document every table and column with a SQL comment
- After schema changes, update the corresponding TypeScript types in src/types/db.ts

Conventions:
- Migrations: db/migrations/YYYYMMDD_description.sql
- Seed data: db/seeds/
- Query helpers: src/db/queries/
- Connection pool: always use the existing pool in src/db/pool.ts — never create new connections

---

### Security Agent

Activate when a prompt is tagged: [SECURITY]

The Security Agent reviews code only — it does NOT write or modify any source files.
It audits all layers touched in the current session and writes a structured report.
On CRITICAL findings: document and continue — do not stop the session.
At the end of the session, include a summary of all CRITICAL findings found across all prompts.

Responsibilities:
- Review every file created or modified in the current session
- Check all layers: frontend, backend, and database
- Write one report per prompt reviewed, named by prompt and date
- Never truncate findings — completeness is mandatory

Report location:
  Security/security-report-{prompt-name}-{YYYY-MM-DD}.md

Report format:
  # Security Report — {Prompt Name} — {YYYY-MM-DD}

  ## CRITICAL (fix immediately)
  - [ ] {Description} | File: {path}:{line} | Risk: {explanation}

  ## WARNING (fix soon)
  - [ ] {Description} | File: {path}:{line} | Risk: {explanation}

  ## INFO (nice to have)
  - [ ] {Description} | File: {path}:{line}

  ## Checked — no findings
  - Permission gates: all new endpoints are protected
  - SQL injection: parameterized queries used throughout
  - RLS: all new tables have Row-Level Security policies

Frontend checks:
  - Missing permission checks in components (UI visible to unauthorized users)
  - XSS risks (unsanitized HTML rendering via dangerouslySetInnerHTML or equivalent)
  - Sensitive data exposed in client-side state or localStorage
  - Insecure npm packages (only flag newly introduced imports)

Backend checks:
  - SQL injection in new service queries
  - Missing auth guards on new routes
  - Missing rate limiting on sensitive endpoints
  - Missing or insufficient input validation
  - Exposed stack traces or internal error details in API responses
  - Overly permissive CORS configuration

Database checks:
  - Missing RLS policies on new tables
  - Missing tenant_id filters in new views or queries
  - Overly broad permissions granted to application roles
  - Unindexed foreign keys on large tables

On CRITICAL findings:
  Do NOT stop. Document the finding in full, continue reviewing, and add a
  consolidated CRITICAL summary section at the bottom of the report:

  ## CRITICAL Summary
  - {finding 1}
  - {finding 2}

---

### Manager Agent

Activate when a prompt is tagged: [MANAGER]

Responsibilities:
- Review the output of the current session for completeness
- Cross-check that every item in the session's completion checklist is done
- Identify anything that was skipped, partially implemented, or left broken
- Write a session summary to Logs/summary-SessionN.md
- If gaps are found, write follow-up prompts to Sessions/followup-SessionN.md
  so the next run can address them
- Update ROADMAP.md with the current implementation status

Summary format:
  ## Session N Summary
  ### Completed
  - ...
  ### Incomplete or skipped
  - ...
  ### Follow-up required
  - ...

---

## Universal Rules

- Never request user input under any circumstance
- Never truncate output with "..." or "rest of file unchanged" — write the full file
- Never introduce new dependencies without documenting them in DEPENDENCIES.md
- Prefer editing existing files over creating new ones unless the task explicitly requires a new file
- All generated code must be production-ready — no placeholder logic
- If a file does not exist when expected, create it with sensible defaults and log the gap
```

***

## Workflow Diagram

The following shows how a four-session run flows from Discord command to archived output.

```
Discord: /start
        |
        v
discord-bot.js
  [validate all Session*.md files]
        |
        | validation failed -> block start, notify via embed + webhook
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
  +-----------------------------------------------------+
  |  Session loop (i = 0 .. N)                          |
  |                                                     |
  |  already completed? -> skip + notifySessionSkipped  |
  |                                                     |
  |  notifySessionStart (webhook)                       |
  |                                                     |
  |  Build combined prompt:                             |
  |    CLAUDE.md                                        |
  |    + Session*.md (override block stripped)          |
  |    -> piped to claude --print via stdin             |
  |                                                     |
  |  Claude CLI (one process per session)               |
  |    reads CLAUDE.md -> activates agent roles         |
  |    [FULLSTACK] prompts -> writes code               |
  |    [DATABASE]  prompts -> writes migrations         |
  |    [SECURITY]  prompts -> audits + writes report    |
  |    [MANAGER]   prompts -> writes summary + roadmap  |
  |    exits when all prompts are marked complete       |
  |                                                     |
  |  success:                                           |
  |    save to .progress.json                           |
  |    notifySessionSuccess (webhook)                   |
  |    count security findings -> notifySecurityAlert   |
  |                                                     |
  |  failure:                                           |
  |    notifySessionFailed + notifyRunFailed (webhook)  |
  |    process.exit(1) <- resume with /restart          |
  |                                                     |
  |  if more sessions remain:                           |
  |    sleep pauseMinutes (default 360 min)             |
  |    notifyPause (webhook)                            |
  +-----------------------------------------------------+
        |
        v (all sessions done)
  notifyRunComplete (webhook)
        |
        v
discord-bot.js (exit event of run-sessions.js)
  [autoSecurityFix = true?]
        |
        v
  startSecurityFix()
    read all Security/*.md reports
    build single prompt: CLAUDE.md + all report contents
    spawn claude --print
    Claude fixes all CRITICAL findings, marks items as FIXED
    writes Security/fix-output-*.md
    notifySecurityFixComplete (webhook)
        |
        v
  [archiveOnComplete = true?]
        |
        v
  archiveCompletedRun()
    move Logs/       -> Archive/run-YYYY-MM-DDTHH-MM-SS/Logs/
    move Security/   -> Archive/run-.../Security/
    move session outputs -> Archive/run-.../Sessions/
    move .progress.json  -> Archive/run-.../progress-*.json
    pruneArchives (keep last 5)
    notifyArchived (webhook)
        |
        v
  Discord embed: "Run archived"
```

### Agent Role Flow Within a Session

Within a single Claude invocation, the session file directs Claude through each agent role in sequence:

```
Combined prompt received by Claude
        |
        v
Read CLAUDE.md -> internalize all four agent role definitions
        |
        v
## Prompt 1 [FULLSTACK] — Implement login page
  -> apply Fullstack Agent rules
  -> write src/components/Login.tsx
  -> write src/routes/auth.ts
  -> write tests
  -> mark: ### PROMPT 1 COMPLETED
        |
        v
## Prompt 2 [DATABASE] — Create users table migration
  -> apply Database Agent rules
  -> write db/migrations/20260301_create_users.sql
  -> write rollback migration
  -> update src/types/db.ts
  -> mark: ### PROMPT 2 COMPLETED
        |
        v
## Prompt 3 [SECURITY] — Audit session 1 output
  -> apply Security Agent rules
  -> review all files written in prompts 1 and 2
  -> write Security/security-report-Session1.md
  -> fix all CRITICAL findings immediately
  -> mark: ### PROMPT 3 COMPLETED
        |
        v
## Prompt 4 [MANAGER] — Review and summarize
  -> apply Manager Agent rules
  -> verify checklist completion
  -> write Logs/summary-Session1.md
  -> update ROADMAP.md
  -> write Sessions/followup-Session1.md if gaps found
  -> mark: ### PROMPT 4 COMPLETED
        |
        v
Claude process exits -> run-sessions.js records success
```

***

## How a Run Works

1. `/start` is issued in Discord
2. `discord-bot.js` validates all session files. If any file fails validation, the run is blocked.
3. `discord-bot.js` spawns `run-sessions.js` as a child process.
4. `run-sessions.js` reads `.progress.json` to skip already-completed sessions.
5. For each remaining session, it builds a combined prompt (`CLAUDE.md` + session file), pipes it to `claude --print` via stdin, and waits for the process to exit.
6. On success, the session is marked complete in `.progress.json`.
7. Between sessions, the runner sleeps for the configured pause duration (default: 6 hours) to stay within Claude's 5-hour rolling rate-limit window.
8. After all sessions complete, `discord-bot.js` optionally runs a security fix pass where Claude reads all reports in `Security/` and fixes every finding.
9. The run is archived: logs, security reports, and session outputs are moved to `Archive/run-YYYY-MM-DDTHH-MM-SS/`.

If the process crashes or is stopped at any point, re-issuing `/start` or running `node run-sessions.js` resumes from the last incomplete session. Use `/start reset:true` or `node run-sessions.js --reset` to start over from Session 1.

***

## Discord Commands

| Command | Description |
|---|---|
| `/setup` | Creates directories, CLAUDE.md, Session1.md template, writes calculated timeouts |
| `/start` | Starts run-sessions.js, optionally with `reset:true` to wipe progress |
| `/restart` | Restarts run-sessions.js, keeping completed sessions |
| `/stop` | Kills run-sessions.js and/or the security fix process |
| `/status` | Shows per-session completion status, durations, and timestamps |
| `/logs` | Prints the last N lines of the current log file |
| `/detect-sessions` | Parses all session files and shows prompt breakdown with token estimates |
| `/validate-sessions` | Validates all session files against template rules before a run |
| `/rate-limit` | Shows estimated token usage vs. your plan's 5-hour budget |
| `/security-status` | Lists all findings across all security reports |
| `/start-resolve-security` | Manually triggers the Claude security fix pass |
| `/settings show` | Displays all current settings |
| `/settings set` | Changes a setting, e.g. `runner.pauseMinutes` to `120` |
| `/settings reset` | Restores all settings to defaults |
| `/archive now` | Archives the current run immediately |
| `/archive list` | Lists all archived runs |
| `/archive prune` | Deletes old archives, keeping the last N |
| `/new-session` | Creates a new Session N.md from template |
| `/help` | Lists all commands |

***

## Settings Reference

| Key | Default | Description |
|---|---|---|
| `runner.defaultModel` | `claude-opus-4-5` | Model used when no prompt-level override is set |
| `runner.maxTurns` | `200` | Maximum turns per session when writing override blocks |
| `runner.pauseMinutes` | `360` | Pause between sessions in minutes (6 hours) |
| `runner.claudePlan` | `max20` | Your plan: `pro`, `max5`, or `max20` |
| `runner.autoSecurityFix` | `true` | Automatically run security fix after all sessions complete |
| `runner.archiveOnComplete` | `true` | Automatically archive after a successful run |
| `bot.webhookUrl` | `""` | Webhook URL for run-sessions.js notifications |

***

## Rate Limits

Claude enforces a rolling 5-hour token window. Approximate limits per plan:

| Plan | Output tokens per 5h | Prompts per 5h |
|---|---|---|
| Pro ($20/mo) | ~44,000 | ~40 |
| Max 5x ($100/mo) | ~88,000 | ~225 |
| Max 20x ($200/mo) | ~220,000 | ~900 |

The runner uses 80% of the budget as a safety margin. If your sessions exceed one window, it will warn you via Discord and space sessions further apart. The default 6-hour pause between sessions is intentionally conservative. If you have a Max 20x plan with small sessions, you can safely reduce `runner.pauseMinutes` to 30-60.

***

## Security Risks

`--dangerously-skip-permissions` is passed to every Claude invocation. This flag instructs Claude CLI to execute file system operations, run commands, and write files without asking for confirmation. Claude will have write access to the entire `PROJECT_DIR` tree (the parent of `BASE_DIR`) and can create, modify, or delete files freely.

You must be aware of the following:

- Never point `PROJECT_DIR` at a directory containing production credentials, `.env` files with live secrets, or infrastructure configuration you cannot afford to lose. Use a dedicated working directory.
- The security fix pass reads all reports in `Security/` and instructs Claude to fix every finding. Claude will write code. Review the output in `Security/fix-output-*.md` before deploying anything.
- Session prompts are piped directly to Claude via stdin. If your session files are sourced from untrusted input, Claude will execute whatever instructions they contain with full file system access.
- The Discord bot does not implement authentication beyond channel restriction. Anyone who can post in the configured channel can start, stop, reset, and modify settings. Restrict channel access accordingly.
- `settings.json` is stored in plain text. If it contains your bot token or webhook URL, protect the directory with appropriate file system permissions.

***

## What to Watch Out For

**Timeout sizing**: The default timeout per session is the sum of all prompt `timeoutMs` values plus 10 minutes. If Claude is doing heavy code generation, a 2-hour per-prompt timeout may still expire. Monitor `/logs` and increase `timeoutMs` in the session override block if you see `SIGTERM` exits.

**Progress file**: `.progress.json` is the only thing that prevents sessions from re-running on restart. Do not delete it mid-run. If it becomes corrupted, use `/reset confirm:yes` to start clean.

**Session file encoding**: Save all `Session*.md` files as UTF-8 without BOM. Windows editors sometimes add a BOM, which will confuse the override block parser.

**Prompt separators**: Each prompt must end with a `---` separator on its own line. The validator checks for this, but a missing separator causes the parser to merge two prompts into one, which results in incorrect turn and timeout calculations.

**CLAUDE.md scope**: The contents of `CLAUDE.md` are prepended to every session prompt. Keep it focused on universal agent rules. Session-specific instructions belong in the session file itself.

**Archive pruning**: By default, only the last 5 archives are kept. If you need to retain more history, increase this or copy archives elsewhere before pruning.

**Output size**: Claude's stdout is buffered in memory (`maxBuffer: 200 MB`). Very long sessions generating large amounts of code can hit this limit. If you see buffer errors, split the session into two smaller ones.

***

## Best Usage

**Write small, focused sessions.** A session that does one well-defined thing is more reliable than one that attempts an entire feature set. Prefer 3-5 prompts per session, each with a clear completion checklist Claude can verify itself.

**End every session with a Security and Manager prompt.** The Security Agent catches issues while the context is fresh. The Manager Agent writes the summary and follow-up file, which makes planning the next session trivial.

**Use the cheapest model that works.** Prompt titles containing keywords like "roadmap update" or "section update" are automatically routed to Sonnet instead of Opus. Extend `LIGHTWEIGHT_KEYWORDS` in `run-sessions.js` for your own lightweight prompt types.

**Validate before every run.** Always run `/validate-sessions` before `/start`, especially after editing session files. A malformed file will block the start rather than silently corrupt the run.

**Set the correct plan.** Run `/setup plan:Max 20x` once. The system calculates and writes correct timeout values into every session override block. Re-run `/setup` if you change plans or add sessions.

**Keep `CLAUDE.md` opinionated.** A strong `CLAUDE.md` with explicit coding standards, file naming conventions, and error handling rules produces consistent output across sessions and significantly reduces security findings.

**Review before deploying.** After a run completes, read every file in `Security/` and the `fix-output-*.md` before pushing any generated code to a production branch. The automated fix pass addresses findings but does not replace a human review.