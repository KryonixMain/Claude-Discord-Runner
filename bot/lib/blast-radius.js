import { spawnSync } from "child_process";
import { getSetting } from "./settings.js";

/**
 * Blast-Radius Guard
 *
 * Monitors changes made during a session and aborts/pauses when
 * configured thresholds are exceeded.
 *
 * Settings structure (in runner.blastRadius):
 * {
 *   maxChangedFiles: 50,
 *   maxDeletedFiles: 10,
 *   maxDeletedLines: 500,
 *   forbiddenPaths: ["package.json", "tsconfig.json"],
 *   enforceMode: "warn" | "abort"
 * }
 */

const DEFAULT_BLAST_RADIUS = {
  maxChangedFiles: 50,
  maxDeletedFiles: 10,
  maxDeletedLines: 500,
  forbiddenPaths: [],
  enforceMode: "warn",
};

export function getBlastRadiusConfig() {
  const config = getSetting("runner", "blastRadius");
  return { ...DEFAULT_BLAST_RADIUS, ...config };
}

export function checkBlastRadius(workDir) {
  const config = getBlastRadiusConfig();
  const violations = [];

  try {
    // Get git status for changed files
    const statusResult = spawnSync("git", ["status", "--porcelain"], {
      encoding: "utf8", cwd: workDir, timeout: 10_000,
    });

    if (statusResult.status !== 0) {
      return { ok: true, violations: [], message: "Not a git repo — blast-radius check skipped" };
    }

    const lines = statusResult.stdout.trim().split("\n").filter(Boolean);
    const changedFiles = lines.length;
    const deletedFiles = lines.filter((l) => l.startsWith("D ") || l.startsWith(" D")).length;

    // Check max changed files
    if (changedFiles > config.maxChangedFiles) {
      violations.push({
        type: "MAX_CHANGED_FILES",
        message: `${changedFiles} files changed (limit: ${config.maxChangedFiles})`,
        severity: "high",
      });
    }

    // Check max deleted files
    if (deletedFiles > config.maxDeletedFiles) {
      violations.push({
        type: "MAX_DELETED_FILES",
        message: `${deletedFiles} files deleted (limit: ${config.maxDeletedFiles})`,
        severity: "high",
      });
    }

    // Check forbidden paths
    const changedPaths = lines.map((l) => l.slice(3).trim());
    for (const forbidden of config.forbiddenPaths) {
      const touched = changedPaths.filter((p) => p.includes(forbidden));
      if (touched.length > 0) {
        violations.push({
          type: "FORBIDDEN_PATH",
          message: `Forbidden path modified: ${forbidden}`,
          severity: "critical",
          files: touched,
        });
      }
    }

    // Check deleted lines
    const diffResult = spawnSync("git", ["diff", "--stat"], {
      encoding: "utf8", cwd: workDir, timeout: 10_000,
    });
    if (diffResult.status === 0) {
      const summaryLine = diffResult.stdout.trim().split("\n").pop() ?? "";
      const deletionMatch = summaryLine.match(/(\d+) deletion/);
      const deletedLines = deletionMatch ? parseInt(deletionMatch[1]) : 0;
      if (deletedLines > config.maxDeletedLines) {
        violations.push({
          type: "MAX_DELETED_LINES",
          message: `${deletedLines} lines deleted (limit: ${config.maxDeletedLines})`,
          severity: "high",
        });
      }
    }
  } catch (err) {
    return { ok: true, violations: [], message: `Blast-radius check error: ${err.message}` };
  }

  return {
    ok: violations.length === 0,
    violations,
    shouldAbort: config.enforceMode === "abort" && violations.length > 0,
    message: violations.length === 0
      ? "Blast-radius check passed"
      : `${violations.length} violation(s) detected`,
  };
}
