import { spawn, spawnSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  notifyRunStart,
  notifyRunComplete,
  notifyRunFailed,
  notifySessionStart,
  notifySessionSuccess,
  notifySessionFailed,
  notifySessionSkipped,
  notifyPromptStart,
  notifyPromptComplete,
  notifyPause,
  notifyRateLimitWarning,
  notifySecurityAlert,
  notifyTimeoutWarning,
} from "./discord-notify.js";

// ########################################################################### Paths ###########################################################################

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;                                   // project root (run-sessions.js lives here)
const SETTINGS_FILE = join(PROJECT_DIR, "bot", "settings.json"); // bot config stays in bot/

// Runtime data directories — at project root (consistent with bot/lib/paths.js)
const SESSION_DIR  = join(PROJECT_DIR, "Sessions");
const LOG_DIR      = join(PROJECT_DIR, "Logs");
const SECURITY_DIR = join(PROJECT_DIR, "Security");
const ARCHIVE_DIR  = join(PROJECT_DIR, "Archive");
const STATE_FILE   = join(PROJECT_DIR, ".progress.json");
const CLAUDE_MD    = join(PROJECT_DIR, "CLAUDE.md");

// Work directory: env var (set by bot process.js) > settings > fallback to PROJECT_DIR
function resolveWorkDir() {
  if (process.env.CLAUDE_WORK_DIR) return process.env.CLAUDE_WORK_DIR;
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      if (s?.runner?.workDir) return s.runner.workDir;
    }
  } catch (err) { console.warn("[run-sessions] Could not read settings for workDir:", err.message); }
  return PROJECT_DIR;
}
const WORK_DIR = resolveWorkDir();

// ########################################################################### CLI Args ###########################################################################

const args = process.argv.slice(2);
const RESET_FLAG   = args.includes("--reset");
const DRY_RUN_FLAG = args.includes("--dry-run");

const sessionArgIdx = args.indexOf("--session");
const SESSION_FILTER = sessionArgIdx !== -1 ? parseInt(args[sessionArgIdx + 1], 10) : null;

// ########################################################################### Settings ###########################################################################

const DEFAULT_SETTINGS = {
  runner: {
    defaultModel: "claude-opus-4-5",
    maxTurns: 200,
    pauseMinutes: 360,
    claudePlan: "max20",
  },
};

function loadSettings() {
  if (!existsSync(SETTINGS_FILE)) return structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return deepMerge(DEFAULT_SETTINGS, raw);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override ?? {})) {
    if (
      typeof override[key] === "object" &&
      override[key] !== null &&
      !Array.isArray(override[key]) &&
      typeof base[key] === "object"
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function getSetting(...keys) {
  return keys.reduce((obj, k) => obj?.[k], loadSettings());
}

// ########################################################################### Claude Plan Definitions ###########################################################################

const CLAUDE_PLANS = {
  pro: {
    label: "Pro ($20/mo)",
    outputTokensPer5h: 44_000,
    windowMs: 5 * 60 * 60 * 1000,
  },
  max5: {
    label: "Max 5× ($100/mo)",
    outputTokensPer5h: 88_000,
    windowMs: 5 * 60 * 60 * 1000,
  },
  max20: {
    label: "Max 20× ($200/mo)",
    outputTokensPer5h: 220_000,
    windowMs: 5 * 60 * 60 * 1000,
  },
};

// ########################################################################### Model Constants ###########################################################################

const OPUS = "claude-opus-4-5";
const SONNET = "claude-sonnet-4-5";

// ########################################################################### Prompt Config Defaults ###########################################################################

const DEFAULT_PROMPT_CONFIG = {
  model: OPUS,
  maxTurns: 80,
  timeoutMs: 2 * 60 * 60 * 1000,
};

const LIGHTWEIGHT_KEYWORDS = [
  "roadmap update",
  "section update",
  "module update",
];

const LIGHTWEIGHT_PROMPT_CONFIG = {
  model: SONNET,
  maxTurns: 25,
  timeoutMs: 45 * 60 * 1000,
};

// ########################################################################### Helpers ###########################################################################

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function formatDuration(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function log(msg, level = "INFO") {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.padEnd(5)}] ${msg}`;
  console.log(line);
  ensureDir(LOG_DIR);
  const logFile = join(
    LOG_DIR,
    `run-${new Date().toISOString().slice(0, 10)}.log`,
  );
  writeFileSync(logFile, line + "\n", { flag: "a" });
}

async function sleepWithCountdown(ms, label) {
  const intervalMs = 60_000;
  const steps = Math.ceil(ms / intervalMs);
  for (let i = 0; i < steps; i++) {
    const remaining = Math.ceil((ms - i * intervalMs) / 60_000);
    process.stdout.write(
      `\r⏸  ${label} — ${remaining} minute(s) remaining...    `,
    );
    await new Promise((r) =>
      setTimeout(r, Math.min(intervalMs, ms - i * intervalMs)),
    );
  }
  process.stdout.write("\n");
}

// ########################################################################### State ###########################################################################

function loadState() {
  if (!existsSync(STATE_FILE))
    return { completedSessions: [], startedAt: new Date().toISOString() };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { completedSessions: [], startedAt: new Date().toISOString() };
  }
}

function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

// ########################################################################### Claude Binary ###########################################################################

function resolveClaudePath() {
  log("Searching for claude binary...");
  const isWin = process.platform === "win32";

  // 1. Platform-native lookup: where.exe (Windows) or which (Unix)
  const whichCmd = isWin ? "where.exe" : "which";
  const w = spawnSync(whichCmd, ["claude"], { encoding: "utf8", shell: isWin });
  if (w.status === 0 && w.stdout?.trim()) {
    const found = w.stdout.trim().split("\n")[0].trim();
    log(`claude found via ${whichCmd}: ${found}`);
    return { path: found, shell: isWin && (found.endsWith(".cmd") || found.endsWith(".ps1")) };
  }

  // 2. npm prefix lookup
  const npmPrefix = spawnSync("npm", ["config", "get", "prefix"], {
    encoding: "utf8",
    shell: true,
  });
  if (npmPrefix.status === 0 && npmPrefix.stdout?.trim()) {
    const prefix = npmPrefix.stdout.trim();
    const candidates = isWin
      ? [join(prefix, "claude.cmd"), join(prefix, "claude.ps1"), join(prefix, "claude")]
      : [join(prefix, "bin", "claude")];
    for (const c of candidates) {
      if (existsSync(c)) {
        log(`claude found via npm prefix: ${c}`);
        return { path: c, shell: isWin && (c.endsWith(".cmd") || c.endsWith(".ps1")) };
      }
    }
  }

  // 3. Platform-specific fallback paths
  if (isWin && process.env.APPDATA) {
    const candidates = [
      join(process.env.APPDATA, "npm", "claude.cmd"),
      join(process.env.APPDATA, "npm", "claude.ps1"),
      join(process.env.APPDATA, "npm", "claude"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        log(`claude found via APPDATA/npm: ${c}`);
        return { path: c, shell: c.endsWith(".cmd") || c.endsWith(".ps1") };
      }
    }
  } else if (!isWin) {
    const home = process.env.HOME ?? "";
    const candidates = [
      join(home, ".npm-global", "bin", "claude"),
      join(home, ".local", "bin", "claude"),
      "/usr/local/bin/claude",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        log(`claude found at: ${c}`);
        return { path: c, shell: false };
      }
    }
  }

  log("Falling back to 'claude' with shell:true", "WARN");
  return { path: "claude", shell: true };
}

// ########################################################################### Session Override Config Parser ###########################################################################

function parseSessionOverride(content) {
  const commentMatch = content.match(
    /<!--\nSESSION OVERRIDE CONFIG\n([\s\S]*?)-->/,
  );
  if (commentMatch) {
    try {
      return JSON.parse(commentMatch[1]);
    } catch {
      log("Failed to parse HTML-comment override block — falling back", "WARN");
    }
  }

  const fenceMatch = content.match(/^```json\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      log("Failed to parse fenced JSON override block", "WARN");
    }
  }

  return {};
}

