import { EmbedBuilder } from "discord.js";
import { isRunning, getRunningProcess, setRunningProcess } from "../state.js";
import { startRunProcess } from "../process.js";
import { getSetting } from "../lib/settings.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { applyTimeoutsToSessionFile } from "../lib/session-setup.js";
import { CLAUDE_PLANS, SAFETY_MARGIN } from "../lib/plans.js";
import { getSessionCount, killProcessGracefully } from "../lib/helpers.js";

export async function handleStart(interaction) {
  const doReset = interaction.options.getBoolean("reset") ?? false;
  await interaction.deferReply();

  if (isRunning()) {
    await killProcessGracefully(getRunningProcess(), "run-sessions.js");
    setRunningProcess(null);
  }

  const detected = detectSessions();
  const planKey  = getSetting("runner", "claudePlan");
  const plan     = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  let warningLines   = [];
  let analysisFields = [];

  if (!detected.error && detected.sessions.length > 0) {
    const calc = calculateSessionTimeouts(detected.sessions, planKey);
    for (const s of calc.sessions)
      applyTimeoutsToSessionFile(s.fullPath, s.recommendedTimeoutMs, s.promptCount, planKey);

    analysisFields = [
      { name: "Total tokens",    value: `~${(calc.totalOutputTokens / 1000).toFixed(1)}k`, inline: true },
      { name: "5h budget",       value: `~${(calc.budgetTokens / 1000).toFixed(1)}k`,      inline: true },
      { name: "Windows needed",  value: String(calc.windowsNeeded),                         inline: true },
      { name: "Rec. pause",      value: `${calc.recommendedPauseMinutes} min`,              inline: true },
    ];

    warningLines.push(
      calc.fitsInOneWindow
        ? `All sessions fit within one 5h window on the **${plan.label}** plan.`
        : `Sessions exceed the 5h budget — **${calc.windowsNeeded} windows** required.`,
    );
  }

  startRunProcess(doReset ? ["--reset"] : [], interaction.channel);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(doReset ? "Run started (Reset)" : "Run started")
        .setDescription([
          doReset
            ? "Progress cleared — starting from Session 1."
            : "run-sessions.js started. Completed sessions will be skipped.",
          "",
          ...warningLines,
        ].join("\n"))
        .addFields(
          { name: "Sessions", value: String(getSessionCount()), inline: true },
          { name: "Model",    value: getSetting("runner", "defaultModel"), inline: true },
          { name: "Plan",     value: plan.label, inline: true },
          ...analysisFields,
        )
        .setColor(doReset ? 0xfee75c : 0x57f287)
        .setTimestamp(),
    ],
  });
}
