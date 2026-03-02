import { EmbedBuilder } from "discord.js";

const COMMAND_GROUPS = [
  {
    name: "Run Control",
    commands: [
      ["/setup `[plan]` `[override]`",    "Create directories, CLAUDE.md and Session1.md template"],
      ["/setup-wizard",                    "Interactive setup — guides through plan, model, permissions"],
      ["/start `[reset]`",                "Start run-sessions.js — optionally reset progress"],
      ["/restart",                        "Restart, keeping completed sessions"],
      ["/stop",                           "Kill the running process and/or Security Fix"],
      ["/reset confirm:yes",              "Clear all progress and restart from Session 1"],
      ["/pause",                          "Pause after the current session completes"],
      ["/resume",                         "Resume a paused run"],
      ["/retry session:N",               "Re-run a single completed/failed session"],
      ["/retry-prompt `session:N` `prompt:M`", "Re-run a specific prompt from a session"],
      ["/schedule time:HH:MM",           "Schedule a run to start at a specific time"],
      ["/cancel-schedule",                "Cancel a scheduled run"],
    ],
  },
  {
    name: "Monitoring",
    commands: [
      ["/status",                         "Show per-session completion status and durations"],
      ["/watch `[action]`",              "Live-stream Claude output to Discord (auto-updates every 5s)"],
      ["/logs `[lines]`",                 "Print the last N lines of the current log file"],
      ["/rate-limit",                     "Show estimated token usage vs. plan budget"],
      ["/detect-sessions",                "Parse all session files and show prompt breakdown"],
      ["/validate-sessions",              "Validate all session files before a run"],
      ["/dry-run",                        "Validate + estimate tokens without executing"],
      ["/export-logs",                    "Export all log files as a Discord attachment"],
      ["/git-changes `[file]`",           "Show files changed by Claude or diff for a specific file"],
    ],
  },
  {
    name: "Security",
    commands: [
      ["/security-status",                "List all findings across all security reports"],
      ["/start-resolve-security",         "Manually trigger the Claude security fix pass"],
    ],
  },
  {
    name: "Sessions & Settings",
    commands: [
      ["/new-session `number` `[override]`", "Create a new Session N.md from template"],
      ["/set-timeout session:N minutes:M", "Set a per-session timeout override"],
      ["/override session:N model:X",      "Set a per-session model override"],
      ["/diff session:N",                  "Compare session output between last two archives"],
      ["/dependency-graph",                "Visualize session dependency relationships"],
      ["/settings show",                  "Display all current settings"],
      ["/settings set `key` `value`",     "Change a setting (e.g. runner.pauseMinutes 120)"],
      ["/settings reset",                 "Restore all settings to defaults"],
    ],
  },
  {
    name: "Archive",
    commands: [
      ["/archive now",                    "Archive the current run immediately"],
      ["/archive list",                   "List all archived runs"],
      ["/archive prune `[keep]`",         "Delete old archives, keeping the last N"],
    ],
  },
  {
    name: "Utilities",
    commands: [
      ["/dashboard",                      "Show the web dashboard URL"],
      ["/info",                           "Show version, system info, and changelog"],
    ],
  },
  {
    name: "AI & Templates",
    commands: [
      ["/create-session `task`",          "AI-generate a session file from a task description"],
      ["/generate-template `which`",      "Scaffold a session or agent template"],
      ["/estimate",                       "Detailed cost/time estimate for all sessions"],
      ["/health",                         "Comprehensive runtime health check"],
    ],
  },
  {
    name: "Git & Comparison",
    commands: [
      ["/rollback `session:N`",           "Stash uncommitted changes for a session via git"],
      ["/compare-sessions `session:N` `[archive]`", "Cross-archive comparison for a session"],
    ],
  },
];

export async function handleHelp(interaction) {
  const embeds = COMMAND_GROUPS.map((group) =>
    new EmbedBuilder()
      .setTitle(group.name)
      .setDescription(
        group.commands.map(([cmd, desc]) => `**${cmd}**\n${desc}`).join("\n\n"),
      )
      .setColor(0x5865f2),
  );

  await interaction.reply({ embeds });
}
