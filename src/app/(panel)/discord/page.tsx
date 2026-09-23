"use client";

import React from "react";
import { api } from "@/lib/client/api";
import { Panel, EmptyState, SkeletonRows } from "@/components/ui";

interface DiscordConfig {
  configured: boolean;
  maskedUrl: string | null;
  enabledEvents: string[];
  supportedEvents: string[];
  recent: { id: number; event_type: string; status: string; error: string | null; created_at: string; sent_at: string | null }[];
}

const EVENT_LABELS: Record<string, string> = {
  player_join: "Player joins",
  player_leave: "Player leaves",
  player_death: "Deaths",
  grave_created: "Grave creation",
  server_start: "Server started",
  server_stop: "Server stopped",
  server_restart: "Server restarted",
  server_crash: "Crashes",
};

export default function DiscordPage() {
  const [cfg, setCfg] = React.useState<DiscordConfig | null>(null);
  const [webhook, setWebhook] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api.get<DiscordConfig>("/api/discord").then(setCfg).catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  React.useEffect(load, [load]);

  async function save(events?: string[]) {
    setBusy("save");
    setMsg(null);
    try {
      await api.put("/api/discord", {
        ...(webhook.trim() ? { webhookUrl: webhook.trim() } : {}),
        ...(events ? { events } : {}),
      });
      setMsg({ ok: true, text: "Saved." });
      setWebhook("");
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setMsg(null);
    try {
      await api.post("/api/discord");
      setMsg({ ok: true, text: "Test queued — check Discord and the delivery log below." });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setBusy(null);
    }
  }

  async function removeWebhook() {
    setBusy("remove");
    try {
      await api.put("/api/discord", { webhookUrl: "" });
      setMsg({ ok: true, text: "Webhook removed." });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  function toggle(evt: string) {
    if (!cfg) return;
    const next = cfg.enabledEvents.includes(evt)
      ? cfg.enabledEvents.filter((x) => x !== evt)
      : [...cfg.enabledEvents, evt];
    setCfg({ ...cfg, enabledEvents: next });
    void save(next);
  }

  if (error) {
    return (
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 14 }}>Discord</h1>
        <div className="error-state">{error}</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 20 }}>Discord</h1>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>
          Server notifications delivered to a Discord channel through a webhook. The webhook URL is stored server-side and never exposed.
        </p>
      </div>

      {!cfg ? (
        <Panel><SkeletonRows rows={5} /></Panel>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
          <Panel title="Webhook">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="row">
                <span className={`badge ${cfg.configured ? "green" : "gray"}`}>
                  {cfg.configured ? "Configured" : "Not configured"}
                </span>
                {cfg.maskedUrl ? <code className="mono faint" style={{ fontSize: 12 }}>{cfg.maskedUrl}</code> : null}
              </div>
              <input
                className="input mono"
                placeholder="https://discord.com/api/webhooks/…"
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                spellCheck={false}
              />
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="btn primary" onClick={() => save()} disabled={busy !== null}>
                  {busy === "save" ? <span className="spinner" /> : "Save"}
                </button>
                <button className="btn" onClick={test} disabled={busy !== null || !cfg.configured}>
                  {busy === "test" ? <span className="spinner" /> : "Send test / flush queue"}
                </button>
                {cfg.configured ? (
                  <button className="btn danger" onClick={removeWebhook} disabled={busy !== null}>
                    Remove webhook
                  </button>
                ) : null}
              </div>
              {msg ? (
                <div style={{ fontSize: 13, color: msg.ok ? "var(--accent-strong)" : "var(--danger)" }}>{msg.text}</div>
              ) : null}
            </div>
          </Panel>

          <Panel title="Notification types">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {cfg.supportedEvents.map((evt) => {
                const on = cfg.enabledEvents.includes(evt);
                return (
                  <button
                    key={evt}
                    onClick={() => toggle(evt)}
                    className="spread"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: `1px solid ${on ? "rgba(85,176,104,0.4)" : "var(--border)"}`,
                      background: on ? "var(--accent-dim)" : "rgba(148,163,184,0.04)",
                      color: "var(--text)",
                      font: "inherit",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {EVENT_LABELS[evt] ?? evt}
                    <span className={`badge ${on ? "green" : "gray"}`}>{on ? "on" : "off"}</span>
                  </button>
                );
              })}
            </div>
            <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
              Toggles take effect immediately for queued events. Falix-side server start/stop/crash webhooks (if configured in the Falix dashboard) are separate and use the same channel.
            </p>
          </Panel>

          <Panel title="Recent deliveries" bodyStyle={{ padding: 0 }}>
            {cfg.recent.length === 0 ? (
              <EmptyState icon="discord" title="No deliveries yet" hint="Queued notifications will show their delivery status here." />
            ) : (
              cfg.recent.map((d) => (
                <div key={d.id} className="spread" style={{ padding: "9px 16px", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{EVENT_LABELS[d.event_type] ?? d.event_type}</span>
                    {d.error ? <span className="dim"> — {d.error}</span> : null}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className={`badge ${d.status === "sent" ? "green" : d.status === "failed" ? "red" : d.status === "skipped" ? "gray" : "amber"}`}>
                      {d.status}
                    </span>
                    <span className="faint">{new Date(d.created_at).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
