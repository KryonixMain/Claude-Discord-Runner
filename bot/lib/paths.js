import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASE_DIR      = join(__dirname, "..");           // bot/
export const PROJECT_DIR   = join(BASE_DIR, "..");            // project root

export const SETTINGS_FILE = join(BASE_DIR, "settings.json");
export const CLAUDE_MD     = join(PROJECT_DIR, "CLAUDE.md");  // stays in bot project

// Resolve workDir from settings (inline to avoid circular dependency with settings.js)
function resolveDataRoot() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      if (s?.runner?.workDir) return resolve(s.runner.workDir);
    }
  } catch { /* fallback */ }
  return PROJECT_DIR;
}

const DATA_ROOT = resolveDataRoot();

export const LOG_DIR       = join(DATA_ROOT, "Logs");
export const SECURITY_DIR  = join(DATA_ROOT, "Security");
export const SESSION_DIR   = join(DATA_ROOT, "Sessions");
export const ARCHIVE_DIR   = join(DATA_ROOT, "Archive");
export const STATE_FILE    = join(DATA_ROOT, ".progress.json");
