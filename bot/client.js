import { Client, EmbedBuilder, GatewayIntentBits, PermissionsBitField, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { commands } from "./commands.js";
import { getSetting } from "./lib/settings.js";
import { CLAUDE_PLANS } from "./lib/plans.js";
import { getSessionCount } from "./lib/helpers.js";
import { SETTINGS_FILE, PROJECT_DIR } from "./lib/paths.js";
import { checkWebhookHealth } from "../discord-notify.js";
import { validateConfig } from "./lib/config-validator.js";
import { loadSettings } from "./lib/settings.js";
import { auditLog } from "./lib/audit-log.js";
import { checkForUpdate } from "./lib/update-checker.js";

// ── Handlers ──────────────────────────────────────────────────────────────────
import { handleSetup }            from "./handlers/setup.js";
import { handleStart }            from "./handlers/start.js";
import { handleRestart }          from "./handlers/restart.js";
import { handleStop }             from "./handlers/stop.js";
import { handleReset }            from "./handlers/reset.js";
import { handleLogs }             from "./handlers/logs.js";
import { handleStatus }           from "./handlers/status.js";
import { handleRateLimit }        from "./handlers/rate-limit.js";
import { handleSecurity }         from "./handlers/security.js";
import { handleDetectSessions }   from "./handlers/detect-sessions.js";
import { handleNewSession }       from "./handlers/new-session.js";
import { handleSettings }         from "./handlers/settings.js";
import { handleArchive }          from "./handlers/archive.js";
import { handleValidateSessions } from "./handlers/validate-sessions.js";
import { handleHelp }             from "./handlers/help.js";
import { handleSetTimeout }       from "./handlers/set-timeout.js";
import { handleGetTimeout }       from "./handlers/get-timeout.js";
import { handleSetPause }             from "./handlers/set-pause.js";
import { handlePause, handleResume } from "./handlers/pause.js";
import { handleRetry }            from "./handlers/retry.js";
import { handleDryRun }           from "./handlers/dry-run.js";
import { handleSchedule, handleCancelSchedule } from "./handlers/schedule.js";
import { handleOverride }         from "./handlers/override.js";
import { handleDiff }             from "./handlers/diff.js";
import { handleExportLogs }       from "./handlers/export-logs.js";
import { handleGitChanges }       from "./handlers/git-changes.js";
import { handleDashboard }       from "./handlers/dashboard.js";
import { handleWatch }           from "./handlers/watch.js";
import { handleDependencyGraph } from "./handlers/dependency-graph.js";
import { handleSetupWizard }     from "./handlers/setup-wizard.js";
import { handleInfo }            from "./handlers/info.js";
import { handleCreateSession }   from "./handlers/create-session.js";
import { handleEstimate }        from "./handlers/estimate.js";
import { handleHealth }          from "./handlers/health.js";
import { handleGenerateTemplate } from "./handlers/generate-template.js";
import { handleRollback }        from "./handlers/rollback.js";
import { handleCompareSessions } from "./handlers/compare-sessions.js";
import { handleRetryPrompt }    from "./handlers/retry-prompt.js";
import { handleSetSecurity }   from "./handlers/set-security.js";

const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN  || getSetting("bot", "token");
const CLIENT_ID  = process.env.DISCORD_CLIENT_ID  || getSetting("bot", "clientId");
export const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || getSetting("bot", "channelId");

if (!BOT_TOKEN || !CLIENT_ID || !CHANNEL_ID) {
  console.error(
    "[Bot] Missing configuration!\n" +
    "Set DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CHANNEL_ID as env vars\n" +
    "or fill in bot.token / bot.clientId / bot.channelId in settings.json",
  );
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] }).catch(() => {});
      console.log(`[Bot] Slash commands registered (guild: ${guildId})`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("[Bot] Slash commands registered (global — may take up to 1h to sync)");
    }
  } catch (err) {
    console.error("[Bot] Command registration failed:", err.message);
  }
}