// ########################################################################### Prompt Parser ###########################################################################

function parsePrompts(content, sessionName, override) {
  const stripped = content
    .replace(/<!--\nSESSION OVERRIDE CONFIG[\s\S]*?-->\n?\n?/, "")
    .replace(/^```json\s*\n[\s\S]*?\n```\s*\n?/, "");

  const matches = [...stripped.matchAll(/^##\s+Prompt\s+(\d+)\s*[—–:\-]/gim)];

  if (matches.length === 0) {
    log(
      `${sessionName}: No ## Prompt N — headers found — treating as 1 prompt`,
      "WARN",
    );
    return [
      {
        index: 1,
        label: `${sessionName} — Main Prompt`,
        chars: stripped.length,
        text: stripped,
        ...DEFAULT_PROMPT_CONFIG,
      },
    ];
  }

  return matches.map((match, i) => {
    const promptNumber = parseInt(match[1]);
    const promptLabel = match[0].replace(/^##\s+/, "").trim();

    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : stripped.length;
    const chars = end - start;
    const text = stripped.slice(start, end);

    const isLightweight = LIGHTWEIGHT_KEYWORDS.some((kw) =>
      promptLabel.toLowerCase().includes(kw),
    );
    const baseConfig = isLightweight
      ? LIGHTWEIGHT_PROMPT_CONFIG
      : DEFAULT_PROMPT_CONFIG;

    const sessionModelOverride = override?.session?.defaultModel
      ? { model: override.session.defaultModel }
      : {};

    const promptOverride = override?.prompts?.[String(promptNumber)] ?? {};

    return {
      index: promptNumber,
      label: promptLabel,
      chars,
      text,
      ...baseConfig,
      ...sessionModelOverride,
      ...promptOverride,
    };
  });
}

// ########################################################################### Session Loader ###########################################################################

function loadSessions() {
  if (!existsSync(SESSION_DIR)) {
    log(`Session directory not found: ${SESSION_DIR}`, "ERROR");
    process.exit(1);
  }

  let files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  // --session N filter
  if (SESSION_FILTER !== null) {
    files = files.filter((f) => parseInt(f.match(/\d+/)[0]) === SESSION_FILTER);
    if (files.length === 0) {
      log(`Session ${SESSION_FILTER} not found in ${SESSION_DIR}`, "ERROR");
      process.exit(1);
    }
  }

  if (files.length === 0) {
    log(`No Session*.md files found in ${SESSION_DIR}`, "ERROR");
    process.exit(1);
  }

  return files.map((file) => {
    const filePath = join(SESSION_DIR, file);
    const name = file.replace(".md", "");
    const content = readFileSync(filePath, "utf8");
    const override = parseSessionOverride(content);
    const prompts = parsePrompts(content, name, override);

    return {
      name,
      file: filePath,
      prompts,
      pauseAfterMs: override?.session?.pauseAfterMs ?? null,
      dependsOn: override?.session?.dependsOn ?? [],
    };
  });
}

// ########################################################################### Startup Check ###########################################################################

function runStartupCheck() {
  log("--- Startup Check -------------------------------------------------");

  const { path: claudePath, shell: useShell } = resolveClaudePath();

  const versionResult = spawnSync(claudePath, ["--version"], {
    encoding: "utf8",
    shell: useShell,
    timeout: 10_000,
  });

  if (versionResult.status === 0 && versionResult.stdout?.trim()) {
    log(`claude reachable: ${versionResult.stdout.trim()}`);
  } else {
    log("claude --version failed", "ERROR");
    log(
      `   exit: ${versionResult.status} | signal: ${versionResult.signal}`,
      "ERROR",
    );
    log(`   stderr: ${versionResult.stderr?.slice(0, 200)}`, "ERROR");
    log("   FIX: npm install -g @anthropic-ai/claude-code", "ERROR");
    process.exit(1);
  }

  log(
    `CLAUDE.md:   ${existsSync(CLAUDE_MD) ? "OK" : "MISSING"} ${CLAUDE_MD}`,
  );
  log(
    `Session dir: ${existsSync(SESSION_DIR) ? "OK" : "MISSING"} ${SESSION_DIR}`,
  );
  log(
    `Project dir: ${existsSync(PROJECT_DIR) ? "OK" : "MISSING"} ${PROJECT_DIR}`,
  );
  if (WORK_DIR !== PROJECT_DIR) {
    log(
      `Work dir:    ${existsSync(WORK_DIR) ? "OK" : "MISSING"} ${WORK_DIR}`,
    );
  }

  if (!existsSync(CLAUDE_MD)) {
    log("ABORT: CLAUDE.md is missing.", "ERROR");
    process.exit(1);
  }

  const sessions = loadSessions();

  for (const s of sessions) {
    const totalTurns = s.prompts.reduce((sum, p) => sum + p.maxTurns, 0);
    const pauseSrc = s.pauseAfterMs
      ? "(session override)"
      : "(settings.json / default)";
    const pauseMs =
      s.pauseAfterMs ?? getSetting("runner", "pauseMinutes") * 60_000;
    log(
      `   ${s.name}: ${s.prompts.length} prompts | ${totalTurns} turns | pause: ${formatDuration(pauseMs)} ${pauseSrc}`,
    );
    s.prompts.forEach((p, i) => {
      log(
        `     [${i + 1}] ${p.label} | model: ${p.model} | maxTurns: ${p.maxTurns} | ~${(p.chars / 1000).toFixed(1)}k chars`,
      );
    });
  }

  // Rate-limit budget check
  const planKey = getSetting("runner", "claudePlan");
  const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const CHARS_PER_TOKEN = 4;
  const OUTPUT_RATIO = 0.35;
  const SAFETY_MARGIN = 0.8;

  const budgetTokens = Math.floor(plan.outputTokensPer5h * SAFETY_MARGIN);
  const totalOutputTokens = sessions.reduce((sum, s) => {
    const chars = s.prompts.reduce((c, p) => c + p.chars, 0);
    return sum + Math.ceil((chars / CHARS_PER_TOKEN) * OUTPUT_RATIO);
  }, 0);
  const windowsNeeded = Math.ceil(totalOutputTokens / budgetTokens);

  log(
    `Rate-limit check: ~${(totalOutputTokens / 1000).toFixed(1)}k tokens estimated vs ~${(budgetTokens / 1000).toFixed(0)}k budget (${plan.label})`,
  );

  if (windowsNeeded > 1) {
    log(
      `Estimated tokens exceed one 5h window — ${windowsNeeded} windows needed`,
      "WARN",
    );
    notifyRateLimitWarning({
      planLabel: plan.label,
      usedTokens: totalOutputTokens,
      budgetTokens,
      windowsNeeded,
    });
  }

  log("--- Startup Check OK -----------------------------------------------");
  return { claudePath, useShell, sessions };
}

// ########################################################################### Prompt Builder ###########################################################################

function buildCombinedPrompt(sessionFile) {
  const raw = readFileSync(sessionFile, "utf8");
  const stripped = raw
    .replace(/<!--\nSESSION OVERRIDE CONFIG[\s\S]*?-->\n?\n?/, "")
    .replace(/^```json\s*\n[\s\S]*?\n```\s*\n?/, "");

  if (!existsSync(CLAUDE_MD)) {
    log("CLAUDE.md not found — continuing without global context", "WARN");
    return stripped;
  }

  const global = readFileSync(CLAUDE_MD, "utf8");

  return [
    "<!-- GLOBAL AGENT CONTEXT — CLAUDE.md -->",
    "",
    global,
    "",
    "<!-- SESSION PROMPTS — execute all sequentially -->",
    "",
    stripped,
  ].join("\n");
}

// ########################################################################### Post-Session Verification ###########################################################################

function loadVerificationConfig() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      return s?.runner?.verification ?? null;
    }
  } catch (err) { console.warn("[run-sessions] Could not load verification config:", err.message); }
  return null;
}

