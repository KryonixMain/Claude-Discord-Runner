import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { LOG_DIR } from "./paths.js";

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;
const MAX_LOG_FILES = 10;

let currentLogFile = null;

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFile() {
  if (currentLogFile) return currentLogFile;
  ensureLogDir();
  currentLogFile = join(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);
  return currentLogFile;
}

function rotateLogFiles() {
  if (!existsSync(LOG_DIR)) return;
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("bot-") && f.endsWith(".log"))
    .map((f) => ({ name: f, path: join(LOG_DIR, f), mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  files.slice(MAX_LOG_FILES).forEach((f) => {
    try { unlinkSync(f.path); } catch (err) { console.warn("[logger] Could not delete old log:", f.name, err.message); }
  });
}

function formatLogLine(level, source, message) {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.padEnd(5)}] [${source}] ${message}`;
}

function writeToFile(line) {
  try {
    writeFileSync(getLogFile(), line + "\n", { flag: "a" });
  } catch (err) { console.warn("[logger] Could not write to log file:", err.message); }
}

function logMessage(level, source, message) {
  if (LEVELS[level] < LOG_LEVEL) return;

  const line = formatLogLine(level, source, message);

  // Write to stdout/stderr
  if (level === "ERROR" || level === "WARN") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }

  // Write to log file
  writeToFile(line);
}

export function createLogger(source) {
  return {
    debug: (msg) => logMessage("DEBUG", source, msg),
    info:  (msg) => logMessage("INFO",  source, msg),
    warn:  (msg) => logMessage("WARN",  source, msg),
    error: (msg) => logMessage("ERROR", source, msg),
  };
}

// Default logger for general use
export const logger = createLogger("Bot");

// Rotate on import
rotateLogFiles();