client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  const guildId = getSetting("bot", "guildId") || channel?.guild?.id || null;

  await registerCommands(guildId);

  if (!channel) {
    console.warn("[Bot] Could not fetch configured channel — check bot.channelId");
    return;
  }

  const me = channel.guild?.members?.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    const missing = [];
    if (!perms.has(PermissionsBitField.Flags.ViewChannel))   missing.push("ViewChannel");
    if (!perms.has(PermissionsBitField.Flags.SendMessages))  missing.push("SendMessages");
    if (!perms.has(PermissionsBitField.Flags.EmbedLinks))    missing.push("EmbedLinks");
    if (missing.length > 0) {
      console.warn(`[Bot] Missing channel permissions: ${missing.join(", ")}`);
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Permission Warning")
            .setDescription(`Bot is missing permissions in this channel:\n${missing.map((p) => `\`${p}\``).join(", ")}`)
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      }).catch(() => {});
    }
  }

  const configResult = validateConfig(loadSettings());
  if (!configResult.valid) {
    console.warn("[Bot] Config validation errors:", configResult.errors.join("; "));
  }
  if (configResult.warnings.length > 0) {
    console.warn("[Bot] Config warnings:", configResult.warnings.join("; "));
  }

  const health = await checkWebhookHealth();
  if (!health.healthy) {
    console.warn(`[Bot] Webhook health check failed: ${health.reason}`);
  } else {
    console.log("[Bot] Webhook health check passed");
  }

  const STARTUP_TITLE = "Claude Runner Bot — Online";
  let alreadySent = false;
  try {
    const recent = await channel.messages.fetch({ limit: 15 });
    alreadySent = recent.some((m) =>
      m.author.id === client.user.id &&
      m.embeds.some((e) => e.title === STARTUP_TITLE),
    );
  } catch (err) { console.warn("[Bot] Could not read message history (no permission?):", err.message); }

  if (alreadySent) {
    console.log("[Bot] Startup message already in channel — skipping");
  } else {
    const plan    = CLAUDE_PLANS[getSetting("runner", "claudePlan")] ?? CLAUDE_PLANS.max20;
    const sc      = getSessionCount();
    const model   = getSetting("runner", "defaultModel");
    const pause   = getSetting("runner", "pauseMinutes");
    const autoFix = getSetting("runner", "autoSecurityFix");
    const archive = getSetting("runner", "archiveOnComplete");

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(STARTUP_TITLE)
          .setDescription([
            "**Claude Runner Bot** is ready to execute your AI sessions automatically.",
            "",
            "## Quick Start",
            "1. Run `/setup` to create all directories and a Session1.md template",
            "2. Edit `Sessions/Session1.md` — fill in your prompts",
            "3. Run `/start` to kick off the automation",
            "",
            "## Key Commands",
            "`/setup` • `/start` • `/status` • `/logs` • `/detect-sessions`",
            "`/settings show` • `/rate-limit` • `/archive list`",
            "`/pause` • `/resume` • `/schedule` • `/dry-run` • `/git-changes`",
          ].join("\n"))
          .addFields(
            { name: "Sessions detected", value: String(sc || "—"),  inline: true },
            { name: "Default model",     value: model,              inline: true },
            { name: "Pause between",     value: `${pause} min`,     inline: true },
            { name: "Claude plan",       value: plan.label,         inline: true },
            { name: "Auto Security Fix", value: autoFix ? "Yes" : "No", inline: true },
            { name: "Auto Archive",      value: archive ? "Yes" : "No", inline: true },
            { name: "Webhook",           value: health.healthy ? "Connected" : `Unhealthy: ${health.reason}`, inline: true },
            { name: "Config file",       value: `\`${SETTINGS_FILE}\``, inline: false },
          )
          .setColor(0x5865f2)
          .setFooter({ text: "Claude Runner Bot • /help for all commands" })
          .setTimestamp(),
      ],
    });
  }

  // ── Update check ────────────────────────────────────────────────────────────
  try {
    console.log("[Bot] Checking for updates...");
    const update = await checkForUpdate();

    if (update.error) {
      console.log(`[Bot] Update check skipped: ${update.error}`);
    } else if (update.updateAvailable) {
      console.log(`[Bot] Update available: v${update.localVersion} → v${update.remoteVersion}`);

      const updateEmbed = new EmbedBuilder()
        .setTitle("New Version Available")
        .setDescription(
          `A new version of Claude Runner is available!\n\n` +
          `**Current:** v${update.localVersion}\n` +
          `**Latest:** v${update.remoteVersion}\n\n` +
          (update.remoteChangelog?.body
            ? `**What's new:**\n${update.remoteChangelog.body.slice(0, 1500)}${update.remoteChangelog.body.length > 1500 ? "\n\n*…truncated*" : ""}`
            : ""),
        )
        .setColor(0xfee75c)
        .setFooter({ text: "github.com/KryonixMain/Claude-Discord-Runner" })
        .setTimestamp();

      const updateRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("update_ignore")
          .setLabel("Ignore")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("update_now")
          .setLabel("Update")
          .setStyle(ButtonStyle.Success),
      );

      const updateMsg = await channel.send({ embeds: [updateEmbed], components: [updateRow] });

      try {
        const btnInteraction = await updateMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.customId.startsWith("update_"),
          time: 300_000,
        });

        if (btnInteraction.customId === "update_ignore") {
          await btnInteraction.update({
            embeds: [
              updateEmbed.setColor(0x99aab5).setTitle("Update Available (ignored)"),
            ],
            components: [],
          });
        } else if (btnInteraction.customId === "update_now") {
          await btnInteraction.update({
            embeds: [
              new EmbedBuilder()
                .setTitle("Updating...")
                .setDescription(
                  "Running `update.bat` — the bot will restart.\n" +
                  "This may take a moment.",
                )
                .setColor(0x57f287)
                .setTimestamp(),
            ],
            components: [],
          });

          const updateProc = spawn("cmd.exe", ["/c", "update.bat"], {
            cwd: PROJECT_DIR,
            detached: true,
            stdio: "ignore",
          });
          updateProc.unref();

          setTimeout(() => process.exit(0), 2000);
        }
      } catch {
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("update_ignore").setLabel("Ignore").setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId("update_now").setLabel("Update").setStyle(ButtonStyle.Success).setDisabled(true),
        );
        await updateMsg.edit({ components: [disabledRow] }).catch(() => {});
      }
    } else {
      console.log(`[Bot] Up to date (v${update.localVersion})`);
      // Show dev version (includes index) from package.json
      try {
        const pkg = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf8"));
        if (pkg.version && pkg.version !== update.localVersion) {
          console.log(`[Bot] Dev version: v${pkg.version}`);
        }
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn("[Bot] Update check failed:", err.message);
  }
});

