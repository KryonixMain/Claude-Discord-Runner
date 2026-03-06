import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import { detectSessions } from "../lib/session-parser.js";
import { calculateSessionTimeouts } from "../lib/calculator.js";
import { getSetting } from "../lib/settings.js";
import { CLAUDE_PLANS } from "../lib/plans.js";

const SESSIONS_PER_PAGE = 8; // 1 summary + 8 sessions + 1 footer = 10 max

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

  const summaryEmbed = new EmbedBuilder()
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
    .setTimestamp();

  const sessionEmbeds = calc.sessions.map((s) => {
    const promptLines = s.prompts.map((p, i) =>
      `\`[${i + 1}]\` ${p.title} — ~${(p.chars / 1000).toFixed(1)}k chars`,
    );
    return new EmbedBuilder()
      .setTitle(s.file)
      .setDescription(promptLines.join("\n"))
      .addFields(
        { name: "Total chars",    value: `~${(s.totalChars / 1000).toFixed(1)}k`,           inline: true },
        { name: "Est. tokens",    value: `~${(s.outputTokens / 1000).toFixed(1)}k`,         inline: true },
        { name: "Rec. timeout",   value: `${Math.round(s.recommendedTimeoutMs / 60_000)}min`, inline: true },
      )
      .setColor(0x5865f2);
  });

  const totalPages = Math.max(1, Math.ceil(sessionEmbeds.length / SESSIONS_PER_PAGE));

  // No pagination needed
  if (totalPages === 1) {
    await interaction.editReply({ embeds: [summaryEmbed, ...sessionEmbeds] });
    return;
  }

  // Paginated view
  let page = 0;

  function buildPage(p) {
    const start = p * SESSIONS_PER_PAGE;
    const slice = sessionEmbeds.slice(start, start + SESSIONS_PER_PAGE);
    const footer = new EmbedBuilder()
      .setDescription(`Page **${p + 1}** / **${totalPages}** — Sessions ${start + 1}–${start + slice.length} of ${sessionEmbeds.length}`)
      .setColor(0x99aab5);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("detect_prev")
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p === 0),
      new ButtonBuilder()
        .setCustomId("detect_next")
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p === totalPages - 1),
    );

    return { embeds: [summaryEmbed, ...slice, footer], components: [row] };
  }

  const msg = await interaction.editReply(buildPage(page));

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (btn) => btn.user.id === interaction.user.id,
    time: 5 * 60_000, // 5 min timeout
  });

  collector.on("collect", async (btn) => {
    if (btn.customId === "detect_prev" && page > 0) page--;
    if (btn.customId === "detect_next" && page < totalPages - 1) page++;
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
