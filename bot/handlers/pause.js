import { EmbedBuilder } from "discord.js";
import { isPaused, setPaused, isRunning } from "../state.js";

export async function handlePause(interaction) {
  if (!isRunning()) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Nothing to pause")
          .setDescription("No run is currently active.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  if (isPaused()) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Already paused")
          .setDescription("The run is already paused. Use `/resume` to continue.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  setPaused(true);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Run paused")
        .setDescription(
          "The current session will finish, then the run will pause.\n" +
          "Use `/resume` to continue.",
        )
        .setColor(0xfee75c)
        .setTimestamp(),
    ],
  });
}

export async function handleResume(interaction) {
  if (!isPaused()) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Not paused")
          .setDescription("The run is not currently paused.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  setPaused(false);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Run resumed")
        .setDescription("The run will continue with the next session.")
        .setColor(0x57f287)
        .setTimestamp(),
    ],
  });
}
