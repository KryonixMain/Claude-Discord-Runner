import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "../lib/paths.js";

export async function handleSetTimeout(interaction) {
  await interaction.deferReply();

  const sessionNum = interaction.options.getInteger("session");
  const minutes    = interaction.options.getInteger("minutes");
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

  const timeoutMs = minutes * 60_000;
  let content = readFileSync(filePath, "utf8");

  const overrideMatch = content.match(/<!--\nSESSION OVERRIDE CONFIG\n([\s\S]*?)\n-->/);
  let config;

  if (overrideMatch) {
    try {
      config = JSON.parse(overrideMatch[1]);
    } catch {
      config = { session: {}, prompts: {} };
    }
  } else {
    config = { session: {}, prompts: {} };
  }

  config.session.timeoutMs = timeoutMs;

  const overrideBlock = `<!--\nSESSION OVERRIDE CONFIG\n${JSON.stringify(config, null, 2)}\n-->`;

  if (overrideMatch) {
    content = content.replace(/<!--\nSESSION OVERRIDE CONFIG\n[\s\S]*?\n-->/, overrideBlock);
  } else {
    content = overrideBlock + "\n\n" + content;
  }

  writeFileSync(filePath, content);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Timeout updated")
        .addFields(
          { name: "Session", value: `Session${sessionNum}`, inline: true },
          { name: "Timeout", value: `${minutes} min`, inline: true },
        )
        .setColor(0x57f287)
        .setTimestamp(),
    ],
  });
}
