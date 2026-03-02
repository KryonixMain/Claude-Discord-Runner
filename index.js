import client from "./bot/client.js";
import { getSetting } from "./bot/lib/settings.js";
import { startDashboard } from "./dashboard/server.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || getSetting("bot", "token");
client.login(BOT_TOKEN);
startDashboard();
