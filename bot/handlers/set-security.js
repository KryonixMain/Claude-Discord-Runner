import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "../lib/paths.js";

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

export async function handleSetSecurity(interaction) {
  await interaction.deferReply();

  const sessionNum = interaction.options.getInteger("session");
  const enabled    = interaction.options.getBoolean("enabled");
  const filePath   = join(SESSION_DIR, `Session${sessionNum}.md`);

  if (!existsSync(filePath)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Session not found")
          .setDescription(`\`Session${sessionNum}.md\` does not exist.`)
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  let content = readFileSync(filePath, "utf8");
  let config  = parseOverrideBlock(content) ?? { session: {}, prompts: {} };
  if (!config.session) config.session = {};

  if (enabled) {
    delete config.session.skipSecurityFix;
  } else {
    config.session.skipSecurityFix = true;
  }

  content = writeOverrideBlock(content, config);
  writeFileSync(filePath, content);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Security Fix Updated")
        .setDescription(
          enabled
            ? `Auto security fix **enabled** for **Session${sessionNum}**.\n\nSecurity reports from this session will be included in the post-run fix pass.`
            : `Auto security fix **disabled** for **Session${sessionNum}**.\n\nSecurity reports from this session will be skipped during the post-run fix pass.`,
        )
        .addFields(
          { name: "Session", value: `Session${sessionNum}`, inline: true },
          { name: "Security Fix", value: enabled ? "Enabled" : "Disabled", inline: true },
        )
        .setColor(enabled ? 0x57f287 : 0xfee75c)
        .setTimestamp(),
    ],
  });
}
