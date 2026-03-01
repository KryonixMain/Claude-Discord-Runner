import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ########################################################################### Config ###########################################################################

function resolveWebhookUrl() {
  if (process.env.DISCORD_WEBHOOK_URL) return process.env.DISCORD_WEBHOOK_URL;

  const settingsPath = join(__dirname, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (s?.bot?.webhookUrl) return s.bot.webhookUrl;
    } catch {
      /* ignore */
    }
  }

  return null;
}

function resolveConfig() {
  const settingsPath = join(__dirname, "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

// ########################################################################### Constants ###########################################################################

export const COLORS = {
  info: 0x5865f2, // Discord blue
  success: 0x57f287, // Green
  warning: 0xfee75c, // Yellow
  error: 0xed4245, // Red
  start: 0xeb459e, // Pink
  purple: 0x9b59b6, // Purple
  orange: 0xe67e22, // Orange
};

const BOT_NAME = "Claude Runner";
const AVATAR_URL = "https://cdn.discordapp.com/embed/avatars/0.png";

// ########################################################################### Core Send ###########################################################################

async function sendWebhook(payload) {
  const url = resolveWebhookUrl();

  if (!url) {
    console.warn("[Notify] DISCORD_WEBHOOK_URL not set — notification skipped");
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[Notify] Webhook failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Notify] Webhook error: ${err.message}`);
    return false;
  }
}

// ########################################################################### Public API ###########################################################################

export async function notify(message) {
  return sendWebhook({ content: message });
}

export async function notifyEmbed({
  title,
  description,
  color = "info",
  fields = [],
  footer,
  thumbnail,
} = {}) {
  const embed = {
    title,
    description,
    color: COLORS[color] ?? color ?? COLORS.info,
    fields: fields.map(({ name, value, inline = false }) => ({
      name,
      value: String(value),
      inline,
    })),
    timestamp: new Date().toISOString(),
  };

  if (footer) embed.footer = { text: footer };
  if (thumbnail) embed.thumbnail = { url: thumbnail };

  return sendWebhook({
    username: BOT_NAME,
    avatar_url: AVATAR_URL,
    embeds: [embed],
  });
}

export async function notifyEmbeds(embedsArray) {
  if (!embedsArray?.length) return false;

  const built = embedsArray.slice(0, 10).map((e) => ({
    title: e.title,
    description: e.description,
    color: COLORS[e.color] ?? e.color ?? COLORS.info,
    fields: (e.fields ?? []).map(({ name, value, inline = false }) => ({
      name,
      value: String(value),
      inline,
    })),
    timestamp: new Date().toISOString(),
    ...(e.footer ? { footer: { text: e.footer } } : {}),
    ...(e.thumbnail ? { thumbnail: { url: e.thumbnail } } : {}),
  }));

  return sendWebhook({
    username: BOT_NAME,
    avatar_url: AVATAR_URL,
    embeds: built,
  });
}

// ########################################################################### Run lifecycle ###########################################################################

export async function notifyRunStart({
  totalSessions,
  totalPrompts,
  model,
  plan,
  baseDir,
}) {
  const cfg = resolveConfig();
  return notifyEmbed({
    title: "🚀 Claude Runner — Run started",
    description: "Automatic session execution has begun.",
    color: "start",
    fields: [
      { name: "Sessions", value: totalSessions, inline: true },
      { name: "Prompts", value: totalPrompts, inline: true },
      {
        name: "Model",
        value: model ?? cfg?.runner?.defaultModel ?? "—",
        inline: true,
      },
      {
        name: "Plan",
        value: plan ?? cfg?.runner?.claudePlan ?? "—",
        inline: true,
      },
      {
        name: "Started at",
        value: new Date().toLocaleTimeString("en-US"),
        inline: true,
      },
      {
        name: "Directory",
        value: `\`${baseDir ?? __dirname}\``,
        inline: false,
      },
    ],
    footer: "Claude Runner",
  });
}

export async function notifyRunComplete({
  totalSessions,
  totalDurationMs,
  archivePath,
}) {
  const mins = totalDurationMs ? Math.floor(totalDurationMs / 60_000) : null;
  return notifyEmbed({
    title: "🎉 All sessions completed!",
    description:
      "The run finished successfully. Check completion checklists and security reports.",
    color: "success",
    fields: [
      {
        name: "Sessions completed",
        value: String(totalSessions),
        inline: true,
      },
      {
        name: "Total duration",
        value: mins != null ? `${mins} min` : "—",
        inline: true,
      },
      {
        name: "Finished at",
        value: new Date().toLocaleString("en-US"),
        inline: true,
      },
      ...(archivePath
        ? [{ name: "Archived to", value: `\`${archivePath}\``, inline: false }]
        : []),
    ],
    footer: `Claude Runner • ${new Date().toLocaleString("en-US")}`,
  });
}

