import { EmbedBuilder } from "discord.js";
import { isRunning, isSecurityFixRunning, getRunningProcess, setRunningProcess, getSecurityFixProcess, setSecurityFixProcess } from "../state.js";
import { killProcessGracefully } from "../lib/helpers.js";

export async function handleStop(interaction) {
  const killed = [];

  if (isRunning()) {
    await killProcessGracefully(getRunningProcess(), "run-sessions.js");
    setRunningProcess(null);
    killed.push("run-sessions.js");
  }
  if (isSecurityFixRunning()) {
    await killProcessGracefully(getSecurityFixProcess(), "Security Fix");
    setSecurityFixProcess(null);
    killed.push("Security Fix");
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(killed.length > 0 ? "Stopped" : "Nothing is running")
        .setDescription(
          killed.length > 0
            ? `Stopped: ${killed.join(", ")}\nProgress is preserved — use \`/restart\` to continue.`
            : "No running process found.",
        )
        .setColor(killed.length > 0 ? 0xed4245 : 0xfee75c)
        .setTimestamp(),
    ],
  });
}
