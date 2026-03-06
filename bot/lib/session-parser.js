import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "./paths.js";

export function parseSessionFile(content) {
  const prompts = [];
  const lines   = content.split("\n");
  let current   = null;
  let buffer    = [];

  for (const line of lines) {
    if (/^## Prompt\s+\d+\s*[—–-]/i.test(line)) {
      if (current !== null) {
        const text = buffer.join("\n").trim();
        prompts.push({ title: current, chars: text.length, text });
      }
      current = line.replace(/^##\s*/, "").trim();
      buffer  = [line];
      continue;
    }
    if (/^---+\s*$/.test(line) && current !== null) {
      buffer.push(line);
      const text = buffer.join("\n").trim();
      prompts.push({ title: current, chars: text.length, text });
      current = null;
      buffer  = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }

  if (current !== null && buffer.length > 0) {
    const text = buffer.join("\n").trim();
    prompts.push({ title: current, chars: text.length, text });
  }

  return prompts;
}

export function detectSessions() {
  if (!existsSync(SESSION_DIR))
    return { error: `Sessions directory not found:\n\`${SESSION_DIR}\`` };

  const files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  if (files.length === 0)
    return { error: `No session files (Session1.md etc.) found in:\n\`${SESSION_DIR}\`` };

  const sessions = files.map((file) => {
    const fullPath = join(SESSION_DIR, file);
    const content  = readFileSync(fullPath, "utf8");
    const prompts  = parseSessionFile(content);
    const override = parseOverrideBlocks(content);
    const name     = file.replace(".md", "");
    const dependsOn = override?.session?.dependsOn ?? [];
    return { file, fullPath, name, totalChars: content.length, promptCount: prompts.length, prompts, dependsOn, override };
  });

  return { sessions };
}

/** Parse ALL SESSION OVERRIDE CONFIG blocks from content and merge them */
function parseOverrideBlocks(content) {
  const allMatches = [...content.matchAll(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n([\s\S]*?)-->/g)];
  if (allMatches.length === 0) return {};
  let merged = {};
  for (const m of allMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      merged.session = { ...merged.session, ...parsed.session };
      merged.prompts = merged.prompts || {};
      if (parsed.prompts) {
        for (const [k, v] of Object.entries(parsed.prompts)) {
          merged.prompts[k] = { ...merged.prompts[k], ...v };
        }
      }
    } catch { /* ignore */ }
  }
  return merged;
}

/** Build wave assignments from sessions with dependsOn arrays */
export function buildWaves(sessions) {
  const waves = [];
  const assigned = new Set();
  const sessionNames = new Set(sessions.map((s) => s.name));

  while (assigned.size < sessions.length) {
    const wave = [];
    for (const s of sessions) {
      if (assigned.has(s.name)) continue;
      const deps = (s.dependsOn ?? []).filter((d) => sessionNames.has(d));
      const unmet = deps.filter((d) => !assigned.has(d));
      if (unmet.length === 0) wave.push(s);
    }
    if (wave.length === 0) {
      // Deadlock — remaining sessions have circular/unresolvable deps
      const remaining = sessions.filter((s) => !assigned.has(s.name));
      waves.push(remaining);
      break;
    }
    waves.push(wave);
    for (const s of wave) assigned.add(s.name);
  }
  return waves;
}
