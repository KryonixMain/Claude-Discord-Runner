import { spawn } from "child_process";
import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { EmbedBuilder } from "discord.js";
import { SESSION_DIR } from "../lib/paths.js";
import { getSetting } from "../lib/settings.js";
import { resolveClaudePath, ensureDir, getWorkDir } from "../lib/helpers.js";
import { buildSessionTemplate } from "../lib/session-setup.js";

function getNextSessionNumber() {
  ensureDir(SESSION_DIR);
  const files = readdirSync(SESSION_DIR).filter((f) => /^Session\d+\.md$/i.test(f));
  if (files.length === 0) return 1;
  const nums = files.map((f) => parseInt(f.match(/\d+/)[0]));
  return Math.max(...nums) + 1;
}

export async function handleCreateSession(interaction) {
  const task = interaction.options.getString("task");
  if (!task || task.trim().length < 5) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Invalid task description")
          .setDescription("Please provide a task description of at least 5 characters.")
          .setColor(0xed4245),
      ],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const sessionNum = getNextSessionNumber();
  const sessionFile = join(SESSION_DIR, `Session${sessionNum}.md`);
  const exampleTemplate = buildSessionTemplate(sessionNum, true);

  const prompt = [
    "You are a session file generator for an automated Claude Runner system.",
    "Generate a complete Session markdown file for the following task.",
    "",
    "## Task Description",
    task,
    "",
    "## Output Format Requirements",
    "Generate a COMPLETE session file following this exact structure:",
    "",
    "1. Start with an HTML comment containing SESSION OVERRIDE CONFIG JSON block:",
    "   - session.pauseAfterMs, session.defaultModel",
    "   - prompts object mapping prompt numbers to {model, maxTurns, timeoutMs}",
    "",
    "2. Session header: `# Session N — {Task Title}`",
    "",
    "3. Instruction block (EXACTLY these lines):",
    "   Execute ALL of the following prompts in order.",
    "   Do NOT wait for user input between prompts.",
    "   Continue automatically once the completion checklist of a prompt is fulfilled.",
    "   Mark each completed prompt with: `### PROMPT X COMPLETED`",
    "",
    "4. Each prompt MUST have:",
    "   - Header: `## Prompt N — {Description}`",
    "   - Agent tag: `[FULLSTACK]`, `[DATABASE]`, `[SECURITY]`, or `[MANAGER]`",
    "   - Clear task instructions",
    "   - Completion checklist with `- [ ]` items",
    "   - Separator: `---`",
    "",
    "5. Always include a final [SECURITY] prompt and a final [MANAGER] prompt",
    "",
    "## Rules",
    "- Generate 3-6 prompts depending on task complexity",
    "- Use appropriate agent tags for each prompt",
    "- Include risk tags where appropriate: `[LOW_RISK]`, `[REVIEW_REQUIRED]`, `[CRITICAL_PATH]`",
    "- Make prompts specific and actionable — no placeholders",
    "- Each prompt should have a clear completion checklist",
    `- Session number is: ${sessionNum}`,
    "",
    "## Example Template Structure (for reference only)",
    "```",
    exampleTemplate.slice(0, 600),
    "```",
    "",
    "Generate ONLY the session file content. No explanations or markdown code fences around the output.",
  ].join("\n");

  const claudePath = resolveClaudePath();
  const model = getSetting("runner", "defaultModel");

  const cliArgs = ["--print", "--model", model, "--max-turns", "5", "--output-format", "text"];
  if (getSetting("runner", "skipPermissions")) {
    cliArgs.push("--dangerously-skip-permissions");
  }

  const proc = spawn(
    claudePath,
    cliArgs,
    { cwd: getWorkDir(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
  );

  let output = "";
  let stderr = "";
  proc.stdout.on("data", (d) => { output += d; });
  proc.stderr.on("data", (d) => { stderr += d; });

  proc.stdin.write(prompt);
  proc.stdin.end();

  proc.on("exit", async (code) => {
    if (code !== 0 || output.trim().length < 50) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Session generation failed")
            .setDescription(
              `Claude exited with code ${code}.\n` +
              (stderr ? `\`\`\`${stderr.slice(0, 400)}\`\`\`` : "No error output captured."),
            )
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
    }

    // Clean output — remove any markdown code fences wrapping the result
    let content = output.trim();
    if (content.startsWith("```")) {
      content = content.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "");
    }

    ensureDir(SESSION_DIR);
    writeFileSync(sessionFile, content);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Session ${sessionNum} generated`)
          .setDescription(
            `AI-generated session file created from your task description.\n\n` +
            `**File:** \`Sessions/Session${sessionNum}.md\`\n` +
            `**Task:** ${task.slice(0, 200)}\n\n` +
            `Review the file before running \`/start\`. Use \`/validate-sessions\` to check structure.`,
          )
          .addFields(
            { name: "Model used", value: model, inline: true },
            { name: "Session #", value: String(sessionNum), inline: true },
          )
          .setColor(0x57f287)
          .setFooter({ text: "Review before /start — edit as needed" })
          .setTimestamp(),
      ],
    });
  });

  // Safety timeout for the generation process
  setTimeout(() => {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Session generation timed out")
            .setDescription("Claude did not respond within 120 seconds.")
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      }).catch(() => {});
    }
  }, 120_000);
}
