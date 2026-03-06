import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { LOG_DIR } from "../lib/paths.js";

export async function handleExportLogs(interaction) {
  await interaction.deferReply();

  if (!existsSync(LOG_DIR)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No logs")
          .setDescription("Log directory does not exist.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const logFiles = readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"));

  if (logFiles.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No logs")
          .setDescription("No log files found.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  let combined = "";
  for (const f of logFiles.sort()) {
    const content = readFileSync(join(LOG_DIR, f), "utf8");
    combined += `\n${"=".repeat(60)}\n${f}\n${"=".repeat(60)}\n${content}\n`;
    if (combined.length > 8_000_000) {
      combined += "\n... (truncated — file size limit reached)";
      break;
    }
  }

  const attachment = new AttachmentBuilder(Buffer.from(combined, "utf8"), {
    name: `logs-${new Date().toISOString().slice(0, 10)}.txt`,
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Logs exported")
        .addFields(
          { name: "Files", value: String(logFiles.length), inline: true },
          { name: "Size",  value: `${(combined.length / 1024).toFixed(1)} KB`, inline: true },
        )
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
    files: [attachment],
  });
}
