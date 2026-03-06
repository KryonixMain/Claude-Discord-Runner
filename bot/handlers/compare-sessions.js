import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { EmbedBuilder } from "discord.js";
import { ARCHIVE_DIR } from "../lib/paths.js";

function listArchives() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .filter((f) => f.startsWith("run-") && statSync(join(ARCHIVE_DIR, f)).isDirectory())
    .sort()
    .reverse();
}

export async function handleCompareSessions(interaction) {
  const sessionNum = interaction.options.getInteger("session");
  const archiveName = interaction.options.getString("archive");

  const archives = listArchives();
  if (archives.length < 2) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Not enough archives")
          .setDescription(`Need at least 2 archived runs to compare.\nFound: ${archives.length}\n\nUse \`/archive now\` after a run completes.`)
          .setColor(0xfee75c),
      ],
      ephemeral: true,
    });
  }

  let archiveA, archiveB;
  if (archiveName) {
    const match = archives.find((a) => a.includes(archiveName));
    if (!match) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Archive not found")
            .setDescription(`No archive matching \`${archiveName}\`.\n\nAvailable:\n${archives.slice(0, 10).map((a) => `\`${a}\``).join("\n")}`)
            .setColor(0xed4245),
        ],
        ephemeral: true,
      });
    }
    archiveB = match;
    archiveA = archives.find((a) => a !== match) ?? archives[0];
  } else {
    archiveA = archives[0];
    archiveB = archives[1];
  }

  await interaction.deferReply();

  const sessionFile = `Session${sessionNum}.md`;
  const logFile = `run-Session${sessionNum}.log`;

  const pathsToCheck = [
    { dir: "Logs", file: logFile },
    { dir: "Sessions", file: sessionFile },
  ];

  const results = [];

  for (const { dir, file } of pathsToCheck) {
    const pathA = join(ARCHIVE_DIR, archiveA, dir, file);
    const pathB = join(ARCHIVE_DIR, archiveB, dir, file);

    const existsA = existsSync(pathA);
    const existsB = existsSync(pathB);

    if (!existsA && !existsB) continue;

    const contentA = existsA ? readFileSync(pathA, "utf8") : "(not found)";
    const contentB = existsB ? readFileSync(pathB, "utf8") : "(not found)";

    if (contentA === contentB) {
      results.push({ file: `${dir}/${file}`, status: "identical", diff: null });
    } else {
      const linesA = contentA.split("\n");
      const linesB = contentB.split("\n");

      const added = linesA.filter((l) => !linesB.includes(l)).length;
      const removed = linesB.filter((l) => !linesA.includes(l)).length;

      results.push({
        file: `${dir}/${file}`,
        status: "changed",
        added,
        removed,
        sizeA: contentA.length,
        sizeB: contentB.length,
      });
    }
  }

  const progressFiles = [archiveA, archiveB].map((arch) => {
    const dir = join(ARCHIVE_DIR, arch);
    const files = readdirSync(dir).filter((f) => f.startsWith("progress-") && f.endsWith(".json"));
    if (files.length === 0) return null;
    try {
      return JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    } catch { return null; }
  });

  const [progressA, progressB] = progressFiles;

  const fileComparison = results.length > 0
    ? results.map((r) => {
        if (r.status === "identical") return `\`${r.file}\` — Identical`;
        return `\`${r.file}\` — +${r.added} / -${r.removed} lines (${r.sizeA} → ${r.sizeB} chars)`;
      }).join("\n")
    : `No output files found for Session ${sessionNum} in either archive.`;

  const fields = [
    { name: "Archive A (newer)", value: `\`${archiveA}\``, inline: false },
    { name: "Archive B (older)", value: `\`${archiveB}\``, inline: false },
  ];

  if (progressA || progressB) {
    const sessionsA = progressA?.completedSessions?.length ?? 0;
    const sessionsB = progressB?.completedSessions?.length ?? 0;
    fields.push(
      { name: "Completed (A)", value: String(sessionsA), inline: true },
      { name: "Completed (B)", value: String(sessionsB), inline: true },
      { name: "Delta", value: String(sessionsA - sessionsB), inline: true },
    );

    const tokensA = progressA?.sessionDetails
      ? Object.values(progressA.sessionDetails).reduce((s, d) => s + (d.tokenUsage?.outputTokens ?? 0), 0)
      : 0;
    const tokensB = progressB?.sessionDetails
      ? Object.values(progressB.sessionDetails).reduce((s, d) => s + (d.tokenUsage?.outputTokens ?? 0), 0)
      : 0;
    if (tokensA > 0 || tokensB > 0) {
      fields.push(
        { name: "Tokens (A)", value: `~${(tokensA / 1000).toFixed(1)}k`, inline: true },
        { name: "Tokens (B)", value: `~${(tokensB / 1000).toFixed(1)}k`, inline: true },
        { name: "Token delta", value: `${tokensA > tokensB ? "+" : ""}${((tokensA - tokensB) / 1000).toFixed(1)}k`, inline: true },
      );
    }
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Session ${sessionNum} — Cross-Archive Comparison`)
        .setDescription(fileComparison)
        .addFields(fields)
        .setColor(0x5865f2)
        .setFooter({ text: "Use /diff for comparing the two most recent archives only" })
        .setTimestamp(),
    ],
  });
}
