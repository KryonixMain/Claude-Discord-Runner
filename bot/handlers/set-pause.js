import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_DIR, SETTINGS_FILE } from "../lib/paths.js";
import { loadSettings, saveSettings } from "../lib/settings.js";

function parseOverrideBlock(content) {
  const allMatches = [...content.matchAll(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n([\s\S]*?)-->/g)];
  if (allMatches.length === 0) return null;
  let merged = { session: {}, prompts: {} };
  for (const m of allMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      merged.session = { ...merged.session, ...parsed.session };
      if (parsed.prompts) {
        for (const [k, v] of Object.entries(parsed.prompts)) {
          merged.prompts[k] = { ...merged.prompts[k], ...v };
        }
      }
    } catch { /* ignore */ }
  }
  return merged;
}

function writeOverrideBlock(content, config) {
  const block = `<!--\nSESSION OVERRIDE CONFIG\n${JSON.stringify(config, null, 2)}\n-->`;
  const cleaned = content.replace(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n[\s\S]*?\r?\n-->\r?\n?\r?\n?/g, "");
  return block + "\n\n" + cleaned;
}

export async function handleSetPause(interaction) {
  await interaction.deferReply();

  const minutes    = interaction.options.getInteger("minutes");
  const sessionNum = interaction.options.getInteger("session");

  if (sessionNum !== null) {
    const filePath = join(SESSION_DIR, `Session${sessionNum}.md`);

    if (!existsSync(filePath)) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Session nicht gefunden")
            .setDescription(`\`Session${sessionNum}.md\` existiert nicht.`)
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
      return;
    }

    let content = readFileSync(filePath, "utf8");
    let config  = parseOverrideBlock(content) ?? { session: {}, prompts: {} };
    if (!config.session) config.session = {};

    config.session.pauseAfterMs = minutes * 60_000;
    content = writeOverrideBlock(content, config);
    writeFileSync(filePath, content);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Session-Pause aktualisiert")
          .setDescription(
            `Pause nach **Session${sessionNum}** auf **${minutes} min** gesetzt.\n\n` +
            "_Die Pause ist die Wartezeit nach Abschluss dieser Session, bevor die nächste startet._",
          )
          .addFields(
            { name: "Session", value: `Session${sessionNum}`, inline: true },
            { name: "Pause", value: `${minutes} min`, inline: true },
            { name: "Scope", value: "Nur diese Session", inline: true },
          )
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
  } else {
    const settings = loadSettings();
    if (!settings.runner) settings.runner = {};
    settings.runner.pauseMinutes = minutes;
    saveSettings(settings);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Globale Pause aktualisiert")
          .setDescription(
            `Standard-Pause zwischen Sessions auf **${minutes} min** gesetzt.\n\n` +
            "_Gilt für alle Sessions ohne eigenen Pause-Override._\n" +
            "_Per-Session-Overrides haben Vorrang (über `/set-pause session:N` oder Session-Override-Block)._",
          )
          .addFields(
            { name: "runner.pauseMinutes", value: `${minutes} min`, inline: true },
            { name: "Scope", value: "Global (alle Sessions)", inline: true },
          )
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
  }
}
