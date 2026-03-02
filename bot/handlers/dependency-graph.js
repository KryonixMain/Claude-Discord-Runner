import { EmbedBuilder } from "discord.js";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { SESSION_DIR } from "../lib/paths.js";
import { loadState } from "../lib/helpers.js";

function parseOverride(content) {
  const match = content.match(/<!--\nSESSION OVERRIDE CONFIG\n([\s\S]*?)-->/);
  if (match) {
    try { return JSON.parse(match[1]); } catch { /* ignore */ }
  }
  return {};
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

  // Parse sessions and their dependencies
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

  // Build the graph visualization
  const lines = [];
  const sessionNames = new Set(sessions.map((s) => s.name));

  // Find roots (no dependencies) and dependents
  const roots = sessions.filter((s) => s.dependsOn.length === 0);
  const withDeps = sessions.filter((s) => s.dependsOn.length > 0);

  // Build adjacency for display
  const dependents = new Map(); // parent -> [children]
  for (const s of sessions) {
    for (const dep of s.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(s.name);
    }
  }

  // Status indicator
  const icon = (s) => s.completed ? "[done]" : "[    ]";

  // Render tree
  lines.push("```");

  if (withDeps.length === 0) {
    // No dependencies — all sessions are independent
    lines.push("All sessions are independent (no dependencies):");
    lines.push("");
    for (const s of sessions) {
      lines.push(`  ${icon(s)} ${s.name}`);
    }
  } else {
    // Show dependency tree
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

    // Start from roots
    for (const root of roots) {
      renderNode(root.name, 0, false, "");
      lines.push("");
    }

    // Show any sessions with unresolvable deps (pointing to non-existent sessions)
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

  // Summary
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
        )
        .setColor(0x5865f2)
        .setTimestamp(),
    ],
  });
}
