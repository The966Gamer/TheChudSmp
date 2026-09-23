"use client";

import React from "react";
import { api, ApiError } from "./api";

export type PowerSignal = "start" | "stop" | "restart";

export interface Verification {
  /** Falix-provided https URL hosting the verification challenge. */
  url: string;
  /** The power signal to re-send once the user completes the challenge. */
  signal: PowerSignal;
}

/**
 * Single owner of server power-action UI state: which signal is in flight,
 * the last error, and the Falix free-plan verification flow (a challenge URL
 * the user must complete before Falix honors a start).
 *
 * Flow: power("start") → 409 with action_url → dialog opens → user solves the
 * captcha → retryVerification() re-sends the same signal → success closes the
 * dialog. A repeated challenge URL replaces the old one (links expire in 5 min).
 */
export function useServerPower(onSuccess?: () => void) {
  const [busySignal, setBusySignal] = React.useState<PowerSignal | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [verification, setVerification] = React.useState<Verification | null>(null);
  const [verifyBusy, setVerifyBusy] = React.useState(false);

  const extractChallenge = (e: unknown): string | undefined => {
    const url = e instanceof ApiError ? e.actionUrl : (e as { actionUrl?: string })?.actionUrl;
    return typeof url === "string" && url.startsWith("https://") ? url : undefined;
  };

  const power = React.useCallback(
    async (signal: PowerSignal) => {
      setBusySignal(signal);
      setError(null);
      try {
        await api.post("/api/server/power", { signal });
      } catch (e) {
        // A verification challenge opens the dialog INSTEAD of showing an
        // error — the user's next step is the captcha, not an error message.
        const url = extractChallenge(e);
        if (url) {
          setError(null);
          setVerification({ url, signal });
        } else {
          setError(e instanceof Error ? e.message : "Action failed");
        }
      } finally {
        setBusySignal(null);
      }
    },
    [],
  );

  const retryVerification = React.useCallback(async () => {
    if (!verification) return;
    setVerifyBusy(true);
    try {
      await api.post("/api/server/power", { signal: verification.signal });
      setVerification(null);
      onSuccess?.();
    } catch (e) {
      const url = extractChallenge(e);
      if (url) {
        // Challenge not finished yet (or a fresh link arrived): swap the URL
        // quietly — the dialog stays open on the captcha, no error text.
        setVerification({ url, signal: verification.signal });
      } else {
        // Not a challenge (e.g. Falix is already booting): close the dialog,
        // refresh status, and surface any real message in the controls widget.
        setVerification(null);
        setError(e instanceof Error ? e.message : "Action failed");
        onSuccess?.();
      }
    } finally {
      setVerifyBusy(false);
    }
  }, [verification, onSuccess]);

  const dismissVerification = React.useCallback(() => {
    setVerification(null);
  }, []);

  /**
   * Falix auto-starts the server once the captcha is solved, so while the
   * dialog is open we watch server status: the moment the panel sees the
   * server running/starting, the dialog closes itself — no button press
   * needed. Status reads go straight to the status API (bypassing the
   * caller's refresh callback, which may be tied to component lifecycles).
   */
  React.useEffect(() => {
    if (!verification) return;
    let cancelled = false;
    const check = async () => {
      try {
        const s = await api.get<{ falix?: { status?: string } }>("/api/status");
        if (cancelled) return;
        const st = s.falix?.status;
        if (st === "running" || st === "starting") {
          setVerification(null);
          onSuccess?.();
        }
      } catch {
        // transient — keep polling
      }
    };
    const t = setInterval(check, 4000);
    void check();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [verification, onSuccess]);

  return {
    busySignal,
    error,
    verification,
    verifyBusy,
    power,
    retryVerification,
    dismissVerification,
  };
}
