import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/api";
import { getSettings, FEATURES } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await auth(req);
  if (!ctx) return NextResponse.json({ user: null }, { status: 401 });
  let features: string[] = [...FEATURES];
  try {
    features = Object.entries((await getSettings()).features)
      .filter(([, on]) => on)
      .map(([id]) => id);
  } catch {
    // settings table unavailable — all features stay visible
  }
  return NextResponse.json({
    user: {
      id: ctx.user.id,
      username: ctx.user.usernameDisplay,
      role: ctx.user.role,
      mcUsername: ctx.user.mcUsername,
      headUrl: ctx.user.headUrl,
    },
    csrfToken: ctx.csrfToken,
    features,
  });
}