export async function notifyRunFailed({ errorMsg, exitCode }) {
  return notifyEmbed({
    title: "💥 Run failed",
    description: "The run exited unexpectedly. Manual review required.",
    color: "error",
    fields: [
      { name: "Exit code", value: String(exitCode ?? "?"), inline: true },
      {
        name: "Error",
        value: `\`${String(errorMsg ?? "unknown").slice(0, 300)}\``,
        inline: false,
      },
      {
        name: "Tip",
        value:
          "Use `/restart` in Discord to resume from the last completed session.",
        inline: false,
      },
    ],
    footer: "Completed sessions will be skipped on restart",
  });
}

// ########################################################################### Session lifecycle ###########################################################################

export async function notifySessionStart({
  sessionName,
  promptCount,
  model,
  sessionIndex,
  totalSessions,
}) {
  return notifyEmbed({
    title: `▶️ ${sessionName} — Starting`,
    description: `Session ${sessionIndex ?? "?"}/${totalSessions ?? "?"} is now running.`,
    color: "info",
    fields: [
      { name: "Prompts", value: String(promptCount), inline: true },
      { name: "Model", value: model ?? "—", inline: true },
      {
        name: "Time",
        value: new Date().toLocaleTimeString("en-US"),
        inline: true,
      },
    ],
  });
}

export async function notifySessionSuccess({
  sessionName,
  durationMs,
  outputPath,
  promptsCompleted,
}) {
  const mins = Math.floor(durationMs / 60_000);
  const secs = Math.floor((durationMs % 60_000) / 1000);
  return notifyEmbed({
    title: `✅ ${sessionName} — Completed`,
    description: "Session finished successfully.",
    color: "success",
    fields: [
      { name: "Duration", value: `${mins}m ${secs}s`, inline: true },
      {
        name: "Prompts completed",
        value: String(promptsCompleted ?? "—"),
        inline: true,
      },
      {
        name: "Time",
        value: new Date().toLocaleTimeString("en-US"),
        inline: true,
      },
      ...(outputPath
        ? [{ name: "Output", value: `\`${outputPath}\``, inline: false }]
        : []),
    ],
  });
}

export async function notifySessionFailed({
  sessionName,
  errorMsg,
  outputPath,
  exitCode,
}) {
  return notifyEmbed({
    title: `❌ ${sessionName} — FAILED`,
    description: "Session ended with an error. Manual review required.",
    color: "error",
    fields: [
      { name: "Exit code", value: String(exitCode ?? "?"), inline: true },
      {
        name: "Error",
        value: `\`${String(errorMsg ?? "unknown").slice(0, 200)}\``,
        inline: false,
      },
      ...(outputPath
        ? [{ name: "Output", value: `\`${outputPath}\``, inline: false }]
        : []),
      {
        name: "Restart",
        value: "Use `/restart` to resume from this session.",
        inline: false,
      },
    ],
    footer: "Completed sessions are skipped on restart",
  });
}

export async function notifySessionSkipped({ sessionName, reason }) {
  return notifyEmbed({
    title: `⏭️ ${sessionName} — Skipped`,
    description: reason ?? "Session was already marked as completed.",
    color: "warning",
    fields: [
      {
        name: "Time",
        value: new Date().toLocaleTimeString("en-US"),
        inline: true,
      },
    ],
  });
}

// ########################################################################### Prompt lifecycle ###########################################################################

export async function notifyPromptStart({
  sessionName,
  promptIndex,
  promptTitle,
  totalPrompts,
}) {
  return notifyEmbed({
    title: `🔹 Prompt ${promptIndex}/${totalPrompts} started`,
    description: `**${sessionName}** — \`${promptTitle?.slice(0, 100) ?? "—"}\``,
    color: "info",
    fields: [
      {
        name: "Time",
        value: new Date().toLocaleTimeString("en-US"),
        inline: true,
      },
    ],
  });
}

export async function notifyPromptComplete({
  sessionName,
  promptIndex,
  totalPrompts,
  durationMs,
}) {
  const secs = Math.floor((durationMs ?? 0) / 1000);
  return notifyEmbed({
    title: `✔️ Prompt ${promptIndex}/${totalPrompts} completed`,
    description: `**${sessionName}**`,
    color: "success",
    fields: [
      { name: "Duration", value: `${secs}s`, inline: true },
      {
        name: "Time",
        value: new Date().toLocaleTimeString("en-US"),
        inline: true,
      },
    ],
  });
}

// ########################################################################### Pause / Rate-limit ###########################################################################

