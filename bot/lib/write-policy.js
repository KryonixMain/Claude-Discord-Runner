import { resolve, relative } from "path";
import { getSetting } from "./settings.js";

/**
 * Write Policy Engine
 *
 * Checks whether a file path is allowed for reading/writing based on
 * configured allow-list and deny-list patterns.
 *
 * Settings structure (in runner.writePolicy):
 * {
 *   denyPaths: [".env", "secrets/", "prod/", "infra/", ".git/"],
 *   allowPaths: ["src/", "lib/", "tests/"],    // empty = allow all except denied
 *   readOnlyPaths: ["package-lock.json", "node_modules/"],
 *   enforceMode: "warn" | "block"              // warn = log only, block = prevent
 * }
 */

const DEFAULT_DENY_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  "secrets/",
  "credentials/",
  ".git/config",
  ".git/credentials",
];

export function getWritePolicy() {
  const policy = getSetting("runner", "writePolicy");
  return {
    denyPaths: policy?.denyPaths ?? DEFAULT_DENY_PATHS,
    allowPaths: policy?.allowPaths ?? [],
    readOnlyPaths: policy?.readOnlyPaths ?? [],
    enforceMode: policy?.enforceMode ?? "warn",
  };
}

function matchesPattern(filePath, patterns) {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const p = pattern.replace(/\\/g, "/");
    if (p.endsWith("/")) {
      // Directory pattern — matches anything under it
      return normalized.startsWith(p) || normalized.includes(`/${p}`);
    }
    // File pattern — exact match or filename match
    return normalized === p || normalized.endsWith(`/${p}`) || normalized.endsWith(p);
  });
}

export function checkWritePermission(filePath, workDir) {
  const policy = getWritePolicy();
  const rel = relative(resolve(workDir), resolve(filePath)).replace(/\\/g, "/");

  // Check deny list first
  if (matchesPattern(rel, policy.denyPaths)) {
    return {
      allowed: policy.enforceMode !== "block",
      reason: `Path matches deny pattern: ${rel}`,
      severity: "DENIED",
    };
  }

  // Check read-only paths
  if (matchesPattern(rel, policy.readOnlyPaths)) {
    return {
      allowed: policy.enforceMode !== "block",
      reason: `Path is read-only: ${rel}`,
      severity: "READ_ONLY",
    };
  }

  // Check allow list (if defined, only allowed paths are writable)
  if (policy.allowPaths.length > 0 && !matchesPattern(rel, policy.allowPaths)) {
    return {
      allowed: policy.enforceMode !== "block",
      reason: `Path not in allow list: ${rel}`,
      severity: "NOT_ALLOWED",
    };
  }

  return { allowed: true, reason: null, severity: null };
}

/**
 * Generate write policy rules for CLAUDE.md injection
 */
export function generateWritePolicyBlock() {
  const policy = getWritePolicy();

  const lines = [
    "",
    "---",
    "",
    "## Write Policy",
    "",
  ];

  if (policy.denyPaths.length > 0) {
    lines.push("**Denied paths (DO NOT modify these files):**");
    policy.denyPaths.forEach((p) => lines.push(`- \`${p}\``));
    lines.push("");
  }

  if (policy.readOnlyPaths.length > 0) {
    lines.push("**Read-only paths (read but do not modify):**");
    policy.readOnlyPaths.forEach((p) => lines.push(`- \`${p}\``));
    lines.push("");
  }

  if (policy.allowPaths.length > 0) {
    lines.push("**Allowed write paths (only modify files within these):**");
    policy.allowPaths.forEach((p) => lines.push(`- \`${p}\``));
    lines.push("");
  }

  lines.push(`**Enforcement mode:** ${policy.enforceMode}`);
  lines.push("");

  return lines.join("\n");
}
