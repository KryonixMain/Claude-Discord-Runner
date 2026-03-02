import { EmbedBuilder } from "discord.js";
import { loadSecurityReports, countFindings } from "../lib/helpers.js";
import { startSecurityFix } from "../process.js";
import { isSecurityFixRunning } from "../state.js";
import { SECURITY_DIR } from "../lib/paths.js";

export async function handleSecurity(interaction) {
  await interaction.deferReply();
  const cmd = interaction.commandName;

  if (cmd === "security-status") {
    const reports = loadSecurityReports();

    if (reports.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Security Status")
            .setDescription(`No security reports found in \`${SECURITY_DIR}\`.`)
            .setColor(0x57f287)
            .setTimestamp(),
        ],
      });
      return;
    }

    let totalC = 0, totalW = 0, totalI = 0;
    const reportLines = reports.map((r) => {
      const c = countFindings(r.content, "CRITICAL");
      const w = countFindings(r.content, "WARNING");
      const i = countFindings(r.content, "INFO");
      totalC += c; totalW += w; totalI += i;
      return `**${r.name}** — 🔴 ${c} CRITICAL  🟡 ${w} WARNING  🔵 ${i} INFO`;
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Security Status")
          .setDescription(reportLines.join("\n"))
          .addFields(
            { name: "Total CRITICAL", value: String(totalC), inline: true },
            { name: "Total WARNING",  value: String(totalW), inline: true },
            { name: "Total INFO",     value: String(totalI), inline: true },
            { name: "Reports",        value: String(reports.length), inline: true },
          )
          .setColor(totalC > 0 ? 0xed4245 : totalW > 0 ? 0xfee75c : 0x57f287)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (cmd === "start-resolve-security") {
    if (isSecurityFixRunning()) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Security Fix already running")
            .setDescription("Wait for the current fix pass to finish before starting another.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
      return;
    }

    const reports = loadSecurityReports();
    if (reports.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No reports found")
            .setDescription(`No security reports in \`${SECURITY_DIR}\` — nothing to fix.`)
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
      return;
    }

    startSecurityFix(interaction.channel);

    const totalC = reports.reduce((s, r) => s + countFindings(r.content, "CRITICAL"), 0);
    const totalW = reports.reduce((s, r) => s + countFindings(r.content, "WARNING"), 0);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Security Fix started")
          .setDescription("Claude is now processing all security reports.")
          .addFields(
            { name: "Reports",  value: String(reports.length), inline: true },
            { name: "Critical", value: String(totalC),         inline: true },
            { name: "Warnings", value: String(totalW),         inline: true },
          )
          .setColor(0xeb459e)
          .setTimestamp(),
      ],
    });
  }
}
