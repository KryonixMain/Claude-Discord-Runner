import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { EmbedBuilder } from "discord.js";
import { SESSION_DIR, LOG_DIR, CLAUDE_MD } from "../lib/paths.js";
import { getSetting } from "../lib/settings.js";
import { resolveClaudePath, ensureDir, loadState, saveState, getWorkDir } from "../lib/helpers.js";
import { parseSessionFile } from "../lib/session-parser.js";
import { isRunning } from "../state.js";

export async function handleRetryPrompt(interaction) {
  const sessionNum = interaction.options.getInteger("session");
  const promptNum = interaction.options.getInteger("prompt");

  if (isRunning()) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Run in progress")
          .setDescription("Cannot retry a prompt while a run is active. Use `/stop` first.")
          .setColor(0xed4245),
      ],
      ephemeral: true,
    });
  }

  const sessionFile = join(SESSION_DIR, `Session${sessionNum}.md`);
  if (!existsSync(sessionFile)) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Session not found")
          .setDescription(`\`Session${sessionNum}.md\` does not exist.`)
          .setColor(0xed4245),
      ],
      ephemeral: true,
    });
  }

  const content = readFileSync(sessionFile, "utf8");
  const prompts = parseSessionFile(content);
  const targetPrompt = prompts.find((p) => {
    const num = parseInt(p.title.match(/\d+/)?.[0]);
    return num === promptNum;
  });

  if (!targetPrompt) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Prompt not found")
          .setDescription(`Prompt ${promptNum} not found in Session ${sessionNum}.\nAvailable prompts: ${prompts.map((p) => p.title.match(/\d+/)?.[0]).join(", ")}`)
          .setColor(0xed4245),
      ],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const globalCtx = existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, "utf8") : "";
  const combinedPrompt = [
    "<!-- GLOBAL AGENT CONTEXT — CLAUDE.md -->",
    "",
    globalCtx,
    "",
    `<!-- RETRYING PROMPT ${promptNum} FROM Session${sessionNum} -->`,
    "",
    `# Session ${sessionNum} — Retry Prompt ${promptNum}`,
    "",
    "Execute the following prompt. This is a retry of a specific prompt.",
    `Mark completion with: \`### PROMPT ${promptNum} COMPLETED\``,
    "",
    "---",
    "",
    targetPrompt.text,
  ].join("\n");

  const claudePath = resolveClaudePath();
  const model = getSetting("runner", "defaultModel");
  const workDir = getWorkDir();

  ensureDir(LOG_DIR);

  const proc = spawn(
    claudePath,
    ["--print", "--model", model, "--max-turns", "100",
     "--dangerously-skip-permissions", "--output-format", "text",
     "--verbose", "--add-dir", workDir],
    { cwd: workDir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
  );

  let output = "";
  let stderr = "";
  const startTime = Date.now();

  proc.stdout.on("data", (d) => { output += d; });
  proc.stderr.on("data", (d) => { stderr += d; });

  proc.stdin.write(combinedPrompt);
  proc.stdin.end();

  const timeout = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
  }, 30 * 60_000);

  proc.on("exit", async (code) => {
    clearTimeout(timeout);
    const durationMs = Date.now() - startTime;
    const durationMin = Math.floor(durationMs / 60_000);
    const durationSec = Math.floor((durationMs % 60_000) / 1000);

    const outputFile = join(LOG_DIR, `Session${sessionNum}-Prompt${promptNum}.retry.md`);
    writeFileSync(outputFile, [
      `# Session ${sessionNum} — Prompt ${promptNum} — Retry Output`,
      `Date: ${new Date().toISOString()}`,
      `Duration: ${durationMin}m ${durationSec}s`,
      `Exit code: ${code}`,
      "",
      "---",
      "",
      output || "(no output)",
    ].join("\n"));

    try {
      const state = loadState();
      if (!state.promptCheckpoints) state.promptCheckpoints = {};
      if (!state.promptCheckpoints[`Session${sessionNum}`]) {
        state.promptCheckpoints[`Session${sessionNum}`] = {};
      }
      state.promptCheckpoints[`Session${sessionNum}`][String(promptNum)] = {
        completedAt: new Date().toISOString(),
        elapsedMs: durationMs,
        outputFile,
        retried: true,
      };
      saveState(state);
    } catch (err) { console.warn("[retry-prompt] Checkpoint save failed:", err.message); }

    const success = code === 0;

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(success
            ? `Prompt ${promptNum} retry completed`
            : `Prompt ${promptNum} retry failed`)
          .setDescription(
            `**Session:** ${sessionNum}\n` +
            `**Prompt:** ${promptNum} — ${targetPrompt.title.slice(0, 80)}\n` +
            `**Duration:** ${durationMin}m ${durationSec}s\n` +
            `**Output:** \`${outputFile}\`\n\n` +
            (success ? "Prompt executed successfully." : `Exit code: ${code}`),
          )
          .setColor(success ? 0x57f287 : 0xed4245)
          .setTimestamp(),
      ],
    });
  });
}
