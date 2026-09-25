import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { obj, str } from "@/lib/validate";
import { jsonError, clientIp, rateLimit, rateLimitResponse } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { q } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendPowerSignal, FalixError, type FalixPowerSignal } from "@/lib/falix";
import { rconSendCommand, rconStatus } from "@/lib/rconService";
import { insertEvent } from "@/lib/events";
import { getDiscordNameMapping } from "@/lib/discord";
import { effectivePowerScope, scopeAllows } from "@/lib/power";
import type { Role } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated API for the standalone Discord bot service (see discord-bot/).
 * The bot identifies itself with BOT_SERVICE_KEY and acts ON BEHALF of a
 * Discord user mapped to a panel user — so every action goes through the SAME
 * permission system the web panel uses: DB roles + per-user power scopes.
 *
 * POST /api/bot  { action, discordId, ...params }
 *
 * Permission resolution for a Discord actor:
 *  1. Look up the actor's Discord ID in the panel's Discord-name mapping
 *     (Settings → Discord pings, same store as death pings).
 *  2. If it maps to a panel username, that user's real role + power_scope
 *     from the database decide what is allowed.
 *  3. If it does NOT map, the actor is the server owner's surrogate: they get
 *     the owner's own role (admin) — whoever deployed the bot service holds
 *     its key and is accountable for it. Everything is audited either way.
 */

interface BotCtx {
  discordId: string;
  /** null = unmapped actor acting as the owner's surrogate. */
  username: string | null;
  role: Role;
  powerScope: "full" | "start" | "none";
  displayName: string;
}

function surrogate(discordId: string): BotCtx {
  return {
    discordId,
    username: null,
    role: "admin",
    powerScope: "full",
    displayName: `Discord <@${discordId}>`,
  };
}

/**
 * The service key the bot must present. Stored in app_meta (editable from the
 * panel's Discord page) with the BOT_SERVICE_KEY env var as fallback.
 */
async function readServiceKey(): Promise<string | null> {
  try {
    const res = await q<{ value: { key?: string } }>(
      `select value from app_meta where key = 'bot_service_key'`,
    );
    const fromDb = res.rows[0]?.value?.key?.trim();
    if (fromDb) return fromDb;
  } catch {
    // DB unavailable — env fallback still works.
  }
  return getConfig().BOT_SERVICE_KEY || null;
}

async function authenticateBot(req: NextRequest, body: Record<string, unknown>): Promise<BotCtx | NextResponse> {
  const expected = await readServiceKey();
  const provided = req.headers.get("x-bot-key") ?? "";
  // Timing-safe compare — this key grants power actions.
  const ok =
    expected !== null &&
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    return jsonError(401, "unauthorized", "Invalid or missing bot service key");
  }

  const discordIdRaw = str(body, "discordId", { max: 25 });
  // Discord user IDs are 15-20 digits. Anything else cannot be a real actor —
  // rejecting early also prevents crafted short IDs from substring-matching
  // another user's mapping below.
  if (!/^\d{15,20}$/.test(discordIdRaw)) {
    return jsonError(400, "bad_request", "discordId must be a raw Discord user ID (15-20 digits)");
  }
  const discordId = discordIdRaw;
  const rl = rateLimit(`bot:${discordId}`, 30, 60_000);
  if (!rl.ok) return rateLimitResponse(rl.retryAfter);

  // Resolve the Discord actor through the panel's own Discord-name mapping.
  // Values may be <@id>, <@!id> or raw ids — extract the numeric id and
  // compare EXACTLY (never substring: ids share digit substrings).
  const mapping = await getDiscordNameMapping();
  const mappedMc = Object.entries(mapping).find(([, mention]) => {
    const m = mention.match(/(\d{15,21})/);
    return m ? m[1] === discordId : false;
  })?.[0];
  if (!mappedMc) return surrogate(discordId);

  const r = await q<{ username: string; username_display: string; role: string; power_scope: string | null }>(
    `select username::text as username, username_display, role, power_scope
     from users where username = $1 limit 1`,
    [mappedMc.toLowerCase()],
  );
  const row = r.rows[0];
  if (!row) return surrogate(discordId);

  const role = (["admin", "moderator", "player"].includes(row.role) ? row.role : "player") as Role;
  return {
    discordId,
    username: row.username,
    role,
    powerScope: effectivePowerScope(role, row.power_scope),
    displayName: row.username_display || row.username,
  };
}

