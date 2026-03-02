import { EmbedBuilder } from "discord.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { getSetting } from "../lib/settings.js";
import { queryRateLimit } from "../lib/helpers.js";
import { CLAUDE_PLANS } from "../lib/plans.js";

export async function handleRateLimit(interaction) {
  await interaction.deferReply();

  const planKey  = getSetting("runner", "claudePlan");
  const plan     = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const detected = detectSessions();

  const fields = [];

  if (!detected.error && detected.sessions.length > 0) {
    const calc = calculateSessionTimeouts(detected.sessions, planKey);
    const pct  = Math.round((calc.totalOutputTokens / calc.budgetTokens) * 100);

    fields.push(
      { name: "Plan",              value: plan.label,                                     inline: true  },
      { name: "5h budget",         value: `~${(calc.budgetTokens / 1000).toFixed(0)}k tokens`,  inline: true  },
      { name: "Estimated usage",   value: `~${(calc.totalOutputTokens / 1000).toFixed(1)}k tokens (${pct}%)`, inline: true },
      { name: "Windows needed",    value: String(calc.windowsNeeded),                     inline: true  },
      { name: "Rec. pause",        value: `${calc.recommendedPauseMinutes} min`,          inline: true  },
      { name: "Fits in 1 window",  value: calc.fitsInOneWindow ? "Yes" : "No",           inline: true  },
    );

    for (const s of calc.sessions) {
      fields.push({
        name:   s.file,
        value:  `~${(s.outputTokens / 1000).toFixed(1)}k tokens | rec. timeout: ${Math.round(s.recommendedTimeoutMs / 60_000)}min`,
        inline: false,
      });
    }
  }

  const apiStatus = queryRateLimit();
  if (apiStatus) {
    fields.push({ name: "API Status", value: "```json\n" + JSON.stringify(apiStatus, null, 2).slice(0, 900) + "\n```", inline: false });
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Rate Limit Status")
        .setDescription(
          detected.error
            ? detected.error
            : `Based on session files and the **${plan.label}** plan.`,
        )
        .addFields(...fields)
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });
}
