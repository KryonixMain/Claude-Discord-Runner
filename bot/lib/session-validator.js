import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { SESSION_DIR, CLAUDE_MD } from "./paths.js";
import { parseSessionFile } from "./session-parser.js";

const VALIDATION_RULES = {
  hasHeader:     { re: /^# Session \d+ —/m,                       msg: "Missing session header `# Session N —`" },
  hasInstruction:{ re: /Do NOT wait for user input between prompts/, msg: "Missing instruction block (Do NOT wait...)" },
  hasPrompt:     { re: /^## Prompt\s+\d+\s*[—–-]/m,              msg: "No prompts found (`## Prompt N —` format)" },
};

export function validateSessionContent(content) {
  const errors   = [];
  const warnings = [];
  const stripped = content.replace(/<!--[\s\S]*?-->/g, "").trim();

  if (!VALIDATION_RULES.hasHeader.re.test(stripped))      errors.push(VALIDATION_RULES.hasHeader.msg);
  if (!VALIDATION_RULES.hasInstruction.re.test(stripped)) warnings.push(VALIDATION_RULES.hasInstruction.msg);
  if (!VALIDATION_RULES.hasPrompt.re.test(stripped))      errors.push(VALIDATION_RULES.hasPrompt.msg);

  const promptHeaders = [...stripped.matchAll(/^## Prompt\s+(\d+)\s*[—–-]/gm)].map((m) => parseInt(m[1]));
  promptHeaders.forEach((n, i) => {
    if (n !== i + 1)
      errors.push(`Prompt numbering not sequential: expected Prompt ${i + 1}, found Prompt ${n}`);
  });

  const separators = [...stripped.matchAll(/^---+\s*$/gm)];
  if (promptHeaders.length > 0 && separators.length < promptHeaders.length)
    warnings.push(`${promptHeaders.length} prompt(s) found but only ${separators.length} separator(s) (\`---\`) — last prompt may not be closed`);

  const overrideMatch = content.match(/<!--\r?\nSESSION OVERRIDE CONFIG\r?\n([\s\S]*?)-->/);
  if (overrideMatch) {
    try {
      const parsed = JSON.parse(overrideMatch[1]);
      if (!parsed.session) warnings.push("Override config: missing `session` key");
      if (!parsed.prompts) {
        warnings.push("Override config: missing `prompts` key");
      } else {
        const overrideKeys = Object.keys(parsed.prompts).map(Number).sort((a, b) => a - b);
        const missing = promptHeaders.filter((n) => !overrideKeys.includes(n));
        if (missing.length > 0)
          warnings.push(`Override config: prompts [${missing.join(", ")}] have no override entry`);
      }
    } catch (e) {
      errors.push(`Override config JSON is invalid: ${e.message}`);
    }
  }

  parseSessionFile(stripped).forEach((p, i) => {
    const body = p.text.replace(/^## Prompt[^\n]+\n/, "").replace(/^---+\s*$/m, "").trim();
    if (body.length < 10)
      errors.push(`Prompt ${i + 1} ("${p.title.slice(0, 40)}") appears to be empty`);
  });

  if (existsSync(CLAUDE_MD)) {
    const md = readFileSync(CLAUDE_MD, "utf8");
    if (!(/security agent/i.test(md) && /\[SECURITY\]/i.test(md) && /security-report/i.test(md)))
      warnings.push("CLAUDE.md does not define a Security Agent — run `/setup` to regenerate.");
  } else {
    warnings.push("CLAUDE.md is missing — run `/setup` to create it.");
  }

  if (!/\[SECURITY\]/i.test(stripped))
    warnings.push("No `[SECURITY]` tagged prompt found — no security report will be written.");

  return { valid: errors.length === 0, errors, warnings };
}

export function validateAllSessions() {
  if (!existsSync(SESSION_DIR))
    return { allValid: false, results: [], globalError: `Sessions directory not found: \`${SESSION_DIR}\`` };

  const files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  if (files.length === 0)
    return { allValid: false, results: [], globalError: `No session files found in \`${SESSION_DIR}\`` };

  const results = files.map((file) => {
    const fullPath = join(SESSION_DIR, file);
    const content  = readFileSync(fullPath, "utf8");
    return { file, fullPath, ...validateSessionContent(content) };
  });

  return { allValid: results.every((r) => r.valid), results };
}
