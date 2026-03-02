# Getting Started

Step-by-step guide to set up Claude Runner from scratch.

---

## 1. Prerequisites

- **Node.js 18+** — [download](https://nodejs.org/)
- **Claude CLI** — installed globally:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
- **Active Claude subscription** — Pro ($20/mo), Max 5x ($100/mo), or Max 20x ($200/mo)
- **Discord application** with a bot token and webhook URL

---

## 2. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** — give it a name (e.g. "Claude Runner")
3. Go to the **Bot** tab:
   - Click **Reset Token** — copy and save the token (you'll need it later)
   - Enable **Message Content Intent** under Privileged Gateway Intents
4. Go to the **OAuth2** tab:
   - Copy the **Client ID** (also called Application ID)
5. Under **OAuth2 → URL Generator**:
   - Select scopes: `bot`, `applications.commands`
   - Select bot permissions: `Send Messages`, `Embed Links`, `Read Message History`, `View Channels`
   - Copy the generated URL and open it in your browser to invite the bot to your server

---

## 3. Create a Discord Webhook

1. In your Discord server, go to the channel where you want notifications
2. Click the gear icon → **Integrations** → **Webhooks** → **New Webhook**
3. Name it (e.g. "Claude Runner Notifications")
4. Copy the webhook URL
5. Note the **Channel ID**: right-click the channel → **Copy Channel ID**
   (Enable Developer Mode in Discord Settings → Advanced if you don't see this option)

---

## 4. Clone and Install

```bash
git clone https://github.com/your-username/claude-runner.git
cd claude-runner
npm install
```

---

## 5. Configure Settings

Copy the example settings file and fill in your credentials:

```bash
cp bot/settings.example.json bot/settings.json
```

Edit `bot/settings.json`:

```json
{
  "bot": {
    "token": "YOUR_BOT_TOKEN",
    "clientId": "YOUR_CLIENT_ID",
    "channelId": "YOUR_CHANNEL_ID",
    "guildId": "",
    "webhookUrl": "YOUR_WEBHOOK_URL",
    "locale": "en-US"
  },
  "runner": {
    "defaultModel": "claude-opus-4-5",
    "maxTurns": 200,
    "pauseMinutes": 360,
    "claudePlan": "max20",
    "skipPermissions": true,
    "autoSecurityFix": true,
    "archiveOnComplete": true,
    "workDir": ""
  },
  "sessions": { "count": 4 },
  "logging": { "keepLogs": 10 },
  "dashboard": { "port": 3000 }
}
```

### Required fields

| Field | Where to find it |
|---|---|
| `bot.token` | Discord Developer Portal → Bot → Token |
| `bot.clientId` | Discord Developer Portal → OAuth2 → Client ID |
| `bot.channelId` | Right-click channel → Copy Channel ID |
| `bot.webhookUrl` | Channel Settings → Integrations → Webhooks |

### Choose your plan

Set `runner.claudePlan` to match your Claude subscription:

| Plan | Value | Monthly cost |
|---|---|---|
| Pro | `"pro"` | $20/mo |
| Max 5x | `"max5"` | $100/mo |
| Max 20x | `"max20"` | $200/mo |

---

## 6. First Run

```bash
node index.js
```

This starts both the Discord bot and the web dashboard. You should see:

```
[Bot] Logged in as YourBot#1234
[Bot] Slash commands registered (guild: ...)
[Bot] Webhook health check passed
[Dashboard] listening on http://localhost:3000
```

---

## 7. Run `/setup` in Discord

In your configured Discord channel, type:

```
/setup plan:Max 20x
```

This creates:
- `Sessions/` directory with a `Session1.md` template
- `Logs/`, `Security/`, `Archive/` directories
- `CLAUDE.md` with agent instructions and your working directory
- Calculated timeout values based on your plan

---

## 8. Write Your First Session

Edit `Sessions/Session1.md`. A minimal session looks like:

```markdown
# Session 1 — My First Task

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: `### PROMPT X COMPLETED`

---

## Prompt 1 — Create hello world

[FULLSTACK]

Create a file called hello.txt with the text "Hello from Claude Runner!"

**Completion checklist:**
- [ ] hello.txt exists with the correct content

---
```

---

## 9. Validate and Start

```
/validate-sessions    ← check for format errors
/dry-run              ← estimate tokens without executing
/start                ← begin execution
```

---

## 10. Monitor Progress

- **Discord**: `/status`, `/logs`, `/rate-limit`
- **Dashboard**: Open `http://localhost:3000` in your browser
- **Webhook**: Automatic notifications for every session event

---

## Next Steps

- Read the [Session File Format](session-format.md) guide for advanced prompt writing
- Check the [Configuration Reference](configuration.md) for all available settings
- See the [Architecture](architecture.md) overview to understand how components fit together
- Run `/help` in Discord for a full command list