function runVerification(sessionName) {
  const config = loadVerificationConfig();
  if (!config || !config.commands || config.commands.length === 0) {
    return { skipped: true, results: [] };
  }

  log(`Running post-session verification for ${sessionName}...`);
  const results = [];

  for (const cmd of config.commands) {
    const label = cmd.label ?? cmd.command;
    log(`  Verification: ${label}`);

    const startMs = Date.now();
    const result = spawnSync(cmd.command, cmd.args ?? [], {
      encoding: "utf8",
      cwd: WORK_DIR,
      timeout: cmd.timeoutMs ?? 120_000,
      shell: true,
      env: { ...process.env },
    });
    const durationMs = Date.now() - startMs;

    const passed = result.status === 0;
    const status = passed ? "passed" : (result.signal === "SIGTERM" ? "timeout" : "failed");

    results.push({
      label,
      command: cmd.command,
      status,
      exitCode: result.status,
      durationMs,
      stdout: result.stdout?.slice(0, 500) ?? "",
      stderr: result.stderr?.slice(0, 500) ?? "",
    });

    log(`  ${label}: ${status} (${Math.ceil(durationMs / 1000)}s)`);
  }

  // Write verification report
  const reportLines = [
    `# Verification Report — ${sessionName}`,
    `Date: ${new Date().toISOString()}`,
    "",
  ];
  for (const r of results) {
    reportLines.push(`## ${r.label} — ${r.status.toUpperCase()}`);
    reportLines.push(`Command: \`${r.command}\``);
    reportLines.push(`Exit code: ${r.exitCode ?? "null"}`);
    reportLines.push(`Duration: ${Math.ceil(r.durationMs / 1000)}s`);
    if (r.stdout.trim()) reportLines.push(`\`\`\`\n${r.stdout.trim()}\n\`\`\``);
    if (r.stderr.trim()) reportLines.push(`**stderr:**\n\`\`\`\n${r.stderr.trim()}\n\`\`\``);
    reportLines.push("");
  }

  ensureDir(LOG_DIR);
  writeFileSync(join(LOG_DIR, `verification-${sessionName}.md`), reportLines.join("\n"));

  const allPassed = results.every((r) => r.status === "passed");
  const anyFailed = results.some((r) => r.status === "failed");

  return {
    skipped: false,
    allPassed,
    unstable: !allPassed && !anyFailed,
    results,
  };
}

