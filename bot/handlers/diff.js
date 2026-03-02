import { EmbedBuilder } from "discord.js";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { ARCHIVE_DIR } from "../lib/paths.js";

export async function handleDiff(interaction) {
  await interaction.deferReply();

  const sessionNum = interaction.options.getInteger("session");
  const sessionKey = `Session${sessionNum}`;

  if (!existsSync(ARCHIVE_DIR)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No archives")
          .setDescription("No archive directory found. Run at least two runs first.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  // Find the two most recent archives that contain this session's output
  const archives = readdirSync(ARCHIVE_DIR)
    .filter((f) => f.startsWith("run-"))
    .sort()
    .reverse();

  const findSessionOutput = (archiveName) => {
    const sessDir = join(ARCHIVE_DIR, archiveName, "Sessions");
    if (!existsSync(sessDir)) return null;
    const files = readdirSync(sessDir).filter(
      (f) => f.includes(sessionKey) && f.endsWith(".output.md"),
    );
    if (files.length === 0) return null;
    return readFileSync(join(sessDir, files[0]), "utf8");
  };

  let prev = null;
  let curr = null;
  let prevName = null;
  let currName = null;

  for (const archiveName of archives) {
    const content = findSessionOutput(archiveName);
    if (content === null) continue;
    if (!curr) {
      curr = content;
      currName = archiveName;
    } else if (!prev) {
      prev = content;
      prevName = archiveName;
      break;
    }
  }

  if (!curr || !prev) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Not enough data")
          .setDescription(
            `Need at least 2 archived runs with \`${sessionKey}\` output to compare.\n` +
            `Found: ${curr ? 1 : 0} archive(s) with this session.`,
          )
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  // Simple line-based diff
  const prevLines = prev.split("\n");
  const currLines = curr.split("\n");
  const added   = currLines.filter((l) => !prevLines.includes(l));
  const removed = prevLines.filter((l) => !currLines.includes(l));

  const diffLines = [];
  for (const line of removed.slice(0, 15)) diffLines.push(`- ${line}`);
  for (const line of added.slice(0, 15))   diffLines.push(`+ ${line}`);

  const diffText = diffLines.length > 0
    ? `\`\`\`diff\n${diffLines.join("\n").slice(0, 1800)}\n\`\`\``
    : "No differences found.";

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Diff — ${sessionKey}`)
        .setDescription(diffText)
        .addFields(
          { name: "Previous", value: prevName, inline: true },
          { name: "Current",  value: currName, inline: true },
          { name: "Added lines",   value: String(added.length),   inline: true },
          { name: "Removed lines", value: String(removed.length), inline: true },
        )
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });
}
