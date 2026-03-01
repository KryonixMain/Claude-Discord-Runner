import { spawnSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
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
} from "./discord-notify.js";

// ########################################################################### Paths ###########################################################################

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = __dirname;
const PROJECT_DIR = join(BASE_DIR, "..");

const SESSION_DIR = join(BASE_DIR, "Sessions");
const LOG_DIR = join(BASE_DIR, "Logs");
const SECURITY_DIR = join(BASE_DIR, "Security");
const STATE_FILE = join(BASE_DIR, ".progress.json");
const CLAUDE_MD = join(BASE_DIR, "CLAUDE.md");
const SETTINGS_FILE = join(BASE_DIR, "settings.json");

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
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ########################################################################### Claude Binary ###########################################################################

function resolveClaudePath() {
  log("Searching for claude binary...");

  const w = spawnSync("where.exe", ["claude"], {
    encoding: "utf8",
    shell: false,
  });
  if (w.status === 0 && w.stdout?.trim()) {
    const found = w.stdout.trim().split("\n")[0].trim();
    log(`✅ claude found via where.exe: ${found}`);
    return { path: found, shell: false };
  }

  const npmPrefix = spawnSync("npm", ["config", "get", "prefix"], {
    encoding: "utf8",
    shell: true,
  });
  if (npmPrefix.status === 0 && npmPrefix.stdout?.trim()) {
    const prefix = npmPrefix.stdout.trim();
    const candidates = [
      join(prefix, "claude.cmd"),
      join(prefix, "claude.ps1"),
      join(prefix, "claude"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        log(`✅ claude found via npm prefix: ${c}`);
        return { path: c, shell: c.endsWith(".cmd") || c.endsWith(".ps1") };
      }
    }
  }

  if (process.env.APPDATA) {
    const candidates = [
      join(process.env.APPDATA, "npm", "claude.cmd"),
      join(process.env.APPDATA, "npm", "claude.ps1"),
      join(process.env.APPDATA, "npm", "claude"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        log(`✅ claude found via APPDATA\\npm: ${c}`);
        return { path: c, shell: c.endsWith(".cmd") || c.endsWith(".ps1") };
      }
    }
  }

  log("⚠️  Falling back to 'claude' with shell:true", "WARN");
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

  const files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

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
    };
  });
}

// ########################################################################### Startup Check ###########################################################################

function runStartupCheck() {
  log("─── Startup Check ─────────────────────────────────────────────");

  const { path: claudePath, shell: useShell } = resolveClaudePath();

  const versionResult = spawnSync(claudePath, ["--version"], {
    encoding: "utf8",
    shell: useShell,
    timeout: 10_000,
  });

  if (versionResult.status === 0 && versionResult.stdout?.trim()) {
    log(`✅ claude reachable: ${versionResult.stdout.trim()}`);
  } else {
    log("❌ claude --version failed", "ERROR");
    log(
      `   exit: ${versionResult.status} | signal: ${versionResult.signal}`,
      "ERROR",
    );
    log(`   stderr: ${versionResult.stderr?.slice(0, 200)}`, "ERROR");
    log("   FIX: npm install -g @anthropic-ai/claude-code", "ERROR");
    process.exit(1);
  }

  log(
    `CLAUDE.md:   ${existsSync(CLAUDE_MD) ? "✅" : "❌ MISSING"} ${CLAUDE_MD}`,
  );
  log(
    `Session dir: ${existsSync(SESSION_DIR) ? "✅" : "❌ MISSING"} ${SESSION_DIR}`,
  );
  log(
    `Project dir: ${existsSync(PROJECT_DIR) ? "✅" : "❌ MISSING"} ${PROJECT_DIR}`,
  );

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

  // ########################################################################### Rate-limit budget check ###########################################################################
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
      `⚠️  Estimated tokens exceed one 5h window — ${windowsNeeded} windows needed`,
      "WARN",
    );
    notifyRateLimitWarning({
      planLabel: plan.label,
      usedTokens: totalOutputTokens,
      budgetTokens,
      windowsNeeded,
    });
  }

  log("─── Startup Check OK ───────────────────────────────────────────");
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
    "<!-- ══════════════════════════════════════════════════════════ -->",
    "<!-- GLOBAL AGENT CONTEXT — CLAUDE.md                          -->",
    "<!-- These rules apply to ALL prompts in this session           -->",
    "<!-- ══════════════════════════════════════════════════════════ -->",
    "",
    global,
    "",
    "<!-- ══════════════════════════════════════════════════════════ -->",
    "<!-- SESSION PROMPTS — execute all sequentially                 -->",
    "<!-- ══════════════════════════════════════════════════════════ -->",
    "",
    stripped,
  ].join("\n");
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

