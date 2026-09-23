import { redirect } from "next/navigation";
import { isConfigured } from "@/lib/config";
import { isSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

/**
 * Server-side first-run gate: fresh installs land on /setup, configured but
 * unseeded installs also complete setup, everything else goes to /login.
 */
export default async function Home() {
  const configured = isConfigured();
  const seeded = configured ? await isSeeded().catch(() => false) : false;
  if (!configured || !seeded) {
    redirect("/setup");
  }
  redirect("/login");
}
