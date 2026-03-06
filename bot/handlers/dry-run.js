import { EmbedBuilder } from "discord.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { validateAllSessions } from "../lib/session-validator.js";
import { getSetting } from "../lib/settings.js";
import { CLAUDE_PLANS, CHARS_PER_TOKEN } from "../lib/plans.js";

export async function handleDryRun(interaction) {
  await interaction.deferReply();

  const validation = validateAllSessions();
  if (!validation.allValid) {
    const failedLines = validation.results
      .filter((r) => !r.valid)
      .map((r) => `**${r.file}**: ${r.errors.join(" | ")}`)
      .join("\n");

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Dry Run — Validation failed")
          .setDescription(`Cannot proceed — session files have errors:\n\n${failedLines}`)
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const detected = detectSessions();
  if (detected.error || !detected.sessions?.length) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Dry Run — No sessions")
          .setDescription(detected.error || "No session files found.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const planKey = getSetting("runner", "claudePlan");
  const plan    = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const calc    = calculateSessionTimeouts(detected.sessions, planKey);

  const sessionLines = detected.sessions.map((s, i) => {
    const c = calc.sessions?.[i];
    const estChars  = s.prompts.reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
    const estTokens = Math.ceil(estChars / CHARS_PER_TOKEN);
    const timeout   = c?.recommendedTimeoutMs ? `${Math.round(c.recommendedTimeoutMs / 60_000)} min` : "—";
    return `**${s.file}** — ${s.promptCount} prompt(s) | ~${estTokens} input tokens | timeout: ${timeout}`;
  });

  const totalPrompts = detected.sessions.reduce((s, x) => s + x.promptCount, 0);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Dry Run — Estimation")
        .setDescription(
          "Validation passed. Here is the token and time estimation:\n\n" +
          sessionLines.join("\n"),
        )
        .addFields(
          { name: "Sessions",       value: String(detected.sessions.length), inline: true },
          { name: "Total prompts",  value: String(totalPrompts),              inline: true },
          { name: "Plan",           value: plan.label,                        inline: true },
          { name: "Est. output tokens", value: `~${(calc.totalOutputTokens / 1000).toFixed(1)}k`, inline: true },
          { name: "5h budget",      value: `~${(calc.budgetTokens / 1000).toFixed(1)}k`,           inline: true },
          { name: "Windows needed", value: String(calc.windowsNeeded),                              inline: true },
          { name: "Fits in 1 window?", value: calc.fitsInOneWindow ? "Yes" : "No",                 inline: true },
          { name: "Rec. pause",     value: `${calc.recommendedPauseMinutes} min`,                   inline: true },
        )
        .setColor(calc.fitsInOneWindow ? 0x57f287 : 0xfee75c)
        .setFooter({ text: "No Claude processes were started — this is estimation only" })
        .setTimestamp(),
    ],
  });
}
