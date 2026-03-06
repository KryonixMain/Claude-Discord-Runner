import { EmbedBuilder } from "discord.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { DEFAULT_SETTINGS } from "../lib/plans.js";
import { SETTINGS_FILE } from "../lib/paths.js";
import { updateClaudeMdWorkDir } from "../lib/session-setup.js";
import { writeFileSync } from "fs";

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

export async function handleSettings(interaction) {
  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();

  if (sub === "show") {
    const s = loadSettings();
    const lines = [
      `**runner.defaultModel**       \`${s.runner.defaultModel}\``,
      `**runner.maxTurns**           \`${s.runner.maxTurns}\``,
      `**runner.pauseMinutes**       \`${s.runner.pauseMinutes}\``,
      `**runner.claudePlan**         \`${s.runner.claudePlan}\``,
      `**runner.skipPermissions**    \`${s.runner.skipPermissions}\``,
      `**runner.parallel**           \`${s.runner.parallel ?? false}\``,
      `**runner.autoSecurityFix**    \`${s.runner.autoSecurityFix}\``,
      `**runner.archiveOnComplete**  \`${s.runner.archiveOnComplete}\``,
      `**runner.workDir**            \`${s.runner.workDir || "— (defaults to project root)"}\``,
      `**sessions.count**            \`${s.sessions.count}\``,
      `**logging.keepLogs**          \`${s.logging.keepLogs}\``,
      `**dashboard.port**            \`${s.dashboard?.port || 3000}\``,
      `**bot.channelId**             \`${s.bot.channelId || "—"}\``,
      `**bot.webhookUrl**            \`${s.bot.webhookUrl ? s.bot.webhookUrl.slice(0, 40) + "…" : "—"}\``,
      `**bot.locale**                \`${s.bot?.locale || "en-US"}\``,
    ];

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Current Settings")
          .setDescription(lines.join("\n"))
          .addFields({ name: "Config file", value: `\`${SETTINGS_FILE}\``, inline: false })
          .setColor(0x5865f2)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (sub === "set") {
    const key   = interaction.options.getString("key");
    const value = interaction.options.getString("value");

    const parts    = key.split(".");
    let defaultObj = DEFAULT_SETTINGS;
    for (const p of parts) {
      if (defaultObj == null || typeof defaultObj !== "object" || !(p in defaultObj)) {
        const validKeys = flattenKeys(DEFAULT_SETTINGS);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("Settings — Unknown key")
              .setDescription(
                `Key \`${key}\` is not a valid setting.\n\n` +
                `**Valid keys:**\n${validKeys.map((k) => `\`${k}\``).join(", ")}`,
              )
              .setColor(0xed4245)
              .setTimestamp(),
          ],
        });
        return;
      }
      defaultObj = defaultObj[p];
    }

    const s   = loadSettings();
    let obj   = s;

    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
      obj = obj[parts[i]];
    }

    const lastKey  = parts[parts.length - 1];
    const oldValue = obj[lastKey];
    const parsed   =
      value === "true"  ? true  :
      value === "false" ? false :
      !isNaN(Number(value)) ? Number(value) : value;

    obj[lastKey] = parsed;
    saveSettings(s);

    if (key === "runner.workDir") {
      updateClaudeMdWorkDir(parsed);
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Setting updated")
          .addFields(
            { name: "Key",   value: `\`${key}\``,          inline: true },
            { name: "Before", value: `\`${oldValue}\``,    inline: true },
            { name: "After",  value: `\`${parsed}\``,      inline: true },
          )
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (sub === "reset") {
    writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Settings reset to defaults")
          .setDescription(`\`${SETTINGS_FILE}\` has been restored.`)
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
  }
}
