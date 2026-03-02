import { EmbedBuilder } from "discord.js";
import { getSetting } from "../lib/settings.js";

export async function handleDashboard(interaction) {
  const port = parseInt(getSetting("dashboard", "port")) || 3000;
  const url  = `http://localhost:${port}`;

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Web Dashboard")
        .setDescription([
          `The dashboard is available at:`,
          `**${url}**`,
          "",
          "Features:",
          "- Live session status and progress",
          "- Log viewer with auto-refresh",
          "- Command buttons (Start, Stop, Pause, Resume, ...)",
          "- Token budget overview",
          "- Security report summary",
          "- Settings viewer",
          "- Git changes tracker",
        ].join("\n"))
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });
}
