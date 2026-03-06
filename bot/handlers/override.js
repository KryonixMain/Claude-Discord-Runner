import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "../lib/paths.js";

export async function handleOverride(interaction) {
  await interaction.deferReply();

  const sessionNum = interaction.options.getInteger("session");
  const model      = interaction.options.getString("model");
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

  let config = { session: {}, prompts: {} };
  const allMatches = [...content.matchAll(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n([\s\S]*?)-->/g)];
  for (const m of allMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      config.session = { ...config.session, ...parsed.session };
      if (parsed.prompts) {
        for (const [k, v] of Object.entries(parsed.prompts)) {
          config.prompts[k] = { ...config.prompts[k], ...v };
        }
      }
    } catch { /* ignore */ }
  }

  config.session.defaultModel = model;

  const overrideBlock = `<!--\nSESSION OVERRIDE CONFIG\n${JSON.stringify(config, null, 2)}\n-->`;

  // Remove ALL existing override blocks, then prepend the merged one
  content = content.replace(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n[\s\S]*?\r?\n-->\r?\n?\r?\n?/g, "");
  content = overrideBlock + "\n\n" + content;

  writeFileSync(filePath, content);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Model override set")
        .addFields(
          { name: "Session", value: `Session${sessionNum}`, inline: true },
          { name: "Model",   value: model,                   inline: true },
        )
        .setColor(0x57f287)
        .setTimestamp(),
    ],
  });
}
