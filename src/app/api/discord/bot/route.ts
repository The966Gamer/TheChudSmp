import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireCsrf, readJson, handleRouteError } from "@/lib/api";
import { obj } from "@/lib/validate";
import { getConfig, maskSecret } from "@/lib/config";
import { q } from "@/lib/db";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin settings for the STANDALONE Discord bot service (discord-bot/).
 *
 * The bot itself does NOT run inside the panel — a persistent Discord gateway
 * connection cannot live in serverless functions. The panel only stores the
 * bot's service key (BOT_SERVICE_KEY) that authorizes the bot service to call
 * /api/bot. The Discord bot TOKEN lives only in the bot service's own .env.
 */

/** Stored in app_meta so it can be changed from the panel on any host. */
const KEY = "bot_service_key";

async function readKey(): Promise<string | null> {
  try {
    const res = await q<{ value: { key?: string } }>(
      `select value from app_meta where key = 'bot_service_key'`,
    );
    return res.rows[0]?.value?.key?.trim() || getConfig().BOT_SERVICE_KEY || null;
  } catch {
    return getConfig().BOT_SERVICE_KEY || null;
  }
}

async function writeKey(key: string | null): Promise<void> {
  if (key === null) {
    await q(`delete from app_meta where key = 'bot_service_key'`);
    return;
  }
  await q(
    `insert into app_meta (key, value) values ('bot_service_key', $1::jsonb)
     on conflict (key) do update set value = $1::jsonb, updated_at = now()`,
    [JSON.stringify({ key })],
  );
}

export async function GET(req: NextRequest) {
  try {
    const guard = await requirePermission(req, "manage_discord");
    if (!guard.ok) return guard.res;
    const key = await readKey();
    return NextResponse.json({
      ok: true,
      configured: Boolean(key),
      maskedKey: key ? maskSecret(key) : null,
    });
  } catch (e) {
    return handleRouteError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requirePermission(req, "manage_discord");
    if (!guard.ok) return guard.res;
    const csrf = await requireCsrf(req, guard.ctx);
    if (!csrf.ok) return csrf.res;

    const body = obj(await readJson(req));
    if (body.key === "" || body.key === null) {
      await writeKey(null);
      await audit(guard.ctx, "bot_service_key.remove", "bot_service_key");
      return NextResponse.json({ ok: true, removed: true });
    }
    const key = String(body.key).trim();
    if (key.length < 16 || key.length > 200) {
      return NextResponse.json(
        { error: { code: "bad_request", message: "Service key must be 16-200 characters" } },
        { status: 400 },
      );
    }
    await writeKey(key);
    await audit(guard.ctx, "bot_service_key.save", "bot_service_key");
    return NextResponse.json({ ok: true, configured: true });
  } catch (e) {
    return handleRouteError(e);
  }
}