// ########################################################################### Session Runner ###########################################################################

function runSession(session, claudePath, useShell) {
  const { name, file, prompts } = session;

  log("═".repeat(64));
  log(`▶  Starting ${name}`);
  log(`   File: ${file}`);
  prompts.forEach((p, i) => {
    log(`   [${i + 1}/${prompts.length}] ${p.label}`);
    log(
      `         model: ${p.model} | maxTurns: ${p.maxTurns} | ~${(p.chars / 1000).toFixed(1)}k chars | timeout: ${formatDuration(p.timeoutMs)}`,
    );
  });
  log("═".repeat(64));

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
  log("Spawning claude CLI...");

  const startTime = Date.now();

  const result = spawnSync(
    claudePath,
    [
      "--print",
      "--model",
      sessionModel,
      "--max-turns",
      String(totalTurns),
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
      "--verbose",
      "--add-dir",
      PROJECT_DIR,
    ],
    {
      cwd: BASE_DIR,
      encoding: "utf8",
      input: combinedPrompt,
      shell: useShell,
      maxBuffer: 200 * 1024 * 1024,
      timeout: totalTimeout,
      env: { ...process.env },
    },
  );

  const durationMs = Date.now() - startTime;

  if (result.stdout) {
    writeFileSync(
      outputFile,
      [
        `# ${name} — Output`,
        `Date:      ${new Date().toISOString()}`,
        `Model:     ${sessionModel}`,
        `Duration:  ${formatDuration(durationMs)}`,
        `Exit code: ${result.status ?? "null"}`,
        `Turns:     ${totalTurns}`,
        "",
        "---",
        "",
        result.stdout,
      ].join("\n"),
    );
    log(`Output → ${outputFile}`);
  }

  if (result.stderr?.trim()) {
    writeFileSync(errorFile, result.stderr);
    log(`Stderr → ${errorFile}`, "WARN");
  }

  if (result.signal === "SIGTERM") {
    const msg = `Timeout after ${formatDuration(durationMs)} — increase timeoutMs in session override`;
    log(`${name}: TIMEOUT — ${msg}`, "ERROR");
    return { success: false, durationMs, errorMsg: msg, exitCode: null };
  }

  if (result.status !== 0) {
    const msg = result.stderr?.slice(0, 300) ?? `Exit code ${result.status}`;
    log(
      `${name}: FAILED (exit ${result.status}) after ${formatDuration(durationMs)}`,
      "ERROR",
    );
    return {
      success: false,
      durationMs,
      errorMsg: msg,
      exitCode: result.status,
    };
  }

  log(`✅ ${name} completed in ${formatDuration(durationMs)}`);
  return { success: true, durationMs, errorMsg: null, exitCode: 0 };
}

// ########################################################################### Main ###########################################################################

