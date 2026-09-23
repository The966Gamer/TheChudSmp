import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireCsrf, readJson, handleRouteError, clientIp, rateLimit, rateLimitResponse } from "@/lib/api";
import { obj, enumOf } from "@/lib/validate";
import { getConfig } from "@/lib/config";
import { sendPowerSignal, type FalixPowerSignal } from "@/lib/falix";
import { audit } from "@/lib/audit";
import { insertEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const guard = await requirePermission(req, "power_control");
    if (!guard.ok) return guard.res;
    const csrf = await requireCsrf(req, guard.ctx);
    if (!csrf.ok) return csrf.res;

    const ip = clientIp(req);
    const rl = rateLimit(`power:${guard.ctx.user.id}`, 12, 60_000);
    if (!rl.ok) return rateLimitResponse(rl.retryAfter);

    const body = obj(await readJson(req));
    const signal = enumOf<FalixPowerSignal>(body, "signal", ["start", "stop", "restart", "kill"]);

    const config = getConfig();
    const result = await sendPowerSignal(config.FALIX_SERVER_ID, signal);

    await audit(guard.ctx, `server.${signal}`, config.FALIX_SERVER_ID, { state: result.state }, ip);
    await insertEvent({
      type:
        signal === "start"
          ? "server_start"
          : signal === "stop"
            ? "server_stop"
            : signal === "restart"
              ? "server_restart"
              : "server_event",
      message: `${signal} issued by ${guard.ctx.user.usernameDisplay} via panel (state: ${result.state})`,
      data: { via: "panel", signal, state: result.state },
    }).catch(() => undefined);

    return NextResponse.json({ ok: true, signal: result.signal, state: result.state });
  } catch (e) {
    return handleRouteError(e);
  }
}
