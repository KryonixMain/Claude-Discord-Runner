import { EmbedBuilder } from "discord.js";
import { writeFileSync } from "fs";
import { STATE_FILE } from "../lib/paths.js";
import { isRunning, getRunningProcess, setRunningProcess } from "../state.js";
import { startRunProcess } from "../process.js";
import { killProcessGracefully } from "../lib/helpers.js";

export async function handleReset(interaction) {
  await interaction.deferReply();
  const confirm = interaction.options.getString("confirm");

  if (confirm?.toLowerCase() !== "yes") {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Reset — not confirmed")
          .setDescription("Pass `confirm: yes` to clear progress and restart from Session 1.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (isRunning()) {
    await killProcessGracefully(getRunningProcess(), "run-sessions.js");
    setRunningProcess(null);
  }

  writeFileSync(STATE_FILE, JSON.stringify({ completedSessions: [] }, null, 2));
  startRunProcess(["--reset"], interaction.channel);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Progress reset — starting from Session 1")
        .setDescription(
          "`.progress.json` has been cleared.\n" +
          "run-sessions.js restarted from the beginning.",
        )
        .setColor(0xed4245)
        .setTimestamp(),
    ],
  });
}