export async function notifyPause({ nextSession, pauseMinutes, reason }) {
  const resumeAt = new Date(Date.now() + pauseMinutes * 60_000);
  return notifyEmbed({
    title: `⏸️ Pause before ${nextSession}`,
    description:
      reason ?? "Rate-limit buffer active — waiting before next session.",
    color: "warning",
    fields: [
      { name: "Duration", value: `${pauseMinutes} min`, inline: true },
      { name: "Next session", value: nextSession, inline: true },
      {
        name: "Resume at",
        value: resumeAt.toLocaleTimeString("en-US"),
        inline: true,
      },
    ],
  });
}

export async function notifyRateLimitWarning({
  planLabel,
  usedTokens,
  budgetTokens,
  windowsNeeded,
}) {
  const pct = Math.round((usedTokens / budgetTokens) * 100);
  return notifyEmbed({
    title: "⚠️ Rate-Limit Warning",
    description: `Token usage is approaching the 5h window limit for **${planLabel}**.`,
    color: pct >= 90 ? "error" : "warning",
    fields: [
      {
        name: "Used",
        value: `~${(usedTokens / 1000).toFixed(1)}k tokens`,
        inline: true,
      },
      {
        name: "Budget",
        value: `~${(budgetTokens / 1000).toFixed(1)}k tokens`,
        inline: true,
      },
      { name: "Usage", value: `${pct}%`, inline: true },
      { name: "Windows needed", value: String(windowsNeeded), inline: true },
    ],
    footer: "Claude Runner will add automatic pauses between sessions",
  });
}

// ########################################################################### Security ###########################################################################

export async function notifySecurityAlert({
  sessionName,
  criticalCount,
  warningCount,
  reportPath,
}) {
  if (criticalCount === 0 && warningCount === 0) return false;

  return notifyEmbed({
    title: `🔴 Security findings in ${sessionName}`,
    description: "The security agent found issues that require attention.",
    color: criticalCount > 0 ? "error" : "warning",
    fields: [
      { name: "🔴 Critical", value: String(criticalCount), inline: true },
      { name: "🟡 Warnings", value: String(warningCount), inline: true },
      ...(reportPath
        ? [{ name: "Report", value: `\`${reportPath}\``, inline: false }]
        : []),
      {
        name: "Fix",
        value: "Use `/start-resolve-security` in Discord.",
        inline: false,
      },
    ],
  });
}

export async function notifySecurityFixStart({
  reportCount,
  criticalCount,
  warningCount,
}) {
  return notifyEmbed({
    title: "🔧 Security Fix started",
    description: "Claude is now processing all security violations.",
    color: "start",
    fields: [
      { name: "Reports", value: String(reportCount), inline: true },
      { name: "🔴 Critical", value: String(criticalCount), inline: true },
      { name: "🟡 Warnings", value: String(warningCount), inline: true },
    ],
    footer: "Order: 🔴 Critical → 🟡 Warning → 🔵 Info",
  });
}

export async function notifySecurityFixComplete({
  success,
  outputPath,
  exitCode,
}) {
  return notifyEmbed({
    title: success ? "✅ Security Fix completed" : "❌ Security Fix failed",
    description: success
      ? "All violations have been processed."
      : `Process exited with code ${exitCode}.`,
    color: success ? "success" : "error",
    fields: [
      ...(outputPath
        ? [{ name: "Output", value: `\`${outputPath}\``, inline: false }]
        : []),
    ],
  });
}

// ########################################################################### Validation ###########################################################################

export async function notifyValidationFailed({ failedFiles }) {
  const lines = failedFiles
    .map((f) => `**${f.file}**\n${f.errors.map((e) => `  🔴 ${e}`).join("\n")}`)
    .join("\n\n");

  return notifyEmbed({
    title: "🚫 Startup blocked — Validation failed",
    description: `Session files contain errors and must be fixed before the run can start.\n\n${lines}`,
    color: "error",
    footer: "Use /validate-sessions for details",
  });
}

export async function notifyValidationPassed({ sessionCount, totalPrompts }) {
  return notifyEmbed({
    title: "✅ Validation passed",
    description: "All session files are valid and ready to run.",
    color: "success",
    fields: [
      { name: "Sessions", value: String(sessionCount), inline: true },
      { name: "Prompts", value: String(totalPrompts), inline: true },
    ],
  });
}

// ########################################################################### Archive ###########################################################################

export async function notifyArchived({ archivePath, runLabel }) {
  return notifyEmbed({
    title: "📦 Run archived",
    description: "All logs, security reports and outputs have been archived.",
    color: "info",
    fields: [
      { name: "Run", value: runLabel ?? "—", inline: true },
      { name: "Location", value: `\`${archivePath}\``, inline: false },
    ],
  });
}
