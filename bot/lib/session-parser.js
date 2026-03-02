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
    return { file, fullPath, totalChars: content.length, promptCount: prompts.length, prompts };
  });

  return { sessions };
}
