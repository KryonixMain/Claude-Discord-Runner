import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

import { isRunning, isPaused, setPaused, isSecurityFixRunning,
         getRunningProcess, setRunningProcess, getScheduledTimer } from "../bot/state.js";
import { startRunProcess, startSecurityFix } from "../bot/process.js";
import { loadState, formatDuration, sessionKey, getLatestLogFile,
         loadSecurityReports, countFindings, getSessionCount,
         killProcessGracefully, queryRateLimit } from "../bot/lib/helpers.js";
import { detectSessions } from "../bot/lib/session-parser.js";
import { calculateSessionTimeouts } from "../bot/lib/calculator.js";
import { getSetting, loadSettings } from "../bot/lib/settings.js";
import { CLAUDE_PLANS } from "../bot/lib/plans.js";
import { PROJECT_DIR, ARCHIVE_DIR } from "../bot/lib/paths.js";
import { readAuditLog } from "../bot/lib/audit-log.js";
import { readdirSync, statSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      const completedAt = state[`${key}_completedAt`];
      const durationMs  = state[`${key}_durationMs`];
      return {
        file: s.file,
        promptCount: s.promptCount,
        done,
        completedAt: completedAt || null,
        duration: durationMs ? formatDuration(durationMs) : null,
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
    // Redact sensitive fields
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
      const result = spawnSync("git", ["diff", "--name-only"], {
        cwd: PROJECT_DIR, encoding: "utf8", timeout: 5000,
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
          return {
            name,
            path: archivePath,
            manifest,
          };
        });
      res.json({ archives });
    } catch {
      res.json({ archives: [], error: "Failed to list archives" });
    }
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

export function startDashboard() {
  const port = parseInt(getSetting("dashboard", "port")) || 3000;
  const app  = createDashboardServer();

  app.listen(port, () => {
    console.log(`[Dashboard] http://localhost:${port}`);
  });

  return port;
}
