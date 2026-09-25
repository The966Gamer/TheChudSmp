import { NextRequest, NextResponse } from "next/server";
import { jsonError, clientIp, rateLimit, rateLimitResponse } from "@/lib/api";
import { obj, str } from "@/lib/validate";
import { getConfig } from "@/lib/config";
import { q } from "@/lib/db";
import { rconStatus } from "@/lib/rconService";
import { sendPowerSignal } from "@/lib/falix";
import { insertEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Backend for the Minecraft mod's /panel commands. Authenticated with the
 * same X-Integration-Key the mod already uses for events/config, so no new
 * mod configuration is needed.
 *
 * POST { player: "<mc username>", command: "status" | "whoami" |
 *                        "notifications" | "restart" | "help" }
 *
 * The mod displays the returned `lines` to the player in-game. Restart is
 * performed by the PANEL (Falix power API) — vanilla servers have no restart
 * command, which is why the old in-game attempt silently did nothing.
 */

/** Panel users linked to a Minecraft name (same linkage Settings manages). */
async function panelUserFor(mcName: string): Promise<{ username: string; username_display: string; role: string; power_scope: string | null } | null> {
  try {
    const res = await q<{ username: string; username_display: string; role: string; power_scope: string | null }>(
      `select username::text as username, username_display, role, power_scope
       from users where mc_username = $1 limit 1`,
      [mcName],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`panel-command:${ip}`, 60, 60_000);
    if (!rl.ok) return rateLimitResponse(rl.retryAfter);

    const config = getConfig();
    if (!config.INTEGRATION_SECRET_KEY) {
      return jsonError(503, "integration_not_configured", "Integration secret is not configured");
    }
    const provided = req.headers.get("x-integration-key") ?? "";
    if (provided !== config.INTEGRATION_SECRET_KEY) {
      return jsonError(401, "unauthorized", "Invalid integration key");
    }

    const body = obj(await req.json().catch(() => ({})));
    const player = str(body, "player", { max: 20 });
    const command = str(body, "command", { max: 20 }).toLowerCase();

    switch (command) {
      case "help": {
        return NextResponse.json({
          ok: true,
          lines: [
            "/panel status — live TPS + panel link health",
            "/panel graves — your active graves",
            "/panel whoami — your panel account + permissions",
            "/panel notifications — recent panel notifications",
            "/panel server restart — admins: real restart via the panel",
          ],
        });
      }

      case "status": {
        const rcon = await rconStatus().catch(() => ({ configured: false, online: false, error: "unreachable", latencyMs: undefined }));
        return NextResponse.json({
          ok: true,
          lines: [
            `Panel: online`,
            `MC target: ${config.MINECRAFT_SERVER_HOST || "?"}:${config.MINECRAFT_SERVER_PORT || "?"}`,
            rcon.online ? `RCON: online (${rcon.latencyMs}ms)` : `RCON: ${rcon.configured ? "offline" : "not configured"}`,
          ],
        });
      }

      case "whoami": {
        const u = await panelUserFor(player);
        if (!u) {
          return NextResponse.json({
            ok: true,
            lines: [`No panel account is linked to "${player}".`, "Ask the admin to create one in Settings → Users."],
          });
        }
        return NextResponse.json({
          ok: true,
          lines: [`Panel account: ${u.username_display || u.username}`, `Role: ${u.role}`, `Server power: ${u.power_scope ?? "start"}`],
        });
      }

      case "notifications": {
        const res = await q<{ type: string; title: string; body: string | null; created_at: string }>(
          `select type, title, body, created_at from notifications
           where user_id is null order by created_at desc limit 10`,
        ).catch(() => ({ rows: [] as { type: string; title: string; body: string | null; created_at: string }[] }));
        if (res.rows.length === 0) {
          return NextResponse.json({ ok: true, lines: ["No recent panel notifications."] });
        }
        const fmt = (d: string) => {
          const diff = Date.now() - new Date(d).getTime();
          const m = Math.round(diff / 60_000);
          return m < 60 ? `${Math.max(1, m)}m ago` : `${Math.round(m / 60)}h ago`;
        };
        return NextResponse.json({
          ok: true,
          lines: res.rows.map((n) => `• [${fmt(n.created_at)}] ${n.title}${n.body ? ` — ${n.body.slice(0, 80)}` : ""}`),
        });
      }

      case "restart": {
        // The in-game command is admin-gated (vanilla permission level 3) on
        // the mod side; here we execute a REAL restart through the Falix API.
        const result = await sendPowerSignal(config.FALIX_SERVER_ID, "restart");
        await insertEvent({
          type: "server_restart",
          message: `Restart requested in-game by ${player} (state: ${result.state})`,
          data: { via: "minecraft", player, state: result.state },
        }).catch(() => undefined);
        return NextResponse.json({
          ok: true,
          lines: [`Restart signal sent to Falix — state: ${result.state ?? "unknown"}.`],
        });
      }

      default:
        return NextResponse.json({ ok: false, error: `Unknown panel command: ${command}` });
    }
  } catch (e) {
    console.error("[integration/panel-command] error:", e instanceof Error ? e.message : e);
    return jsonError(500, "internal", "Panel command failed");
  }
}
