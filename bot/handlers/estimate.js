import { EmbedBuilder } from "discord.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { CLAUDE_PLANS, CHARS_PER_TOKEN } from "../lib/plans.js";
import { getSetting } from "../lib/settings.js";
import { formatDuration, loadState } from "../lib/helpers.js";

export async function handleEstimate(interaction) {
  const detected = detectSessions();
  if (detected.error) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No sessions found")
          .setDescription(detected.error)
          .setColor(0xed4245),
      ],
      ephemeral: true,
    });
  }

  const planKey  = getSetting("runner", "claudePlan");
  const plan     = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const calc     = calculateSessionTimeouts(detected.sessions, planKey);
  const state    = loadState();
  const pauseMin = getSetting("runner", "pauseMinutes");

  // Per-session breakdown
  const sessionLines = calc.sessions.map((s, i) => {
    const completed = state.completedSessions?.includes(s.file?.replace(".md", ""));
    const status = completed ? "Done" : "Pending";
    const inputK  = (s.inputTokens / 1000).toFixed(1);
    const outputK = (s.outputTokens / 1000).toFixed(1);
    const timeoutMin = Math.ceil(s.recommendedTimeoutMs / 60_000);
    const estMin  = Math.ceil(s.estimatedMs / 60_000);
    return [
      `**Session ${i + 1}** — ${s.file} [${status}]`,
      `  Prompts: ${s.promptCount} | Input: ~${inputK}k tokens | Output: ~${outputK}k tokens`,
      `  Est. duration: ~${estMin} min | Timeout: ${timeoutMin} min`,
    ].join("\n");
  });

  // Total estimates
  const totalInputTokens = calc.sessions.reduce((s, x) => s + x.inputTokens, 0);
  const totalEstMs = calc.sessions.reduce((s, x) => s + x.estimatedMs, 0);
  const totalPauseMs = (detected.sessions.length - 1) * pauseMin * 60_000;
  const totalWallMs = totalEstMs + totalPauseMs;
  const budgetPct = Math.round((calc.totalOutputTokens / calc.budgetTokens) * 100);

  // Warnings
  const warnings = [];
  if (!calc.fitsInOneWindow) {
    warnings.push(`Estimated output exceeds single 5h window — **${calc.windowsNeeded} windows** needed`);
  }
  if (budgetPct >= 90) {
    warnings.push(`Token usage at **${budgetPct}%** of budget — risk of rate limiting`);
  }
  calc.sessions.forEach((s, i) => {
    if (s.estimatedMs > s.recommendedTimeoutMs * 0.8) {
      warnings.push(`Session ${i + 1} may exceed its timeout (${Math.ceil(s.estimatedMs / 60_000)} min est. vs ${Math.ceil(s.recommendedTimeoutMs / 60_000)} min timeout)`);
    }
  });
  if (totalPauseMs > totalEstMs) {
    warnings.push(`Idle time (${formatDuration(totalPauseMs)}) exceeds execution time (${formatDuration(totalEstMs)}) — consider reducing pauseMinutes`);
  }

  const embeds = [
    new EmbedBuilder()
      .setTitle("Run Estimate")
      .setDescription(sessionLines.join("\n\n"))
      .addFields(
        { name: "Total sessions",       value: String(detected.sessions.length), inline: true },
        { name: "Total prompts",        value: String(detected.sessions.reduce((s, x) => s + x.promptCount, 0)), inline: true },
        { name: "Plan",                 value: plan.label, inline: true },
        { name: "Input tokens (est.)",  value: `~${(totalInputTokens / 1000).toFixed(1)}k`, inline: true },
        { name: "Output tokens (est.)", value: `~${(calc.totalOutputTokens / 1000).toFixed(1)}k`, inline: true },
        { name: "Budget usage",         value: `${budgetPct}%`, inline: true },
        { name: "Est. execution time",  value: formatDuration(totalEstMs), inline: true },
        { name: "Est. pause time",      value: formatDuration(totalPauseMs), inline: true },
        { name: "Est. total wall time", value: formatDuration(totalWallMs), inline: true },
        { name: "5h windows needed",    value: String(calc.windowsNeeded), inline: true },
      )
      .setColor(calc.fitsInOneWindow ? 0x57f287 : 0xfee75c)
      .setFooter({ text: "Estimates based on prompt character counts — actual usage may vary" })
      .setTimestamp(),
  ];

  if (warnings.length > 0) {
    embeds.push(
      new EmbedBuilder()
        .setTitle("Warnings")
        .setDescription(warnings.map((w) => `- ${w}`).join("\n"))
        .setColor(0xfee75c),
    );
  }

  await interaction.reply({ embeds });
}
