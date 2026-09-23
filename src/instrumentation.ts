/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * Starts the Discord queue worker at startup so queued notifications
 * (deaths, graves, server events) are delivered even when no browser is
 * open. Previously the worker only started when someone loaded the panel's
 * realtime stream, which silently dropped notifications otherwise.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureDiscordWorker } = await import("@/lib/discord");
  ensureDiscordWorker();
}
