import { EmbedBuilder } from "discord.js";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ARCHIVE_DIR } from "../lib/paths.js";
import { archiveCompletedRun, pruneArchives } from "../lib/archive.js";
import { getSetting } from "../lib/settings.js";

export async function handleArchive(interaction) {
  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();

  if (sub === "now") {
    const ap = archiveCompletedRun();
    pruneArchives(5);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Run archived")
          .setDescription(`All files moved to:\n\`${ap}\``)
          .setColor(0x5865f2)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (sub === "list") {
    if (!existsSync(ARCHIVE_DIR)) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Archives")
            .setDescription("No archive directory found.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
      return;
    }

    const entries = readdirSync(ARCHIVE_DIR)
      .filter((f) => f.startsWith("run-"))
      .map((f) => {
        const fullPath = join(ARCHIVE_DIR, f);
        const stat     = statSync(fullPath);
        return { name: f, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (entries.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Archives")
            .setDescription("No archived runs found.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
      return;
    }

    const lines = entries.slice(0, 15).map((e, i) =>
      `\`${String(i + 1).padStart(2)}\` **${e.name}** — ${new Date(e.mtime).toLocaleString(getSetting("bot", "locale") || "en-US")}`,
    );

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Archives (${entries.length} total)`)
          .setDescription(lines.join("\n"))
          .addFields({ name: "Location", value: `\`${ARCHIVE_DIR}\``, inline: false })
          .setColor(0x5865f2)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (sub === "prune") {
    const keep = interaction.options.getInteger("keep") ?? 5;
    const before = existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR).filter((f) => f.startsWith("run-")).length : 0;
    pruneArchives(keep);
    const after = existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR).filter((f) => f.startsWith("run-")).length : 0;
    const deleted = before - after;

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Archives pruned")
          .addFields(
            { name: "Kept",    value: String(after),   inline: true },
            { name: "Deleted", value: String(deleted), inline: true },
            { name: "Limit",   value: String(keep),    inline: true },
          )
          .setColor(deleted > 0 ? 0xed4245 : 0x57f287)
          .setTimestamp(),
      ],
    });
  }
}
