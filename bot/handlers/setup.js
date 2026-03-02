import { EmbedBuilder } from "discord.js";
import { runSetup, applyTimeoutsToSessionFile } from "../lib/session-setup.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { getSetting } from "../lib/settings.js";
import { CLAUDE_PLANS } from "../lib/plans.js";

export async function handleSetup(interaction) {
  await interaction.deferReply();

  const planKey     = interaction.options.getString("plan") ?? getSetting("runner", "claudePlan");
  const withOverride = interaction.options.getBoolean("override") ?? false;

  const created = runSetup(withOverride, planKey);

  const detected = detectSessions();
  let timeoutLines = [];

  if (!detected.error && detected.sessions.length > 0) {
    const calc = calculateSessionTimeouts(detected.sessions, planKey);
    for (const s of calc.sessions) {
      const applied = applyTimeoutsToSessionFile(
        s.fullPath,
        s.recommendedTimeoutMs,
        s.promptCount,
        planKey,
      );
      if (applied)
        timeoutLines.push(
          `\`${s.file}\` — timeout: ${Math.round(s.recommendedTimeoutMs / 60_000)}min`,
        );
    }
  }

  const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Setup complete")
        .setDescription(
          created.length > 0
            ? created.join("\n")
            : "All files and directories already exist — nothing to create.",
        )
        .addFields(
          { name: "Plan",           value: plan.label, inline: true },
          { name: "Override block", value: withOverride ? "Yes" : "No", inline: true },
          ...(timeoutLines.length > 0
            ? [{ name: "Timeouts applied", value: timeoutLines.join("\n"), inline: false }]
            : []),
        )
        .setColor(0x57f287)
        .setTimestamp(),
    ],
  });
}
