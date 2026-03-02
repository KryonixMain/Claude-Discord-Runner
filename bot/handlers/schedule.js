import { EmbedBuilder } from "discord.js";
import { getScheduledTimer, setScheduledTimer, clearScheduledTimer, isRunning } from "../state.js";
import { startRunProcess } from "../process.js";

export async function handleSchedule(interaction) {
  await interaction.deferReply();

  const timeStr = interaction.options.getString("time");

  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Invalid time format")
          .setDescription("Use `HH:MM` (24-hour), e.g. `03:00` or `14:30`.")
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  const hours   = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours > 23 || minutes > 59) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Invalid time")
          .setDescription("Hours must be 0-23, minutes 0-59.")
          .setColor(0xed4245)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (getScheduledTimer()) {
    clearScheduledTimer();
  }

  const now   = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  const delayMs = target.getTime() - now.getTime();
  const channel = interaction.channel;

  const timer = setTimeout(async () => {
    setScheduledTimer(null);
    if (isRunning()) {
      await channel?.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Scheduled run skipped")
            .setDescription("A run is already in progress.")
            .setColor(0xfee75c)
            .setTimestamp(),
        ],
      });
      return;
    }
    await channel?.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Scheduled run starting")
          .setDescription(`Scheduled start at ${timeStr} triggered.`)
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
    await startRunProcess([], channel);
  }, delayMs);

  setScheduledTimer(timer);

  const delayMin = Math.round(delayMs / 60_000);
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Run scheduled")
        .addFields(
          { name: "Start at",     value: timeStr,                                inline: true },
          { name: "In",           value: `~${delayMin} min`,                     inline: true },
          { name: "Target date",  value: target.toLocaleDateString("en-US"),      inline: true },
        )
        .setColor(0x57f287)
        .setFooter({ text: "Use /cancel-schedule to cancel" })
        .setTimestamp(),
    ],
  });
}

export async function handleCancelSchedule(interaction) {
  if (!getScheduledTimer()) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("No schedule active")
          .setDescription("There is no scheduled run to cancel.")
          .setColor(0xfee75c)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  clearScheduledTimer();
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Schedule cancelled")
        .setDescription("The scheduled run has been cancelled.")
        .setColor(0xed4245)
        .setTimestamp(),
    ],
  });
}
