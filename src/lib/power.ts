import type { Role } from "./auth";

/**
 * Per-user server power scope. Independent of the panel role: a moderator can
 * be limited to start-only, a player can be granted full power, etc.
 *  - "full": start / stop / restart (the console is a separate permission)
 *  - "start": may start the server, never stop or restart
 *  - "none": no power actions at all
 */
export type PowerScope = "full" | "start" | "none";

export const POWER_SCOPES: readonly PowerScope[] = ["full", "start", "none"] as const;

export function isPowerScope(v: unknown): v is PowerScope {
  return v === "full" || v === "start" || v === "none";
}

/**
 * Effective scope. Admins ALWAYS hold 'full' — that is decided by the role
 * from the database session, never by username and never overridable by a
 * stored column. Everyone else: exactly what an admin granted them. Users
 * created before the power_scope column existed default to 'start' (they may
 * start the server, never stop or restart — the product default).
 */
export function effectivePowerScope(role: Role, stored: string | null | undefined): PowerScope {
  if (role === "admin") return "full";
  if (isPowerScope(stored)) return stored;
  return "start";
}

/** Whether `scope` allows this specific power signal. */
export function scopeAllows(scope: PowerScope, signal: "start" | "stop" | "restart" | "kill"): boolean {
  switch (scope) {
    case "full":
      return signal === "start" || signal === "stop" || signal === "restart";
    case "start":
      return signal === "start";
    case "none":
      return false;
  }
}
