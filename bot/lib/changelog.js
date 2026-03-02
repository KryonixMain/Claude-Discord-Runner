import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { PROJECT_DIR } from "./paths.js";

const CHANGELOG_PATH = join(PROJECT_DIR, "CHANGELOG.md");

/**
 * Parse the latest version entry from CHANGELOG.md.
 * Returns { version, date, body } or null if not found.
 */
export function parseLatestChangelog() {
  if (!existsSync(CHANGELOG_PATH)) return null;

  const content = readFileSync(CHANGELOG_PATH, "utf8");
  return parseLatestFromContent(content);
}

/**
 * Parse the latest version entry from raw changelog content.
 */
export function parseLatestFromContent(content) {
  // Match ## [X.Y.Z] — YYYY-MM-DD
  const versionRegex = /^## \[(\d+\.\d+\.\d+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})/gm;
  const firstMatch = versionRegex.exec(content);
  if (!firstMatch) return null;

  const version = firstMatch[1];
  const date = firstMatch[2];

  // Find the start of the body (after the header line)
  const bodyStart = firstMatch.index + firstMatch[0].length;

  // Find the next version header or end of content
  const nextMatch = versionRegex.exec(content);
  const bodyEnd = nextMatch ? nextMatch.index : content.length;

  const body = content.slice(bodyStart, bodyEnd).trim();

  return { version, date, body };
}

/**
 * Extract just the version string from changelog content.
 */
export function parseVersionFromContent(content) {
  const match = content.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  return match ? match[1] : null;
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b
 *   0 if a === b
 *   1 if a > b
 */
export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
