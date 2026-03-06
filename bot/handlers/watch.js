import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync, statSync } from "fs";
import { getLatestLogFile } from "../lib/helpers.js";
import { isRunning, isSecurityFixRunning } from "../state.js";

const MAX_EMBED_LEN = 3800;
const WATCH_INTERVAL_MS = 5000;
const MAX_WATCH_DURATION_MS = 30 * 60 * 1000;

const activeWatchers = new Map();

export async function handleWatch(interaction) {
  await interaction.deferReply();

  const action = interaction.options.getString("action") ?? "start";

  if (action === "stop") {
    const existing = activeWatchers.get(interaction.channelId);
    if (existing) {
      clearInterval(existing.interval);
      activeWatchers.delete(interaction.channelId);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Watch stopped")
            .setDescription("Live log streaming has been stopped.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
    } else {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Watch")
            .setDescription("No active watch in this channel.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
    }
    return;
  }

  if (activeWatchers.has(interaction.channelId)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Watch")
          .setDescription("Already watching in this channel. Use `/watch action:stop` to stop first.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (!isRunning() && !isSecurityFixRunning()) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Watch")
          .setDescription("No process is currently running. Start a run first with `/start`.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const logFile = getLatestLogFile();
  if (!logFile || !existsSync(logFile)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Watch")
          .setDescription("No log file found yet. Try again in a few seconds.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const msg = await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Watch — Live Log Stream")
        .setDescription("Starting live log stream...")
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });

  let lastSize = 0;
  let lastContent = "";
  const startedAt = Date.now();

  const interval = setInterval(async () => {
    try {
      const elapsed = Date.now() - startedAt;
      if (elapsed > MAX_WATCH_DURATION_MS || (!isRunning() && !isSecurityFixRunning())) {
        clearInterval(interval);
        activeWatchers.delete(interaction.channelId);

        const reason = elapsed > MAX_WATCH_DURATION_MS
          ? "Maximum watch duration reached (30 min)."
          : "Process has finished.";

        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("Watch ended")
              .setDescription(reason)
              .setColor(0xfee75c)
              .setTimestamp(),
          ],
        });
        return;
      }

      const currentLog = getLatestLogFile();
      if (!currentLog || !existsSync(currentLog)) return;

      const stat = statSync(currentLog);
      if (stat.size === lastSize) return;

      lastSize = stat.size;

      const content = readFileSync(currentLog, "utf8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      const tail = lines.slice(-25).join("\n");

      if (tail === lastContent) return;
      lastContent = tail;

      const trimmed = tail.length > MAX_EMBED_LEN
        ? "…" + tail.slice(-MAX_EMBED_LEN)
        : tail;

      const elapsed_m = Math.floor(elapsed / 60000);
      const elapsed_s = Math.floor((elapsed % 60000) / 1000);

      await msg.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle("Watch — Live Log Stream")
            .setDescription(`\`\`\`\n${trimmed || "(waiting for output...)"}\n\`\`\``)
            .addFields(
              { name: "Watching", value: `${elapsed_m}m ${elapsed_s}s`, inline: true },
              { name: "Status", value: isRunning() ? "Running" : (isSecurityFixRunning() ? "Security Fix" : "Idle"), inline: true },
            )
            .setColor(0x57f287)
            .setFooter({ text: "Updates every 5s • /watch action:stop to end" })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      if (err.code === 10008) {
        clearInterval(interval);
        activeWatchers.delete(interaction.channelId);
      }
    }
  }, WATCH_INTERVAL_MS);

  activeWatchers.set(interaction.channelId, { interval, startedAt });
}
