/**
 * Falix Control Panel — standalone Discord bot service.
 *
 * Runs as its own persistent process (your PC, a VPS, a Raspberry Pi —
 * anywhere Node 18+ runs). NOT part of the Netlify deployment: a long-lived
 * Discord gateway socket cannot live in serverless functions.
 *
 * Slash commands call the panel's /api/bot endpoint with PANEL_SERVICE_KEY,
 * so every action goes through the panel's REAL permission system (DB roles +
 * per-user power scopes). Players who may only start the server get exactly
 * that here too; admins get full control.
 *
 * Setup:  npm install   →   fill .env   →   npm start
 */
const WebSocket = require("ws");
const fs = require("fs");

// ---- env ------------------------------------------------------------------
function loadEnv() {
  try {
    for (const line of fs.readFileSync(`${__dirname}/.env`, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — real environment variables still work */
  }
}
loadEnv();

const TOKEN = (process.env.DISCORD_BOT_TOKEN || "").trim();
const PANEL_URL = (process.env.PANEL_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = (process.env.PANEL_SERVICE_KEY || "").trim();
const API = "https://discord.com/api/v10";

if (!TOKEN || !PANEL_URL || !SERVICE_KEY) {
  console.error("[bot] Missing config. Fill discord-bot/.env (copy .env.example):");
  console.error("       DISCORD_BOT_TOKEN, PANEL_URL (e.g. http://localhost:3000), PANEL_SERVICE_KEY");
  process.exit(1);
}

// ---- panel client ----------------------------------------------------------
async function panel(action, extra = {}) {
  const res = await fetch(`${PANEL_URL}/api/bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bot-key": SERVICE_KEY },
    body: JSON.stringify({ action, discordId: CURRENT_USER_ID || "0", ...extra }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Panel error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// ---- slash commands ---------------------------------------------------------
const COMMANDS = [
  { name: "status", description: "Minecraft server status (RCON + host)" },
  { name: "start", description: "Start the Minecraft server" },
  { name: "stop", description: "Stop the Minecraft server (admins)" },
  { name: "restart", description: "Restart the Minecraft server (admins)" },
  {
    name: "console",
    description: "Run a server console command (admins)",
    options: [{ name: "command", description: "e.g. say hello, whitelist add Steve", type: 3, required: true }],
  },
  { name: "players", description: "List online players" },
  { name: "graves", description: "List active graves from the panel" },
  { name: "whoami", description: "Show your panel role and server-power permissions" },
];

async function registerCommands(applicationId) {
  const res = await fetch(`${API}/applications/${applicationId}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
  });
  if (!res.ok) throw new Error(`command registration failed: ${res.status} ${await res.text().catch(() => "")}`);
  console.log("[bot] slash commands registered:", COMMANDS.map((c) => `/${c.name}`).join(" "));
}

// ---- interaction handling ----------------------------------------------------
let CURRENT_USER_ID = null;

async function handleInteraction(d) {
  const name = d?.data?.name;
  if (!name || !d.id || !d.token) return;
  CURRENT_USER_ID = d?.member?.user?.id ?? d?.user?.id ?? null;
  const reply = (content) =>
    fetch(`${API}/interactions/${d.id}/${d.token}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 4, data: { content: String(content).slice(0, 1900) } }),
    }).catch(() => undefined);

  try {
    switch (name) {
      case "status": {
        const s = await panel("status");
        await reply(
          [
            "```",
            s.rcon.online ? `RCON: online (${s.rcon.latencyMs}ms)` : s.rcon.configured ? `RCON: offline — ${s.rcon.error ?? "unreachable"}` : "RCON: not configured",
            `MC: ${s.mcHost ?? "?"}:${s.mcPort ?? "?"}`,
            "```",
          ].join("\n"),
        );
        break;
      }
      case "start":
      case "stop":
      case "restart": {
        const r = await panel(name);
        await reply(`✅ Server ${name} sent — state: ${r.state ?? "unknown"}`);
        break;
      }
      case "console": {
        const r = await panel("console", { command: d.data.options?.find((o) => o.name === "command")?.value ?? "" });
        await reply(r.ok ? `\`${r.response || "(no output)"}\`` : `❌ ${r.response}`);
        break;
      }
      case "players": {
        const r = await panel("players");
        await reply(r.ok ? `Players online: ${r.response}` : `❌ ${r.response}`);
        break;
      }
      case "graves": {
        const r = await panel("graves");
        if (!r.graves.length) return void (await reply("No active graves — nobody has died (recently)."));
        await reply(
          ["**Active graves**", ...r.graves.map((g) => `**${g.player}** — ${g.dimension} @ ${g.x}, ${g.y}, ${g.z}`)].join("\n"),
        );
        break;
      }
      case "whoami": {
        const w = await panel("whoami");
        await reply(
          w.mappedPanelUser
            ? `You are panel user **${w.mappedPanelUser}** — role: **${w.role}**, server power: **${w.powerScope}**`
            : "Your Discord ID is not linked to a panel user — you act as the owner (admin). Link it in the panel: Settings → Discord pings (use your raw Discord user ID).",
        );
        break;
      }
      default:
        await reply(`Unknown command: ${name}`);
    }
  } catch (e) {
    await reply(`❌ ${e.message}`).catch(() => undefined);
  }
}

// ---- gateway -----------------------------------------------------------------
let ws = null;
let heartbeatTimer = null;
let lastSeq = null;
let sessionId = null;

function connect() {
  ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
  ws.on("open", () => {
    /* wait for HELLO */
  });
  ws.on("message", (raw) => {
    let p;
    try {
      p = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (p.s != null) lastSeq = p.s;
    if (p.op === 10) {
      const interval = p.d?.heartbeat_interval ?? 41250;
      heartbeatTimer = setInterval(() => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op: 1, d: lastSeq })), interval);
      if (sessionId) ws.send(JSON.stringify({ op: 6, d: { token: TOKEN, session_id: sessionId, seq: lastSeq } }));
      else
        ws.send(
          JSON.stringify({
            op: 2,
            d: { token: TOKEN, intents: 0, properties: { os: "node", browser: "falix-panel-bot", device: "falix-panel-bot" } },
          }),
        );
    } else if (p.t === "READY") {
      sessionId = p.d?.session_id ?? null;
      console.log(`[bot] gateway ready as ${p.d?.user?.username ?? "?"}`);
      registerCommands(p.d?.application?.id ?? p.d?.user?.id).catch((e) => console.error("[bot]", e.message));
    } else if (p.t === "INTERACTION_CREATE") {
      handleInteraction(p.d).catch((e) => console.error("[bot] interaction error:", e.message));
    } else if (p.op === 7) {
      ws.close(4000);
    } else if (p.op === 9) {
      setTimeout(connect, 3000);
    }
  });
  ws.on("close", (code) => {
    clearInterval(heartbeatTimer);
    const backoff = Math.min(30_000, 2000 * 2 ** Math.min(4, code === 4004 ? 4 : 1));
    console.log(`[bot] closed (${code}) — reconnecting in ${Math.round(backoff / 1000)}s`);
    setTimeout(connect, backoff);
  });
  ws.on("error", () => {
    /* close event follows */
  });
}

connect();
