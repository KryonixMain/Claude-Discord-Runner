import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { LOG_DIR, PROJECT_DIR, SECURITY_DIR, SESSION_DIR, ARCHIVE_DIR, SETTINGS_FILE, CLAUDE_MD } from "./paths.js";
import { CLAUDE_PLANS, DEFAULT_SETTINGS } from "./plans.js";
import { getSetting, saveSettings, loadSettings } from "./settings.js";
import { ensureDir } from "./helpers.js";

/**
 * Build the Working Directory block appended to CLAUDE.md.
 */
function buildWorkDirBlock(workDir) {
  return [
    "",
    "---",
    "",
    "## Working Directory",
    "",
    "All file operations and code changes MUST target the following directory:",
    "",
    `    ${workDir}`,
    "",
    "Do not create or modify files outside this directory unless explicitly instructed.",
    "",
  ].join("\n");
}

/**
 * Write or update CLAUDE.md with the current workDir.
 * Replaces the Working Directory section if it already exists.
 */
export function updateClaudeMdWorkDir(workDir) {
  const resolved = resolve(workDir || PROJECT_DIR);
  const template = readFileSync(new URL("./claude-md-template.txt", import.meta.url), "utf8");
  const workDirBlock = buildWorkDirBlock(resolved);

  if (!existsSync(CLAUDE_MD)) {
    writeFileSync(CLAUDE_MD, template + workDirBlock);
    return true;
  }

  // Replace existing Working Directory section
  const current = readFileSync(CLAUDE_MD, "utf8");
  const sectionRegex = /\n---\n\n## Working Directory\n[\s\S]*$/;
  if (sectionRegex.test(current)) {
    writeFileSync(CLAUDE_MD, current.replace(sectionRegex, workDirBlock));
  } else {
    writeFileSync(CLAUDE_MD, current + workDirBlock);
  }
  return true;
}

export function buildSessionTemplate(sessionNumber, withOverride) {
  const header = [
    `# Session ${sessionNumber} — Task Overview`,
    "",
    "Execute ALL of the following prompts in order.",
    "Do NOT wait for user input between prompts.",
    "Continue automatically once the completion checklist of a prompt is fulfilled.",
    "Mark each completed prompt with: `### PROMPT X COMPLETED`",
    "",
    "---",
    "",
  ].join("\n");

  const promptBlock = (n) =>
    `## Prompt ${n} — {Description}\n\n{Your prompt here}\n\n---\n\n`;
  const prompts = [1, 2, 3].map(promptBlock).join("");

  if (!withOverride) return header + prompts;

  const overrideBlock = [
    "<!--",
    "SESSION OVERRIDE CONFIG",
    JSON.stringify({
      session: { pauseAfterMs: 300_000, defaultModel: "claude-opus-4-5" },
      prompts: {
        1: { model: "claude-opus-4-5",  maxTurns: 100, timeoutMs: 120_000 },
        2: { model: "claude-sonnet-4-5", maxTurns: 20,  timeoutMs: 120_000 },
      },
    }, null, 2),
    "-->",
    "",
    "",
  ].join("\n");

  return overrideBlock + header + prompts;
}

export function applyTimeoutsToSessionFile(filePath, recommendedTimeoutMs, promptCount, planKey) {
  if (!existsSync(filePath)) return false;

  const plan    = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const content = readFileSync(filePath, "utf8");
  const prompts = {};

  for (let i = 1; i <= (promptCount || 3); i++) {
    prompts[String(i)] = {
      model:     plan.label.includes("20") ? "claude-opus-4-5" : "claude-sonnet-4-5",
      maxTurns:  getSetting("runner", "maxTurns"),
      timeoutMs: recommendedTimeoutMs,
    };
  }

  const overrideJson   = JSON.stringify({
    session: {
      pauseAfterMs: getSetting("runner", "pauseMinutes") * 60_000,
      defaultModel: getSetting("runner", "defaultModel"),
    },
    prompts,
  }, null, 2);

  const overrideBlock = `<!--\nSESSION OVERRIDE CONFIG\n${overrideJson}\n-->\n\n`;
  const cleaned       = content.replace(/<!--\nSESSION OVERRIDE CONFIG[\s\S]*?-->\n\n/, "");
  writeFileSync(filePath, overrideBlock + cleaned);
  return true;
}

export function runSetup(withOverride = false, planKey = null) {
  const created = [];

  for (const dir of [LOG_DIR, SECURITY_DIR, SESSION_DIR, ARCHIVE_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(`📁 ${basename(dir)}/`);
    }
  }

  if (!existsSync(SETTINGS_FILE)) {
    saveSettings(DEFAULT_SETTINGS);
    created.push("⚙️ settings.json");
  }

  // Auto-set workDir if not configured
  const settings = loadSettings();
  if (!settings.runner?.workDir) {
    settings.runner = settings.runner || {};
    settings.runner.workDir = PROJECT_DIR;
    saveSettings(settings);
    created.push(`📂 workDir set → ${PROJECT_DIR}`);
  }

  if (planKey && CLAUDE_PLANS[planKey]) {
    const s = loadSettings();
    s.runner.claudePlan = planKey;
    saveSettings(s);
    created.push(`📋 Plan set → ${CLAUDE_PLANS[planKey].label}`);
  }

  // Write or update CLAUDE.md with workDir injected
  const workDir = resolve(getSetting("runner", "workDir") || PROJECT_DIR);
  const claudeMdExisted = existsSync(CLAUDE_MD);
  updateClaudeMdWorkDir(workDir);
  if (!claudeMdExisted) {
    created.push("📄 CLAUDE.md");
  } else {
    created.push("📄 CLAUDE.md (workDir updated)");
  }

  const session1Path = join(SESSION_DIR, "Session1.md");
  if (!existsSync(session1Path)) {
    writeFileSync(session1Path, buildSessionTemplate(1, withOverride));
    created.push("📝 Sessions/Session1.md (template)");
  }

  return created;
}
