import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { setTimeout as delay } from "timers/promises";
import { LOG_DIR, PROJECT_DIR, SECURITY_DIR, SESSION_DIR, STATE_FILE } from "./paths.js";
import { getSetting } from "./settings.js";

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function formatDuration(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function getSessionCount() {
  if (!existsSync(SESSION_DIR)) return 0;
  return readdirSync(SESSION_DIR).filter((f) => /^Session\d+\.md$/i.test(f)).length;
}

export function getLatestLogFile() {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("run-") && f.endsWith(".log"))
    .map((f) => ({ name: f, mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? join(LOG_DIR, files[0].name) : null;
}

export function loadSecurityReports() {
  if (!existsSync(SECURITY_DIR)) return [];
  return readdirSync(SECURITY_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("fix-output"))
    .map((f) => ({
      file: join(SECURITY_DIR, f),
      name: f,
      content: readFileSync(join(SECURITY_DIR, f), "utf8"),
    }));
}

export function sessionKey(filePath) {
  return filePath.replace(".md", "").split("/").pop().split("\\").pop();
}

export function countFindings(content, level) {
  // Match checklist items under the level header: "- [ ] ..." or "- [x] ..."
  // Also count the section header itself as a structural match
  const levelPatterns = {
    CRITICAL: /^[ \t]*- \[[ x]\].*$/gm,
    WARNING:  /^[ \t]*- \[[ x]\].*$/gm,
    INFO:     /^[ \t]*- \[[ x]\].*$/gm,
    FIXED:    /FIXED/g,
  };

  // Strategy: find the section for this level, then count items in it
  const sectionRegex = new RegExp(`## ${level}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`, "g");
  let count = 0;
  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    const section = match[1];
    const items = section.match(/^[ \t]*- \[[ x]\]/gm);
    count += items ? items.length : 0;
  }
  return count;
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return { completedSessions: [] };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { completedSessions: [] };
  }
}

export function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

export function resolveClaudePath() {
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where.exe" : "which";
  const w = spawnSync(whichCmd, ["claude"], { encoding: "utf8", shell: isWin });
  if (w.status === 0 && w.stdout?.trim())
    return w.stdout.trim().split("\n")[0].trim();
  if (isWin) {
    const fallback = join(process.env.APPDATA ?? "", "npm", "claude.cmd");
    if (existsSync(fallback)) return fallback;
  }
  return "claude";
}

export async function killProcessGracefully(proc, label = "process") {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => proc.on("exit", resolve)),
    delay(3000),
  ]);
  if (proc.exitCode === null) {
    console.warn(`[Bot] ${label} did not exit after SIGTERM — sending SIGKILL`);
    proc.kill("SIGKILL");
  }
}

export function getWorkDir() {
  const configured = getSetting("runner", "workDir");
  return configured ? resolve(configured) : PROJECT_DIR;
}

export function queryRateLimit() {
  const result = spawnSync(resolveClaudePath(), ["api-status", "--json"], {
    encoding: "utf8",
    timeout: 8_000,
    shell: false,
    env: { ...process.env },
  });
  if (result.status === 0 && result.stdout?.trim()) {
    try { return JSON.parse(result.stdout.trim()); } catch (err) { console.warn("[helpers] Could not parse rate-limit JSON:", err.message); }
  }
  return null;
}
