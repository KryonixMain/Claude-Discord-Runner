import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { CLAUDE_PLANS } from "../lib/plans.js";
import { getSetting } from "../lib/settings.js";
import { formatDuration, loadState } from "../lib/helpers.js";

const SESSIONS_PER_PAGE = 8;

export async function handleEstimate(interaction) {
  await interaction.deferReply();

  const detected = detectSessions();
  if (detected.error) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No sessions found")
          .setDescription(detected.error)
          .setColor(0xed4245),
      ],
    });
  }

  const planKey  = getSetting("runner", "claudePlan");
  const plan     = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const calc     = calculateSessionTimeouts(detected.sessions, planKey);
  const state    = loadState();
  const pauseMin = getSetting("runner", "pauseMinutes");

  const sessionEmbeds = calc.sessions.map((s, i) => {
    const completed = state.completedSessions?.includes(s.file?.replace(".md", ""));
    const status = completed ? "Done" : "Pending";
    const inputK  = (s.inputTokens / 1000).toFixed(1);
    const outputK = (s.outputTokens / 1000).toFixed(1);
    const timeoutMin = Math.ceil(s.recommendedTimeoutMs / 60_000);
    const estMin  = Math.ceil(s.estimatedMs / 60_000);

    return new EmbedBuilder()
      .setTitle(`Session ${i + 1} — ${s.file} [${status}]`)
      .setDescription(
        `Prompts: **${s.promptCount}** | Input: ~${inputK}k tokens | Output: ~${outputK}k tokens\n` +
        `Est. duration: ~${estMin} min | Timeout: ${timeoutMin} min`,
      )
      .setColor(completed ? 0x57f287 : 0x5865f2);
  });

  const totalInputTokens = calc.sessions.reduce((s, x) => s + x.inputTokens, 0);
  const totalEstMs = calc.sessions.reduce((s, x) => s + x.estimatedMs, 0);
  const totalPauseMs = (detected.sessions.length - 1) * pauseMin * 60_000;
  const totalWallMs = totalEstMs + totalPauseMs;
  const budgetPct = Math.round((calc.totalOutputTokens / calc.budgetTokens) * 100);

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

  const summaryEmbed = new EmbedBuilder()
    .setTitle("Run Estimate")
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
    .setTimestamp();

  const warningEmbed = warnings.length > 0
    ? new EmbedBuilder()
        .setTitle("Warnings")
        .setDescription(warnings.map((w) => `- ${w}`).join("\n"))
        .setColor(0xfee75c)
    : null;

  // Count fixed embeds (summary + optional warning)
  const fixedEmbeds = warningEmbed ? [summaryEmbed, warningEmbed] : [summaryEmbed];
  const slotsPerPage = 10 - fixedEmbeds.length - 1; // -1 for page footer
  const totalPages = Math.max(1, Math.ceil(sessionEmbeds.length / slotsPerPage));

  // No pagination needed
  if (totalPages === 1) {
    await interaction.editReply({ embeds: [...fixedEmbeds, ...sessionEmbeds] });
    return;
  }

  let page = 0;

  function buildPage(p) {
    const start = p * slotsPerPage;
    const slice = sessionEmbeds.slice(start, start + slotsPerPage);
    const footer = new EmbedBuilder()
      .setDescription(`Page **${p + 1}** / **${totalPages}** — Sessions ${start + 1}–${start + slice.length} of ${sessionEmbeds.length}`)
      .setColor(0x99aab5);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("estimate_prev")
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p === 0),
      new ButtonBuilder()
        .setCustomId("estimate_next")
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p === totalPages - 1),
    );

    return { embeds: [...fixedEmbeds, ...slice, footer], components: [row] };
  }

  const msg = await interaction.editReply(buildPage(page));

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (btn) => btn.user.id === interaction.user.id,
    time: 5 * 60_000,
  });

  collector.on("collect", async (btn) => {
    if (btn.customId === "estimate_prev" && page > 0) page--;
    if (btn.customId === "estimate_next" && page < totalPages - 1) page++;
    await btn.update(buildPage(page));
  });

  collector.on("end", async () => {
    try {
      const final = buildPage(page);
      final.components[0].components.forEach((b) => b.setDisabled(true));
      await interaction.editReply(final);
    } catch { /* message may be deleted */ }
  });
}
