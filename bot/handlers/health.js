import { existsSync, readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import os from "os";
import http from "http";
import { EmbedBuilder } from "discord.js";
import { SETTINGS_FILE, LOG_DIR, ARCHIVE_DIR, SESSION_DIR, SECURITY_DIR, CLAUDE_MD } from "../lib/paths.js";
import { resolveClaudePath, getWorkDir } from "../lib/helpers.js";
import { getSetting } from "../lib/settings.js";
import { checkWebhookHealth } from "../../discord-notify.js";

function checkClaudeCli() {
  try {
    const claudePath = resolveClaudePath();
    const result = spawnSync(claudePath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      shell: process.platform === "win32",
    });
    if (result.status === 0 && result.stdout?.trim()) {
      return { ok: true, detail: `${result.stdout.trim()} (${claudePath})` };
    }
    return { ok: false, detail: `Exit code ${result.status} — ${claudePath}` };
  } catch (err) {
    return { ok: false, detail: `Not found: ${err.message}` };
  }
}

function checkDiskSpace() {
  try {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();

    if (process.platform === "win32") {
      const drive = LOG_DIR.charAt(0);
      const result = spawnSync("powershell", [
        "-Command",
        `(Get-PSDrive ${drive}).Free`,
      ], { encoding: "utf8", timeout: 5_000 });
      if (result.status === 0 && result.stdout?.trim()) {
        const freeBytes = parseInt(result.stdout.trim(), 10);
        const freeGB = (freeBytes / (1024 ** 3)).toFixed(2);
        const ok = freeBytes > 500 * 1024 * 1024;
        return { ok, detail: `${freeGB} GB free on ${drive}:` };
      }
    } else {
      const result = spawnSync("df", ["-k", LOG_DIR], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (result.status === 0 && result.stdout) {
        const lines = result.stdout.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          const freeKB = parseInt(parts[3], 10);
          const freeGB = (freeKB / (1024 ** 2)).toFixed(2);
          const ok = freeKB > 500 * 1024;
          return { ok, detail: `${freeGB} GB free` };
        }
      }
    }
    return { ok: true, detail: "Unable to determine disk space — assuming OK" };
  } catch (err) {
    console.warn("[health] Disk space check failed:", err.message);
    return { ok: true, detail: "Unable to determine — assuming OK" };
  }
}

function checkGitRepo() {
  const workDir = getWorkDir();
  try {
    const result = spawnSync("git", ["status", "--porcelain", "-b"], {
      encoding: "utf8",
      cwd: workDir,
      timeout: 5_000,
    });
    if (result.status === 0) {
      const lines = result.stdout.trim().split("\n");
      const branch = lines[0]?.replace(/^##\s*/, "") ?? "unknown";
      const dirty = lines.length > 1 ? ` (${lines.length - 1} changed files)` : " (clean)";
      return { ok: true, detail: `${branch}${dirty}` };
    }
    return { ok: false, detail: "Not a git repository" };
  } catch (err) {
    console.warn("[health] Git check failed:", err.message);
    return { ok: false, detail: "Git not available" };
  }
}

function checkDashboard() {
  const port = getSetting("dashboard", "port") || 3000;
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/status`, { timeout: 3000 }, (res) => {
      resolve(
        res.statusCode === 200
          ? { ok: true, detail: `Reachable on port ${port}` }
          : { ok: false, detail: `HTTP ${res.statusCode} on port ${port}` },
      );
      res.resume();
    });
    req.on("error", () => {
      resolve({ ok: false, detail: `Not responding on port ${port}` });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: `Timeout on port ${port}` });
    });
  });
}

function checkSettings() {
  if (!existsSync(SETTINGS_FILE)) {
    return { ok: false, detail: "settings.json not found" };
  }
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const issues = [];
    if (!parsed.bot?.token)    issues.push("bot.token missing");
    if (!parsed.bot?.clientId) issues.push("bot.clientId missing");
    if (!parsed.bot?.channelId) issues.push("bot.channelId missing");
    if (issues.length > 0) {
      return { ok: false, detail: issues.join(", ") };
    }
    return { ok: true, detail: "Valid — all required keys present" };
  } catch (err) {
    return { ok: false, detail: `Parse error: ${err.message}` };
  }
}

function checkWorkDir() {
  const workDir = getWorkDir();
  if (!existsSync(workDir)) {
    return { ok: false, detail: `Directory not found: ${workDir}` };
  }
  try {
    statSync(workDir);
    return { ok: true, detail: workDir };
  } catch (err) {
    console.warn("[health] WorkDir check failed:", err.message);
    return { ok: false, detail: `Cannot access: ${workDir}` };
  }
}

function checkDirectories() {
  const dirs = [
    { name: "Sessions", path: SESSION_DIR },
    { name: "Logs", path: LOG_DIR },
    { name: "Security", path: SECURITY_DIR },
    { name: "Archive", path: ARCHIVE_DIR },
  ];
  const missing = dirs.filter((d) => !existsSync(d.path));
  if (missing.length === 0) return { ok: true, detail: "All directories exist" };
  return { ok: false, detail: `Missing: ${missing.map((d) => d.name).join(", ")}` };
}

function checkClaudeMd() {
  if (!existsSync(CLAUDE_MD)) return { ok: false, detail: "CLAUDE.md not found — run /setup" };
  const content = readFileSync(CLAUDE_MD, "utf8");
  const hasRoles = /security agent/i.test(content) && /fullstack agent/i.test(content);
  const hasWorkDir = /Working Directory/i.test(content);
  if (!hasRoles) return { ok: false, detail: "Missing agent role definitions" };
  if (!hasWorkDir) return { ok: false, detail: "Missing Working Directory section" };
  return { ok: true, detail: "Agent roles and workDir configured" };
}

export async function handleHealth(interaction) {
  await interaction.deferReply();

  const syncChecks = [
    { name: "Claude CLI",     result: checkClaudeCli() },
    { name: "Settings",       result: checkSettings() },
    { name: "Work Directory", result: checkWorkDir() },
    { name: "Directories",    result: checkDirectories() },
    { name: "CLAUDE.md",      result: checkClaudeMd() },
    { name: "Git Repo",       result: checkGitRepo() },
    { name: "Disk Space",     result: checkDiskSpace() },
  ];

  // Async checks in parallel
  const [dashResult, whResult] = await Promise.all([
    checkDashboard(),
    checkWebhookHealth(),
  ]);

  const results = [
    ...syncChecks.map((c) => ({ name: c.name, ...c.result })),
    { name: "Dashboard", ...dashResult },
    { name: "Webhook", ok: whResult.healthy, detail: whResult.reason || "Connected" },
  ];

  const allOk = results.every((r) => r.ok);
  const statusIcon = (ok) => ok ? "+" : "-";

  const description = results
    .map((r) => `\`[${statusIcon(r.ok)}]\` **${r.name}**\n    ${r.detail}`)
    .join("\n\n");

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(allOk ? "Health Check — All systems operational" : "Health Check — Issues detected")
        .setDescription(description)
        .setColor(allOk ? 0x57f287 : 0xfee75c)
        .setFooter({ text: `${results.filter((r) => r.ok).length}/${results.length} checks passed` })
        .setTimestamp(),
    ],
  });
}
