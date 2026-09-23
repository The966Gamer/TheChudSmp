import { NextRequest, NextResponse } from "next/server";
import { requirePermission, handleRouteError } from "@/lib/api";
import { q } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const guard = await requirePermission(req, "manage_permissions");
    if (!guard.ok) return guard.res;
    const res = await q<{
      username: string;
      username_display: string;
      role: string;
      created_at: Date;
    }>(
      `select username, username_display, role, created_at from users order by created_at asc limit 100`,
    );
    return NextResponse.json({
      ok: true,
      users: res.rows.map((r) => ({
        username: r.username,
        displayName: r.username_display,
        role: r.role,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    return handleRouteError(e);
  }
}
