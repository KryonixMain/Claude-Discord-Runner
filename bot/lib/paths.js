import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASE_DIR      = join(__dirname, "..");           // bot/
export const PROJECT_DIR   = join(BASE_DIR, "..");            // project root

// Runtime data directories — at project root (outside bot/)
export const LOG_DIR       = join(PROJECT_DIR, "Logs");
export const SECURITY_DIR  = join(PROJECT_DIR, "Security");
export const SESSION_DIR   = join(PROJECT_DIR, "Sessions");
export const ARCHIVE_DIR   = join(PROJECT_DIR, "Archive");
export const STATE_FILE    = join(PROJECT_DIR, ".progress.json");
export const CLAUDE_MD     = join(PROJECT_DIR, "CLAUDE.md");

// Bot config — stays inside bot/
export const SETTINGS_FILE = join(BASE_DIR, "settings.json");
