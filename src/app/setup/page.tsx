import { redirect } from "next/navigation";
import { isConfigured } from "@/lib/config";
import { isSeeded } from "@/lib/seed";
import SetupWizard from "./SetupWizard";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const configured = isConfigured();
  const seeded = configured ? await isSeeded().catch(() => false) : false;
  if (configured && seeded) {
    redirect("/login");
  }
  return <SetupWizard />;
}
