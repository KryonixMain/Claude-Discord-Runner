import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { existsSync } from "fs";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { CLAUDE_PLANS } from "../lib/plans.js";
import { SETTINGS_FILE, SESSION_DIR, CLAUDE_MD } from "../lib/paths.js";
import { runSetup } from "../lib/session-setup.js";

const TIMEOUT_MS = 120_000; // 2 minutes per step

export async function handleSetupWizard(interaction) {
  await interaction.deferReply();

  const settings = loadSettings();

  // Step 1: Welcome + check current state
  const hasToken = !!settings.bot?.token;
  const hasChannel = !!settings.bot?.channelId;
  const hasWebhook = !!settings.bot?.webhookUrl;
  const hasSessions = existsSync(SESSION_DIR);
  const hasClaudeMd = existsSync(CLAUDE_MD);

  const statusLines = [
    `Bot token: ${hasToken ? "configured" : "**missing**"}`,
    `Channel ID: ${hasChannel ? "configured" : "**missing**"}`,
    `Webhook URL: ${hasWebhook ? "configured" : "**missing**"}`,
    `Sessions dir: ${hasSessions ? "exists" : "will be created"}`,
    `CLAUDE.md: ${hasClaudeMd ? "exists" : "will be created"}`,
  ];

  const welcomeEmbed = new EmbedBuilder()
    .setTitle("Setup Wizard — Step 1/4: Plan Selection")
    .setDescription(
      "Welcome to the Claude Runner setup wizard!\n\n" +
      "**Current status:**\n" +
      statusLines.join("\n") +
      "\n\nSelect your Claude subscription plan below.",
    )
    .setColor(0x5865f2)
    .setTimestamp();

  const planSelect = new StringSelectMenuBuilder()
    .setCustomId("wizard_plan")
    .setPlaceholder("Choose your Claude plan...")
    .addOptions(
      { label: "Pro ($20/mo)", value: "pro", description: "~44k output tokens per 5h window" },
      { label: "Max 5x ($100/mo)", value: "max5", description: "~88k output tokens per 5h window" },
      { label: "Max 20x ($200/mo)", value: "max20", description: "~220k output tokens per 5h window" },
    );

  const row1 = new ActionRowBuilder().addComponents(planSelect);
  const msg = await interaction.editReply({ embeds: [welcomeEmbed], components: [row1] });

  // Collect plan choice
  let planChoice;
  try {
    const planResp = await msg.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.user.id === interaction.user.id && i.customId === "wizard_plan",
      time: TIMEOUT_MS,
    });
    planChoice = planResp.values[0];
    await planResp.deferUpdate();
  } catch {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Setup Wizard — Timed out").setDescription("No response received. Run `/setup-wizard` again.").setColor(0xed4245)],
      components: [],
    });
    return;
  }

  // Step 2: Model selection
  const modelEmbed = new EmbedBuilder()
    .setTitle("Setup Wizard — Step 2/4: Default Model")
    .setDescription(
      `Plan selected: **${CLAUDE_PLANS[planChoice].label}**\n\n` +
      "Choose the default model for your sessions.",
    )
    .setColor(0x5865f2)
    .setTimestamp();

  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId("wizard_model")
    .setPlaceholder("Choose default model...")
    .addOptions(
      { label: "Claude Opus 4.5", value: "claude-opus-4-5", description: "Most capable — complex coding and architecture" },
      { label: "Claude Sonnet 4.5", value: "claude-sonnet-4-5", description: "Faster and cheaper — good for simpler tasks" },
    );

  const row2 = new ActionRowBuilder().addComponents(modelSelect);
  await interaction.editReply({ embeds: [modelEmbed], components: [row2] });

  let modelChoice;
  try {
    const modelResp = await msg.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.user.id === interaction.user.id && i.customId === "wizard_model",
      time: TIMEOUT_MS,
    });
    modelChoice = modelResp.values[0];
    await modelResp.deferUpdate();
  } catch {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Setup Wizard — Timed out").setDescription("No response received.").setColor(0xed4245)],
      components: [],
    });
    return;
  }

  // Step 3: Permissions
  const permEmbed = new EmbedBuilder()
    .setTitle("Setup Wizard — Step 3/4: Permissions")
    .setDescription(
      `Model: **${modelChoice}**\n\n` +
      "Should Claude run with `--dangerously-skip-permissions`?\n\n" +
      "**Yes** (recommended): Claude can read/write files and run commands without asking. Required for unattended automation.\n" +
      "**No**: Claude will prompt for each file operation. Not compatible with automated runs.",
    )
    .setColor(0x5865f2)
    .setTimestamp();

  const permButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("wizard_perm_yes").setLabel("Yes — Skip Permissions (recommended)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("wizard_perm_no").setLabel("No — Require Permissions").setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [permEmbed], components: [permButtons] });

  let skipPerms;
  try {
    const permResp = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith("wizard_perm_"),
      time: TIMEOUT_MS,
    });
    skipPerms = permResp.customId === "wizard_perm_yes";
    await permResp.deferUpdate();
  } catch {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Setup Wizard — Timed out").setDescription("No response received.").setColor(0xed4245)],
      components: [],
    });
    return;
  }

  // Step 4: Confirm and apply
  const confirmEmbed = new EmbedBuilder()
    .setTitle("Setup Wizard — Step 4/4: Confirm")
    .setDescription(
      "Review your settings:\n\n" +
      `**Plan:** ${CLAUDE_PLANS[planChoice].label}\n` +
      `**Model:** ${modelChoice}\n` +
      `**Skip Permissions:** ${skipPerms ? "Yes" : "No"}\n\n` +
      "This will create directories, CLAUDE.md, and Session1.md template.\nClick **Apply** to proceed.",
    )
    .setColor(0x5865f2)
    .setTimestamp();

  const confirmButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("wizard_apply").setLabel("Apply").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("wizard_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({ embeds: [confirmEmbed], components: [confirmButtons] });

  try {
    const confirmResp = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith("wizard_"),
      time: TIMEOUT_MS,
    });
    await confirmResp.deferUpdate();

    if (confirmResp.customId === "wizard_cancel") {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Setup Wizard — Cancelled")
            .setDescription("No changes were made.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
        components: [],
      });
      return;
    }
  } catch {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Setup Wizard — Timed out").setDescription("No response received.").setColor(0xed4245)],
      components: [],
    });
    return;
  }

  // Apply settings
  const s = loadSettings();
  s.runner.claudePlan = planChoice;
  s.runner.defaultModel = modelChoice;
  s.runner.skipPermissions = skipPerms;
  saveSettings(s);

  // Run the standard setup
  const created = runSetup(false, planChoice);

  const resultEmbed = new EmbedBuilder()
    .setTitle("Setup Wizard — Complete")
    .setDescription(
      "Your Claude Runner is configured and ready!\n\n" +
      (created.length > 0
        ? "**Created:**\n" + created.join("\n")
        : "All files already exist.") +
      "\n\n**Next steps:**\n" +
      "1. Edit `Sessions/Session1.md` with your prompts\n" +
      "2. Run `/validate-sessions` to check format\n" +
      "3. Run `/start` to begin execution",
    )
    .addFields(
      { name: "Plan", value: CLAUDE_PLANS[planChoice].label, inline: true },
      { name: "Model", value: modelChoice, inline: true },
      { name: "Skip Permissions", value: skipPerms ? "Yes" : "No", inline: true },
    )
    .setColor(0x57f287)
    .setTimestamp();

  await interaction.editReply({ embeds: [resultEmbed], components: [] });
}
