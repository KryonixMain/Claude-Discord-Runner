import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { LOG_DIR, PROJECT_DIR, SECURITY_DIR, SESSION_DIR, ARCHIVE_DIR, SETTINGS_FILE, CLAUDE_MD } from "./paths.js";
import { CLAUDE_PLANS, DEFAULT_SETTINGS } from "./plans.js";
import { getSetting, saveSettings, loadSettings } from "./settings.js";

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

export function updateClaudeMdWorkDir(workDir) {
  const resolved = resolve(workDir || PROJECT_DIR);
  const template = readFileSync(new URL("./claude-md-template.txt", import.meta.url), "utf8");
  const workDirBlock = buildWorkDirBlock(resolved);

  if (!existsSync(CLAUDE_MD)) {
    writeFileSync(CLAUDE_MD, template + workDirBlock);
    return true;
  }

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
      session: { pauseAfterMs: 300_000, defaultModel: "claude-opus-4-6" },
      prompts: {
        1: { model: "claude-opus-4-6",  maxTurns: 100, timeoutMs: 120_000 },
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

  // Parse existing override to preserve dependsOn, waitForFile, and other custom props
  const existingOverride = parseExistingOverride(content);

  const prompts = {};
  for (let i = 1; i <= (promptCount || 3); i++) {
    const existing = existingOverride.prompts?.[String(i)] ?? {};
    prompts[String(i)] = {
      model:     existing.model     ?? (plan.label.includes("20") ? "claude-opus-4-6" : "claude-sonnet-4-5"),
      maxTurns:  existing.maxTurns  ?? getSetting("runner", "maxTurns"),
      timeoutMs: existing.timeoutMs ?? recommendedTimeoutMs,
      // Preserve waitForFile from existing override
      ...(existing.waitForFile ? { waitForFile: existing.waitForFile } : {}),
    };
  }

  const sessionConfig = {
    pauseAfterMs: existingOverride.session?.pauseAfterMs ?? getSetting("runner", "pauseMinutes") * 60_000,
    defaultModel: existingOverride.session?.defaultModel ?? getSetting("runner", "defaultModel"),
    // Preserve dependsOn from existing override
    ...(existingOverride.session?.dependsOn ? { dependsOn: existingOverride.session.dependsOn } : {}),
    // Preserve waitForFile at session level
    ...(existingOverride.session?.waitForFile ? { waitForFile: existingOverride.session.waitForFile } : {}),
  };

  const overrideJson  = JSON.stringify({ session: sessionConfig, prompts }, null, 2);
  const overrideBlock = `<!--\nSESSION OVERRIDE CONFIG\n${overrideJson}\n-->\n\n`;
  // Remove ALL existing override blocks (global flag)
  const cleaned       = content.replace(/<!--\r?\nSESSION OVERRIDE CONFIG[\s\S]*?-->\r?\n?\r?\n?/g, "");
  writeFileSync(filePath, overrideBlock + cleaned);
  return true;
}

/** Parse ALL SESSION OVERRIDE CONFIG blocks and merge them (preserves dependsOn, waitForFile from any block) */
function parseExistingOverride(content) {
  const allMatches = [...content.matchAll(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n([\s\S]*?)-->/g)];
  if (allMatches.length === 0) return {};

  let merged = {};
  for (const m of allMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      merged.session = { ...merged.session, ...parsed.session };
      merged.prompts = merged.prompts || {};
      if (parsed.prompts) {
        for (const [k, v] of Object.entries(parsed.prompts)) {
          merged.prompts[k] = { ...merged.prompts[k], ...v };
        }
      }
    } catch { /* ignore malformed block */ }
  }
  return merged;
}

export function runSetup(withOverride = false, planKey = null) {
  const created = [];

  // Create bot runtime dirs (now inside workDir)
  for (const dir of [LOG_DIR, SECURITY_DIR, SESSION_DIR, ARCHIVE_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(`📁 ${basename(dir)}/`);
    }
  }

  // Create workspace communication dirs inside workDir
  const workDir = resolve(getSetting("runner", "workDir") || PROJECT_DIR);
  const workspaceDirs = ["tasks", "plans", "inbox", "status", "review", "locks", "Learnings", "Agents"];
  for (const sub of workspaceDirs) {
    const dir = join(workDir, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(`📁 ${sub}/`);
    }
  }

  if (!existsSync(SETTINGS_FILE)) {
    saveSettings(DEFAULT_SETTINGS);
    created.push("⚙️ settings.json");
  }

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
