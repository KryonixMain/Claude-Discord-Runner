import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "../lib/paths.js";
import { loadState, formatDuration } from "../lib/helpers.js";
import { isRunning } from "../state.js";
import { getSetting } from "../lib/settings.js";

const DEFAULT_TIMEOUT_MS     = 2 * 60 * 60 * 1000;   
const LIGHTWEIGHT_TIMEOUT_MS = 45 * 60 * 1000;        
const BUFFER_MS              = 10 * 60 * 1000;         
const LIGHTWEIGHT_KEYWORDS   = ["roadmap update", "section update", "module update"];

function parseOverrideBlock(content) {
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

function resolvePromptTimeout(promptLabel, promptNumber, override) {
  const isLightweight = LIGHTWEIGHT_KEYWORDS.some((kw) =>
    promptLabel.toLowerCase().includes(kw),
  );
  const base = isLightweight ? LIGHTWEIGHT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const sessionTimeout = override?.session?.timeoutMs ?? null;
  const promptTimeout = override?.prompts?.[String(promptNumber)]?.timeoutMs ?? null;
  return promptTimeout ?? sessionTimeout ?? base;
}

export async function handleGetTimeout(interaction) {
  await interaction.deferReply();

  const sessionNum = interaction.options.getInteger("session");
  if (sessionNum === null) {
    return showAllSessions(interaction);
  }

  const filePath = join(SESSION_DIR, `Session${sessionNum}.md`);

  if (!existsSync(filePath)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Session nicht gefunden")
          .setDescription(`\`Session${sessionNum}.md\` existiert nicht.`)
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const content  = readFileSync(filePath, "utf8");
  const override = parseOverrideBlock(content);

  const stripped = content
    .replace(/<!--\r?\nSESSION OVERRIDE CONFIG[\s\S]*?-->\r?\n?\r?\n?/g, "")
    .replace(/^```json\s*\n[\s\S]*?\n```\s*\n?/, "");

  const matches = [...stripped.matchAll(/^##\s+Prompt\s+(\d+)\s*[—–:\-]/gim)];

  const prompts = matches.length === 0
    ? [{ number: 1, label: "Main Prompt" }]
    : matches.map((m) => ({
        number: parseInt(m[1]),
        label: m[0].replace(/^##\s+/, "").trim(),
      }));

  const promptDetails = prompts.map((p) => {
    const timeoutMs = resolvePromptTimeout(p.label, p.number, override);
    return { ...p, timeoutMs };
  });

  const totalTimeoutMs = promptDetails.reduce((sum, p) => sum + p.timeoutMs, 0) + BUFFER_MS;

  const pauseAfterMs = override?.session?.pauseAfterMs
    ?? getSetting("runner", "pauseMinutes") * 60_000;

  const state   = loadState();
  const running = isRunning();
  const name    = `Session${sessionNum}`;
  const isDone  = state.completedSessions?.includes(name);

  const promptLines = promptDetails.map((p) => {
    const src = override?.prompts?.[String(p.number)]?.timeoutMs
      ? "override"
      : override?.session?.timeoutMs
        ? "session"
        : "default";
    return `\`[${p.number}]\` ${p.label}\n  Timeout: **${formatDuration(p.timeoutMs)}** _(${src})_`;
  });

  let runningInfo = "";
  if (isDone) {
    const details = state.sessionDetails?.[name];
    if (details) {
      runningInfo = `\n\n**Status:** Abgeschlossen in ${formatDuration(details.durationMs)}`;
    } else {
      runningInfo = "\n\n**Status:** Abgeschlossen";
    }
  } else if (running && state.sessionDetails?.[name]?.startedAt) {
    const elapsed = Date.now() - new Date(state.sessionDetails[name].startedAt).getTime();
    const remaining = Math.max(0, totalTimeoutMs - elapsed);
    runningInfo = `\n\n**Status:** Läuft\n**Vergangen:** ${formatDuration(elapsed)}\n**Verbleibend:** ${formatDuration(remaining)}`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Timeout — Session${sessionNum}`)
    .setDescription(
      promptLines.join("\n\n") +
      `\n\n**Gesamt-Timeout:** ${formatDuration(totalTimeoutMs)} _(inkl. ${formatDuration(BUFFER_MS)} Buffer)_` +
      `\n**Pause danach:** ${formatDuration(pauseAfterMs)}` +
      runningInfo,
    )
    .addFields(
      { name: "Prompts",        value: String(prompts.length),            inline: true },
      { name: "Session-Timeout", value: formatDuration(totalTimeoutMs),   inline: true },
      { name: "Pause danach",    value: formatDuration(pauseAfterMs),     inline: true },
    )
    .setColor(isDone ? 0x57f287 : running ? 0xfee75c : 0x5865f2)
    .setTimestamp();

  if (override?.session?.timeoutMs) {
    embed.setFooter({ text: `Session-Timeout-Override aktiv: ${formatDuration(override.session.timeoutMs)} pro Prompt` });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function showAllSessions(interaction) {
  if (!existsSync(SESSION_DIR)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Timeout-Übersicht")
          .setDescription("Sessions-Verzeichnis nicht gefunden.")
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const { readdirSync } = await import("fs");
  const files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  if (files.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Timeout-Übersicht")
          .setDescription("Keine Session-Dateien gefunden.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const state = loadState();
  const lines = [];
  let totalTimeoutAll = 0;
  let totalPauseAll   = 0;

  for (const file of files) {
    const num     = parseInt(file.match(/\d+/)[0]);
    const content = readFileSync(join(SESSION_DIR, file), "utf8");
    const override = parseOverrideBlock(content);

    const stripped = content
      .replace(/<!--\r?\nSESSION OVERRIDE CONFIG[\s\S]*?-->\r?\n?\r?\n?/g, "")
      .replace(/^```json\s*\n[\s\S]*?\n```\s*\n?/, "");

    const matches = [...stripped.matchAll(/^##\s+Prompt\s+(\d+)\s*[—–:\-]/gim)];
    const promptCount = Math.max(1, matches.length);

    let sessionTotalMs = BUFFER_MS;
    if (matches.length === 0) {
      sessionTotalMs += resolvePromptTimeout("Main Prompt", 1, override);
    } else {
      for (const m of matches) {
        const pNum   = parseInt(m[1]);
        const pLabel = m[0].replace(/^##\s+/, "").trim();
        sessionTotalMs += resolvePromptTimeout(pLabel, pNum, override);
      }
    }

    const pauseMs = override?.session?.pauseAfterMs
      ?? getSetting("runner", "pauseMinutes") * 60_000;

    const name   = file.replace(".md", "");
    const isDone = state.completedSessions?.includes(name);
    const icon   = isDone ? "✅" : "⬜";

    const hasOverride = override?.session?.timeoutMs ? " ⚙️" : "";

    lines.push(
      `${icon} **${name}** — ${promptCount} Prompt(s)\n` +
      `  Timeout: **${formatDuration(sessionTotalMs)}**${hasOverride} | Pause: **${formatDuration(pauseMs)}**`,
    );

    totalTimeoutAll += sessionTotalMs;
    totalPauseAll   += pauseMs;
  }

  const totalRuntime = totalTimeoutAll + totalPauseAll;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Timeout-Übersicht — Alle Sessions")
        .setDescription(
          lines.join("\n\n") +
          `\n\n---\n` +
          `**Max. Ausführungszeit:** ${formatDuration(totalTimeoutAll)}\n` +
          `**Gesamte Pausenzeit:** ${formatDuration(totalPauseAll)}\n` +
          `**Max. Gesamtlaufzeit:** ${formatDuration(totalRuntime)}`,
        )
        .addFields(
          { name: "Sessions",       value: String(files.length),              inline: true },
          { name: "Max. Laufzeit",   value: formatDuration(totalTimeoutAll),   inline: true },
          { name: "Pausenzeit",      value: formatDuration(totalPauseAll),     inline: true },
        )
        .setColor(0x5865f2)
        .setFooter({ text: "⚙️ = Session-Timeout-Override aktiv | Timeout ≠ Pause" })
        .setTimestamp(),
    ],
  });
}
