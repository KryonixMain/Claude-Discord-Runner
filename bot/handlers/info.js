import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { parseLatestChangelog } from "../lib/changelog.js";
import { getSetting } from "../lib/settings.js";
import { CLAUDE_PLANS } from "../lib/plans.js";
import { getSessionCount } from "../lib/helpers.js";

const MAX_EMBED_DESC = 4000;

export async function handleInfo(interaction) {
  await interaction.deferReply();

  const changelog = parseLatestChangelog();

  if (!changelog) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Claude Runner")
          .setDescription("Could not read CHANGELOG.md — version unknown.")
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const planKey = getSetting("runner", "claudePlan");
  const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const model = getSetting("runner", "defaultModel");
  const sessions = getSessionCount();

  const infoEmbed = new EmbedBuilder()
    .setTitle(`Claude Runner — v${changelog.version}`)
    .setDescription(
      `**Version:** \`${changelog.version}\`\n` +
      `**Released:** ${changelog.date}\n\n` +
      `Automated multi-session executor for Claude CLI,\n` +
      `controlled via Discord bot and web dashboard.`,
    )
    .addFields(
      { name: "Plan", value: plan.label, inline: true },
      { name: "Model", value: `\`${model}\``, inline: true },
      { name: "Sessions", value: String(sessions || "—"), inline: true },
      { name: "Node.js", value: process.version, inline: true },
      { name: "discord.js", value: `v${(await import("discord.js")).version}`, inline: true },
      { name: "Platform", value: `${process.platform} ${process.arch}`, inline: true },
    )
    .setColor(0x5865f2)
    .setFooter({ text: "github.com/KryonixMain/Claude-Discord-Runner" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("info_show_changelog")
      .setLabel("Show Changelog")
      .setStyle(ButtonStyle.Primary),
  );

  const msg = await interaction.editReply({ embeds: [infoEmbed], components: [row] });

  try {
    const btnInteraction = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.customId === "info_show_changelog",
      time: 120_000,
    });

    await btnInteraction.deferUpdate();

    let changelogText = changelog.body;
    if (changelogText.length > MAX_EMBED_DESC) {
      changelogText = changelogText.slice(0, MAX_EMBED_DESC - 20) + "\n\n*…truncated*";
    }

    const changelogEmbed = new EmbedBuilder()
      .setTitle(`Changelog — v${changelog.version} (${changelog.date})`)
      .setDescription(changelogText)
      .setColor(0x57f287)
      .setTimestamp();

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("info_show_changelog")
        .setLabel("Show Changelog")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
    );

    await interaction.editReply({ embeds: [infoEmbed], components: [disabledRow] });
    await btnInteraction.followUp({ embeds: [changelogEmbed], ephemeral: false });
  } catch {
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("info_show_changelog")
        .setLabel("Show Changelog")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );
    await interaction.editReply({ embeds: [infoEmbed], components: [disabledRow] }).catch(() => {});
  }
}
