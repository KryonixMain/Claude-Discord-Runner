# Session File Format

Complete reference for writing `Session*.md` files.

---

## Overview

Session files are Markdown documents that contain structured prompts for Claude. They live in the `Sessions/` directory and follow the naming convention `Session1.md`, `Session2.md`, etc.

Each session file is processed by `run-sessions.js`, which:
1. Parses the override block (if present)
2. Strips the override block from the content
3. Prepends `CLAUDE.md` (agent instructions)
4. Pipes the combined prompt to Claude CLI via stdin

---

## Basic Structure

```markdown
# Session 1 — Task Overview

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: `### PROMPT X COMPLETED`

---

## Prompt 1 — Description of first task

[AGENT_ROLE]

Detailed instructions for Claude...

**Completion checklist:**
- [ ] Item 1
- [ ] Item 2

---

## Prompt 2 — Description of second task

[AGENT_ROLE]

More instructions...

---
```

### Required elements

| Element | Format | Purpose |
|---|---|---|
| Session header | `# Session N — Title` | Identifies the session. `N` must match the filename. |
| Instruction block | `Do NOT wait for user input...` | Tells Claude to run autonomously. |
| Prompt headers | `## Prompt N — Title` | Separates individual tasks. Numbers must be sequential (1, 2, 3...). |
| Agent role tag | `[FULLSTACK]`, `[DATABASE]`, etc. | Activates an agent role defined in CLAUDE.md. |
| Separator | `---` | Marks the end of each prompt section. |

---

## Override Block

An optional JSON configuration block at the top of the file that controls per-session and per-prompt settings. It is stripped before sending to Claude.

### HTML comment format (recommended)

```markdown
<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 3600000,
    "defaultModel": "claude-opus-4-6",
    "dependsOn": ["Session1"]
  },
  "prompts": {
    "1": { "model": "claude-opus-4-6", "maxTurns": 80, "timeoutMs": 7200000 },
    "2": { "model": "claude-sonnet-4-5", "maxTurns": 25, "timeoutMs": 1800000 }
  }
}
-->
```

### Fenced JSON format (alternative)

````markdown
```json
{
  "session": { ... },
  "prompts": { ... }
}
```
````

### Override fields

#### session.*

| Field | Type | Description |
|---|---|---|
| `session.pauseAfterMs` | number | Override pause time after this session (milliseconds). |
| `session.defaultModel` | string | Default model for all prompts in this session. |
| `session.dependsOn` | string[] | List of session names that must complete before this one runs. |

#### prompts.*

Per-prompt overrides keyed by prompt number (as string):

| Field | Type | Description |
|---|---|---|
| `prompts.N.model` | string | Model for this specific prompt. |
| `prompts.N.maxTurns` | number | Maximum turns for this prompt. |
| `prompts.N.timeoutMs` | number | Timeout in milliseconds for this prompt. |

### Override precedence

Settings are merged in this order (later wins):

1. **Global defaults** — `DEFAULT_PROMPT_CONFIG` in run-sessions.js (Opus, 80 turns, 2h timeout)
2. **Lightweight keyword override** — if prompt title contains "roadmap update", "section update", or "module update" → auto-route to Sonnet (25 turns, 45min)
3. **Session-level override** — `session.defaultModel` applies to all prompts
4. **Prompt-level override** — `prompts.N.*` overrides everything for that specific prompt

---

## Session Dependencies

Sessions can declare dependencies on other sessions using the `dependsOn` field:

```json
{
  "session": {
    "dependsOn": ["Session1", "Session2"]
  }
}
```

