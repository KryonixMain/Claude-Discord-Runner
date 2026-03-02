import { EmbedBuilder } from "discord.js";
import { loadState, saveState } from "../lib/helpers.js";
import { startRunProcess } from "../process.js";
import { isRunning } from "../state.js";

export async function handleRetry(interaction) {
  await interaction.deferReply();

  const sessionNum = interaction.options.getInteger("session");
  const sessionKey = `Session${sessionNum}`;

  if (isRunning()) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Cannot retry")
          .setDescription("A run is already in progress. Use `/stop` first.")
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const state = loadState();
  const idx = state.completedSessions?.indexOf(sessionKey) ?? -1;

  if (idx === -1) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Session not completed")
          .setDescription(`\`${sessionKey}\` has not been completed yet — nothing to retry.`)
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  // Remove from completed so it will run again
  state.completedSessions.splice(idx, 1);
  delete state[`${sessionKey}_completedAt`];
  delete state[`${sessionKey}_durationMs`];
  saveState(state);

  await startRunProcess(["--session", String(sessionNum)], interaction.channel);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Retrying ${sessionKey}`)
        .setDescription(
          `${sessionKey} has been removed from completed sessions and will re-run now.`,
        )
        .setColor(0x57f287)
        .setTimestamp(),
    ],
  });
}
