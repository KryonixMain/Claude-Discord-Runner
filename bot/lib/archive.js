import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { LOG_DIR, SECURITY_DIR, SESSION_DIR, ARCHIVE_DIR, STATE_FILE, SETTINGS_FILE } from "./paths.js";
import { ensureDir, loadState } from "./helpers.js";
import { getSetting } from "./settings.js";
import { CLAUDE_PLANS } from "./plans.js";

export function archiveCompletedRun() {
  const ts         = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runArchive = join(ARCHIVE_DIR, `run-${ts}`);

  ensureDir(runArchive);
  for (const sub of ["Logs", "Security", "Sessions"]) ensureDir(join(runArchive, sub));

  // Logs — move all files (output, error logs, diffs, per-prompt outputs)
  if (existsSync(LOG_DIR)) {
    for (const f of readdirSync(LOG_DIR)) {
      const src = join(LOG_DIR, f);
      if (statSync(src).isFile()) renameSync(src, join(runArchive, "Logs", f));
    }
  }

  // Security — move all report files and fix outputs
  if (existsSync(SECURITY_DIR)) {
    for (const f of readdirSync(SECURITY_DIR)) {
      const src = join(SECURITY_DIR, f);
      if (statSync(src).isFile()) renameSync(src, join(runArchive, "Security", f));
    }
  }

  // Sessions — COPY session definition files (preserve originals for next run)
  if (existsSync(SESSION_DIR)) {
    for (const f of readdirSync(SESSION_DIR)) {
      const src = join(SESSION_DIR, f);
      if (!statSync(src).isFile()) continue;
      if (/^Session\d+\.md$/i.test(f)) {
        // Copy session definitions — keep originals intact
        copyFileSync(src, join(runArchive, "Sessions", f));
      } else {
        // Move any other files (output fragments, temp files)
        renameSync(src, join(runArchive, "Sessions", f));
      }
    }
  }

  // Progress state — move
  let progressData = null;
  if (existsSync(STATE_FILE)) {
    try { progressData = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch (err) { console.warn("[archive] Could not parse progress state:", err.message); }
    renameSync(STATE_FILE, join(runArchive, `progress-${ts}.json`));
  }

  // Generate immutable manifest
  const manifest = buildManifest(runArchive, ts, progressData);
  writeFileSync(join(runArchive, "manifest.json"), JSON.stringify(manifest, null, 2));

  return runArchive;
}

function hashFile(filePath) {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch { return null; }
}

function buildManifest(archivePath, ts, progressData) {
  const plan = CLAUDE_PLANS[getSetting("runner", "claudePlan")] ?? {};

  // Collect file hashes
  const files = {};
  for (const sub of ["Logs", "Security", "Sessions"]) {
    const dir = join(archivePath, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const fullPath = join(dir, f);
      if (statSync(fullPath).isFile()) {
        files[`${sub}/${f}`] = hashFile(fullPath);
      }
    }
  }

  // Extract session summary from progress data
  const sessions = {};
  if (progressData?.sessionDetails) {
    for (const [name, detail] of Object.entries(progressData.sessionDetails)) {
      sessions[name] = {
        success: detail.success,
        durationMs: detail.durationMs,
        promptsCompleted: detail.promptsCompleted,
        totalPrompts: detail.totalPrompts,
        tokenUsage: detail.tokenUsage ?? {},
        verification: detail.verification ?? null,
      };
    }
  }

  return {
    runId: `run-${ts}`,
    startedAt: progressData?.startedAt ?? null,
    finishedAt: progressData?.finishedAt ?? new Date().toISOString(),
    status: progressData?.completedSessions?.length > 0 ? "completed" : "unknown",
    completedSessions: progressData?.completedSessions ?? [],
    settings: {
      plan: plan.label ?? "unknown",
      model: getSetting("runner", "defaultModel"),
      pauseMinutes: getSetting("runner", "pauseMinutes"),
      maxTurns: getSetting("runner", "maxTurns"),
    },
    sessions,
    files,
    fileCount: Object.keys(files).length,
  };
}

export function pruneArchives(keepCount = 5) {
  if (!existsSync(ARCHIVE_DIR)) return;
  readdirSync(ARCHIVE_DIR)
    .filter((f) => f.startsWith("run-"))
    .map((f) => ({ name: f, mtime: statSync(join(ARCHIVE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(keepCount)
    .forEach((r) => rmSync(join(ARCHIVE_DIR, r.name), { recursive: true, force: true }));
}
