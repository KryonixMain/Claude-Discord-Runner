import { EmbedBuilder } from "discord.js";
import { validateAllSessions } from "../lib/session-validator.js";
import { notifyValidationPassed, notifyValidationFailed } from "../../discord-notify.js";

export async function handleValidateSessions(interaction) {
  await interaction.deferReply();
  const { allValid, results, globalError } = validateAllSessions();

  if (globalError) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Validate Sessions").setDescription(globalError).setColor(0xed4245).setTimestamp()],
    });
    return;
  }

  const passCount = results.filter((r) => r.valid).length;
  const failCount = results.length - passCount;
  const warnCount = results.reduce((s, r) => s + r.warnings.length, 0);

  const embeds = [
    new EmbedBuilder()
      .setTitle(allValid ? "All sessions valid" : "Validation failed")
      .setDescription(results.map((r) => {
        const icon = r.valid ? "✅" : "❌";
        const warn = r.warnings.length > 0 ? ` ⚠️ ${r.warnings.length} warning(s)` : "";
        const err  = !r.valid ? ` — ${r.errors.length} error(s)` : "";
        return `${icon} **${r.file}**${err}${warn}`;
      }).join("\n"))
      .addFields(
        { name: "Passed",       value: String(passCount), inline: true },
        { name: "Failed",       value: String(failCount), inline: true },
        { name: "Warnings",     value: String(warnCount), inline: true },
        { name: "Start blocked", value: allValid ? "No — ready to run" : "Yes — fix errors first", inline: false },
      )
      .setColor(allValid ? 0x57f287 : 0xed4245)
      .setTimestamp(),
  ];

  for (const r of results) {
    if (r.errors.length === 0 && r.warnings.length === 0) continue;
    const lines = [...r.errors.map((e) => `🔴 ${e}`), ...r.warnings.map((w) => `🟡 ${w}`)];
    embeds.push(
      new EmbedBuilder()
        .setTitle(`${r.valid ? "⚠️" : "❌"} ${r.file}`)
        .setDescription(lines.join("\n"))
        .setColor(r.valid ? 0xfee75c : 0xed4245),
    );
    if (embeds.length >= 10) break;
  }

  const totalPrompts = results.reduce((s, r) => s + (r.prompts?.length ?? 0), 0);
  if (allValid) {
    notifyValidationPassed({ sessionCount: results.length, totalPrompts });
  } else {
    notifyValidationFailed({ failedFiles: results.filter((r) => !r.valid) });
  }

  await interaction.editReply({ embeds });
}
