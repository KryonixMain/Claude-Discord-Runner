import { spawnSync } from "child_process";
import { EmbedBuilder } from "discord.js";
import { getWorkDir } from "../lib/helpers.js";

export async function handleRollback(interaction) {
  const sessionNum = interaction.options.getInteger("session");
  const workDir = getWorkDir();

  // Check if workDir is a git repo
  const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8", cwd: workDir, timeout: 5_000,
  });

  if (gitCheck.status !== 0) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Not a git repository")
          .setDescription(`The working directory is not a git repository:\n\`${workDir}\`\n\nRollback requires git to identify and revert changes.`)
          .setColor(0xed4245),
      ],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  // Find commits related to this session
  // Look for recent commits and identify files changed
  const logResult = spawnSync("git", [
    "log", "--oneline", "--since=24 hours ago", "--all", "-50",
  ], { encoding: "utf8", cwd: workDir, timeout: 10_000 });

  if (logResult.status !== 0 || !logResult.stdout?.trim()) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No recent commits found")
          .setDescription("Could not find any commits from the last 24 hours to rollback.")
          .setColor(0xfee75c),
      ],
    });
  }

  // Get files changed by Claude in the working tree (uncommitted changes + recent commits)
  const diffResult = spawnSync("git", ["diff", "--stat", "HEAD~5", "HEAD"], {
    encoding: "utf8", cwd: workDir, timeout: 10_000,
  });

  const uncommittedResult = spawnSync("git", ["diff", "--stat"], {
    encoding: "utf8", cwd: workDir, timeout: 10_000,
  });

  const stagedResult = spawnSync("git", ["diff", "--staged", "--stat"], {
    encoding: "utf8", cwd: workDir, timeout: 10_000,
  });

  const changedFiles = [
    diffResult.stdout?.trim(),
    uncommittedResult.stdout?.trim(),
    stagedResult.stdout?.trim(),
  ].filter(Boolean).join("\n\n");

  if (!changedFiles) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No changes to rollback")
          .setDescription("No modified files found in the working directory.")
          .setColor(0xfee75c),
      ],
    });
  }

  // Show preview of what would be reverted
  const recentCommits = logResult.stdout.trim().split("\n").slice(0, 10).join("\n");

  // Actually perform the rollback: revert uncommitted changes for now
  // For safety, we only revert uncommitted changes (staged + unstaged)
  const stashResult = spawnSync("git", ["stash", "push", "-m", `rollback-session-${sessionNum}-${Date.now()}`], {
    encoding: "utf8", cwd: workDir, timeout: 10_000,
  });

  const stashed = stashResult.status === 0;
  const stashMsg = stashed
    ? "Uncommitted changes have been stashed. Use `git stash pop` to restore them."
    : "No uncommitted changes to stash.";

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Rollback for Session ${sessionNum}`)
        .setDescription(
          `**Recent commits:**\n\`\`\`\n${recentCommits}\n\`\`\`\n\n` +
          `**Changed files:**\n\`\`\`\n${changedFiles.slice(0, 1500)}\n\`\`\`\n\n` +
          `**Action taken:** ${stashMsg}\n\n` +
          `To fully revert committed changes, use:\n\`git revert <commit-hash>\``,
        )
        .setColor(stashed ? 0x57f287 : 0xfee75c)
        .setFooter({ text: "Use 'git stash list' to see stashed changes" })
        .setTimestamp(),
    ],
  });
}
