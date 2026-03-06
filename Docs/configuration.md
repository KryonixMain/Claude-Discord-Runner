# Configuration Reference

All settings for Claude Runner, documented with type, default, and usage.

---

## Settings File

Location: `bot/settings.json`

Template: `bot/settings.example.json`

Settings can be viewed and modified via:
- **Discord**: `/settings show`, `/settings set key value`, `/settings reset`
- **File**: Edit `bot/settings.json` directly (restart bot to apply)
- **Environment variables**: Override specific values (take priority over settings.json)

---

## bot.*

Bot credentials and Discord configuration.

| Key | Type | Default | Description |
|---|---|---|---|
| `bot.token` | string | `""` | Discord bot token. Get from Developer Portal → Bot → Token. |
| `bot.clientId` | string | `""` | Discord application ID. Get from Developer Portal → OAuth2. |
| `bot.channelId` | string | `""` | Channel ID where the bot listens and posts. Right-click channel → Copy ID. |
| `bot.guildId` | string | `""` | Guild (server) ID for instant command sync. Auto-derived from channel if empty. |
| `bot.webhookUrl` | string | `""` | Primary webhook URL for notifications. Channel Settings → Integrations → Webhooks. |
| `bot.locale` | string | `"en-US"` | Locale for date/time formatting in embeds. |

### bot.webhookUrls.*

Optional per-category webhook routing. If set, overrides `bot.webhookUrl` for that category.

| Key | Type | Default | Description |
|---|---|---|---|
| `bot.webhookUrls.default` | string | `""` | Webhook for general notifications. |
| `bot.webhookUrls.security` | string | `""` | Webhook for security alerts and fix notifications. |
| `bot.webhookUrls.progress` | string | `""` | Webhook for session progress updates. |

### Environment Variable Overrides

These environment variables take priority over settings.json:

| Variable | Overrides |
|---|---|
| `DISCORD_BOT_TOKEN` | `bot.token` |
| `DISCORD_CLIENT_ID` | `bot.clientId` |
| `DISCORD_CHANNEL_ID` | `bot.channelId` |
| `DISCORD_WEBHOOK_URL` | `bot.webhookUrl` |
| `CLAUDE_WORK_DIR` | `runner.workDir` |

---

## runner.*

Claude CLI execution settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `runner.defaultModel` | string | `"claude-opus-4-6"` | Default model when no per-session override is set. |
| `runner.maxTurns` | number | `200` | Maximum turns per Claude CLI invocation. |
| `runner.pauseMinutes` | number | `360` | Minutes to pause between sessions (rate-limit buffer). |
| `runner.claudePlan` | string | `"max20"` | Your Claude subscription: `"pro"`, `"max5"`, or `"max20"`. |
| `runner.skipPermissions` | boolean | `true` | Pass `--dangerously-skip-permissions` to Claude CLI. |
| `runner.autoSecurityFix` | boolean | `true` | Auto-run Claude security fix pass after all sessions complete. |
| `runner.archiveOnComplete` | boolean | `true` | Auto-archive Logs/Security/Sessions after a successful run. |
| `runner.workDir` | string | `""` | Working directory for Claude. Empty = project root. |

### Model options

| Model | ID | Best for |
|---|---|---|
| Claude Opus 4.6 | `claude-opus-4-6` | Complex coding, architecture, multi-file changes |
| Claude Sonnet 4.6 | `claude-sonnet-4-5` | Lightweight tasks, documentation, simple edits |

### Plan details

| Plan | Value | Output tokens / 5h | Recommended pause |
|---|---|---|---|
| Pro ($20/mo) | `"pro"` | ~44,000 | 360 min |
| Max 5x ($100/mo) | `"max5"` | ~88,000 | 60-120 min |
| Max 20x ($200/mo) | `"max20"` | ~220,000 | 30-60 min |

### Recommended pause times

| Scenario | pauseMinutes |
|---|---|
| Pro plan, any session size | `360` (default) |
| Max 5x, small sessions | `60` |
| Max 5x, large sessions | `120` |
| Max 20x, small sessions | `30` |
| Max 20x, large sessions | `60` |

---

## sessions.*

| Key | Type | Default | Description |
|---|---|---|---|
| `sessions.count` | number | `4` | Expected number of session files. Used by the bot to determine if all sessions are done. |

---

## logging.*

| Key | Type | Default | Description |
|---|---|---|---|
| `logging.keepLogs` | number | `10` | Number of log files to retain. Older logs are pruned. |

---

## dashboard.*

| Key | Type | Default | Description |
|---|---|---|---|
| `dashboard.port` | number | `3000` | Port for the web dashboard. Access at `http://localhost:<port>`. |

---

## runner.verification (Advanced)

Optional post-session verification commands. Run automatically after each session completes.

```json
{
  "runner": {
    "verification": {
      "commands": [
        {
          "label": "TypeScript check",
          "command": "npx",
          "args": ["tsc", "--noEmit"],
          "timeoutMs": 60000
        },
        {
          "label": "Unit tests",
          "command": "npm",
          "args": ["test"],
          "timeoutMs": 4200000
        }
      ],
      "autoStopAfter": 3
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `verification.commands[]` | array | List of commands to run after each session. |
| `commands[].label` | string | Display name for logs and reports. |
| `commands[].command` | string | The executable to run. |
| `commands[].args` | string[] | Arguments to pass. |
| `commands[].timeoutMs` | number | Timeout per command (default: 4200000). |
| `verification.autoStopAfter` | number | Stop the run after N consecutive verification failures. 0 = never stop. |

---

## runner.blastRadius (Advanced)

Optional safety limits on how many files Claude can change per session.

```json
{
  "runner": {
    "blastRadius": {
      "maxChangedFiles": 50,
      "maxDeletedFiles": 10,
      "maxDeletedLines": 500,
      "forbiddenPaths": ["package-lock.json", ".env"],
      "enforceMode": "warn"
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `maxChangedFiles` | number | `50` | Max files that can be modified in a session. |
| `maxDeletedFiles` | number | `10` | Max files that can be deleted. |
| `maxDeletedLines` | number | `500` | Max lines deleted (checked via git). |
| `forbiddenPaths` | string[] | `[]` | Files that must never be modified. |
| `enforceMode` | string | `"warn"` | `"warn"` = log warning, `"abort"` = stop the run. |

---

## Full Example

```json
{
  "bot": {
    "token": "MTIz...",
    "clientId": "1234567890",
    "channelId": "9876543210",
    "guildId": "",
    "webhookUrl": "https://discord.com/api/webhooks/...",
    "locale": "en-US",
    "webhookUrls": {
      "default": "",
      "security": "",
      "progress": ""
    }
  },
  "runner": {
    "defaultModel": "claude-opus-4-6",
    "maxTurns": 200,
    "pauseMinutes": 60,
    "autoSecurityFix": true,
    "archiveOnComplete": true,
    "claudePlan": "max20",
    "skipPermissions": true,
    "workDir": "F:/my-project"
  },
  "sessions": {
    "count": 4
  },
  "logging": {
    "keepLogs": 10
  },
  "dashboard": {
    "port": 3000
  }
}
```