const HANDLERS = {
  setup:                    handleSetup,
  start:                    handleStart,
  restart:                  handleRestart,
  stop:                     handleStop,
  reset:                    handleReset,
  logs:                     handleLogs,
  status:                   handleStatus,
  "rate-limit":             handleRateLimit,
  "security-status":        handleSecurity,
  "start-resolve-security": handleSecurity,
  "detect-sessions":        handleDetectSessions,
  "new-session":            handleNewSession,
  settings:                 handleSettings,
  archive:                  handleArchive,
  "validate-sessions":      handleValidateSessions,
  help:                     handleHelp,
  "get-timeout":            handleGetTimeout,
  "set-timeout":            handleSetTimeout,
  "set-pause":              handleSetPause,
  pause:                    handlePause,
  resume:                   handleResume,
  retry:                    handleRetry,
  "dry-run":                handleDryRun,
  schedule:                 handleSchedule,
  "cancel-schedule":        handleCancelSchedule,
  override:                 handleOverride,
  diff:                     handleDiff,
  "export-logs":            handleExportLogs,
  "git-changes":            handleGitChanges,
  dashboard:                handleDashboard,
  watch:                    handleWatch,
  "dependency-graph":       handleDependencyGraph,
  "setup-wizard":           handleSetupWizard,
  info:                     handleInfo,
  "create-session":         handleCreateSession,
  estimate:                 handleEstimate,
  health:                   handleHealth,
  "generate-template":      handleGenerateTemplate,
  rollback:                 handleRollback,
  "compare-sessions":       handleCompareSessions,
  "retry-prompt":           handleRetryPrompt,
  "set-security":           handleSetSecurity,
};

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const channelId = CHANNEL_ID || getSetting("bot", "channelId");
  if (interaction.channelId !== channelId) {
    await interaction.reply({ content: "Wrong channel.", ephemeral: true });
    return;
  }

  const handler = HANDLERS[interaction.commandName];
  if (!handler) return;
  const cmdArgs = {};
  try {
    for (const opt of interaction.options?.data ?? []) {
      if (opt.type === 1) { // Subcommand
        cmdArgs._subcommand = opt.name;
        for (const sub of opt.options ?? []) cmdArgs[sub.name] = sub.value;
      } else {
        cmdArgs[opt.name] = opt.value;
      }
    }
  } catch (err) { console.warn("[Bot] Could not parse command args for audit:", err.message); }

  try {
    await handler(interaction);
    auditLog({ command: interaction.commandName, actor: interaction.user?.tag, args: cmdArgs, outcome: "ok" });
  } catch (err) {
    auditLog({ command: interaction.commandName, actor: interaction.user?.tag, args: cmdArgs, outcome: `error: ${err.message}` });
    console.error(`[Bot] Handler error (${interaction.commandName}):`, err);
    const reply = {
      embeds: [
        new EmbedBuilder()
          .setTitle("Command failed")
          .setDescription(`\`${interaction.commandName}\` threw an error:\n\`\`\`${String(err.message).slice(0, 500)}\`\`\``)
          .setColor(0xed4245)
          .setTimestamp(),
      ],
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

export default client;
