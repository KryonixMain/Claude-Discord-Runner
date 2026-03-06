import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";

import { isRunning, isPaused, setPaused, isSecurityFixRunning,
         getRunningProcess, setRunningProcess, getScheduledTimer } from "../bot/state.js";
import { startRunProcess, startSecurityFix } from "../bot/process.js";
import { loadState, formatDuration, sessionKey, getLatestLogFile,
         loadSecurityReports, countFindings, getSessionCount,
         killProcessGracefully, queryRateLimit, getWorkDir } from "../bot/lib/helpers.js";
import { detectSessions } from "../bot/lib/session-parser.js";
import { calculateSessionTimeouts } from "../bot/lib/calculator.js";
import { getSetting, loadSettings, saveSettings } from "../bot/lib/settings.js";
import { CLAUDE_PLANS } from "../bot/lib/plans.js";
import { PROJECT_DIR, ARCHIVE_DIR, SESSION_DIR, LOG_DIR } from "../bot/lib/paths.js";
import { readAuditLog } from "../bot/lib/audit-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Timeout constants (must match run-sessions.js) ──────────────────────────
const DEFAULT_TIMEOUT_MS     = 2 * 60 * 60 * 1000;
const LIGHTWEIGHT_TIMEOUT_MS = 45 * 60 * 1000;
const BUFFER_MS              = 10 * 60 * 1000;
const LIGHTWEIGHT_KEYWORDS   = ["roadmap update", "section update", "module update"];

function parseOverrideBlock(content) {
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
    } catch { /* ignore */ }
  }
  return merged;
}

function resolvePromptTimeout(label, num, override) {
  const isLight = LIGHTWEIGHT_KEYWORDS.some((kw) => label.toLowerCase().includes(kw));
  const base = isLight ? LIGHTWEIGHT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  return override?.prompts?.[String(num)]?.timeoutMs
    ?? override?.session?.timeoutMs
    ?? base;
}