// ########################################################################### Blast-Radius Check ###########################################################################

function loadBlastRadiusConfig() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      return s?.runner?.blastRadius ?? null;
    }
  } catch (err) { console.warn("[run-sessions] Could not load blastRadius config:", err.message); }
  return null;
}

function checkBlastRadiusLocal(sessionName) {
  const config = loadBlastRadiusConfig();
  if (!config) return { ok: true, violations: [] };

  const defaults = {
    maxChangedFiles: 50, maxDeletedFiles: 10,
    maxDeletedLines: 500, forbiddenPaths: [], enforceMode: "warn",
  };
  const cfg = { ...defaults, ...config };
  const violations = [];

  try {
    const statusResult = spawnSync("git", ["status", "--porcelain"], {
      encoding: "utf8", cwd: WORK_DIR, timeout: 10_000,
    });
    if (statusResult.status !== 0) return { ok: true, violations: [] };

    const lines = statusResult.stdout.trim().split("\n").filter(Boolean);
    const changedFiles = lines.length;
    const deletedFiles = lines.filter((l) => l.startsWith("D ") || l.startsWith(" D")).length;

    if (changedFiles > cfg.maxChangedFiles) {
      violations.push(`${changedFiles} files changed (limit: ${cfg.maxChangedFiles})`);
    }
    if (deletedFiles > cfg.maxDeletedFiles) {
      violations.push(`${deletedFiles} files deleted (limit: ${cfg.maxDeletedFiles})`);
    }

    const changedPaths = lines.map((l) => l.slice(3).trim());
    for (const fp of cfg.forbiddenPaths) {
      if (changedPaths.some((p) => p.includes(fp))) {
        violations.push(`Forbidden path modified: ${fp}`);
      }
    }
  } catch (err) { console.warn("[run-sessions] Blast-radius git check failed:", err.message); }

  return {
    ok: violations.length === 0,
    shouldAbort: cfg.enforceMode === "abort" && violations.length > 0,
    violations,
  };
}

// ########################################################################### Security Finding Counter ###########################################################################

function countSecurityFindings(sessionName) {
  if (!existsSync(SECURITY_DIR)) return { critical: 0, warnings: 0 };
  try {
    const files = readdirSync(SECURITY_DIR).filter(
      (f) =>
        f.toLowerCase().includes(sessionName.toLowerCase()) &&
        f.endsWith(".md"),
    );
    let critical = 0,
      warnings = 0;
    for (const file of files) {
      const content = readFileSync(join(SECURITY_DIR, file), "utf8");
      critical += (content.match(/🔴\s*CRITICAL/g) ?? []).length;
      warnings += (content.match(/🟡\s*WARNING/g) ?? []).length;
    }
    return { critical, warnings };
  } catch {
    return { critical: 0, warnings: 0 };
  }
}

// ########################################################################### Token Parser ###########################################################################

function parseTokenUsage(output) {
  // Claude verbose output includes token count patterns
  const inputMatch  = output.match(/input[_\s]tokens[:\s]+(\d[\d,]*)/i);
  const outputMatch = output.match(/output[_\s]tokens[:\s]+(\d[\d,]*)/i);
  return {
    inputTokens:  inputMatch  ? parseInt(inputMatch[1].replace(/,/g, ""), 10) : null,
    outputTokens: outputMatch ? parseInt(outputMatch[1].replace(/,/g, ""), 10) : null,
  };
}

