import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { spawn, spawnSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import {
  notifyRunStart,
  notifyRunComplete,
  notifyRunFailed,
  notifySessionStart,
  notifySessionSuccess,
  notifySessionFailed,
  notifyPause,
  notifyRateLimitWarning,
  notifySecurityAlert,
  notifySecurityFixStart,
  notifySecurityFixComplete,
  notifyValidationFailed,
  notifyValidationPassed,
  notifyArchived,
} from "./discord-notify.js";

// ########################################################################### Paths ###########################################################################

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = __dirname;
const PROJECT_DIR = join(BASE_DIR, "..");

const LOG_DIR = join(BASE_DIR, "Logs");
const SECURITY_DIR = join(BASE_DIR, "Security");
const SESSION_DIR = join(BASE_DIR, "Sessions");
const ARCHIVE_DIR = join(BASE_DIR, "Archive");
const SETTINGS_FILE = join(BASE_DIR, "settings.json");
const STATE_FILE = join(BASE_DIR, ".progress.json");
const CLAUDE_MD = join(BASE_DIR, "CLAUDE.md");

// ########################################################################### Claude Plan Definitions ###########################################################################
// Based on Anthropic's 5-hour rolling window model (as of 2025/2026)

const CLAUDE_PLANS = {
  pro: {
    label: "Pro ($20/mo)",
    outputTokensPer5h: 44_000,
    promptsPer5h: 40,
    windowMs: 5 * 60 * 60 * 1000, // 5 hours
    weeklyHours: 80,
    avgOutputTokensPerPrompt: 1_100,
  },
  max5: {
    label: "Max 5× ($100/mo)",
    outputTokensPer5h: 88_000,
    promptsPer5h: 225,
    windowMs: 5 * 60 * 60 * 1000,
    weeklyHours: 400,
    avgOutputTokensPerPrompt: 1_100,
  },
  max20: {
    label: "Max 20× ($200/mo)",
    outputTokensPer5h: 220_000,
    promptsPer5h: 900,
    windowMs: 5 * 60 * 60 * 1000,
    weeklyHours: 1_600,
    avgOutputTokensPerPrompt: 1_100,
  },
};

// ########################################################################### Default Settings ###########################################################################

const DEFAULT_SETTINGS = {
  bot: {
    token: "",
    clientId: "",
    channelId: "",
    webhookUrl: "",
  },
  runner: {
    defaultModel: "claude-opus-4-5",
    maxTurns: 200,
    pauseMinutes: 360,
    autoSecurityFix: true,
    archiveOnComplete: true,
    claudePlan: "max20", // pro | max5 | max20
  },
  sessions: {
    count: 4,
  },
  logging: {
    keepLogs: 10,
  },
};

// ########################################################################### Settings ###########################################################################

function loadSettings() {
  if (!existsSync(SETTINGS_FILE)) {
    writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return deepMerge(DEFAULT_SETTINGS, raw);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings(s) {
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
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

// ########################################################################### Credentials ###########################################################################

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || getSetting("bot", "token");
const CLIENT_ID =
  process.env.DISCORD_CLIENT_ID || getSetting("bot", "clientId");
const CHANNEL_ID =
  process.env.DISCORD_CHANNEL_ID || getSetting("bot", "channelId");

// ########################################################################### Process State ###########################################################################

let runningProcess = null;
let securityFixProcess = null;

// ########################################################################### Helpers ###########################################################################

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getSessionCount() {
  if (!existsSync(SESSION_DIR)) return 0;
  return readdirSync(SESSION_DIR).filter((f) => /^Session\d+\.md$/i.test(f))
    .length;
}

function isRunning() {
  return runningProcess !== null && !runningProcess.killed;
}
function isSecurityFixRunning() {
  return securityFixProcess !== null && !securityFixProcess.killed;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { completedSessions: [] };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { completedSessions: [] };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function formatDuration(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function getLatestLogFile() {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("run-") && f.endsWith(".log"))
    .map((f) => ({ name: f, mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? join(LOG_DIR, files[0].name) : null;
}

function loadSecurityReports() {
  if (!existsSync(SECURITY_DIR)) return [];
  return readdirSync(SECURITY_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("fix-output"))
    .map((f) => ({
      file: join(SECURITY_DIR, f),
      name: f,
      content: readFileSync(join(SECURITY_DIR, f), "utf8"),
    }));
}

function countFindings(content, level) {
  return (content.match(new RegExp(level, "g")) ?? []).length;
}

function resolveClaudePath() {
  const w = spawnSync("where.exe", ["claude"], { encoding: "utf8" });
  if (w.status === 0 && w.stdout?.trim())
    return w.stdout.trim().split("\n")[0].trim();
  const fallback = join(process.env.APPDATA ?? "", "npm", "claude.cmd");
  return existsSync(fallback) ? fallback : "claude";
}

function queryRateLimit() {
  const result = spawnSync(resolveClaudePath(), ["api-status", "--json"], {
    encoding: "utf8",
    timeout: 8_000,
    shell: false,
    env: { ...process.env },
  });
  if (result.status === 0 && result.stdout?.trim()) {
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      /* no JSON */
    }
  }
  return null;
}

// ########################################################################### Rate-Limit / Timeout Calculator ###########################################################################
//
// Strategy:
//  1. Estimate total output tokens needed for all sessions based on file sizes
//  2. Compare against the plan's 5h window budget
//  3. Recommend per-session timeouts and required pauses
//
// Token estimation heuristic:
//  ~4 chars per token for input, output is typically 30–50% of input length
//  We use 0.35 as a conservative output ratio for code generation tasks.

const CHARS_PER_TOKEN = 4;
const OUTPUT_RATIO = 0.35; // estimated output / input token ratio
const SAFETY_MARGIN = 0.95; // use max 95% of the window budget

/**
 * @param {object[]} sessions
 * @param {string}   planKey
 * @returns {object}
 */
function calculateSessionTimeouts(sessions, planKey) {
  const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

  const budgetTokens = Math.floor(plan.outputTokensPer5h * SAFETY_MARGIN);
  const windowMs = plan.windowMs;

  const sessionData = sessions.map((s) => {
    const inputTokens = Math.ceil(s.totalChars / CHARS_PER_TOKEN);
    const outputTokens = Math.ceil(inputTokens * OUTPUT_RATIO);
    const estimatedMs = Math.ceil((outputTokens / 500) * 1_000);

    return {
      ...s,
      inputTokens,
      outputTokens,
      estimatedMs,
    };
  });

  const totalOutputTokens = sessionData.reduce((s, x) => s + x.outputTokens, 0);
  const fitsInOneWindow = totalOutputTokens <= budgetTokens;

  const windowsNeeded = Math.ceil(totalOutputTokens / budgetTokens);

  const sessionsPerWindow = Math.ceil(sessions.length / windowsNeeded);
  const pauseBetweenMs =
    windowsNeeded > 1
      ? Math.ceil(windowMs / sessionsPerWindow)
      : Math.ceil(windowMs / sessions.length);

  const perSessionTimeouts = sessionData.map((s) => {
    const recommended = Math.min(
      Math.max(s.estimatedMs * 2.5, 2 * 60_000),
      windowMs / 2,
    );
    return {
      ...s,
      recommendedTimeoutMs: Math.ceil(recommended / 60_000) * 60_000,
    };
  });

  return {
    plan,
    planKey,
    totalOutputTokens,
    budgetTokens,
    fitsInOneWindow,
    windowsNeeded,
    sessionsPerWindow,
    pauseBetweenMs,
    recommendedPauseMinutes: Math.ceil(pauseBetweenMs / 60_000),
    sessions: perSessionTimeouts,
  };
}

function applyTimeoutsToSessionFile(
  filePath,
  recommendedTimeoutMs,
  promptCount,
  planKey,
) {
  if (!existsSync(filePath)) return false;

  const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const content = readFileSync(filePath, "utf8");

  const prompts = {};
  for (let i = 1; i <= (promptCount || 3); i++) {
    prompts[String(i)] = {
      model: plan.label.includes("20")
        ? "claude-opus-4-5"
        : "claude-sonnet-4-5",
      maxTurns: getSetting("runner", "maxTurns"),
      timeoutMs: recommendedTimeoutMs,
    };
  }

  const overrideJson = JSON.stringify(
    {
      session: {
        pauseAfterMs: getSetting("runner", "pauseMinutes") * 60_000,
        defaultModel: getSetting("runner", "defaultModel"),
      },
      prompts,
    },
    null,
    2,
  );

  const overrideBlock = `<!--\nSESSION OVERRIDE CONFIG\n${overrideJson}\n-->\n\n`;

  const cleaned = content.replace(
    /<!--\nSESSION OVERRIDE CONFIG[\s\S]*?-->\n\n/,
    "",
  );
  writeFileSync(filePath, overrideBlock + cleaned);
  return true;
}

// ########################################################################### Session Validation ###########################################################################

const VALIDATION_RULES = {
  hasHeader: {
    re: /^# Session \d+ —/m,
    msg: "Missing session header `# Session N —`",
  },
  hasInstruction: {
    re: /Do NOT wait for user input between prompts/,
    msg: "Missing instruction block (Do NOT wait...)",
  },
  hasPrompt: {
    re: /^## Prompt\s+\d+\s*[—–-]/m,
    msg: "No prompts found (`## Prompt N —` format)",
  },
};

function validateSessionContent(content, filePath) {
  const errors = [];
  const warnings = [];

  const stripped = content.replace(/<!--[\s\S]*?-->/g, "").trim();

  // ########################################################################### Basic structure ###########################################################################
  if (!VALIDATION_RULES.hasHeader.re.test(stripped))
    errors.push(VALIDATION_RULES.hasHeader.msg);

  if (!VALIDATION_RULES.hasInstruction.re.test(stripped))
    warnings.push(VALIDATION_RULES.hasInstruction.msg);

  if (!VALIDATION_RULES.hasPrompt.re.test(stripped))
    errors.push(VALIDATION_RULES.hasPrompt.msg);

  // ########################################################################### Prompt numbering sequential ###########################################################################
  const promptHeaders = [
    ...stripped.matchAll(/^## Prompt\s+(\d+)\s*[—–-]/gm),
  ].map((m) => parseInt(m[1]));

  if (promptHeaders.length > 0) {
    promptHeaders.forEach((n, i) => {
      if (n !== i + 1)
        errors.push(
          `Prompt numbering not sequential: expected Prompt ${i + 1}, found Prompt ${n}`,
        );
    });
  }

  // ########################################################################### Unfilled placeholders ###########################################################################
  const placeholders = stripped.match(/\{[^}]{1,60}\}/g) ?? [];
  if (placeholders.length > 0) {
    const unique = [...new Set(placeholders)];
    errors.push(
      `Unfilled placeholders: ${unique.map((p) => `\`${p}\``).join(", ")}`,
    );
  }

  // ########################################################################### Separator coverage ###########################################################################
  const separators = [...stripped.matchAll(/^---+\s*$/gm)];

  if (promptHeaders.length > 0 && separators.length < promptHeaders.length) {
    warnings.push(
      `${promptHeaders.length} prompt(s) found but only ${separators.length} ` +
        `separator(s) (\`---\`) — last prompt may not be closed`,
    );
  }

  // ########################################################################### Override JSON block validation ###########################################################################
  const overrideMatch = content.match(
    /<!--\nSESSION OVERRIDE CONFIG\n([\s\S]*?)-->/,
  );
  if (overrideMatch) {
    try {
      const parsed = JSON.parse(overrideMatch[1]);

      if (!parsed.session)
        warnings.push("Override config: missing `session` key");

      if (!parsed.prompts) {
        warnings.push("Override config: missing `prompts` key");
      } else {
        const overrideKeys = Object.keys(parsed.prompts)
          .map(Number)
          .sort((a, b) => a - b);
        const missing = promptHeaders.filter((n) => !overrideKeys.includes(n));
        if (missing.length > 0)
          warnings.push(
            `Override config: prompts [${missing.join(", ")}] have no override entry`,
          );
      }
    } catch (e) {
      errors.push(`Override config JSON is invalid: ${e.message}`);
    }
  }

  // ########################################################################### Empty prompt bodies ###########################################################################
  const prompts = parseSessionFile(stripped);
  prompts.forEach((p, i) => {
    const body = p.text
      .replace(/^## Prompt[^\n]+\n/, "")
      .replace(/^---+\s*$/m, "")
      .trim();
    if (body.length < 10)
      errors.push(
        `Prompt ${i + 1} ("${p.title.slice(0, 40)}") appears to be empty`,
      );
  });

  // ########################################################################### Security Agent defined in CLAUDE.md ###########################################################################
  if (existsSync(CLAUDE_MD)) {
    const claudeMdContent = readFileSync(CLAUDE_MD, "utf8");
    const hasSecurityAgent =
      /security agent/i.test(claudeMdContent) &&
      /\[SECURITY\]/i.test(claudeMdContent) &&
      /security-report/i.test(claudeMdContent);

    if (!hasSecurityAgent) {
      warnings.push(
        "CLAUDE.md does not define a Security Agent with `[SECURITY]` tag and report instructions — " +
          "the security fix pass will have nothing to process. Run `/setup` to regenerate CLAUDE.md.",
      );
    }
  } else {
    warnings.push(
      "CLAUDE.md is missing — Security Agent is not defined. Run `/setup` to create it.",
    );
  }

  // ########################################################################### [SECURITY] prompt present in this session ###########################################################################
  if (!/\[SECURITY\]/i.test(stripped)) {
    warnings.push(
      "No `[SECURITY]` tagged prompt found in this session — no security report will be written. " +
        "Add a `## Prompt N — [SECURITY] Audit` prompt before the Manager prompt.",
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateAllSessions() {
  if (!existsSync(SESSION_DIR))
    return {
      allValid: false,
      results: [],
      globalError: `Sessions directory not found: \`${SESSION_DIR}\``,
    };

  const files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  if (files.length === 0)
    return {
      allValid: false,
      results: [],
      globalError: `No session files found in \`${SESSION_DIR}\``,
    };

  const results = files.map((file) => {
    const fullPath = join(SESSION_DIR, file);
    const content = readFileSync(fullPath, "utf8");
    const result = validateSessionContent(content, fullPath);
    return { file, fullPath, ...result };
  });

  return {
    allValid: results.every((r) => r.valid),
    results,
  };
}

// ########################################################################### Archive ###########################################################################

function archiveCompletedRun() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runArchive = join(ARCHIVE_DIR, `run-${ts}`);

  ensureDir(runArchive);
  for (const sub of ["Logs", "Security", "Sessions"])
    ensureDir(join(runArchive, sub));

  if (existsSync(LOG_DIR))
    readdirSync(LOG_DIR).forEach((f) =>
      renameSync(join(LOG_DIR, f), join(runArchive, "Logs", f)),
    );

  if (existsSync(SECURITY_DIR))
    readdirSync(SECURITY_DIR).forEach((f) =>
      renameSync(join(SECURITY_DIR, f), join(runArchive, "Security", f)),
    );

  if (existsSync(SESSION_DIR))
    readdirSync(SESSION_DIR)
      .filter((f) => f.startsWith("output-") || f.endsWith(".output.md"))
      .forEach((f) =>
        renameSync(join(SESSION_DIR, f), join(runArchive, "Sessions", f)),
      );

  if (existsSync(STATE_FILE)) {
    const dest = join(runArchive, `progress-${ts}.json`);
    renameSync(STATE_FILE, dest);
  }

  return runArchive;
}

function pruneArchives(keepCount = 5) {
  if (!existsSync(ARCHIVE_DIR)) return;
  readdirSync(ARCHIVE_DIR)
    .filter((f) => f.startsWith("run-"))
    .map((f) => ({ name: f, mtime: statSync(join(ARCHIVE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(keepCount)
    .forEach((r) =>
      rmSync(join(ARCHIVE_DIR, r.name), { recursive: true, force: true }),
    );
}

// ########################################################################### Session Parser ###########################################################################

function parseSessionFile(content) {
  const prompts = [];
  const lines = content.split("\n");
  let current = null;
  let buffer = [];

  for (const line of lines) {
    if (/^## Prompt\s+\d+\s*[—–-]/i.test(line)) {
      if (current !== null) {
        const text = buffer.join("\n").trim();
        prompts.push({ title: current, chars: text.length, text });
      }
      current = line.replace(/^##\s*/, "").trim();
      buffer = [line];
      continue;
    }
    if (/^---+\s*$/.test(line) && current !== null) {
      buffer.push(line);
      const text = buffer.join("\n").trim();
      prompts.push({ title: current, chars: text.length, text });
      current = null;
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }

  if (current !== null && buffer.length > 0) {
    const text = buffer.join("\n").trim();
    prompts.push({ title: current, chars: text.length, text });
  }

  return prompts;
}

function detectSessions() {
  if (!existsSync(SESSION_DIR))
    return { error: `Sessions directory not found:\n\`${SESSION_DIR}\`` };

  const files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  if (files.length === 0)
    return {
      error: `No session files (Session1.md etc.) found in:\n\`${SESSION_DIR}\``,
    };

  const sessions = files.map((file) => {
    const fullPath = join(SESSION_DIR, file);
    const content = readFileSync(fullPath, "utf8");
    const prompts = parseSessionFile(content);
    return {
      file,
      fullPath,
      totalChars: content.length,
      promptCount: prompts.length,
      prompts,
    };
  });

  return { sessions };
}

// ########################################################################### Setup ###########################################################################

function buildSessionTemplate(sessionNumber, withOverride) {
  const header = [
    `# Session ${sessionNumber} — Task Overview`,
    "",
    "Execute ALL of the following prompts in order.",
    "Do NOT wait for user input between prompts.",
    "Continue automatically once the completion checklist of a prompt is fulfilled.",
    "Mark each completed prompt with: `### ✅ PROMPT X COMPLETED`",
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
    JSON.stringify(
      {
        session: {
          pauseAfterMs: 300_000,
          defaultModel: "claude-opus-4-5",
        },
        prompts: {
          1: { model: "claude-opus-4-5", maxTurns: 100, timeoutMs: 120_000 },
          2: { model: "claude-sonnet-4-5", maxTurns: 20, timeoutMs: 120_000 },
        },
      },
      null,
      2,
    ),
    "-->",
    "",
    "",
  ].join("\n");

  return overrideBlock + header + prompts;
}

function runSetup(withOverride = false, planKey = null) {
  const created = [];

  for (const dir of [LOG_DIR, SECURITY_DIR, SESSION_DIR, ARCHIVE_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(`📁 ${basename(dir)}/`);
    }
  }

  if (!existsSync(CLAUDE_MD)) {
    writeFileSync(
      CLAUDE_MD,
      [
        "# Claude Runner — Global Agent Context",
        "",
        "You are an automated coding assistant operating in a multi-agent framework.",
        "Each prompt in a session designates which agent role is active.",
        "Read the role designation at the top of each prompt and apply its rules strictly.",
        "Complete every prompt fully without requesting user input.",
        "Mark each completed prompt with: `### PROMPT X COMPLETED`",
        "On errors: document what failed, attempt a fix, and continue to the next prompt.",
        "",
        "---",
        "",
        "## Agent Roles",
        "",
        "### Fullstack Agent",
        "",
        "Activate when a prompt is tagged: [FULLSTACK]",
        "",
        "Responsibilities:",
        "- Implement frontend components, pages, and API routes",
        "- Write clean, typed TypeScript — no any types",
        "- Follow the existing file structure and naming conventions exactly",
        "- Every new component must have a corresponding .test.ts file",
        "- Use the existing UI component library — do not introduce new dependencies",
        "- API routes must validate all inputs and return consistent error shapes",
        "- Do not leave TODO comments — implement fully or document the gap in a findings file",
        "",
        "Conventions:",
        "- Components: PascalCase in src/components/",
        "- API routes: kebab-case in src/routes/",
        "- Shared types: src/types/index.ts",
        "- Environment variables: always read from process.env, never hardcode",
        "",
        "---",
        "",
        "### Database Agent",
        "",
        "Activate when a prompt is tagged: [DATABASE]",
        "",
        "Responsibilities:",
        "- Write and apply database migrations — never mutate existing migrations",
        "- Design schemas with explicit foreign keys, indexes, and constraints",
        "- All queries must use parameterized statements — no string interpolation",
        "- Write a rollback migration for every forward migration",
        "- Document every table and column with a SQL comment",
        "- After schema changes, update the corresponding TypeScript types in src/types/db.ts",
        "",
        "Conventions:",
        "- Migrations: db/migrations/YYYYMMDD_description.sql",
        "- Seed data: db/seeds/",
        "- Query helpers: src/db/queries/",
        "- Connection pool: always use the existing pool in src/db/pool.ts",
        "",
        "---",
        "",
        "### Security Agent",
        "",
        "Activate when a prompt is tagged: [SECURITY]",
        "",
        "The Security Agent reviews code only — it does NOT write or modify any source files.",
        "It audits all layers touched in the current session and writes a structured report.",
        "On CRITICAL findings: document and continue — do not stop the session.",
        "At the end of the session, include a summary of all CRITICAL findings found across all prompts.",
        "",
        "Responsibilities:",
        "- Review every file created or modified in the current session",
        "- Check all layers: frontend, backend, and database",
        "- Write one report per prompt reviewed, named by prompt and date",
        "- Never truncate findings — completeness is mandatory",
        "",
        "Report location:",
        "  Security/security-report-{prompt-name}-{YYYY-MM-DD}.md",
        "",
        "Report format:",
        "  # Security Report — {Prompt Name} — {YYYY-MM-DD}",
        "",
        "  ## CRITICAL (fix immediately)",
        "  - [ ] {Description} | File: {path}:{line} | Risk: {explanation}",
        "",
        "  ## WARNING (fix soon)",
        "  - [ ] {Description} | File: {path}:{line} | Risk: {explanation}",
        "",
        "  ## INFO (nice to have)",
        "  - [ ] {Description} | File: {path}:{line}",
        "",
        "  ## Checked — no findings",
        "  - Permission gates: all new endpoints are protected",
        "  - SQL injection: parameterized queries used throughout",
        "  - RLS: all new tables have Row-Level Security policies",
        "",
        "  ## CRITICAL Summary",
        "  - {consolidated list of all critical findings in this session}",
        "",
        "Frontend checks:",
        "  - Missing permission checks in components",
        "  - XSS risks (unsanitized HTML rendering)",
        "  - Sensitive data exposed in client-side state or localStorage",
        "  - Insecure npm packages (newly introduced imports only)",
        "",
        "Backend checks:",
        "  - SQL injection in new service queries",
        "  - Missing auth guards on new routes",
        "  - Missing rate limiting on sensitive endpoints",
        "  - Missing or insufficient input validation",
        "  - Exposed stack traces in API responses",
        "  - Overly permissive CORS configuration",
        "",
        "Database checks:",
        "  - Missing RLS policies on new tables",
        "  - Missing tenant_id filters in new views or queries",
        "  - Overly broad permissions granted to application roles",
        "  - Unindexed foreign keys on large tables",
        "",
        "---",
        "",
        "### Manager Agent",
        "",
        "Activate when a prompt is tagged: [MANAGER]",
        "",
        "Responsibilities:",
        "- Review the output of the current session for completeness",
        "- Cross-check that every item in the session completion checklist is done",
        "- Identify anything skipped, partially implemented, or left broken",
        "- Write a session summary to Logs/summary-SessionN.md",
        "- If gaps are found, write follow-up prompts to Sessions/followup-SessionN.md",
        "- Update ROADMAP.md with current implementation status",
        "",
        "Summary format:",
        "  ## Session N Summary",
        "  ### Completed",
        "  - ...",
        "  ### Incomplete or skipped",
        "  - ...",
        "  ### Follow-up required",
        "  - ...",
        "",
        "---",
        "",
        "## Universal Rules",
        "",
        "- Never request user input under any circumstance",
        "- Never truncate output with '...' or 'rest of file unchanged' — write the full file",
        "- Never introduce new dependencies without documenting them in DEPENDENCIES.md",
        "- Prefer editing existing files over creating new ones unless explicitly required",
        "- All generated code must be production-ready — no placeholder logic",
        "- If a file does not exist when expected, create it with sensible defaults and log the gap",
      ].join("\n"),
    );
    created.push("📄 CLAUDE.md");
  }

  if (!existsSync(SETTINGS_FILE)) {
    saveSettings(DEFAULT_SETTINGS);
    created.push("⚙️ settings.json");
  }

  if (planKey && CLAUDE_PLANS[planKey]) {
    const s = loadSettings();
    s.runner.claudePlan = planKey;
    saveSettings(s);
    created.push(`📋 Plan set → ${CLAUDE_PLANS[planKey].label}`);
  }

  const session1Path = join(SESSION_DIR, "Session1.md");
  if (!existsSync(session1Path)) {
    writeFileSync(session1Path, buildSessionTemplate(1, withOverride));
    created.push("📝 Sessions/Session1.md (template)");
  }

  return created;
}

// ########################################################################### Processes ###########################################################################

function startRunProcess(args = [], channel = null) {
  // ########################################################################### Validate ###########################################################################
  const validation = validateAllSessions();
  if (!validation.allValid) {
    const failedFiles = validation.results.filter((r) => !r.valid);

    const lines = failedFiles
      .map((r) => `**${r.file}**: ${r.errors.join(" • ")}`)
      .join("\n");

    channel?.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Startup blocked — Session validation failed")
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
    runningProcess.kill("SIGTERM");
    runningProcess = null;
  }

  // ########################################################################### Gather session info for notification ###########################################################################
  const detected = detectSessions();
  const totalSessions = detected.sessions?.length ?? 0;
  const totalPrompts =
    detected.sessions?.reduce((s, x) => s + x.promptCount, 0) ?? 0;

  runningProcess = spawn("node", ["run-sessions.js", ...args], {
    cwd: BASE_DIR,
    stdio: "inherit",
    detached: false,
    env: { ...process.env },
  });

  notifyRunStart({
    totalSessions,
    totalPrompts,
    model: getSetting("runner", "defaultModel"),
    plan: CLAUDE_PLANS[getSetting("runner", "claudePlan")]?.label,
    baseDir: BASE_DIR,
  });

  // ########################################################################### Token budget warning ###########################################################################
  if (!detected.error && detected.sessions?.length > 0) {
    const planKey = getSetting("runner", "claudePlan");
    const calc = calculateSessionTimeouts(detected.sessions, planKey);
    const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

    if (!calc.fitsInOneWindow) {
      notifyRateLimitWarning({
        planLabel: plan.label,
        usedTokens: calc.totalOutputTokens,
        budgetTokens: calc.budgetTokens,
        windowsNeeded: calc.windowsNeeded,
      });
    }
  }

  let runStartedAt = Date.now();

  runningProcess.on("exit", async (code) => {
    console.log(`[Bot] run-sessions.js exited — code ${code}`);
    runningProcess = null;

    const totalDurationMs = Date.now() - runStartedAt;
    const state = loadState();
    const sc = getSetting("sessions", "count");
    const allDone = (state.completedSessions?.length ?? 0) >= sc;
    const autoFix = getSetting("runner", "autoSecurityFix");
    const doArchive = getSetting("runner", "archiveOnComplete");

    if (code !== 0) {
      notifyRunFailed({
        exitCode: code,
        errorMsg: `Process exited with code ${code}`,
      });
    }

    if (code === 0 && allDone && channel) {
      if (autoFix) {
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ All sessions completed — starting Security Fix")
              .setDescription(
                "Claude is now scanning all Security Violations and fixing them.",
              )
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
        startSecurityFix(channel);
      } else if (doArchive) {
        const ap = archiveCompletedRun();
        pruneArchives(5);
        notifyRunComplete({
          totalSessions: sc,
          totalDurationMs,
          archivePath: ap,
        });
        notifyArchived({
          archivePath: ap,
          runLabel: `run-${new Date().toISOString().slice(0, 10)}`,
        });
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ Run completed — Archived")
              .setDescription(`All files archived to:\n\`${ap}\``)
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
      } else {
        notifyRunComplete({ totalSessions: sc, totalDurationMs });
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ Run fully completed")
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
      }
    }
  });
}

function startSecurityFix(channel = null) {
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
            .setTitle("📦 Run archived")
            .setDescription(`\`${ap}\``)
            .setColor(0x5865f2)
            .setTimestamp(),
        ],
      });
    }
    return;
  }

  // ########################################################################### Notify fix start ###########################################################################
  const totalC = reports.reduce(
    (s, r) => s + countFindings(r.content, "🔴 CRITICAL"),
    0,
  );
  const totalW = reports.reduce(
    (s, r) => s + countFindings(r.content, "🟡 WARNING"),
    0,
  );
  notifySecurityFixStart({
    reportCount: reports.length,
    criticalCount: totalC,
    warningCount: totalW,
  });

  const reportContents = reports
    .map((r) => `### Report: ${r.name}\n\n${r.content}`)
    .join("\n\n---\n\n");

  const globalCtx = existsSync(CLAUDE_MD)
    ? readFileSync(CLAUDE_MD, "utf8")
    : "";
  const model = getSetting("runner", "defaultModel");

  const prompt = [
    globalCtx,
    "",
    "## Task: Fix Security Violations",
    "",
    "Go through ALL of the following security reports and fix every finding.",
    "Work in order: 🔴 CRITICAL → 🟡 WARNING → 🔵 INFO.",
    "For each fixed item: mark it in the report with ✅ FIXED.",
    "Do not skip any item — complete all of them.",
    "",
    "---",
    "",
    reportContents,
  ].join("\n");

  securityFixProcess = spawn(
    resolveClaudePath(),
    [
      "--print",
      "--model",
      model,
      "--max-turns",
      "200",
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
      "--verbose",
      "--add-dir",
      PROJECT_DIR,
    ],
    { cwd: BASE_DIR, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
  );

  securityFixProcess.stdin.write(prompt);
  securityFixProcess.stdin.end();

  let output = "";
  securityFixProcess.stdout.on("data", (d) => {
    output += d;
  });
  securityFixProcess.stderr.on("data", (d) => {
    console.error("[SecurityFix]", d.toString().slice(0, 200));
  });

  securityFixProcess.on("exit", async (code) => {
    securityFixProcess = null;

    const outFile = join(SECURITY_DIR, `fix-output-${Date.now()}.md`);
    try {
      writeFileSync(outFile, output);
    } catch {
      /* ignore */
    }

    // ########################################################################### Webhook ###########################################################################
    notifySecurityFixComplete({
      success: code === 0,
      outputPath: outFile,
      exitCode: code,
    });

    if (channel) {
      const ok = code === 0;
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(
              ok ? "✅ Security Fix completed" : "❌ Security Fix failed",
            )
            .setDescription(
              ok
                ? `All violations have been processed.\nOutput: \`${outFile}\``
                : `Process exited with code ${code}.\nOutput: \`${outFile}\``,
            )
            .setColor(ok ? 0x57f287 : 0xed4245)
            .setTimestamp(),
        ],
      });
    }

    if (getSetting("runner", "archiveOnComplete")) {
      const ap = archiveCompletedRun();
      pruneArchives(5);
      notifyArchived({ archivePath: ap });
      channel?.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("📦 Run archived")
            .setDescription(`All files moved to:\n\`${ap}\``)
            .setColor(0x5865f2)
            .setTimestamp(),
        ],
      });
    }
  });
}

// ########################################################################### Slash Commands ###########################################################################

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Shows the current progress of all sessions"),

  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Starts run-sessions.js (restarts if already running)")
    .addBooleanOption((o) =>
      o
        .setName("reset")
        .setDescription("Clear progress and restart from Session 1")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription(
      "Restarts run-sessions.js — completed sessions are skipped",
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stops the running script and/or security fix"),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clears progress and restarts from scratch")
    .addStringOption((o) =>
      o
        .setName("confirm")
        .setDescription("Type 'yes' to confirm")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("Shows the last lines of the current log file")
    .addIntegerOption((o) =>
      o
        .setName("lines")
        .setDescription("Number of lines (default: 20, max: 50)")
        .setRequired(false)
        .setMinValue(5)
        .setMaxValue(50),
    ),

  new SlashCommandBuilder()
    .setName("rate-limit")
    .setDescription("Shows the estimated rate-limit status"),

  new SlashCommandBuilder()
    .setName("security-status")
    .setDescription("Shows all security findings from reports"),

  new SlashCommandBuilder()
    .setName("start-resolve-security")
    .setDescription(
      "Starts Claude to automatically fix all security violations",
    ),

  new SlashCommandBuilder()
    .setName("detect-sessions")
    .setDescription("Analyzes all session files and shows prompt breakdown"),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription(
      "Creates directories, CLAUDE.md and Session1.md template — run this first!",
    )
    .addStringOption((o) =>
      o
        .setName("plan")
        .setDescription(
          "Your Claude subscription plan (affects timeout calculation)",
        )
        .setRequired(false)
        .addChoices(
          { name: "Pro ($20/mo)", value: "pro" },
          { name: "Max 5× ($100/mo)", value: "max5" },
          { name: "Max 20× ($200/mo)", value: "max20" },
        ),
    )
    .addBooleanOption((o) =>
      o
        .setName("override")
        .setDescription("Embed override config (JSON) in session template?")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("new-session")
    .setDescription("Creates a new empty session file from template")
    .addIntegerOption((o) =>
      o
        .setName("number")
        .setDescription("Session number (e.g. 2 for Session2.md)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(20),
    )
    .addBooleanOption((o) =>
      o
        .setName("override")
        .setDescription("Embed override config?")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("View or change bot/runner settings")
    .addSubcommand((sub) =>
      sub.setName("show").setDescription("Show all current settings"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Change a setting")
        .addStringOption((o) =>
          o
            .setName("key")
            .setDescription("Key (e.g. runner.pauseMinutes)")
            .setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("value").setDescription("New value").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("reset").setDescription("Reset all settings to defaults"),
    ),

  new SlashCommandBuilder()
    .setName("archive")
    .setDescription("Manage run archives")
    .addSubcommand((sub) =>
      sub.setName("now").setDescription("Archive the current run immediately"),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all archived runs"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("prune")
        .setDescription("Delete old archives (keep last N)")
        .addIntegerOption((o) =>
          o
            .setName("keep")
            .setDescription("Number to keep (default: 5)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(20),
        ),
    ),

  new SlashCommandBuilder()
    .setName("validate-sessions")
    .setDescription(
      "Validates all session files against the expected template structure",
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Shows all available commands"),
].map((c) => c.toJSON());

// ########################################################################### Register Commands ###########################################################################

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("[Bot] Slash commands registered ✅");
  } catch (err) {
    console.error("[Bot] Command registration failed:", err.message);
  }
}

// ########################################################################### Client ###########################################################################

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag} ✅`);
  await registerCommands();

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const plan =
    CLAUDE_PLANS[getSetting("runner", "claudePlan")] ?? CLAUDE_PLANS.max20;
  const sc = getSessionCount();
  const model = getSetting("runner", "defaultModel");
  const pause = getSetting("runner", "pauseMinutes");
  const autoFix = getSetting("runner", "autoSecurityFix");
  const archive = getSetting("runner", "archiveOnComplete");

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🤖 Claude Runner Bot — Online")
        .setDescription(
          [
            "**Claude Runner Bot** is ready to execute your AI sessions automatically.",
            "",
            "## 🚀 Quick Start",
            "1. Run `/setup` to create all directories and a Session1.md template",
            "2. Edit `Sessions/Session1.md` — fill in your prompts",
            "3. Run `/start` to kick off the automation",
            "",
            "## ⚙️ How it works",
            "• Sessions are executed sequentially by `run-sessions.js`",
            "• Progress is saved in `.progress.json` — crashes resume automatically",
            "• After all sessions finish, a **Security Fix** pass runs automatically",
            "• The completed run is then **archived** to `Archive/run-<timestamp>/`",
            "",
            "## 📋 Key Commands",
            "`/setup` • `/start` • `/status` • `/logs` • `/detect-sessions`",
            "`/settings show` • `/rate-limit` • `/archive list`",
          ].join("\n"),
        )
        .addFields(
          { name: "Sessions detected", value: String(sc || "—"), inline: true },
          { name: "Default model", value: model, inline: true },
          { name: "Pause between", value: `${pause} min`, inline: true },
          { name: "Claude plan", value: plan.label, inline: true },
          {
            name: "Auto Security Fix",
            value: autoFix ? "✅" : "❌",
            inline: true,
          },
          { name: "Auto Archive", value: archive ? "✅" : "❌", inline: true },
          {
            name: "5h token budget",
            value: `~${(plan.outputTokensPer5h / 1000).toFixed(0)}k output tokens`,
            inline: true,
          },
          {
            name: "Rate limit window",
            value: "5 hours (rolling)",
            inline: true,
          },
          {
            name: "Config file",
            value: `\`${SETTINGS_FILE}\``,
            inline: false,
          },
        )
        .setColor(0x5865f2)
        .setFooter({ text: "Claude Runner Bot • Run /help for all commands" })
        .setTimestamp(),
    ],
  });
});

// ########################################################################### Interaction Handler ###########################################################################

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const channelId = CHANNEL_ID || getSetting("bot", "channelId");
  if (interaction.channelId !== channelId) {
    await interaction.reply({ content: "❌ Wrong channel.", ephemeral: true });
    return;
  }

  const { commandName } = interaction;

  // ########################################################################### /setup ###########################################################################
  if (commandName === "setup") {
    const withOverride = interaction.options.getBoolean("override") ?? false;
    const planKey =
      interaction.options.getString("plan") ??
      getSetting("runner", "claudePlan");
    const created = runSetup(withOverride, planKey);
    const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

    const detected = detectSessions();
    let timeoutInfo = "";

    if (!detected.error && detected.sessions.length > 0) {
      const calc = calculateSessionTimeouts(detected.sessions, planKey);
      timeoutInfo = [
        "",
        "**Timeout Calculation based on plan:**",
        `• Total estimated output tokens: ~${(calc.totalOutputTokens / 1000).toFixed(1)}k`,
        `• 5h budget (${SAFETY_MARGIN * 100}% safety): ~${(calc.budgetTokens / 1000).toFixed(1)}k tokens`,
        `• Windows needed: ${calc.windowsNeeded}`,
        `• Recommended pause between sessions: **${calc.recommendedPauseMinutes} min**`,
      ].join("\n");

      for (const s of calc.sessions) {
        applyTimeoutsToSessionFile(
          s.fullPath,
          s.recommendedTimeoutMs,
          s.promptCount,
          planKey,
        );
      }
      timeoutInfo += `\n• ✅ Override configs written to all ${detected.sessions.length} session files`;
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔧 Setup completed")
          .setDescription(
            (created.length > 0
              ? `**Created:**\n${created.join("\n")}`
              : "✅ Everything already exists — nothing to do.") + timeoutInfo,
          )
          .addFields(
            { name: "Plan", value: plan.label, inline: true },
            {
              name: "5h token budget",
              value: `${(plan.outputTokensPer5h / 1000).toFixed(0)}k output tokens`,
              inline: true,
            },
            {
              name: "Override config",
              value: withOverride ? "✅ Embedded" : "❌ Not embedded",
              inline: true,
            },
            { name: "Base directory", value: `\`${BASE_DIR}\``, inline: false },
          )
          .setColor(created.length > 0 ? 0x57f287 : 0x5865f2)
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /validate-sessions ###########################################################################
  else if (commandName === "validate-sessions") {
    await interaction.deferReply();

    const { allValid, results, globalError } = validateAllSessions();

    if (globalError) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Validate Sessions")
            .setDescription(globalError)
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
      return;
    }

    const embeds = [];

    // ########################################################################### Summary embed ###########################################################################
    const passCount = results.filter((r) => r.valid).length;
    const failCount = results.length - passCount;
    const warnCount = results.reduce((s, r) => s + r.warnings.length, 0);

    embeds.push(
      new EmbedBuilder()
        .setTitle(allValid ? "✅ All sessions valid" : "❌ Validation failed")
        .setDescription(
          results
            .map((r) => {
              const icon = r.valid ? "✅" : "❌";
              const warn =
                r.warnings.length > 0
                  ? ` ⚠️ ${r.warnings.length} warning(s)`
                  : "";
              const err = !r.valid ? ` — ${r.errors.length} error(s)` : "";
              return `${icon} **${r.file}**${err}${warn}`;
            })
            .join("\n"),
        )
        .addFields(
          { name: "✅ Passed", value: String(passCount), inline: true },
          { name: "❌ Failed", value: String(failCount), inline: true },
          { name: "⚠️ Warnings", value: String(warnCount), inline: true },
          {
            name: "Start blocked",
            value: allValid ? "No — ready to run" : "Yes — fix errors first",
            inline: false,
          },
        )
        .setColor(allValid ? 0x57f287 : 0xed4245)
        .setTimestamp(),
    );

    // ########################################################################### Per-file detail embeds ###########################################################################
    for (const r of results) {
      if (r.errors.length === 0 && r.warnings.length === 0) continue;

      const errorLines = r.errors.map((e) => `🔴 ${e}`);
      const warningLines = r.warnings.map((w) => `🟡 ${w}`);
      const allLines = [...errorLines, ...warningLines];

      embeds.push(
        new EmbedBuilder()
          .setTitle(`${r.valid ? "⚠️" : "❌"} ${r.file}`)
          .setDescription(allLines.join("\n") || "No issues.")
          .setColor(r.valid ? 0xfee75c : 0xed4245),
      );

      if (embeds.length >= 10) break;
    }

    // ########################################################################### Webhook notification ###########################################################################
    if (allValid) {
      const totalPrompts = results.reduce(
        (s, r) => s + parseSessionFile(readFileSync(r.fullPath, "utf8")).length,
        0,
      );
      notifyValidationPassed({ sessionCount: results.length, totalPrompts });
    } else {
      notifyValidationFailed({ failedFiles: results.filter((r) => !r.valid) });
    }

    await interaction.editReply({ embeds });
  }

  // ########################################################################### /status ###########################################################################
  else if (commandName === "status") {
    const state = loadState();
    const done = state.completedSessions ?? [];
    const sc = Math.max(
      getSetting("sessions", "count"),
      getSessionCount(),
      done.length,
    );
    const allNames = Array.from({ length: sc }, (_, i) => `Session${i + 1}`);

    const lines = allNames.map((s) => {
      const isComplete = done.includes(s);
      const completedAt = state[`${s}_completedAt`]
        ? new Date(state[`${s}_completedAt`]).toLocaleString("en-US")
        : null;
      const duration = state[`${s}_durationMs`]
        ? formatDuration(state[`${s}_durationMs`])
        : null;

      if (isComplete)
        return `✅ **${s}** — completed${completedAt ? ` at ${completedAt}` : ""}${duration ? ` (${duration})` : ""}`;

      const isCurrent = isRunning() && done.length === allNames.indexOf(s);
      return `${isCurrent ? "🔄" : "⏳"} **${s}** — ${isCurrent ? "running" : "pending"}`;
    });

    const totalMs = allNames.reduce(
      (sum, s) => sum + (state[`${s}_durationMs`] ?? 0),
      0,
    );
    const plan =
      CLAUDE_PLANS[getSetting("runner", "claudePlan")] ?? CLAUDE_PLANS.max20;

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📊 Claude Runner — Current Status")
          .setDescription(lines.join("\n"))
          .addFields(
            {
              name: "Script running",
              value: isRunning() ? "✅ Yes" : "❌ No",
              inline: true,
            },
            {
              name: "Security Fix",
              value: isSecurityFixRunning() ? "🔄 Running" : "⏸ Idle",
              inline: true,
            },
            { name: "Completed", value: `${done.length}/${sc}`, inline: true },
            {
              name: "Total duration",
              value: totalMs > 0 ? formatDuration(totalMs) : "—",
              inline: true,
            },
            {
              name: "Model",
              value: getSetting("runner", "defaultModel"),
              inline: true,
            },
            { name: "Plan", value: plan.label, inline: true },
            {
              name: "Pause",
              value: `${getSetting("runner", "pauseMinutes")} min`,
              inline: true,
            },
            {
              name: "Started at",
              value: state.startedAt
                ? new Date(state.startedAt).toLocaleString("en-US")
                : "—",
              inline: true,
            },
          )
          .setColor(done.length >= sc ? 0x57f287 : 0x5865f2)
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /start ###########################################################################
  else if (commandName === "start") {
    const doReset = interaction.options.getBoolean("reset") ?? false;
    await interaction.deferReply();

    if (isRunning()) {
      runningProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
    }

    // ########################################################################### Session size + timeout analysis ###########################################################################
    const detected = detectSessions();
    const planKey = getSetting("runner", "claudePlan");
    const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

    let analysisFields = [];
    let warningLines = [];

    if (!detected.error && detected.sessions.length > 0) {
      const calc = calculateSessionTimeouts(detected.sessions, planKey);

      const sessionLines = calc.sessions.map(
        (s) =>
          `**${s.file}**: ~${(s.outputTokens / 1000).toFixed(1)}k tokens | timeout: ${Math.round(s.recommendedTimeoutMs / 60_000)} min`,
      );

      analysisFields = [
        {
          name: "📊 Session Analysis",
          value: sessionLines.join("\n"),
          inline: false,
        },
        {
          name: "Total output tokens",
          value: `~${(calc.totalOutputTokens / 1000).toFixed(1)}k`,
          inline: true,
        },
        {
          name: "5h budget",
          value: `~${(calc.budgetTokens / 1000).toFixed(1)}k tokens`,
          inline: true,
        },
        {
          name: "Windows needed",
          value: String(calc.windowsNeeded),
          inline: true,
        },
        {
          name: "Recommended pause",
          value: `${calc.recommendedPauseMinutes} min`,
          inline: true,
        },
      ];

      for (const s of calc.sessions) {
        applyTimeoutsToSessionFile(
          s.fullPath,
          s.recommendedTimeoutMs,
          s.promptCount,
          planKey,
        );
      }

      if (!calc.fitsInOneWindow) {
        warningLines.push(
          `⚠️ Sessions exceed the 5h token budget of the **${plan.label}** plan.`,
          `Estimated **${calc.windowsNeeded} rolling windows** required.`,
          `Timeouts have been automatically written to all session override configs.`,
        );
      } else {
        warningLines.push(
          `✅ All sessions fit within one 5h window on the **${plan.label}** plan.`,
          `Override configs updated with calculated timeouts.`,
        );
      }
    }

    startRunProcess(doReset ? ["--reset"] : [], interaction.channel);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(doReset ? "🔁 Run started (Reset)" : "▶️ Run started")
          .setDescription(
            [
              doReset
                ? "Progress cleared — starting from Session 1."
                : "run-sessions.js has been started.\nAlready completed sessions will be skipped.",
              "",
              ...warningLines,
            ].join("\n"),
          )
          .addFields(
            {
              name: "Sessions detected",
              value: String(getSessionCount()),
              inline: true,
            },
            {
              name: "Model",
              value: getSetting("runner", "defaultModel"),
              inline: true,
            },
            { name: "Plan", value: plan.label, inline: true },
            ...analysisFields,
          )
          .setColor(doReset ? 0xfee75c : 0x57f287)
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /restart ###########################################################################
  else if (commandName === "restart") {
    await interaction.deferReply();

    if (isRunning()) {
      runningProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
    }

    const detected = detectSessions();
    const planKey = getSetting("runner", "claudePlan");
    const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
    let note = "";

    if (!detected.error && detected.sessions.length > 0) {
      const calc = calculateSessionTimeouts(detected.sessions, planKey);
      for (const s of calc.sessions) {
        applyTimeoutsToSessionFile(
          s.fullPath,
          s.recommendedTimeoutMs,
          s.promptCount,
          planKey,
        );
      }
      note = `\nTimeout configs refreshed (plan: **${plan.label}**, recommended pause: **${calc.recommendedPauseMinutes} min**).`;
    }

    startRunProcess([], interaction.channel);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔄 Restarted")
          .setDescription(
            `run-sessions.js restarted. Completed sessions skipped.${note}`,
          )
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /stop ###########################################################################
  else if (commandName === "stop") {
    const killed = [];

    if (isRunning()) {
      runningProcess.kill("SIGTERM");
      runningProcess = null;
      killed.push("run-sessions.js");
    }
    if (isSecurityFixRunning()) {
      securityFixProcess.kill("SIGTERM");
      securityFixProcess = null;
      killed.push("Security Fix");
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(killed.length > 0 ? "⏹️ Stopped" : "⚠️ Nothing is running")
          .setDescription(
            killed.length > 0
              ? `Stopped: ${killed.join(", ")}\nProgress is preserved — use \`/restart\` to continue.`
              : "No running process found.",
          )
          .setColor(killed.length > 0 ? 0xed4245 : 0xfee75c)
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /reset ###########################################################################
  else if (commandName === "reset") {
    const confirm = interaction.options.getString("confirm");
    if (confirm?.toLowerCase() !== "yes") {
      await interaction.reply({
        content: "❌ Aborted. Type `/reset confirm:yes`.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    if (isRunning()) {
      runningProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
    }

    saveState({ completedSessions: [] });
    startRunProcess(["--reset"], interaction.channel);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔁 Full Reset")
          .setDescription("Progress cleared — starting from Session 1.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /logs ###########################################################################
  else if (commandName === "logs") {
    const n = interaction.options.getInteger("lines") ?? 20;
    const logFile = getLatestLogFile();

    if (!logFile) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📋 Logs")
            .setDescription(`No log files found in:\n\`${LOG_DIR}\``)
            .setColor(0xfee75c),
        ],
      });
      return;
    }

    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    const slice = lines.slice(-n);
    const content = slice.join("\n");
    const truncated =
      content.length > 3800
        ? "...(truncated)\n" + content.slice(-3800)
        : content;

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`📋 Last ${slice.length} log lines`)
          .setDescription(`\`${logFile}\`\n\`\`\`\n${truncated}\n\`\`\``)
          .setColor(0x5865f2)
          .setTimestamp(),
      ],
    });
  }

  // ── /rate-limit ───────────────────────────────────────────────────────────
  else if (commandName === "rate-limit") {
    await interaction.deferReply();

    const data = queryRateLimit();
    const planKey = getSetting("runner", "claudePlan");
    const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

    if (data) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📊 Rate-Limit Status")
            .addFields(
              {
                name: "5h window used",
                value: data.usage_5h ? `${data.usage_5h}%` : "N/A",
                inline: true,
              },
              {
                name: "Weekly used",
                value: data.usage_week ? `${data.usage_week}%` : "N/A",
                inline: true,
              },
              {
                name: "Resets in",
                value: data.reset_in ?? "N/A",
                inline: true,
              },
            )
            .setColor(0x5865f2)
            .setTimestamp(),
        ],
      });
    } else {
      const state = loadState();
      const done = state.completedSessions ?? [];
      const totalMs = done.reduce(
        (s, n) => s + (state[`${n}_durationMs`] ?? 0),
        0,
      );
      const pct = Math.min(100, Math.round((totalMs / (5 * 3_600_000)) * 100));

      const detected = detectSessions();
      let tokenFields = [];
      if (!detected.error && detected.sessions.length > 0) {
        const calc = calculateSessionTimeouts(detected.sessions, planKey);
        const pctTokens = Math.min(
          100,
          Math.round((calc.totalOutputTokens / calc.budgetTokens) * 100),
        );
        tokenFields = [
          {
            name: "Estimated token usage",
            value: `~${pctTokens}% of 5h budget`,
            inline: true,
          },
          {
            name: "Total tokens needed",
            value: `~${(calc.totalOutputTokens / 1000).toFixed(1)}k`,
            inline: true,
          },
          {
            name: "Windows needed",
            value: String(calc.windowsNeeded),
            inline: true,
          },
        ];
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📊 Rate-Limit — Estimate")
            .setDescription(
              "The Claude CLI does not return direct rate-limit data.\n" +
                "Estimates are based on session file sizes and plan limits.",
            )
            .addFields(
              {
                name: "Runtime-based 5h estimate",
                value: `~${pct}%`,
                inline: true,
              },
              {
                name: "Sessions completed",
                value: `${done.length}/${getSetting("sessions", "count")}`,
                inline: true,
              },
              {
                name: "Total runtime",
                value: formatDuration(totalMs),
                inline: true,
              },
              { name: "Plan", value: plan.label, inline: true },
              {
                name: "5h output budget",
                value: `~${(plan.outputTokensPer5h / 1000).toFixed(0)}k tokens`,
                inline: true,
              },
              {
                name: "Prompts per 5h",
                value: `~${plan.promptsPer5h}`,
                inline: true,
              },
              ...tokenFields,
            )
            .setColor(pct > 80 ? 0xed4245 : pct > 50 ? 0xfee75c : 0x57f287)
            .setFooter({
              text: "Tip: Max 20× plan ≈ 220k output tokens per 5h window",
            })
            .setTimestamp(),
        ],
      });
    }
  }

  // ########################################################################### /security-status ###########################################################################
  else if (commandName === "security-status") {
    const reports = loadSecurityReports();

    if (reports.length === 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔒 Security Status")
            .setDescription(`No reports found in:\n\`${SECURITY_DIR}\``)
            .setColor(0x57f287)
            .setTimestamp(),
        ],
      });
      return;
    }

    let totalC = 0,
      totalW = 0,
      totalI = 0;
    const lines = reports.map((r) => {
      const c = countFindings(r.content, "🔴 CRITICAL");
      const w = countFindings(r.content, "🟡 WARNING");
      const i = countFindings(r.content, "🔵 INFO");
      const f = countFindings(r.content, "✅ FIXED");
      totalC += c;
      totalW += w;
      totalI += i;
      return `**${r.name}** — 🔴 ${c} | 🟡 ${w} | 🔵 ${i} | ✅ ${f} fixed`;
    });

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔒 Security Status")
          .setDescription(lines.join("\n"))
          .addFields(
            { name: "🔴 Critical", value: String(totalC), inline: true },
            { name: "🟡 Warnings", value: String(totalW), inline: true },
            { name: "🔵 Info", value: String(totalI), inline: true },
          )
          .setColor(totalC > 0 ? 0xed4245 : totalW > 0 ? 0xfee75c : 0x57f287)
          .setFooter({ text: "Use /start-resolve-security to fix violations" })
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /start-resolve-security ###########################################################################
  else if (commandName === "start-resolve-security") {
    if (isSecurityFixRunning()) {
      await interaction.reply({
        content: "⚠️ Security Fix is already running.",
        ephemeral: true,
      });
      return;
    }

    const reports = loadSecurityReports();
    if (reports.length === 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ No security reports found")
            .setDescription("Nothing to fix.")
            .setColor(0x57f287)
            .setTimestamp(),
        ],
      });
      return;
    }

    const totalC = reports.reduce(
      (s, r) => s + countFindings(r.content, "🔴 CRITICAL"),
      0,
    );
    const totalW = reports.reduce(
      (s, r) => s + countFindings(r.content, "🟡 WARNING"),
      0,
    );

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔧 Security Fix started")
          .setDescription(
            "Claude is now fixing all security violations.\nOrder: 🔴 → 🟡 → 🔵",
          )
          .addFields(
            { name: "Reports", value: String(reports.length), inline: true },
            { name: "🔴 Critical", value: String(totalC), inline: true },
            { name: "🟡 Warnings", value: String(totalW), inline: true },
          )
          .setColor(0xeb459e)
          .setFooter({ text: "You will be notified when done" })
          .setTimestamp(),
      ],
    });

    startSecurityFix(interaction.channel);
  }

  // ########################################################################### /detect-sessions ###########################################################################
  else if (commandName === "detect-sessions") {
    await interaction.deferReply();

    const result = detectSessions();

    if (result.error) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Detect Sessions failed")
            .setDescription(result.error)
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
      return;
    }

    const { sessions } = result;
    const planKey = getSetting("runner", "claudePlan");
    const calc = calculateSessionTimeouts(sessions, planKey);
    const plan = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;

    const grandTotal = sessions.reduce((s, x) => s + x.totalChars, 0);
    const totalPrompts = sessions.reduce((s, x) => s + x.promptCount, 0);
    const embeds = [];

    embeds.push(
      new EmbedBuilder()
        .setTitle("🔍 Session Analysis")
        .setDescription(
          `**Directory:** \`${SESSION_DIR}\`\n` +
            `**Sessions found:** ${sessions.length}\n` +
            `**Total prompts:** ${totalPrompts}\n` +
            `**Total characters:** ${grandTotal.toLocaleString("en-US")}\n\n` +
            `**Plan:** ${plan.label}\n` +
            `**Total estimated output tokens:** ~${(calc.totalOutputTokens / 1000).toFixed(1)}k\n` +
            `**5h budget (${SAFETY_MARGIN * 100}% safety):** ~${(calc.budgetTokens / 1000).toFixed(1)}k tokens\n` +
            `**Windows needed:** ${calc.windowsNeeded}\n` +
            `**Recommended pause:** ${calc.recommendedPauseMinutes} min`,
        )
        .setColor(calc.fitsInOneWindow ? 0x57f287 : 0xfee75c)
        .setTimestamp(),
    );

    for (const s of calc.sessions) {
      const promptLines =
        s.prompts?.map((p, i) => {
          const kChars = (p.chars / 1000).toFixed(1);
          const title =
            p.title.length > 60 ? p.title.slice(0, 57) + "..." : p.title;
          return `**[${i + 1}]** ${title}\n> ${p.chars.toLocaleString("en-US")} chars (~${kChars}k)`;
        }) ?? [];

      const desc =
        promptLines.length > 0
          ? promptLines.join("\n\n")
          : "⚠️ No prompts detected — check the `## Prompt X —` format";
      const truncated =
        desc.length > 3800 ? desc.slice(0, 3800) + "\n...(truncated)" : desc;

      embeds.push(
        new EmbedBuilder()
          .setTitle(`📄 ${s.file}`)
          .setDescription(truncated)
          .addFields(
            {
              name: "Total chars",
              value: s.totalChars.toLocaleString("en-US"),
              inline: true,
            },
            { name: "Prompts", value: String(s.promptCount), inline: true },
            {
              name: "Avg per prompt",
              value:
                s.promptCount > 0
                  ? Math.round(s.totalChars / s.promptCount).toLocaleString(
                      "en-US",
                    ) + " chars"
                  : "—",
              inline: true,
            },
            {
              name: "Est. output tok.",
              value: `~${(s.outputTokens / 1000).toFixed(1)}k`,
              inline: true,
            },
            {
              name: "Rec. timeout",
              value: `${Math.round(s.recommendedTimeoutMs / 60_000)} min`,
              inline: true,
            },
          )
          .setColor(0x5865f2),
      );

      if (embeds.length >= 10) break;
    }

    await interaction.editReply({ embeds });
  }

  // ########################################################################### /new-session ###########################################################################
  else if (commandName === "new-session") {
    const nummer = interaction.options.getInteger("number");
    const withOverride = interaction.options.getBoolean("override") ?? false;
    const filePath = join(SESSION_DIR, `Session${nummer}.md`);

    ensureDir(SESSION_DIR);

    if (existsSync(filePath)) {
      await interaction.reply({
        content: `⚠️ \`Session${nummer}.md\` already exists. Delete it manually or choose a different number.`,
        ephemeral: true,
      });
      return;
    }

    writeFileSync(filePath, buildSessionTemplate(nummer, withOverride));

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`📝 Session${nummer}.md created`)
          .setDescription(
            `Template written to:\n\`${filePath}\`\n\n` +
              `Fill in the \`{Description}\` and \`{Your prompt here}\` placeholders.`,
          )
          .addFields({
            name: "Override config",
            value: withOverride ? "✅ Embedded" : "❌ Not embedded",
            inline: true,
          })
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
  }

  // ########################################################################### /settings ###########################################################################
  else if (commandName === "settings") {
    const sub = interaction.options.getSubcommand();

    if (sub === "show") {
      const s = loadSettings();
      const fmt = (obj, prefix = "") =>
        Object.entries(obj).flatMap(([k, v]) =>
          typeof v === "object" && v !== null && !Array.isArray(v)
            ? fmt(v, `${prefix}${k}.`)
            : [`\`${prefix}${k}\` = **${JSON.stringify(v)}**`],
        );

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚙️ Current Settings")
            .setDescription(fmt(s).join("\n"))
            .setColor(0x5865f2)
            .setFooter({ text: `File: ${SETTINGS_FILE}` })
            .setTimestamp(),
        ],
      });
    } else if (sub === "set") {
      const key = interaction.options.getString("key");
      const value = interaction.options.getString("value");
      const s = loadSettings();
      const keys = key.split(".");

      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }

      let obj = s;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof obj[keys[i]] !== "object") {
          await interaction.reply({
            content: `❌ Key \`${keys[i]}\` not found.`,
            ephemeral: true,
          });
          return;
        }
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = parsed;
      saveSettings(s);

      if (
        key === "bot.webhookUrl" &&
        typeof parsed === "string" &&
        parsed.startsWith("http")
      ) {
        const { notifyEmbed } = await import("./discord-notify.js");
        notifyEmbed({
          title: "✅ Webhook connected",
          description:
            "This channel will now receive Claude Runner notifications.",
          color: "success",
        });
      }

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Setting updated")
            .addFields(
              { name: "Key", value: `\`${key}\``, inline: true },
              {
                name: "New value",
                value: `\`${JSON.stringify(parsed)}\``,
                inline: true,
              },
            )
            .setColor(0x57f287)
            .setTimestamp(),
        ],
      });
    } else if (sub === "reset") {
      saveSettings(DEFAULT_SETTINGS);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔁 Settings reset")
            .setDescription("All values restored to defaults.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
    }
  }

  // ########################################################################### /archive ###########################################################################
  else if (commandName === "archive") {
    const sub = interaction.options.getSubcommand();

    if (sub === "now") {
      await interaction.deferReply();
      try {
        const ap = archiveCompletedRun();
        pruneArchives(5);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("📦 Archived")
              .setDescription(`Files moved to:\n\`${ap}\``)
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
      } catch (err) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("❌ Archive failed")
              .setDescription(`\`${err.message}\``)
              .setColor(0xed4245)
              .setTimestamp(),
          ],
        });
      }
    } else if (sub === "list") {
      ensureDir(ARCHIVE_DIR);
      const runs = readdirSync(ARCHIVE_DIR)
        .filter((f) => f.startsWith("run-"))
        .map((f) => ({
          name: f,
          mtime: statSync(join(ARCHIVE_DIR, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (runs.length === 0) {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle("📦 Archives")
              .setDescription(`No archives found in:\n\`${ARCHIVE_DIR}\``)
              .setColor(0xfee75c),
          ],
        });
        return;
      }

      const lines = runs.map(
        (r) =>
          `📁 **${r.name}**\n> ${new Date(r.mtime).toLocaleString("en-US")}`,
      );

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`📦 Archives (${runs.length} runs)`)
            .setDescription(lines.slice(0, 15).join("\n\n"))
            .setColor(0x5865f2)
            .setTimestamp(),
        ],
      });
    } else if (sub === "prune") {
      const keep = interaction.options.getInteger("keep") ?? 5;
      pruneArchives(keep);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🗑️ Archives pruned")
            .setDescription(`Keeping the last **${keep}** archives.`)
            .setColor(0x57f287)
            .setTimestamp(),
        ],
      });
    }
  }

  // ###########################################################################─ /help ###########################################################################
  else if (commandName === "help") {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🤖 Claude Runner Bot — All Commands")
          .setFields([
            {
              name: "🚀 Setup",
              value: [
                "`/setup [plan] [override]` — Create directories, CLAUDE.md and Session1.md template. Specify your Claude plan to enable timeout calculation.",
                "`/new-session [number] [override]` — Create a new session file from template",
              ].join("\n"),
              inline: false,
            },
            {
              name: "📊 Monitoring",
              value: [
                "`/status` — Sessions with status, duration, model and progress",
                "`/logs [lines]` — Last lines of the current log file (default: 20)",
                "`/rate-limit` — Estimated 5h and weekly token usage",
                "`/detect-sessions` — Analyze all session files with prompt details and timeout recommendations",
              ].join("\n"),
              inline: false,
            },
            {
              name: "▶️ Control",
              value: [
                "`/start [reset]` — Start run-sessions.js (optionally with full reset)",
                "`/restart` — Restart without losing progress, recalculates timeouts",
                "`/stop` — Stop script and/or Security Fix immediately",
                "`/reset confirm:yes` — Clear all progress completely",
              ].join("\n"),
              inline: false,
            },
            {
              name: "🔒 Security",
              value: [
                "`/security-status` — All findings from security reports (🔴/🟡/🔵/✅)",
                "`/start-resolve-security` — Claude fixes all violations (🔴 → 🟡 → 🔵)",
              ].join("\n"),
              inline: false,
            },
            {
              name: "📦 Archive",
              value: [
                "`/archive now` — Archive the current run immediately",
                "`/archive list` — List all archived runs",
                "`/archive prune [keep]` — Delete old archives",
              ].join("\n"),
              inline: false,
            },
            {
              name: "⚙️ Settings",
              value: [
                "`/settings show` — View all settings",
                "`/settings set [key] [value]` — Change a setting (e.g. `runner.pauseMinutes` = `120`)",
                "`/settings reset` — Restore all defaults",
              ].join("\n"),
              inline: false,
            },
            {
              name: "ℹ️ Notes",
              value: [
                "• Security Fix starts **automatically** after all sessions (if `runner.autoSecurityFix = true`)",
                "• Archiving happens **automatically** after completion (if `runner.archiveOnComplete = true`)",
                "• Session timeouts are **auto-calculated** based on file size and your Claude plan",
                "• Plans: **Pro** ~44k tok/5h | **Max 5×** ~88k tok/5h | **Max 20×** ~220k tok/5h",
                "• Set your plan via `/setup plan:max20` or `/settings set runner.claudePlan max20`",
              ].join("\n"),
              inline: false,
            },
          ])
          .setColor(0x5865f2)
          .setFooter({ text: "Claude Runner Bot" })
          .setTimestamp(),
      ],
    });
  }
});

// ########################################################################### Bootstrap ###########################################################################

if (!BOT_TOKEN || !CLIENT_ID || !CHANNEL_ID) {
  console.error(
    "[Bot] Missing configuration!\n" +
      "Set environment variables (DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CHANNEL_ID)\n" +
      "or fill in bot.token / bot.clientId / bot.channelId in settings.json",
  );
  process.exit(1);
}

client.login(BOT_TOKEN);
