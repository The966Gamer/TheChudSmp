import { hasPermission, type Role } from "./auth";

/**
 * Per-user server power scope. Independent of the panel role: a moderator can
 * be limited to start-only, a player can be granted full power, etc.
 *  - "full": start / stop / restart (the power action itself; the console is
 *    still a separate permission)
 *  - "start": may start the server, never stop or restart
 *  - "none": no power actions at all
 */
export type PowerScope = "full" | "start" | "none";

export const POWER_SCOPES: readonly PowerScope[] = ["full", "start", "none"] as const;

export function isPowerScope(v: unknown): v is PowerScope {
  return v === "full" || v === "start" || v === "none";
}

/** Admins always hold 'full'; everyone else uses their stored grant. */
export function effectivePowerScope(role: Role, stored: string | null | undefined): PowerScope {
  if (role === "admin") return "full";
  return isPowerScope(stored) ? stored : "full"; // legacy rows default to old behavior
}

/** Whether `scope` allows this specific power signal. */
export function scopeAllows(scope: PowerScope, signal: "start" | "stop" | "restart" | "kill"): boolean {
  if (!hasPermissionForPower(signal)) return false;
  switch (scope) {
    case "full":
      return signal === "start" || signal === "stop" || signal === "restart";
    case "start":
      return signal === "start";
    case "none":
      return false;
  }
}

function hasPermissionForPower(signal: string): boolean {
  return signal === "start" || signal === "stop" || signal === "restart" || signal === "kill";
}