export function createDashboardServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, "public")));

  // ── GET /api/status ──────────────────────────────────────────────────────
  app.get("/api/status", (_req, res) => {
    const state    = loadState();
    const detected = detectSessions();
    const running  = isRunning();
    const fixing   = isSecurityFixRunning();
    const paused   = isPaused();

    if (detected.error) {
      return res.json({ running, fixing, paused, error: detected.error, sessions: [], completedCount: 0, totalCount: 0, statusLine: "No sessions" });
    }

    const rows = detected.sessions.map((s) => {
      const key         = sessionKey(s.file);
      const done        = state.completedSessions?.includes(key);
      const details     = state.sessionDetails?.[key];
      const completedAt = details?.completedAt ?? state[`${key}_completedAt`] ?? null;
      const durationMs  = details?.durationMs ?? state[`${key}_durationMs`] ?? null;
      return {
        file: s.file,
        promptCount: s.promptCount,
        done,
        completedAt,
        duration: durationMs ? formatDuration(durationMs) : null,
        durationMs,
        tokenUsage: details?.tokenUsage ?? null,
        success: details?.success ?? null,
      };
    });

    const completedCount = state.completedSessions?.length ?? 0;
    const totalCount     = detected.sessions.length;

    const statusLine = fixing
      ? "Security Fix running"
      : running
        ? paused
          ? `Paused — ${completedCount}/${totalCount} done`
          : `Running — ${completedCount}/${totalCount} done`
        : completedCount >= totalCount && totalCount > 0
          ? "Completed"
          : completedCount > 0
            ? `Stopped — ${completedCount}/${totalCount} done`
            : "Idle";

    res.json({
      running, fixing, paused,
      sessions: rows,
      completedCount, totalCount,
      statusLine,
      model: getSetting("runner", "defaultModel"),
      plan: CLAUDE_PLANS[getSetting("runner", "claudePlan")]?.label ?? "Unknown",
      scheduledRun: getScheduledTimer() !== null,
      startedAt: state.startedAt ?? null,
    });
  });

  // ── GET /api/logs ────────────────────────────────────────────────────────
  app.get("/api/logs", (req, res) => {
    const lineCount = Math.min(parseInt(req.query.lines) || 50, 200);
    const logFile   = getLatestLogFile();

    if (!logFile || !existsSync(logFile)) {
      return res.json({ lines: [], file: null });
    }

    const allLines = readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const tail = allLines.slice(-lineCount);

    res.json({ lines: tail, file: logFile, totalLines: allLines.length });
  });

  // ── GET /api/sessions ────────────────────────────────────────────────────
  app.get("/api/sessions", (_req, res) => {
    const detected = detectSessions();
    if (detected.error) return res.json({ error: detected.error, sessions: [] });

    const planKey = getSetting("runner", "claudePlan");
    const calc    = calculateSessionTimeouts(detected.sessions, planKey);

    res.json({
      sessions: calc.sessions.map((s) => ({
        file: s.file,
        promptCount: s.promptCount,
        totalChars: s.totalChars,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        recommendedTimeoutMs: s.recommendedTimeoutMs,
      })),
      totalOutputTokens: calc.totalOutputTokens,
      budgetTokens: calc.budgetTokens,
      fitsInOneWindow: calc.fitsInOneWindow,
      windowsNeeded: calc.windowsNeeded,
      recommendedPauseMinutes: calc.recommendedPauseMinutes,
    });
  });

  // ── GET /api/settings ────────────────────────────────────────────────────
  app.get("/api/settings", (_req, res) => {
    const settings = loadSettings();
    const safe = JSON.parse(JSON.stringify(settings));
    if (safe.bot?.token) safe.bot.token = "***";
    if (safe.bot?.webhookUrl) safe.bot.webhookUrl = safe.bot.webhookUrl ? "***" : "";
    if (safe.bot?.webhookUrls) {
      for (const k of Object.keys(safe.bot.webhookUrls)) {
        if (safe.bot.webhookUrls[k]) safe.bot.webhookUrls[k] = "***";
      }
    }
    res.json(safe);
  });

  // ── GET /api/security ────────────────────────────────────────────────────
  app.get("/api/security", (_req, res) => {
    const reports = loadSecurityReports();
    let totalC = 0, totalW = 0, totalI = 0;

    const items = reports.map((r) => {
      const c = countFindings(r.content, "CRITICAL");
      const w = countFindings(r.content, "WARNING");
      const i = countFindings(r.content, "INFO");
      totalC += c; totalW += w; totalI += i;
      return { name: r.name, critical: c, warning: w, info: i };
    });

    res.json({ reports: items, totalCritical: totalC, totalWarning: totalW, totalInfo: totalI });
  });

  // ── GET /api/rate-limit ──────────────────────────────────────────────────
  app.get("/api/rate-limit", (_req, res) => {
    const planKey = getSetting("runner", "claudePlan");
    const plan    = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
    const detected = detectSessions();

    let calc = null;
    if (!detected.error && detected.sessions?.length > 0) {
      calc = calculateSessionTimeouts(detected.sessions, planKey);
    }

    const apiStatus = queryRateLimit();

    res.json({
      plan: { key: planKey, label: plan.label, outputTokensPer5h: plan.outputTokensPer5h },
      calc: calc ? {
        totalOutputTokens: calc.totalOutputTokens,
        budgetTokens: calc.budgetTokens,
        fitsInOneWindow: calc.fitsInOneWindow,
        windowsNeeded: calc.windowsNeeded,
        recommendedPauseMinutes: calc.recommendedPauseMinutes,
      } : null,
      apiStatus,
    });
  });

  // ── GET /api/git-changes ─────────────────────────────────────────────────
  app.get("/api/git-changes", (_req, res) => {
    try {
      const workDir = getWorkDir();
      const result = spawnSync("git", ["diff", "--name-only"], {
        cwd: workDir, encoding: "utf8", timeout: 5000,
      });
      if (result.status !== 0) return res.json({ files: [], error: "git not available" });
      const files = result.stdout.trim().split("\n").filter(Boolean);
      res.json({ files });
    } catch {
      res.json({ files: [], error: "git not available" });
    }
  });

  // ── GET /api/audit ──────────────────────────────────────────────────────
  app.get("/api/audit", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const entries = readAuditLog(limit);
    res.json({ entries });
  });

  // ── GET /api/archives ─────────────────────────────────────────────────
  app.get("/api/archives", (_req, res) => {
    if (!existsSync(ARCHIVE_DIR)) return res.json({ archives: [] });
    try {
      const archives = readdirSync(ARCHIVE_DIR)
        .filter((f) => f.startsWith("run-") && statSync(join(ARCHIVE_DIR, f)).isDirectory())
        .sort()
        .reverse()
        .map((name) => {
          const archivePath = join(ARCHIVE_DIR, name);
          const manifestPath = join(archivePath, "manifest.json");
          let manifest = null;
          if (existsSync(manifestPath)) {
            try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (err) { console.warn("[dashboard] Bad manifest:", name, err.message); }
          }
          return { name, path: archivePath, manifest };
        });
      res.json({ archives });
    } catch {
      res.json({ archives: [], error: "Failed to list archives" });
    }
  });

  // ── GET /api/timeouts ─────────────────────────────────────────────────
  app.get("/api/timeouts", (_req, res) => {
    if (!existsSync(SESSION_DIR)) return res.json({ sessions: [], error: "No session directory" });

    const files = readdirSync(SESSION_DIR)
      .filter((f) => /^Session\d+\.md$/i.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

    const state = loadState();
    const sessions = [];

    for (const file of files) {
      const num     = parseInt(file.match(/\d+/)[0]);
      const content = readFileSync(join(SESSION_DIR, file), "utf8");
      const override = parseOverrideBlock(content);

      const stripped = content
        .replace(/<!--\r?\nSESSION OVERRIDE CONFIG[\s\S]*?-->\r?\n?\r?\n?/g, "")
        .replace(/^```json\s*\n[\s\S]*?\n```\s*\n?/, "");

      const matches = [...stripped.matchAll(/^##\s+Prompt\s+(\d+)\s*[—–:\-]/gim)];

      const prompts = [];
      if (matches.length === 0) {
        const timeoutMs = resolvePromptTimeout("Main Prompt", 1, override);
        prompts.push({ number: 1, label: "Main Prompt", timeoutMs, source: override?.session?.timeoutMs ? "session" : "default" });
      } else {
        for (const m of matches) {
          const pNum   = parseInt(m[1]);
          const pLabel = m[0].replace(/^##\s+/, "").trim();
          const timeoutMs = resolvePromptTimeout(pLabel, pNum, override);
          const source = override?.prompts?.[String(pNum)]?.timeoutMs ? "prompt" : override?.session?.timeoutMs ? "session" : "default";
          prompts.push({ number: pNum, label: pLabel, timeoutMs, source });
        }
      }

      const totalTimeoutMs = prompts.reduce((s, p) => s + p.timeoutMs, 0) + BUFFER_MS;
      const pauseAfterMs   = override?.session?.pauseAfterMs ?? getSetting("runner", "pauseMinutes") * 60_000;
      const name = file.replace(".md", "");
      const isDone = state.completedSessions?.includes(name);

      sessions.push({
        file, num, name, isDone,
        prompts,
        totalTimeoutMs,
        pauseAfterMs,
        hasTimeoutOverride: !!override?.session?.timeoutMs,
        hasPauseOverride: !!override?.session?.pauseAfterMs,
        skipSecurityFix: override?.session?.skipSecurityFix === true,
        override: override?.session ?? {},
      });
    }

    const totalTimeout = sessions.reduce((s, x) => s + x.totalTimeoutMs, 0);
    const totalPause   = sessions.reduce((s, x) => s + x.pauseAfterMs, 0);

    res.json({ sessions, totalTimeoutMs: totalTimeout, totalPauseMs: totalPause, totalRuntimeMs: totalTimeout + totalPause });
  });

  // ── POST /api/timeout/:session ─────────────────────────────────────────
  // Body: { timeoutMinutes?, pauseMinutes?, promptTimeouts?: { [promptNum]: minutes } }
  app.post("/api/timeout/:session", (req, res) => {
    const num = parseInt(req.params.session);
    if (isNaN(num)) return res.status(400).json({ ok: false, message: "Invalid session number" });

    const filePath = join(SESSION_DIR, `Session${num}.md`);
    if (!existsSync(filePath)) return res.status(404).json({ ok: false, message: `Session${num}.md not found` });

    const { timeoutMinutes, pauseMinutes, promptTimeouts } = req.body;
    if (timeoutMinutes == null && pauseMinutes == null && !promptTimeouts) {
      return res.status(400).json({ ok: false, message: "Provide timeoutMinutes, pauseMinutes, and/or promptTimeouts" });
    }

    let content = readFileSync(filePath, "utf8");
    let config = { session: {}, prompts: {} };
    for (const m of content.matchAll(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n([\s\S]*?)-->/g)) {
      try {
        const parsed = JSON.parse(m[1]);
        config.session = { ...config.session, ...parsed.session };
        if (parsed.prompts) {
          for (const [k, v] of Object.entries(parsed.prompts)) {
            config.prompts[k] = { ...config.prompts[k], ...v };
          }
        }
      } catch { /* ignore */ }
    }

    if (timeoutMinutes != null) config.session.timeoutMs = Math.round(timeoutMinutes * 60_000);
    if (pauseMinutes != null) config.session.pauseAfterMs = Math.round(pauseMinutes * 60_000);

    // Per-prompt timeout overrides
    if (promptTimeouts && typeof promptTimeouts === "object") {
      for (const [pNum, mins] of Object.entries(promptTimeouts)) {
        const m = parseInt(mins);
        if (isNaN(m) || m <= 0) continue;
        if (!config.prompts[pNum]) config.prompts[pNum] = {};
        config.prompts[pNum].timeoutMs = m * 60_000;
      }
    }

    const block = `<!--\nSESSION OVERRIDE CONFIG\n${JSON.stringify(config, null, 2)}\n-->`;
    const cleaned = content.replace(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n[\s\S]*?\r?\n-->\r?\n?\r?\n?/g, "");
    content = block + "\n\n" + cleaned;
    writeFileSync(filePath, content);

    res.json({ ok: true, message: `Session${num} updated`, config });
  });

  // ── POST /api/pause-config ──────────────────────────────────────────
  // Body: { minutes: number } — sets global runner.pauseMinutes
  app.post("/api/pause-config", (req, res) => {
    const { minutes } = req.body;
    if (minutes == null || isNaN(minutes)) {
      return res.status(400).json({ ok: false, message: "Provide minutes" });
    }

    const settings = loadSettings();
    if (!settings.runner) settings.runner = {};
    settings.runner.pauseMinutes = Math.round(minutes);
    saveSettings(settings);

    res.json({ ok: true, message: `Global pause set to ${minutes} min`, pauseMinutes: settings.runner.pauseMinutes });
  });

  // ── POST /api/security-toggle/:session ───────────────────────────────
  // Body: { enabled: boolean }
  app.post("/api/security-toggle/:session", (req, res) => {
    const num = parseInt(req.params.session);
    if (isNaN(num)) return res.status(400).json({ ok: false, message: "Invalid session number" });

    const filePath = join(SESSION_DIR, `Session${num}.md`);
    if (!existsSync(filePath)) return res.status(404).json({ ok: false, message: `Session${num}.md not found` });

    const { enabled } = req.body;
    if (enabled == null) return res.status(400).json({ ok: false, message: "Provide enabled (boolean)" });

    let content = readFileSync(filePath, "utf8");
    let config = { session: {}, prompts: {} };
    for (const m of content.matchAll(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n([\s\S]*?)-->/g)) {
      try {
        const parsed = JSON.parse(m[1]);
        config.session = { ...config.session, ...parsed.session };
        if (parsed.prompts) {
          for (const [k, v] of Object.entries(parsed.prompts)) {
            config.prompts[k] = { ...config.prompts[k], ...v };
          }
        }
      } catch { /* ignore */ }
    }

    if (enabled) {
      delete config.session.skipSecurityFix;
    } else {
      config.session.skipSecurityFix = true;
    }

    const block = `<!--\nSESSION OVERRIDE CONFIG\n${JSON.stringify(config, null, 2)}\n-->`;
    const cleaned2 = content.replace(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n[\s\S]*?\r?\n-->\r?\n?\r?\n?/g, "");
    content = block + "\n\n" + cleaned2;
    writeFileSync(filePath, content);

    res.json({ ok: true, message: `Security fix ${enabled ? "enabled" : "disabled"} for Session${num}` });
  });

  // ── GET /api/live-output ────────────────────────────────────────────
  app.get("/api/live-output", (req, res) => {
    const lineCount = Math.min(parseInt(req.query.lines) || 100, 500);

    // Read live session status
    const statusFile = join(LOG_DIR, ".live-session.json");
    let session = null;
    if (existsSync(statusFile)) {
      try { session = JSON.parse(readFileSync(statusFile, "utf8")); } catch { /* ignore */ }
    }

    // Read live output (tail N lines)
    const outputFile = join(LOG_DIR, ".live-output.txt");
    let lines = [];
    let totalLines = 0;
    if (existsSync(outputFile)) {
      try {
        const content = readFileSync(outputFile, "utf8");
        const allLines = content.split("\n");
        totalLines = allLines.length;
        lines = allLines.slice(-lineCount);
      } catch { /* ignore */ }
    }

    res.json({ session, lines, totalLines });
  });

  // ── GET /api/generated-prompts ──────────────────────────────────────
  app.get("/api/generated-prompts", (_req, res) => {
    const promptsDir = join(LOG_DIR, "generated-prompts");
    if (!existsSync(promptsDir)) return res.json({ prompts: [], enabled: getSetting("runner", "saveGeneratedPrompts") });

    try {
      const files = readdirSync(promptsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();

      const prompts = files.map((f) => {
        const filePath = join(promptsDir, f);
        const stat = statSync(filePath);
        return { name: f, size: stat.size, createdAt: stat.mtime.toISOString() };
      });

      res.json({ prompts, enabled: getSetting("runner", "saveGeneratedPrompts") });
    } catch {
      res.json({ prompts: [], error: "Failed to list generated prompts" });
    }
  });

  // ── GET /api/generated-prompts/:name ──────────────────────────────
  app.get("/api/generated-prompts/:name", (req, res) => {
    const name = req.params.name;
    if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
      return res.status(400).json({ error: "Invalid name" });
    }

    const filePath = join(LOG_DIR, "generated-prompts", name);
    if (!existsSync(filePath)) return res.status(404).json({ error: "Not found" });

    try {
      const content = readFileSync(filePath, "utf8");
      res.json({ name, content, size: content.length });
    } catch {
      res.status(500).json({ error: "Failed to read file" });
    }
  });

  // ── POST /api/generated-prompts/toggle ────────────────────────────
  app.post("/api/generated-prompts/toggle", (req, res) => {
    const { enabled } = req.body;
    if (enabled == null) return res.status(400).json({ ok: false, message: "Provide enabled (boolean)" });

    const settings = loadSettings();
    if (!settings.runner) settings.runner = {};
    settings.runner.saveGeneratedPrompts = !!enabled;
    saveSettings(settings);

    res.json({ ok: true, enabled: !!enabled });
  });

  // ── GET /api/analytics ────────────────────────────────────────────────
  app.get("/api/analytics", (_req, res) => {
    const archives = loadArchiveManifests();
    const state    = loadState();

    // Current run stats
    const currentRun = {
      startedAt: state.startedAt ?? null,
      completedSessions: state.completedSessions?.length ?? 0,
      sessionDetails: state.sessionDetails ?? {},
    };

    // Aggregate stats from all archives
    let totalRuns      = archives.length;
    let totalSessions  = 0;
    let totalSuccesses = 0;
    let totalFailures  = 0;
    let totalDurationMs = 0;
    let totalInputTokens  = 0;
    let totalOutputTokens = 0;
    const runHistory = [];

    for (const arc of archives) {
      const m = arc.manifest;
      if (!m) continue;

      const sessions = m.sessions ?? {};
      const sessionEntries = Object.entries(sessions);
      const successes = sessionEntries.filter(([, v]) => v.success).length;
      const failures  = sessionEntries.filter(([, v]) => !v.success).length;
      const durationMs = sessionEntries.reduce((s, [, v]) => s + (v.durationMs ?? 0), 0);
      const input  = sessionEntries.reduce((s, [, v]) => s + (v.tokenUsage?.inputTokens ?? 0), 0);
      const output = sessionEntries.reduce((s, [, v]) => s + (v.tokenUsage?.outputTokens ?? 0), 0);

      totalSessions  += sessionEntries.length;
      totalSuccesses += successes;
      totalFailures  += failures;
      totalDurationMs += durationMs;
      totalInputTokens += input;
      totalOutputTokens += output;

      runHistory.push({
        runId: m.runId,
        startedAt: m.startedAt,
        finishedAt: m.finishedAt,
        status: m.status,
        sessions: sessionEntries.length,
        successes,
        failures,
        durationMs,
        inputTokens: input,
        outputTokens: output,
        model: m.settings?.model ?? "unknown",
        plan: m.settings?.plan ?? "unknown",
      });
    }

    // Add current run details if any
    if (Object.keys(currentRun.sessionDetails).length > 0) {
      const entries = Object.entries(currentRun.sessionDetails);
      const curSuccesses = entries.filter(([, v]) => v.success).length;
      const curFailures  = entries.filter(([, v]) => !v.success).length;
      const curDuration  = entries.reduce((s, [, v]) => s + (v.durationMs ?? 0), 0);
      const curInput     = entries.reduce((s, [, v]) => s + (v.tokenUsage?.inputTokens ?? 0), 0);
      const curOutput    = entries.reduce((s, [, v]) => s + (v.tokenUsage?.outputTokens ?? 0), 0);

      totalRuns++;
      totalSessions  += entries.length;
      totalSuccesses += curSuccesses;
      totalFailures  += curFailures;
      totalDurationMs += curDuration;
      totalInputTokens += curInput;
      totalOutputTokens += curOutput;
    }

    const avgDurationMs = totalSessions > 0 ? Math.round(totalDurationMs / totalSessions) : 0;
    const successRate   = totalSessions > 0 ? Math.round((totalSuccesses / totalSessions) * 100) : 0;

    res.json({
      summary: {
        totalRuns, totalSessions, totalSuccesses, totalFailures,
        totalDurationMs, avgDurationMs, successRate,
        totalInputTokens, totalOutputTokens,
      },
      runHistory,
      currentRun,
    });
  });

  // ── GET /api/history ──────────────────────────────────────────────────
  app.get("/api/history", (_req, res) => {
    const archives = loadArchiveManifests();
    const state    = loadState();

    const sessions = [];

    // From archives (newest first)
    for (const arc of archives) {
      const m = arc.manifest;
      if (!m?.sessions) continue;
      for (const [name, detail] of Object.entries(m.sessions)) {
        sessions.push({
          runId: m.runId,
          session: name,
          ...detail,
          startedAt: m.startedAt,
          finishedAt: m.finishedAt,
          model: m.settings?.model ?? "unknown",
          archived: true,
        });
      }
    }

    // From current run
    if (state.sessionDetails) {
      for (const [name, detail] of Object.entries(state.sessionDetails)) {
        sessions.push({
          runId: "current",
          session: name,
          ...detail,
          startedAt: state.startedAt,
          model: getSetting("runner", "defaultModel"),
          archived: false,
        });
      }
    }

    res.json({ sessions });
  });

  // ── POST /api/command/:name ──────────────────────────────────────────────
  app.post("/api/command/:name", async (req, res) => {
    const cmd = req.params.name;

    try {
      switch (cmd) {
        case "start": {
          if (isRunning()) return res.json({ ok: false, message: "Already running" });
          startRunProcess([], null);
          return res.json({ ok: true, message: "Run started" });
        }
        case "start-reset": {
          if (isRunning()) {
            await killProcessGracefully(getRunningProcess(), "run-sessions.js");
            setRunningProcess(null);
          }
          startRunProcess(["--reset"], null);
          return res.json({ ok: true, message: "Run started (reset)" });
        }
        case "stop": {
          const killed = [];
          if (isRunning()) {
            await killProcessGracefully(getRunningProcess(), "run-sessions.js");
            setRunningProcess(null);
            killed.push("run-sessions.js");
          }
          if (isSecurityFixRunning()) {
            const { getSecurityFixProcess, setSecurityFixProcess } = await import("../bot/state.js");
            await killProcessGracefully(getSecurityFixProcess(), "Security Fix");
            setSecurityFixProcess(null);
            killed.push("Security Fix");
          }
          return res.json({ ok: killed.length > 0, message: killed.length > 0 ? `Stopped: ${killed.join(", ")}` : "Nothing running" });
        }
        case "pause": {
          if (!isRunning()) return res.json({ ok: false, message: "Nothing running" });
          if (isPaused())   return res.json({ ok: false, message: "Already paused" });
          setPaused(true);
          return res.json({ ok: true, message: "Paused after current session" });
        }
        case "resume": {
          if (!isPaused()) return res.json({ ok: false, message: "Not paused" });
          setPaused(false);
          return res.json({ ok: true, message: "Resumed" });
        }
        case "restart": {
          if (isRunning()) {
            await killProcessGracefully(getRunningProcess(), "run-sessions.js");
            setRunningProcess(null);
          }
          startRunProcess([], null);
          return res.json({ ok: true, message: "Restarted — completed sessions skipped" });
        }
        case "security-fix": {
          if (isSecurityFixRunning()) return res.json({ ok: false, message: "Security fix already running" });
          startSecurityFix(null);
          return res.json({ ok: true, message: "Security fix started" });
        }
        default:
          return res.status(400).json({ ok: false, message: `Unknown command: ${cmd}` });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  });

  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function loadArchiveManifests() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  try {
    return readdirSync(ARCHIVE_DIR)
      .filter((f) => f.startsWith("run-") && statSync(join(ARCHIVE_DIR, f)).isDirectory())
      .sort()
      .reverse()
      .map((name) => {
        const manifestPath = join(ARCHIVE_DIR, name, "manifest.json");
        let manifest = null;
        if (existsSync(manifestPath)) {
          try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { /* skip */ }
        }
        return { name, manifest };
      })
      .filter((a) => a.manifest !== null);
  } catch { return []; }
}

export function startDashboard() {
  const port = parseInt(getSetting("dashboard", "port")) || 3000;
  const app  = createDashboardServer();

  app.listen(port, () => {
    console.log(`[Dashboard] http://localhost:${port}`);
  });

  return port;
}
