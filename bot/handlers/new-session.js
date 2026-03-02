import { EmbedBuilder } from "discord.js";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "../lib/paths.js";
import { buildSessionTemplate } from "../lib/session-setup.js";

export async function handleNewSession(interaction) {
  await interaction.deferReply();

  const number      = interaction.options.getInteger("number");
  const withOverride = interaction.options.getBoolean("override") ?? false;
  const filePath    = join(SESSION_DIR, `Session${number}.md`);

  if (existsSync(filePath)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Session already exists")
          .setDescription(
            `\`Session${number}.md\` already exists.\n` +
            `Delete it manually first if you want to regenerate it.`,
          )
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  writeFileSync(filePath, buildSessionTemplate(number, withOverride));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Session${number}.md created`)
        .setDescription(
          `\`Sessions/Session${number}.md\` has been created from template.\n` +
          `Edit it to add your prompts, then run \`/validate-sessions\` before starting.`,
        )
        .addFields({ name: "Override block", value: withOverride ? "Included" : "Not included", inline: true })
        .setColor(0x57f287)
        .setTimestamp(),
    ],
  });
}