async function main() {
  if (process.argv.includes("--reset")) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ completedSessions: [] }, null, 2),
    );
    log("Progress reset — starting from Session 1");
  }

  const { claudePath, useShell, sessions } = runStartupCheck();

  const totalPrompts = sessions.reduce((s, x) => s + x.prompts.length, 0);

  log("╔════════════════════════════════════════════════════════════╗");
  log("║   Claude Runner — Automatic Session Executor               ║");
  log(`║   Directory: ${BASE_DIR.slice(0, 46).padEnd(46)}║`);
  log(
    `║   Sessions: ${String(sessions.length).padEnd(2)} | Prompts: ${String(totalPrompts).padEnd(2)} | ${new Date().toLocaleString("en-US").padEnd(20)}║`,
  );
  log("╚════════════════════════════════════════════════════════════╝");

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
    baseDir: BASE_DIR,
  });

  let runFailed = false;
  const runStartedAt = Date.now();

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const sessionName = session.name;

    // ########################################################################### Skip completed ###########################################################################
    if (state.completedSessions.includes(sessionName)) {
      log(`⏭  ${sessionName} already completed — skipping`);
      await notifySessionSkipped({
        sessionName,
        reason: "Already marked as completed in .progress.json",
      });
      continue;
    }

    // ########################################################################### Notify session start ###########################################################################
    const heaviest = [...session.prompts].sort(
      (a, b) => b.maxTurns - a.maxTurns,
    )[0];
    await notifySessionStart({
      sessionName,
      promptCount: session.prompts.length,
      model: heaviest.model,
      sessionIndex: i + 1,
      totalSessions: sessions.length,
    });

    // ########################################################################### Notify individual prompt starts ###########################################################################
    for (const p of session.prompts) {
      await notifyPromptStart({
        sessionName,
        promptIndex: p.index,
        promptTitle: p.label,
        totalPrompts: session.prompts.length,
      });
    }

    const { success, durationMs, errorMsg, exitCode } = runSession(
      session,
      claudePath,
      useShell,
    );

    if (success) {
      state.completedSessions.push(sessionName);
      state[`${sessionName}_completedAt`] = new Date().toISOString();
      state[`${sessionName}_durationMs`] = durationMs;
      saveState(state);

      await notifySessionSuccess({
        sessionName,
        durationMs,
        outputPath: join(LOG_DIR, `${sessionName}.output.md`),
        promptsCompleted: session.prompts.length,
      });

      // Notify per-prompt completions retrospectively
      for (const p of session.prompts) {
        await notifyPromptComplete({
          sessionName,
          promptIndex: p.index,
          totalPrompts: session.prompts.length,
          durationMs: Math.floor(durationMs / session.prompts.length),
        });
      }

      // ########################################################################### Security findings ###########################################################################
      const { critical, warnings } = countSecurityFindings(sessionName);
      if (critical > 0 || warnings > 0) {
        const reportPath = join(
          SECURITY_DIR,
          `security-report-${sessionName}.md`,
        );
        await notifySecurityAlert({
          sessionName,
          criticalCount: critical,
          warningCount: warnings,
          reportPath: existsSync(reportPath) ? reportPath : undefined,
        });
        log(
          `⚠️  Security findings: ${critical} critical, ${warnings} warnings — ${SECURITY_DIR}`,
          "WARN",
        );
      }
    } else {
      runFailed = true;
      await notifySessionFailed({
        sessionName,
        errorMsg: errorMsg ?? "Unknown error",
        outputPath: join(LOG_DIR, `${sessionName}.output.md`),
        exitCode,
      });
      await notifyRunFailed({ exitCode, errorMsg });

      log(`⛔ Stopping at ${sessionName} — manual review required`, "ERROR");
      log(`   Output:  ${join(LOG_DIR, sessionName + ".output.md")}`, "ERROR");
      log(`   Errors:  ${join(LOG_DIR, sessionName + ".error.log")}`, "ERROR");
      log(`   Restart: node run-sessions.js`, "ERROR");
      process.exit(1);
    }

    // ########################################################################### Pause before next session ###########################################################################
    if (i < sessions.length - 1) {
      const nextSession = sessions[i + 1].name;
      const pauseMs =
        session.pauseAfterMs ?? getSetting("runner", "pauseMinutes") * 60_000;
      const pauseMinutes = Math.round(pauseMs / 60_000);

      log(`⏸  Pause ${formatDuration(pauseMs)} before ${nextSession}`);
      await notifyPause({
        nextSession,
        pauseMinutes,
        reason: "Rate-limit buffer — waiting before next session",
      });
      await sleepWithCountdown(pauseMs, `Pause before ${nextSession}`);
    }
  }

  // ########################################################################### All done ###########################################################################
  if (!runFailed) {
    state.finishedAt = new Date().toISOString();
    const totalDurationMs = sessions.reduce(
      (sum, s) => sum + (state[`${s.name}_durationMs`] ?? 0),
      0,
    );
    saveState(state);

    log("╔════════════════════════════════════════════════════════════╗");
    log("║   ✅ ALL SESSIONS COMPLETED SUCCESSFULLY                   ║");
    log(`║   Total duration: ${formatDuration(totalDurationMs).padEnd(42)}║`);
    log(`║   Logs: ${LOG_DIR.slice(0, 52).padEnd(52)}║`);
    log("╚════════════════════════════════════════════════════════════╝");

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
