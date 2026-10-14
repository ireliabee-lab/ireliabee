import { useEffect, useState } from "react";
import { SlidersHorizontal, ArrowLeftRight, Sparkles } from "lucide-react";
import SettingsView from "./SettingsView";
import AccountPanel from "./AccountPanel";
import TransferView from "./TransferView";
import { track } from "../lib/usage";
import { useAccount } from "../lib/account";
import Page, { PageTab } from "./Page";

type Tab = "general" | "data" | "plan";

/**
 * Settings with its sections as tabs (roadmap 1.8): General (models, listening,
 * appearance), Your account (sign-in and credits) and Your data (export /
 * import, formerly the Transfer menu item). `section="data"` opens Your data —
 * old Transfer links land there — and `section="plan"` is where every "I need
 * to sign in" route ends up, keeping the links that already point at it.
 */
export default function SettingsHub({ section }: { section?: string }) {
  // Models are the admin's setting alone; nobody else is told they exist.
  const { admin } = useAccount();
  const [tab, setTab] = useState<Tab>(
    section === "data" ? "data" : section === "plan" ? "plan" : "general");
  useEffect(() => { track(`settings.${tab}`); }, [tab]);

  return (
    <Page
      title="Settings"
      subtitle={admin
        ? "Models, how the coach listens and answers, how the app looks, your account and your data."
        : "How the coach listens and answers, how the app looks, your account and your data."}
      tabs={<>
        <PageTab active={tab === "general"} icon={<SlidersHorizontal size={14} />} onClick={() => setTab("general")}>General</PageTab>
        <PageTab active={tab === "plan"} icon={<Sparkles size={14} />} onClick={() => setTab("plan")}>Your account</PageTab>
        <PageTab active={tab === "data"} icon={<ArrowLeftRight size={14} />} onClick={() => setTab("data")}>Your data</PageTab>
      </>}
    >
      {tab === "general" ? <SettingsView /> : tab === "plan" ? <AccountPanel /> : <TransferView />}
    </Page>
  );
}
