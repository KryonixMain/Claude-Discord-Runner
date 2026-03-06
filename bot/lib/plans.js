export const CLAUDE_PLANS = {
  pro: {
    label: "Pro ($20/mo)",
    outputTokensPer5h: 44_000,
    promptsPer5h: 40,
    windowMs: 5 * 60 * 60 * 1000,
    weeklyHours: 80,
    avgOutputTokensPerPrompt: 1_100,
  },
  max5: {
    label: "Max 5× ($100/mo)",
    outputTokensPer5h: 88_000,
    promptsPer5h: 225,
    windowMs: 5 * 60 * 60 * 1000,
    weeklyHours: 400,
    avgOutputTokensPerPrompt: 1_100,
  },
  max20: {
    label: "Max 20× ($200/mo)",
    outputTokensPer5h: 220_000,
    promptsPer5h: 900,
    windowMs: 5 * 60 * 60 * 1000,
    weeklyHours: 1_600,
    avgOutputTokensPerPrompt: 1_100,
  },
};

export const DEFAULT_SETTINGS = {
  bot: {
    token: "",
    clientId: "",
    channelId: "",
    guildId: "",
    webhookUrl: "",
    locale: "en-US",
    webhookUrls: { default: "", security: "", progress: "" },
  },
  runner: {
    defaultModel: "claude-opus-4-6",
    maxTurns: 200,
    pauseMinutes: 360,
    autoSecurityFix: true,
    archiveOnComplete: true,
    claudePlan: "max20",
    skipPermissions: true,
    parallel: false,
    workDir: "",
    saveGeneratedPrompts: false,
    verification: null,
    // Example verification config:
    // verification: {
    //   commands: [
    //     { label: "Lint", command: "npm", args: ["run", "lint"], timeoutMs: 60000 },
    //     { label: "Tests", command: "npm", args: ["test"], timeoutMs: 4200000 },
    //     { label: "Build", command: "npm", args: ["run", "build"], timeoutMs: 180000 },
    //   ],
    //   autoStopAfter: 3,  // Stop after N consecutive verification failures (0 = never)
    // },
  },
  sessions: { count: 4 },
  logging:   { keepLogs: 10 },
  dashboard: { port: 3000 },
};

export const CHARS_PER_TOKEN = 4;
export const OUTPUT_RATIO    = 0.35;
export const SAFETY_MARGIN   = 0.80;
