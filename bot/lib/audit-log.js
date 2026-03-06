import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { LOG_DIR } from "./paths.js";
import { ensureDir } from "./helpers.js";

const AUDIT_FILE = join(LOG_DIR, "audit.jsonl");

export function auditLog({ command, actor, args, outcome, linkedRun, linkedSession }) {
  ensureDir(LOG_DIR);

  const entry = {
    timestamp: new Date().toISOString(),
    command,
    actor: actor ?? "system",
    args: args ?? {},
    outcome: outcome ?? "ok",
    linkedRun: linkedRun ?? null,
    linkedSession: linkedSession ?? null,
  };

  try {
    writeFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", { flag: "a" });
  } catch (err) { console.warn("[audit] Could not write audit entry:", err.message); }

  return entry;
}

export function readAuditLog(limit = 50) {
  if (!existsSync(AUDIT_FILE)) return [];

  try {
    const content = readFileSync(AUDIT_FILE, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getAuditEntriesForCommand(command, limit = 20) {
  return readAuditLog(200).filter((e) => e.command === command).slice(-limit);
}
