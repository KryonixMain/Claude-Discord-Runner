import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { EmbedBuilder } from "discord.js";
import {
  getRunningProcess, setRunningProcess,
  getSecurityFixProcess, setSecurityFixProcess,
  isRunning, isSecurityFixRunning,
} from "./state.js";
import { BASE_DIR, PROJECT_DIR, SECURITY_DIR, CLAUDE_MD } from "./lib/paths.js";
import { getSetting } from "./lib/settings.js";
import { loadSecurityReports, countFindings, resolveClaudePath, loadState, killProcessGracefully, getWorkDir } from "./lib/helpers.js";
import { archiveCompletedRun, pruneArchives } from "./lib/archive.js";
import { validateAllSessions } from "./lib/session-validator.js";
import { detectSessions } from "./lib/session-parser.js";
import { calculateSessionTimeouts } from "./lib/calculator.js";
import { CLAUDE_PLANS } from "./lib/plans.js";
import {
  notifyRunStart,
  notifyRunComplete,
  notifyRunFailed,
  notifyRateLimitWarning,
  notifyValidationFailed,
  notifySecurityFixStart,
  notifySecurityFixComplete,
  notifyArchived,
} from "../discord-notify.js";

export async function startRunProcess(args = [], channel = null) {
  const validation = validateAllSessions();
  if (!validation.allValid) {
    const failedFiles = validation.results.filter((r) => !r.valid);
    const lines = failedFiles
      .map((r) => `**${r.file}**: ${r.errors.join(" • ")}`)
      .join("\n");

    channel?.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Startup blocked — Session validation failed")
          .setDescription(
            "One or more session files contain errors.\n" +
            "Fix all issues and run `/validate-sessions` before retrying.\n\n" +
            lines,
          )
          .setColor(0xed4245)
          .setFooter({ text: "Use /validate-sessions for a detailed report" })
          .setTimestamp(),
      ],
    });
    notifyValidationFailed({ failedFiles });
    return;
  }

  if (isRunning()) {
    await killProcessGracefully(getRunningProcess(), "run-sessions.js");
    setRunningProcess(null);
  }

  // Gather session info for notification
  const detected = detectSessions();
  const totalSessions = detected.sessions?.length ?? 0;
  const totalPrompts  = detected.sessions?.reduce((s, x) => s + x.promptCount, 0) ?? 0;

  const workDir = getWorkDir();
  const proc = spawn("node", ["run-sessions.js", ...args], {
    cwd:      PROJECT_DIR,
    stdio:    "inherit",
    detached: false,
    env:      { ...process.env, CLAUDE_WORK_DIR: workDir },
  });
  setRunningProcess(proc);

  notifyRunStart({
    totalSessions,
    totalPrompts,
    model: getSetting("runner", "defaultModel"),
    plan: CLAUDE_PLANS[getSetting("runner", "claudePlan")]?.label,
    baseDir: BASE_DIR,
  });

  // Rate-limit warning
  if (!detected.error && detected.sessions?.length > 0) {
    const planKey = getSetting("runner", "claudePlan");
    const calc    = calculateSessionTimeouts(detected.sessions, planKey);
    const plan    = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

    if (!calc.fitsInOneWindow) {
      notifyRateLimitWarning({
        planLabel: plan.label,
        usedTokens: calc.totalOutputTokens,
        budgetTokens: calc.budgetTokens,
        windowsNeeded: calc.windowsNeeded,
      });
    }
  }

  const runStartedAt = Date.now();

  proc.on("exit", async (code) => {
    console.log(`[Bot] run-sessions.js exited — code ${code}`);
    setRunningProcess(null);

    const totalDurationMs = Date.now() - runStartedAt;
    const state           = loadState();
    const sc              = getSetting("sessions", "count");
    const allDone         = (state.completedSessions?.length ?? 0) >= sc;
    const autoFix         = getSetting("runner", "autoSecurityFix");
    const doArchive       = getSetting("runner", "archiveOnComplete");

    if (code !== 0) {
      notifyRunFailed({ errorMsg: `Exit code ${code}`, exitCode: code });
      await channel?.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Run failed")
            .setDescription(
              `run-sessions.js exited with code \`${code ?? "?"}\`.\n` +
              `Use \`/restart\` to resume from the last completed session.`,
            )
            .addFields(
              { name: "Exit code", value: String(code ?? "?"), inline: true },
              { name: "Tip",       value: "Use `/restart` to resume. Completed sessions will be skipped.", inline: false },
            )
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
      return;
    }

    if (allDone) {
      if (autoFix) {
        await channel?.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("All sessions completed — starting Security Fix")
              .setDescription("Claude is now scanning all Security reports and fixing violations.")
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
        startSecurityFix(channel);
      } else if (doArchive) {
        const ap = archiveCompletedRun();
        pruneArchives(5);
        notifyRunComplete({ totalSessions: sc, totalDurationMs, archivePath: ap });
        notifyArchived({ archivePath: ap, runLabel: `run-${new Date().toISOString().slice(0, 10)}` });
        await channel?.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("Run completed — Archived")
              .setDescription(`All files archived to:\n\`${ap}\``)
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
      } else {
        notifyRunComplete({ totalSessions: sc, totalDurationMs });
        await channel?.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("Run fully completed")
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
      }
    }
  });
}

