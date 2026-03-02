import { EmbedBuilder } from "discord.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { getSetting } from "../lib/settings.js";
import { CLAUDE_PLANS } from "../lib/plans.js";

export async function handleDetectSessions(interaction) {
  await interaction.deferReply();

  const detected = detectSessions();

  if (detected.error) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Detect Sessions")
          .setDescription(detected.error)
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const planKey  = getSetting("runner", "claudePlan");
  const plan     = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const calc     = calculateSessionTimeouts(detected.sessions, planKey);

  const totalPrompts = detected.sessions.reduce((s, x) => s + x.promptCount, 0);

  const embeds = [
    new EmbedBuilder()
      .setTitle("Session Detection")
      .setDescription(`Found **${detected.sessions.length}** session(s) with **${totalPrompts}** total prompt(s).`)
      .addFields(
        { name: "Plan",            value: plan.label,                                             inline: true },
        { name: "Est. tokens",     value: `~${(calc.totalOutputTokens / 1000).toFixed(1)}k`,     inline: true },
        { name: "5h budget",       value: `~${(calc.budgetTokens / 1000).toFixed(0)}k`,          inline: true },
        { name: "Fits in 1 window",value: calc.fitsInOneWindow ? "Yes" : "No",                   inline: true },
        { name: "Windows needed",  value: String(calc.windowsNeeded),                             inline: true },
        { name: "Rec. pause",      value: `${calc.recommendedPauseMinutes} min`,                 inline: true },
      )
      .setColor(calc.fitsInOneWindow ? 0x57f287 : 0xfee75c)
      .setTimestamp(),
  ];

  for (const s of calc.sessions) {
    const promptLines = s.prompts.map((p, i) =>
      `\`[${i + 1}]\` ${p.title} — ~${(p.chars / 1000).toFixed(1)}k chars`,
    );
    embeds.push(
      new EmbedBuilder()
        .setTitle(s.file)
        .setDescription(promptLines.join("\n"))
        .addFields(
          { name: "Total chars",    value: `~${(s.totalChars / 1000).toFixed(1)}k`,           inline: true },
          { name: "Est. tokens",    value: `~${(s.outputTokens / 1000).toFixed(1)}k`,         inline: true },
          { name: "Rec. timeout",   value: `${Math.round(s.recommendedTimeoutMs / 60_000)}min`, inline: true },
        )
        .setColor(0x5865f2),
    );
    if (embeds.length >= 10) {
      const remaining = calc.sessions.length - embeds.length + 1; // +1 for summary embed
      if (remaining > 0) {
        embeds.push(
          new EmbedBuilder()
            .setDescription(`... and **${remaining}** more session(s) not shown (Discord embed limit).`)
            .setColor(0xfee75c),
        );
      }
      break;
    }
  }

  await interaction.editReply({ embeds });
}
