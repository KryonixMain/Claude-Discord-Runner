import { EmbedBuilder } from "discord.js";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { PROJECT_DIR } from "../lib/paths.js";

export async function handleGitChanges(interaction) {
  await interaction.deferReply();

  const gitDir = join(PROJECT_DIR, ".git");
  if (!existsSync(gitDir)) {
    await interaction.editReply({
      content: "No `.git` directory found — a git repository is required for this command.",
      ephemeral: true,
    });
    return;
  }

  const file = interaction.options.getString("file") ?? null;

  if (!file) {
    // List all changed files
    let output;
    try {
      output = execSync("git diff --name-only", { cwd: PROJECT_DIR, encoding: "utf8", timeout: 10_000 });
    } catch {
      output = "";
    }

    const files = output.trim().split("\n").filter(Boolean);
    if (files.length === 0) {
      await interaction.editReply("No changed files detected (working tree is clean).");
      return;
    }

    const list = files.map((f) => `\`${f}\``).join("\n");
    await interaction.editReply(`**Changed files (${files.length}):**\n${list.slice(0, 1900)}`);
    return;
  }

  // Show diff for specific file
  let diff;
  try {
    diff = execSync(`git diff HEAD -- "${file}"`, { cwd: PROJECT_DIR, encoding: "utf8", timeout: 10_000 });
  } catch {
    diff = "";
  }

  if (!diff.trim()) {
    await interaction.editReply(`No changes found for \`${file}\`.`);
    return;
  }

  // Check if binary
  if (diff.includes("Binary files")) {
    await interaction.editReply(`\`${file}\` is a binary file — cannot display diff.`);
    return;
  }

  // Split into chunks if > 1900 chars
  const MAX = 1900;
  const chunks = [];
  let remaining = diff;

  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", MAX);
    if (splitIdx <= 0) splitIdx = MAX;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  for (let i = 0; i < chunks.length; i++) {
    const content = `\`\`\`diff\n${chunks[i]}\n\`\`\``;
    if (i === 0) {
      await interaction.editReply(content);
    } else {
      await interaction.channel.send(content);
    }
  }
}