function auditActor(ctx: BotCtx): { username: string; usernameDisplay: string } {
  return {
    username: ctx.username ?? ctx.discordId,
    usernameDisplay: `${ctx.displayName} (via Discord)`,
  };
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json().catch(() => ({}));
    const body = obj(raw);
    const auth = await authenticateBot(req, body);
    if (auth instanceof NextResponse) return auth;

    const action = str(body, "action", { max: 20 });
    const config = getConfig();
    const deny = (why: string) => jsonError(403, "bot_forbidden", why);
    const actor = auditActor(auth);

    switch (action) {
      case "status": {
        const rcon = await rconStatus().catch(() => ({ configured: false, online: false }));
        return NextResponse.json({
          ok: true,
          rcon,
          mcHost: config.MINECRAFT_SERVER_HOST || null,
          mcPort: config.MINECRAFT_SERVER_PORT || null,
        });
      }

      case "start":
      case "stop":
      case "restart": {
        const signal = action as FalixPowerSignal;
        if (!scopeAllows(auth.powerScope, signal)) {
          return deny(
            auth.powerScope === "start"
              ? "Your panel account may start the server but not stop or restart it"
              : "Your panel account has no server power permissions",
          );
        }
        const result = await sendPowerSignal(config.FALIX_SERVER_ID, signal);
        await audit(null, `bot.server.${signal}`, config.FALIX_SERVER_ID, {
          discordId: auth.discordId,
          actor: actor.username,
          mapped: auth.username ?? "owner-surrogate",
          state: result.state,
        }).catch(() => undefined);
        await insertEvent({
          type:
            signal === "start"
              ? "server_start"
              : signal === "stop"
                ? "server_stop"
                : "server_restart",
          message: `${signal} issued from Discord by ${auth.displayName} (state: ${result.state})`,
          data: { via: "discord-bot", discordId: auth.discordId, signal, state: result.state },
        }).catch(() => undefined);
        return NextResponse.json({ ok: true, signal: result.signal, state: result.state });
      }

      case "console": {
        if (auth.role !== "admin") return deny("Only panel admins may run console commands");
        const command = str(body, "command", { min: 1, max: 200 });
        const clean = command.replace(/[^\x20-\x7e]/g, "").trim();
        if (!clean) return jsonError(400, "bad_request", "Command is empty");
        if (/^(stop|end)$/i.test(clean)) {
          return deny("Refused — use the stop action for a graceful, notified shutdown");
        }
        const res = await rconSendCommand(clean, 8000);
        await audit(null, "bot.console", clean.slice(0, 40), {
          discordId: auth.discordId,
          actor: actor.username,
          ok: res.ok,
        }).catch(() => undefined);
        return NextResponse.json({ ok: res.ok, response: res.ok ? res.response : res.error });
      }

      case "players": {
        const res = await rconSendCommand("list", 6000);
        return NextResponse.json({ ok: res.ok, response: res.ok ? res.response : res.error });
      }

      case "graves": {
        const res = await q<{ player_name: string; x: number; y: number; z: number; dimension: string; death_time: string }>(
          `select player_name, x, y, z, dimension, death_time from graves
           where status = 'active' order by death_time desc limit 12`,
        );
        const graves = res.rows.map((g) => ({
          player: g.player_name,
          dimension: g.dimension,
          x: g.x,
          y: g.y,
          z: g.z,
          diedAt: g.death_time,
        }));
        return NextResponse.json({ ok: true, graves });
      }

      case "whoami": {
        return NextResponse.json({
          ok: true,
          discordId: auth.discordId,
          mappedPanelUser: auth.username,
          role: auth.role,
          powerScope: auth.powerScope,
        });
      }

      default:
        return jsonError(400, "bad_request", `Unknown action: ${action}`);
    }
  } catch (e) {
    // Upstream Falix errors (verification challenge, conflicts, rate limits)
    // keep their real status/code — a captcha demand must reach the bot as
    // such, not as a generic 500.
    if (e instanceof FalixError) {
      return jsonError(e.status, e.code, e.message, { actionUrl: e.actionUrl });
    }
    console.error("[api/bot] error:", e instanceof Error ? e.message : e);
    return jsonError(500, "internal", "Bot action failed");
  }
}