export function startSecurityFix(channel = null) {
  if (isSecurityFixRunning()) return;

  const reports = loadSecurityReports();
  if (reports.length === 0) {
    console.log("[Bot] No security reports — skipping fix");
    if (getSetting("runner", "archiveOnComplete")) {
      const ap = archiveCompletedRun();
      pruneArchives(5);
      notifyArchived({ archivePath: ap });
      channel?.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Run archived")
            .setDescription(`\`${ap}\``)
            .setColor(0x5865f2)
            .setTimestamp(),
        ],
      });
    }
    return;
  }

  const totalC = reports.reduce((s, r) => s + countFindings(r.content, "CRITICAL"), 0);
  const totalW = reports.reduce((s, r) => s + countFindings(r.content, "WARNING"), 0);

  notifySecurityFixStart({
    reportCount: reports.length,
    criticalCount: totalC,
    warningCount: totalW,
  });

  channel?.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("Security Fix started")
        .addFields(
          { name: "Reports",     value: String(reports.length), inline: true },
          { name: "Critical",    value: String(totalC),         inline: true },
          { name: "Warnings",    value: String(totalW),         inline: true },
        )
        .setColor(0xeb459e)
        .setTimestamp(),
    ],
  });

  const reportContents = reports
    .map((r) => `### Report: ${r.name}\n\n${r.content}`)
    .join("\n\n---\n\n");

  const globalCtx = existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, "utf8") : "";
  const model     = getSetting("runner", "defaultModel");

  const prompt = [
    globalCtx, "",
    "## Task: Fix Security Violations", "",
    "Go through ALL of the following security reports and fix every finding.",
    "Work in order: CRITICAL → WARNING → INFO.",
    "For each fixed item: mark it in the report with FIXED.",
    "Do not skip any item — complete all of them.", "",
    "---", "",
    reportContents,
  ].join("\n");

  const secWorkDir = getWorkDir();
  const secCliArgs = [
    "--print", "--model", model, "--max-turns", "200",
    "--output-format", "text", "--verbose", "--add-dir", secWorkDir,
  ];
  if (getSetting("runner", "skipPermissions")) {
    secCliArgs.push("--dangerously-skip-permissions");
  }
  const proc = spawn(
    resolveClaudePath(),
    secCliArgs,
    { cwd: secWorkDir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
  );
  setSecurityFixProcess(proc);

  proc.stdin.write(prompt);
  proc.stdin.end();

  let output = "";
  proc.stdout.on("data", (d) => { output += d; });
  proc.stderr.on("data", (d) => { console.error("[SecurityFix]", d.toString().slice(0, 200)); });

  proc.on("exit", async (code) => {
    setSecurityFixProcess(null);

    const outFile = join(SECURITY_DIR, `fix-output-${Date.now()}.md`);
    try { writeFileSync(outFile, output); } catch (err) { console.warn("[Bot] Failed to write security fix output:", err.message); }

    const ok = code === 0;

    notifySecurityFixComplete({ success: ok, outputPath: outFile, exitCode: code });

    await channel?.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(ok ? "Security Fix completed" : "Security Fix failed")
          .setDescription(
            ok
              ? `All violations processed.\nOutput: \`${outFile}\``
              : `Process exited with code ${code}.\nOutput: \`${outFile}\``,
          )
          .setColor(ok ? 0x57f287 : 0xed4245)
          .setTimestamp(),
      ],
    });

    if (getSetting("runner", "archiveOnComplete")) {
      const ap = archiveCompletedRun();
      pruneArchives(5);
      notifyArchived({ archivePath: ap, runLabel: `run-${new Date().toISOString().slice(0, 10)}` });
      await channel?.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Run archived")
            .setDescription(`All files moved to:\n\`${ap}\``)
            .setColor(0x5865f2)
            .setTimestamp(),
        ],
      });
    }
  });
}
