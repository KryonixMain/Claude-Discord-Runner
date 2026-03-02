import { EmbedBuilder } from "discord.js";
import { isRunning, getRunningProcess, setRunningProcess } from "../state.js";
import { startRunProcess } from "../process.js";
import { loadState, killProcessGracefully } from "../lib/helpers.js";

export async function handleRestart(interaction) {
  await interaction.deferReply();

  if (isRunning()) {
    await killProcessGracefully(getRunningProcess(), "run-sessions.js");
    setRunningProcess(null);
  }

  const state          = loadState();
  const completedCount = state.completedSessions?.length ?? 0;

  startRunProcess([], interaction.channel);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Run restarted")
        .setDescription(
          completedCount > 0
            ? `Resuming from where it stopped.\n${completedCount} completed session(s) will be skipped.`
            : "Starting from Session 1 — no completed sessions to skip.",
        )
        .addFields({
          name:   "Completed sessions",
          value:  state.completedSessions?.join(", ") || "none",
          inline: false,
        })
        .setColor(0x57f287)
        .setTimestamp(),
    ],
  });
}