When a session has unmet dependencies (those sessions haven't completed yet), it is skipped with a notification. This is useful when sessions can't run until prerequisite work is done.

With parallel execution enabled, independent sessions (no dependencies or all dependencies met) can run concurrently.

---

## Agent Role Tags

Each prompt should be tagged with an agent role. These roles are defined in `CLAUDE.md`:

| Tag | Agent | Purpose |
|---|---|---|
| `[FULLSTACK]` | Fullstack Agent | Frontend components, API routes, TypeScript |
| `[DATABASE]` | Database Agent | Migrations, schemas, queries |
| `[SECURITY]` | Security Agent | Read-only audit, writes reports (never modifies code) |
| `[MANAGER]` | Manager Agent | Reviews output, writes summaries, creates follow-up prompts |

### Prompt structure per agent

**Fullstack prompt:**
```markdown
## Prompt 1 — Implement user profile

[FULLSTACK]

Create a user profile page:
1. Component at src/components/UserProfile.tsx
2. API route at src/routes/users.ts
3. Tests at src/components/UserProfile.test.ts

**Completion checklist:**
- [ ] Component renders user data
- [ ] API route validates input
- [ ] Tests cover happy path and errors
```

**Security prompt:**
```markdown
## Prompt 3 — Security audit

[SECURITY]

Review ALL files created or modified in Prompts 1 and 2.
Write the report to Security/security-report-Session1.md

---
```

**Manager prompt:**
```markdown
## Prompt 4 — Session summary

[MANAGER]

Review session output for completeness.
Write summary to Logs/summary-Session1.md
Update ROADMAP.md with current status.

---
```

---

## Completion Markers

Claude marks each completed prompt with:

```
### PROMPT X COMPLETED
```

The runner detects these markers in real-time to:
- Track per-prompt progress
- Save prompt checkpoints to `.progress.json`
- Send webhook notifications
- Write per-prompt output files

---

## Lightweight Prompt Routing

Prompt titles containing certain keywords are automatically routed to Sonnet (cheaper, faster):

| Keyword | Model | Max Turns | Timeout |
|---|---|---|---|
| `roadmap update` | claude-sonnet-4-5 | 25 | 45 min |
| `section update` | claude-sonnet-4-5 | 25 | 45 min |
| `module update` | claude-sonnet-4-5 | 25 | 45 min |

To add custom keywords, edit `LIGHTWEIGHT_KEYWORDS` in `run-sessions.js`.

---

## Validation Rules

Run `/validate-sessions` to check all session files. The validator checks:

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

---

## Best Practices

1. **Tag every prompt** with its agent role
2. **Include a completion checklist** — Claude uses it to self-verify
3. **Be specific about file paths** — reduces ambiguity
4. **End every session with `[SECURITY]` + `[MANAGER]`** — catches issues while context is fresh
5. **Keep sessions focused** — 3-5 prompts per session, one feature per session
6. **Always end prompts with `---`** — missing separators break timeout calculations

### Anti-patterns

- Vague prompts ("make it better") — Claude needs concrete requirements
- Mixing unrelated features in one session — makes debugging harder
- Skipping Security prompts — CRITICAL issues compound
- Sessions with 10+ prompts — more likely to timeout
- Missing `---` separators — merges prompts, breaks calculations

---

## Complete Example

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

# Session 1 — User Authentication

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
3. Add JWT handling in `src/lib/auth.ts`
4. Create `src/components/Login.test.ts`

**Completion checklist:**
- [ ] Login.tsx renders email + password form
- [ ] POST /api/auth/login returns JWT on valid credentials
- [ ] Invalid credentials return 401
- [ ] Tests cover happy path and error cases

---

## Prompt 2 — Create users table

[DATABASE]

1. Write migration `db/migrations/20260301_create_users.sql`
2. Write rollback migration
3. Create `src/db/queries/users.ts`
4. Update `src/types/db.ts`

**Completion checklist:**
- [ ] Forward migration creates users table
- [ ] Rollback migration drops the table
- [ ] Queries use parameterized statements
- [ ] Types match schema

---

## Prompt 3 — Security audit

[SECURITY]

Review ALL files from Prompts 1 and 2.
Write report to Security/security-report-Session1-auth.md

---

## Prompt 4 — Session summary

[MANAGER]

Review session output. Write summary to Logs/summary-Session1.md.
If any checklist items are incomplete, write follow-up prompts.

---
```
