import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "../lib/paths.js";
import { loadState } from "../lib/helpers.js";
import { buildWaves } from "../lib/session-parser.js";

function parseOverride(content) {
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

export async function handleDependencyGraph(interaction) {
  await interaction.deferReply();

  if (!existsSync(SESSION_DIR)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Dependency Graph")
          .setDescription("Sessions directory not found. Run `/setup` first.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const files = readdirSync(SESSION_DIR)
    .filter((f) => /^Session\d+\.md$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  if (files.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Dependency Graph")
          .setDescription("No session files found.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
    });
    return;
  }

  const state = loadState();
  const completed = new Set(state.completedSessions ?? []);

  const sessions = files.map((file) => {
    const content = readFileSync(join(SESSION_DIR, file), "utf8");
    const override = parseOverride(content);
    const name = file.replace(".md", "");
    return {
      name,
      file,
      dependsOn: override?.session?.dependsOn ?? [],
      completed: completed.has(name),
    };
  });

  const lines = [];
  const sessionNames = new Set(sessions.map((s) => s.name));

  const roots = sessions.filter((s) => s.dependsOn.length === 0);
  const withDeps = sessions.filter((s) => s.dependsOn.length > 0);

  const dependents = new Map();
  for (const s of sessions) {
    for (const dep of s.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(s.name);
    }
  }

  const icon = (s) => s.completed ? "[done]" : "[    ]";

  lines.push("```");

  if (withDeps.length === 0) {
    lines.push("All sessions are independent (no dependencies):");
    lines.push("");
    for (const s of sessions) {
      lines.push(`  ${icon(s)} ${s.name}`);
    }
  } else {
    lines.push("Session Dependency Graph:");
    lines.push("");

    const rendered = new Set();

    function renderNode(name, indent, isLast, prefix) {
      const session = sessions.find((s) => s.name === name);
      if (!session) return;

      const connector = indent === 0 ? "" : (isLast ? " └── " : " ├── ");
      const status = session.completed ? "[done]" : "[    ]";
      lines.push(`${prefix}${connector}${status} ${name}`);
      rendered.add(name);

      const children = dependents.get(name) ?? [];
      const newPrefix = indent === 0 ? "" : (prefix + (isLast ? "     " : " │   "));
      children.forEach((child, i) => {
        if (!rendered.has(child)) {
          renderNode(child, indent + 1, i === children.length - 1, newPrefix);
        }
      });
    }

    for (const root of roots) {
      renderNode(root.name, 0, false, "");
      lines.push("");
    }

    const orphans = withDeps.filter((s) =>
      s.dependsOn.some((d) => !sessionNames.has(d))
    );
    if (orphans.length > 0) {
      lines.push("Broken dependencies:");
      for (const s of orphans) {
        const broken = s.dependsOn.filter((d) => !sessionNames.has(d));
        lines.push(`  ${s.name} -> ${broken.join(", ")} (not found)`);
      }
    }
  }

  lines.push("```");

  // Build wave assignments
  const waveSessions = sessions.map((s) => ({ name: s.name, dependsOn: s.dependsOn }));
  const waves = buildWaves(waveSessions);
  const waveLines = [];
  waves.forEach((wave, i) => {
    waveLines.push(`**Wave ${i + 1}:** ${wave.map((s) => s.name).join(", ")}`);
  });

  const completedCount = sessions.filter((s) => s.completed).length;
  const independentCount = roots.length;
  const dependentCount = withDeps.length;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Session Dependency Graph")
        .setDescription(lines.join("\n"))
        .addFields(
          { name: "Total", value: String(sessions.length), inline: true },
          { name: "Completed", value: `${completedCount}/${sessions.length}`, inline: true },
          { name: "Independent", value: String(independentCount), inline: true },
          { name: "With dependencies", value: String(dependentCount), inline: true },
          { name: "Execution Waves", value: waveLines.join("\n") || "All in Wave 1", inline: false },
        )
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });
}