// ########################################################################### Output Diffing ###########################################################################

function diffWithPreviousRun(sessionName, currentOutput) {
  if (!existsSync(ARCHIVE_DIR)) return;

  const archives = readdirSync(ARCHIVE_DIR)
    .filter((f) => f.startsWith("run-"))
    .sort()
    .reverse();

  for (const archive of archives) {
    const sessDir = join(ARCHIVE_DIR, archive, "Sessions");
    if (!existsSync(sessDir)) continue;
    const files = readdirSync(sessDir).filter(
      (f) => f.includes(sessionName) && f.endsWith(".output.md"),
    );
    if (files.length === 0) continue;

    const prevContent = readFileSync(join(sessDir, files[0]), "utf8");
    const prevLines = prevContent.split("\n");
    const currLines = currentOutput.split("\n");

    const added   = currLines.filter((l) => !prevLines.includes(l)).length;
    const removed = prevLines.filter((l) => !currLines.includes(l)).length;

    if (added > 0 || removed > 0) {
      const diffSummary = `Compared with ${archive}: +${added} / -${removed} lines`;
      log(`Diff: ${diffSummary}`);
      ensureDir(LOG_DIR);
      writeFileSync(
        join(LOG_DIR, `diff-${sessionName}.md`),
        `# Diff: ${sessionName}\n\nPrevious: ${archive}\n\n- Added lines: ${added}\n- Removed lines: ${removed}\n`,
      );
    }
    break; // Only compare with most recent
  }
}

// ########################################################################### Async Session Runner ###########################################################################

let activeChild = null;

function runSessionAsync(session, claudePath, useShell) {
  const { name, file, prompts } = session;

  log("=".repeat(64));
  log(`Starting ${name}`);
  log(`   File: ${file}`);
  prompts.forEach((p, i) => {
    log(`   [${i + 1}/${prompts.length}] ${p.label}`);
    log(
      `         model: ${p.model} | maxTurns: ${p.maxTurns} | ~${(p.chars / 1000).toFixed(1)}k chars | timeout: ${formatDuration(p.timeoutMs)}`,
    );
  });
  log("=".repeat(64));

  const sessionModel = [...prompts].sort((a, b) => b.maxTurns - a.maxTurns)[0]
    .model;
  const totalTurns = prompts.reduce((sum, p) => sum + p.maxTurns, 0);
  const totalTimeout =
    prompts.reduce((sum, p) => sum + p.timeoutMs, 0) + 10 * 60_000;

  ensureDir(LOG_DIR);
  const outputFile = join(LOG_DIR, `${name}.output.md`);
  const errorFile = join(LOG_DIR, `${name}.error.log`);

  const combinedPrompt = buildCombinedPrompt(file);
  log(
    `Prompt: ${(combinedPrompt.length / 1000).toFixed(1)}k chars → via stdin`,
  );
  log("Spawning claude CLI (async)...");

  const startTime = Date.now();

  return new Promise((resolve) => {
    const cliArgs = [
      "--print",
      "--model", sessionModel,
      "--max-turns", String(totalTurns),
      "--output-format", "text",
      "--verbose",
      "--add-dir", WORK_DIR,
    ];
    if (getSetting("runner", "skipPermissions")) {
      cliArgs.push("--dangerously-skip-permissions");
    }

    const proc = spawn(
      claudePath,
      cliArgs,
      {
        cwd: WORK_DIR,
        stdio: ["pipe", "pipe", "pipe"],
        shell: useShell,
        env: { ...process.env },
      },
    );

    activeChild = proc;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const completedPrompts = new Set();

    // Timeout timer
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log(`${name}: TIMEOUT after ${formatDuration(totalTimeout)}`, "ERROR");
      proc.kill("SIGTERM");
    }, totalTimeout);

    // 80% timeout warning
    const warningTimer = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      notifyTimeoutWarning({ sessionName: name, elapsedMs: elapsed, timeoutMs: totalTimeout });
      log(`${name}: 80% timeout warning — ${formatDuration(elapsed)} elapsed`, "WARN");
    }, Math.floor(totalTimeout * 0.8));

    proc.stdin.write(combinedPrompt);
    proc.stdin.end();

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;

      // Detect prompt completion markers
      const markerRegex = /### PROMPT (\d+) COMPLETED/g;
      let match;
      while ((match = markerRegex.exec(chunk)) !== null) {
        const promptNum = parseInt(match[1], 10);
        if (!completedPrompts.has(promptNum)) {
          completedPrompts.add(promptNum);
          const elapsed = Date.now() - startTime;
          log(`${name}: Prompt ${promptNum} completed at ${formatDuration(elapsed)}`);

          // Write per-prompt output
          const promptOutput = stdout.split(`### PROMPT ${promptNum} COMPLETED`)[0];
          const prevMarker = promptNum > 1
            ? stdout.lastIndexOf(`### PROMPT ${promptNum - 1} COMPLETED`)
            : 0;
          const promptSection = prevMarker > 0
            ? stdout.slice(prevMarker, stdout.indexOf(`### PROMPT ${promptNum} COMPLETED`))
            : promptOutput;

          const promptFile = join(LOG_DIR, `${name}-Prompt${promptNum}.output.md`);
          writeFileSync(promptFile, promptSection);

          notifyPromptComplete({
            sessionName: name,
            promptIndex: promptNum,
            totalPrompts: prompts.length,
            durationMs: elapsed,
            preview: promptSection.slice(-200),
          });

          // Save prompt checkpoint
          try {
            const ckState = loadState();
            if (!ckState.promptCheckpoints) ckState.promptCheckpoints = {};
            if (!ckState.promptCheckpoints[name]) ckState.promptCheckpoints[name] = {};
            ckState.promptCheckpoints[name][String(promptNum)] = {
              completedAt: new Date().toISOString(),
              elapsedMs: elapsed,
              outputFile: promptFile,
            };
            saveState(ckState);
          } catch (err) { console.warn("[run-sessions] Prompt checkpoint save failed:", err.message); }
        }
      }
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("exit", (code, signal) => {
      clearTimeout(timeoutTimer);
      clearTimeout(warningTimer);
      activeChild = null;

      const durationMs = Date.now() - startTime;

      // Write output
      const outputContent = [
        `# ${name} — Output`,
        `Date:      ${new Date().toISOString()}`,
        `Model:     ${sessionModel}`,
        `Duration:  ${formatDuration(durationMs)}`,
        `Exit code: ${code ?? "null (timeout / signal)"}`,
        `Signal:    ${signal ?? "none"}`,
        `Turns:     ${totalTurns}`,
        "",
        "---",
        "",
        stdout.trim()
          ? stdout
          : "_No output captured — session was terminated before producing output._",
      ].join("\n");

      writeFileSync(outputFile, outputContent);
      log(`Output -> ${outputFile}`);

      const errorContent = stderr.trim()
        ? stderr
        : `No stderr captured.\nSignal: ${signal ?? "none"}\nExit code: ${code ?? "null"}\n`;

      writeFileSync(errorFile, errorContent);
      if (stderr.trim()) {
        log(`Stderr -> ${errorFile}`, "WARN");
      }

      // Token usage tracking
      const tokenUsage = parseTokenUsage(stderr + stdout);

      // Output diffing
      diffWithPreviousRun(name, outputContent);

      if (timedOut || signal === "SIGTERM") {
        const msg = `Timeout after ${formatDuration(durationMs)}`;
        log(`${name}: TIMEOUT — ${msg}`, "ERROR");
        resolve({
          success: false, durationMs, errorMsg: msg, exitCode: null,
          tokenUsage, isRateLimit: false, completedPrompts: completedPrompts.size,
        });
        return;
      }

      if (code !== 0) {
        const isRateLimit = /rate.?limit|429/i.test(stderr);
        const msg =
          stderr.trim()?.slice(0, 300) ?? `Exit code ${code}`;
        log(
          `${name}: FAILED (exit ${code}) after ${formatDuration(durationMs)}`,
          "ERROR",
        );
        resolve({
          success: false, durationMs, errorMsg: msg, exitCode: code,
          tokenUsage, isRateLimit, completedPrompts: completedPrompts.size,
        });
        return;
      }

      log(`${name} completed in ${formatDuration(durationMs)}`);
      resolve({
        success: true, durationMs, errorMsg: null, exitCode: 0,
        tokenUsage, isRateLimit: false, completedPrompts: completedPrompts.size,
      });
    });
  });
}

