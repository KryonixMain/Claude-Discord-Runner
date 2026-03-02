import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync } from "fs";
import { getLatestLogFile } from "../lib/helpers.js";

export async function handleLogs(interaction) {
  await interaction.deferReply();

  const lineCount = interaction.options.getInteger("lines") ?? 20;
  const logFile   = getLatestLogFile();

  if (!logFile || !existsSync(logFile)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Logs")
          .setDescription("No log file found. Start a run first.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const lines = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const tail  = lines.slice(-lineCount).join("\n");
  const trimmed = tail.length > 3800 ? "…" + tail.slice(-3800) : tail;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Logs — last ${lineCount} lines`)
        .setDescription(`\`\`\`\n${trimmed || "(empty)"}\n\`\`\``)
        .addFields({ name: "File", value: `\`${logFile}\``, inline: false })
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });
}
