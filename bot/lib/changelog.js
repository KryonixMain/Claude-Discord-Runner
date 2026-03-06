import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { PROJECT_DIR } from "./paths.js";

const CHANGELOG_PATH = join(PROJECT_DIR, "CHANGELOG.md");

export function parseLatestChangelog() {
  if (!existsSync(CHANGELOG_PATH)) return null;

  const content = readFileSync(CHANGELOG_PATH, "utf8");
  return parseLatestFromContent(content);
}

export function parseLatestFromContent(content) {
  const versionRegex = /^## \[(\d+\.\d+\.\d+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})/gm;
  const firstMatch = versionRegex.exec(content);
  if (!firstMatch) return null;

  const version = firstMatch[1];
  const date = firstMatch[2];

  const bodyStart = firstMatch.index + firstMatch[0].length;

  const nextMatch = versionRegex.exec(content);
  const bodyEnd = nextMatch ? nextMatch.index : content.length;

  const body = content.slice(bodyStart, bodyEnd).trim();

  return { version, date, body };
}

export function parseVersionFromContent(content) {
  const match = content.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  return match ? match[1] : null;
}

export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