// ########################################################################### Graceful Shutdown ###########################################################################

let shuttingDown = false;

function setupGracefulShutdown() {
  const handler = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal} — shutting down gracefully`, "WARN");

    if (activeChild && activeChild.exitCode === null) {
      log("Killing active Claude process...", "WARN");
      activeChild.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 3000));
      if (activeChild?.exitCode === null) {
        activeChild.kill("SIGKILL");
      }
    }

    log("Saving state and exiting...", "WARN");
    process.exit(0);
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

// ########################################################################### Main ###########################################################################

async function main() {
  setupGracefulShutdown();

  if (RESET_FLAG) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ completedSessions: [] }, null, 2),
    );
    log("Progress reset — starting from Session 1");
  }

  const { claudePath, useShell, sessions } = runStartupCheck();

  const totalPrompts = sessions.reduce((s, x) => s + x.prompts.length, 0);

  // --dry-run: print estimation and exit
  if (DRY_RUN_FLAG) {
    const CHARS_PER_TOKEN = 4;
    log("=== DRY RUN — No Claude processes will be started ===");
    for (const s of sessions) {
      const chars = s.prompts.reduce((c, p) => c + p.chars, 0);
      const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
      log(`   ${s.name}: ${s.prompts.length} prompts | ~${tokens} input tokens`);
      for (const p of s.prompts) {
        log(`     [${p.index}] ${p.label} | ${(p.chars / 1000).toFixed(1)}k chars | model: ${p.model}`);
      }
    }
    log("=== END DRY RUN ===");
    process.exit(0);
  }

  const parallelMode = getSetting("runner", "parallel") === true;

  log("================================================================");
  log("   Claude Runner — Automatic Session Executor");
  log(`   Directory: ${PROJECT_DIR}`);
  log(`   Sessions: ${sessions.length} | Prompts: ${totalPrompts} | ${new Date().toLocaleString("en-US")}`);
  if (SESSION_FILTER !== null) log(`   Filtered to: Session${SESSION_FILTER}`);
  if (parallelMode) log("   Mode: PARALLEL (independent sessions run concurrently)");
  log("================================================================");

  const state = loadState();
  log(
    `Progress: ${state.completedSessions.length}/${sessions.length} sessions completed`,
  );
  if (state.completedSessions.length > 0)
    log(`Already done: ${state.completedSessions.join(", ")}`);

  await notifyRunStart({
    totalSessions: sessions.length,
    totalPrompts,
    model: getSetting("runner", "defaultModel"),
    plan: CLAUDE_PLANS[getSetting("runner", "claudePlan")]?.label,
    baseDir: PROJECT_DIR,
  });

  let runFailed = false;
  const MAX_RATE_LIMIT_RETRIES = 2;

  if (parallelMode) {
    await runParallel(sessions, state, claudePath, useShell, MAX_RATE_LIMIT_RETRIES);
  } else {
    await runSequential(sessions, state, claudePath, useShell, MAX_RATE_LIMIT_RETRIES);
  }

  async function runSequential(sessions, state, claudePath, useShell, maxRetries) {
    for (let i = 0; i < sessions.length; i++) {
      if (shuttingDown) break;
      const failed = await executeSession(sessions[i], i, sessions.length, state, claudePath, useShell, maxRetries);
      if (failed) {
        runFailed = true;
        process.exit(1);
      }

      // Pause before next session
      if (i < sessions.length - 1) {
        const nextSession = sessions[i + 1].name;
        const pauseMs =
          sessions[i].pauseAfterMs ?? getSetting("runner", "pauseMinutes") * 60_000;
        const pauseMinutes = Math.round(pauseMs / 60_000);

        log(`Pause ${formatDuration(pauseMs)} before ${nextSession}`);
        await notifyPause({
          nextSession,
          pauseMinutes,
          reason: "Rate-limit buffer — waiting before next session",
        });
        await sleepWithCountdown(pauseMs, `Pause before ${nextSession}`);
      }
    }
  }

  async function runParallel(sessions, state, claudePath, useShell, maxRetries) {
    // Build dependency graph and execute in waves
    const remaining = new Set(sessions.map((s) => s.name));
    const sessionMap = new Map(sessions.map((s) => [s.name, s]));
    let waveIndex = 0;

    while (remaining.size > 0 && !shuttingDown) {
      // Find sessions whose dependencies are all met
      const ready = [];
      for (const name of remaining) {
        const session = sessionMap.get(name);

        // Skip already completed
        if (state.completedSessions.includes(name)) {
          log(`${name} already completed — skipping`);
          await notifySessionSkipped({ sessionName: name, reason: "Already completed" });
          remaining.delete(name);
          continue;
        }

        const deps = session.dependsOn ?? [];
        const unmet = deps.filter((d) => !state.completedSessions.includes(d));
        if (unmet.length === 0) {
          ready.push(session);
        }
      }

      if (ready.length === 0 && remaining.size > 0) {
        // All remaining sessions have unmet dependencies that can't be resolved
        const blocked = [...remaining].join(", ");
        log(`Deadlock: ${blocked} have unresolvable dependencies — skipping`, "ERROR");
        for (const name of remaining) {
          await notifySessionSkipped({ sessionName: name, reason: "Unresolvable dependencies" });
        }
        break;
      }

      waveIndex++;
      log(`--- Parallel wave ${waveIndex}: ${ready.map((s) => s.name).join(", ")} ---`);

      // Execute all ready sessions concurrently
      const results = await Promise.all(
        ready.map(async (session, idx) => {
          const failed = await executeSession(
            session,
            sessions.indexOf(session),
            sessions.length,
            state,
            claudePath,
            useShell,
            maxRetries,
          );
          return { session, failed };
        }),
      );

      // Remove completed from remaining
      for (const { session, failed } of results) {
        remaining.delete(session.name);
        if (failed) {
          runFailed = true;
          log(`${session.name} failed in parallel wave ${waveIndex}`, "ERROR");
        }
      }

      if (runFailed) {
        log("One or more parallel sessions failed — stopping run", "ERROR");
        process.exit(1);
      }

      // Pause between waves if there are more sessions
      if (remaining.size > 0) {
        const pauseMs = getSetting("runner", "pauseMinutes") * 60_000;
        const pauseMinutes = Math.round(pauseMs / 60_000);
        log(`Pause ${formatDuration(pauseMs)} before next wave`);
        await notifyPause({
          nextSession: `Wave ${waveIndex + 1}`,
          pauseMinutes,
          reason: "Rate-limit buffer between parallel waves",
        });
        await sleepWithCountdown(pauseMs, `Pause before wave ${waveIndex + 1}`);
      }
    }
  }

  async function executeSession(session, sessionIndex, totalSessions, state, claudePath, useShell, maxRetries) {
    const sessionName = session.name;

    // Skip completed
    if (state.completedSessions.includes(sessionName)) {
      log(`${sessionName} already completed — skipping`);
      await notifySessionSkipped({
        sessionName,
        reason: "Already marked as completed in .progress.json",
      });
      return false;
    }

    // Check dependencies (dependsOn)
    if (session.dependsOn && session.dependsOn.length > 0) {
      const unmet = session.dependsOn.filter(
        (dep) => !state.completedSessions.includes(dep),
      );
      if (unmet.length > 0) {
        log(`${sessionName}: Skipping — unmet dependencies: ${unmet.join(", ")}`, "WARN");
        await notifySessionSkipped({
          sessionName,
          reason: `Blocked by unmet dependencies: ${unmet.join(", ")}`,
        });
        return false;
      }
      log(`${sessionName}: All dependencies met (${session.dependsOn.join(", ")})`);
    }

    // Notify session start
    const heaviest = [...session.prompts].sort(
      (a, b) => b.maxTurns - a.maxTurns,
    )[0];
    await notifySessionStart({
      sessionName,
      promptCount: session.prompts.length,
      model: heaviest.model,
      sessionIndex: sessionIndex + 1,
      totalSessions,
    });

    // Notify individual prompt starts
    for (const p of session.prompts) {
      await notifyPromptStart({
        sessionName,
        promptIndex: p.index,
        promptTitle: p.label,
        totalPrompts: session.prompts.length,
      });
    }

    // Run with rate-limit retry
    let result;
    let retries = 0;

    while (true) {
      result = await runSessionAsync(session, claudePath, useShell);

      if (result.success || !result.isRateLimit || retries >= maxRetries) break;

      retries++;
      const waitMs = 5 * 60_000;
      log(`Rate limit detected — retry ${retries}/${maxRetries} after ${formatDuration(waitMs)}`, "WARN");
      await notifyPause({
        nextSession: sessionName,
        pauseMinutes: 5,
        reason: `Rate limit hit — auto-retry ${retries}/${maxRetries}`,
      });
      await sleepWithCountdown(waitMs, "Rate-limit cooldown");
    }

    // Save session details
    if (!state.sessionDetails) state.sessionDetails = {};
    state.sessionDetails[sessionName] = {
      durationMs: result.durationMs,
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      promptsCompleted: result.completedPrompts,
      totalPrompts: session.prompts.length,
      tokenUsage: result.tokenUsage ?? {},
      success: result.success,
    };

    if (result.success) {
      state.completedSessions.push(sessionName);
      saveState(state);

      await notifySessionSuccess({
        sessionName,
        durationMs: result.durationMs,
        outputPath: join(LOG_DIR, `${sessionName}.output.md`),
        promptsCompleted: session.prompts.length,
      });

      // Post-session verification
      const verification = runVerification(sessionName);
      if (!verification.skipped) {
        state.sessionDetails[sessionName].verification = {
          allPassed: verification.allPassed,
          unstable: verification.unstable,
          results: verification.results.map((r) => ({ label: r.label, status: r.status })),
        };
        saveState(state);

        if (!verification.allPassed) {
          log(`Verification failed for ${sessionName}`, "WARN");
          const consecutiveFailures = Object.values(state.sessionDetails)
            .filter((d) => d.verification && !d.verification.allPassed).length;
          const maxFailures = loadVerificationConfig()?.autoStopAfter ?? 0;
          if (maxFailures > 0 && consecutiveFailures >= maxFailures) {
            log(`Auto-stop: ${consecutiveFailures} consecutive verification failures — aborting run`, "ERROR");
            await notifyRunFailed({
              exitCode: null,
              errorMsg: `Auto-stopped after ${consecutiveFailures} consecutive verification failures`,
            });
            return true; // signal failure
          }
        }
      }

      // Blast-radius check
      const blastCheck = checkBlastRadiusLocal(sessionName);
      if (!blastCheck.ok) {
        log(`Blast-radius violations for ${sessionName}: ${blastCheck.violations.join("; ")}`, "WARN");
        if (blastCheck.shouldAbort) {
          log("Blast-radius abort triggered — stopping run", "ERROR");
          await notifyRunFailed({
            exitCode: null,
            errorMsg: `Blast-radius abort: ${blastCheck.violations.join("; ")}`,
          });
          return true; // signal failure
        }
      }

      // Security findings
      const { critical, warnings } = countSecurityFindings(sessionName);
      if (critical > 0 || warnings > 0) {
        const reportPath = join(SECURITY_DIR, `security-report-${sessionName}.md`);
        await notifySecurityAlert({
          sessionName,
          criticalCount: critical,
          warningCount: warnings,
          reportPath: existsSync(reportPath) ? reportPath : undefined,
        });
        log(`Security findings: ${critical} critical, ${warnings} warnings`, "WARN");
      }

      return false; // success
    } else {
      await notifySessionFailed({
        sessionName,
        errorMsg: result.errorMsg ?? "Unknown error",
        outputPath: join(LOG_DIR, `${sessionName}.output.md`),
        exitCode: result.exitCode,
      });
      await notifyRunFailed({ exitCode: result.exitCode, errorMsg: result.errorMsg });

      log(`Stopping at ${sessionName} — manual review required`, "ERROR");
      log(`   Output:  ${join(LOG_DIR, sessionName + ".output.md")}`, "ERROR");
      log(`   Errors:  ${join(LOG_DIR, sessionName + ".error.log")}`, "ERROR");
      log(`   Restart: node run-sessions.js`, "ERROR");
      return true; // signal failure
    }
  }

  // All done
  if (!runFailed) {
    state.finishedAt = new Date().toISOString();
    const totalDurationMs = sessions.reduce(
      (sum, s) => sum + (state.sessionDetails?.[s.name]?.durationMs ?? 0),
      0,
    );
    saveState(state);

    log("================================================================");
    log("   ALL SESSIONS COMPLETED SUCCESSFULLY");
    log(`   Total duration: ${formatDuration(totalDurationMs)}`);
    log(`   Logs: ${LOG_DIR}`);
    log("================================================================");

    await notifyRunComplete({
      totalSessions: sessions.length,
      totalDurationMs,
      archivePath: undefined,
    });
  }
}

main().catch(async (err) => {
  log(`CRITICAL ERROR: ${err.message}`, "ERROR");
  log(err.stack ?? "", "ERROR");
  await notifyRunFailed({ exitCode: 1, errorMsg: err.message });
  process.exit(1);
});
