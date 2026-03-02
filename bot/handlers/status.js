import { EmbedBuilder } from "discord.js";
import { loadState, formatDuration, sessionKey } from "../lib/helpers.js";
import { detectSessions } from "../lib/session-parser.js";
import { isRunning, isSecurityFixRunning } from "../state.js";
import { getSetting } from "../lib/settings.js";

export async function handleStatus(interaction) {
  await interaction.deferReply();

  const state    = loadState();
  const detected = detectSessions();
  const running  = isRunning();
  const fixing   = isSecurityFixRunning();

  if (detected.error) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Status")
          .setDescription(detected.error)
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const rows = detected.sessions.map((s) => {
    const key         = sessionKey(s.file);
    const done        = state.completedSessions?.includes(key);
    const completedAt = state[`${key}_completedAt`];
    const durationMs  = state[`${key}_durationMs`];
    const icon = done ? "✅" : (running ? "⏳" : "⬜");
    const meta = done
      ? `${completedAt ? new Date(completedAt).toLocaleString(getSetting("bot", "locale") || "en-US") : "—"} (${durationMs ? formatDuration(durationMs) : "—"})`
      : "—";
    return `${icon} **${s.file}** — ${s.promptCount} prompt(s) | ${meta}`;
  });

  const completedCount = state.completedSessions?.length ?? 0;
  const totalCount     = detected.sessions.length;

  const statusLine = fixing
    ? "Security Fix running"
    : running
      ? `Running — ${completedCount}/${totalCount} sessions done`
      : completedCount >= totalCount
        ? "Completed"
        : completedCount > 0
          ? `Paused — ${completedCount}/${totalCount} sessions done`
          : "Idle";

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Session Status")
        .setDescription(rows.join("\n") || "No sessions found.")
        .addFields(
          { name: "Status",    value: statusLine,            inline: true },
          { name: "Progress",  value: `${completedCount}/${totalCount}`, inline: true },
          { name: "Model",     value: getSetting("runner", "defaultModel"), inline: true },
        )
        .setColor(running ? 0x57f287 : fixing ? 0xeb459e : 0x5865f2)
        .setTimestamp(),
    ],
  });
}
