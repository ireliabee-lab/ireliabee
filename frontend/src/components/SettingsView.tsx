import { useEffect, useState } from "react";
import { Key, CheckCircle, XCircle, Save, RefreshCw, Eye, EyeOff, Maximize2, ExternalLink } from "lucide-react";
import { errorFromResponse, notifyError } from "../lib/errors";
import toast from "react-hot-toast";
import GlassSelect from "./GlassSelect";
import { LANGUAGE_OPTIONS } from "../lib/languages";
import { ThemePicker, PatternPicker } from "./LookPicker";
import { openExternal } from "../lib/openExternal";
import { RESPONSE_TONES } from "./PreferencesModal";
import { fetchApi, isTauri } from "../lib/api";
import { TEXT_SIZES, getTextSize, setTextSize } from "../lib/textSize";
import { PAGE_WIDTHS, WINDOW_SIZES, getPageWidth, setPageWidth, canResizeWindow, monitorLimit, resizeWindow, type PageWidthId } from "../lib/pageWidth";
import { PAUSE_TOLERANCES, getPauseTolerance, setPauseTolerance, type PauseToleranceId } from "../lib/turnAssembler";
import { PERSONAS, getPersona, setPersona, type PersonaId } from "../lib/persona";
import { useAccount } from "../lib/account";
import { keepInTray, setKeepInTray, setStartsAtLogin, startsAtLogin } from "../lib/notify";
import { reminderSound, setReminderSound } from "../lib/reminderSound";
import PhoneSettings from "./PhoneSettings";
import ClaudeOneClick from "./ClaudeOneClick";
import { getRelayStatus, relayReady, getMcpUrl, regenerateRelayKey, getBridgeLaunch, claudeAddCommand, antigravityConfig, codexConfig, type BridgeLaunch, type RelayStatus } from "../lib/relay";

interface ModelDef  { id: string; label: string; }
interface ProviderDef {
  id: string;
  env: string | null;
  has_key: boolean;
  models: ModelDef[];
  default_model: string;
}
interface ResearchKey { env: string; label: string; hint: string; url: string; has_key: boolean; }
interface ConfigData {
  saved: { provider?: string; model?: string; stt_provider?: string; stt_model?: string; response_tone?: string; english_support?: boolean; language?: string; notebook_auto?: boolean; notebook_relay?: boolean };
  llm_providers: ProviderDef[];
  stt_providers: ProviderDef[];
  research_keys?: ResearchKey[];
}

export default function SettingsView() {
  const [data, setData]       = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  // Own provider keys (`admin`) and the backoffice are two grants an owner
  // switches in the backoffice. The service decides both, so neither can be
  // turned on from the client.
  const { admin, backoffice } = useAccount();

  // The backoffice is on the web; the app vouches for the browser it opens
  // with a one-time link, so the admin never waits on a sign-in email.
  const [openingBackoffice, setOpeningBackoffice] = useState(false);
  async function openBackoffice() {
    setOpeningBackoffice(true);
    try {
      const res = await fetchApi("/account/backoffice", { method: "POST" });
      if (!res.ok) throw await errorFromResponse(res);
      const { url } = await res.json();
      await openExternal(url);
    } catch (e) {
      notifyError(e);
    } finally {
      setOpeningBackoffice(false);
    }
  }

  const [llmProvider, setLlmProvider] = useState("");
  const [llmModel, setLlmModel]       = useState("");
  const [sttProvider, setSttProvider] = useState("");
  const [sttModel, setSttModel]       = useState("");
  const [responseTone, setResponseTone] = useState("advanced");
  const [englishSupport, setEnglishSupport] = useState(false);
  const [notebookAuto, setNotebookAuto] = useState(true);
  const [notebookRelay, setNotebookRelay] = useState(false);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [mcpUrl, setMcpUrl] = useState("");
  const [regeneratingKey, setRegeneratingKey] = useState(false);
  const [bridge, setBridge] = useState<BridgeLaunch | null>(null);
  useEffect(() => { void getBridgeLaunch().then(setBridge); }, []);

  async function handleRegenerateKey() {
    setRegeneratingKey(true);
    try {
      await regenerateRelayKey();
      toast.success("Regenerated relay pairing key");
      const [st, url] = await Promise.all([getRelayStatus(), getMcpUrl()]);
      setRelayStatus(st);
      setMcpUrl(url);
    } catch {
      toast.error("Failed to regenerate pairing key");
    } finally {
      setRegeneratingKey(false);
    }
  }

  useEffect(() => {
    let live = true;
    async function updateRelay() {
      try {
        const [st, url] = await Promise.all([getRelayStatus(), getMcpUrl()]);
        if (live) {
          setRelayStatus(st);
          setMcpUrl(url);
        }
      } catch {
        // backend might be busy/starting
      }
    }
    updateRelay();
    const interval = setInterval(updateRelay, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, []);
  const [tray, setTray] = useState(keepInTray);
  const [chime, setChime] = useState(reminderSound);
  const [atLogin, setAtLogin] = useState(false);
  useEffect(() => { void startsAtLogin().then(setAtLogin); }, []);
  const [language, setLanguage] = useState("en");
  const [textSize, setTextSizeState] = useState(getTextSize);
  const [pageWidth, setPageWidthState] = useState<PageWidthId>(getPageWidth);
  const [screenLimit, setScreenLimit] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => { monitorLimit().then(setScreenLimit); }, []);
  const [pauseTolerance, setPauseToleranceState] = useState<PauseToleranceId>(getPauseTolerance);
  const [persona, setPersonaState] = useState<PersonaId | null>(getPersona);
  useEffect(() => {
    const h = () => setPersonaState(getPersona());
    window.addEventListener("persona-changed", h);
    return () => window.removeEventListener("persona-changed", h);
  }, []);
  // Keep the picker in sync when Ctrl +/− changes the size.
  useEffect(() => {
    const h = () => setTextSizeState(getTextSize());
    window.addEventListener("text-size", h);
    return () => window.removeEventListener("text-size", h);
  }, []);

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<Record<string, boolean>>({});
  const [keyHidden, setKeyHidden] = useState<Record<string, boolean>>({});

  async function fetchConfig() {
    setLoading(true);
    try {
      const r = await fetchApi("/config");
      if (!r.ok) throw new Error(r.status.toString());
      const d: ConfigData = await r.json();
      setData(d);
      setLlmProvider(d.saved.provider ?? d.llm_providers[0]?.id ?? "");
      setLlmModel(d.saved.model ?? d.llm_providers[0]?.default_model ?? "");
      // A saved choice this install doesn't offer (e.g. offline Whisper, which the
      // packaged app doesn't ship) falls back to Deepgram, the live-streaming default.
      const savedStt = d.stt_providers.find(p => p.id === d.saved.stt_provider);
      const stt = savedStt ?? d.stt_providers.find(p => p.id === "deepgram") ?? d.stt_providers[0];
      setSttProvider(stt?.id ?? "");
      setSttModel((savedStt && d.saved.stt_model) || stt?.default_model || "");
      setResponseTone(d.saved.response_tone ?? "advanced");
      setEnglishSupport(Boolean(d.saved.english_support));
      setNotebookAuto(d.saved.notebook_auto !== false);
      setNotebookRelay(Boolean(d.saved.notebook_relay));
      setLanguage(d.saved.language ?? "en");
    } catch {
      toast.error("Failed to load config — is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchConfig(); }, []);

  function onLlmProviderChange(id: string) {
    setLlmProvider(id);
    const prov = data?.llm_providers.find(p => p.id === id);
    setLlmModel(prov?.default_model ?? "");
  }

  function onSttProviderChange(id: string) {
    setSttProvider(id);
    const prov = data?.stt_providers.find(p => p.id === id);
    setSttModel(prov?.default_model ?? "");
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const r = await fetchApi("/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: llmProvider, model: llmModel, stt_provider: sttProvider, stt_model: sttModel, response_tone: responseTone, english_support: englishSupport, language, notebook_auto: notebookAuto, notebook_relay: notebookRelay }),
      });
      if (!r.ok) throw new Error(r.status.toString());
      toast.success("Configuration saved");
      window.dispatchEvent(new CustomEvent("settings-saved"));
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveKey(envVar: string) {
    const value = keyInputs[envVar]?.trim();
    if (!value) return;
    setSavingKey(prev => ({ ...prev, [envVar]: true }));
    try {
      const r = await fetchApi("/config/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env_var: envVar, value }),
      });
      if (!r.ok) throw new Error(r.status.toString());
      toast.success(`${envVar} saved`);
      setKeyInputs(prev => ({ ...prev, [envVar]: "" }));
      await fetchConfig();
    } catch {
      toast.error("Failed to save key");
    } finally {
      setSavingKey(prev => ({ ...prev, [envVar]: false }));
    }
  }

  if (loading) {
    return (
      <div className="page-content muted" style={{ fontSize: 13 }}>
        Loading configuration…
      </div>
    );
  }

  if (!data) return null;

  // Cards are numbered in the order they appear, so hiding the admin-only
  // ones does not leave a list that starts at 3.
  let stepNo = 0;
  const step = () => String(++stepNo);

  const activeLlm = data.llm_providers.find(p => p.id === llmProvider);

  const activeStt = data.stt_providers.find(p => p.id === sttProvider);

  const researchCard = () => (
    <>
      {/* ── Research: optional search keys (roadmap 2.6) ─────────── */}
      <StepCard step={step()} title="Research" area="research" tone="b">
        <div className="settings-hint" style={{ marginTop: 0 }}>
          {admin
            ? <>People research works without keys (Wikipedia, Hacker News, papers, GitHub and your links).
                Add a free <strong>Tavily</strong> or <strong>Brave Search</strong> key to also search the web — news,
                interviews, talks and company pages.</>
            : <>People research reads Wikipedia, Hacker News, papers, GitHub and any links you give it,
                and every claim in a brief is linked back to where it came from. Nothing to set up.</>}
        </div>
        {/* Search is not proxied, so these are keys in the old sense. Research
            works without them, which is why hiding them costs a non-admin an
            enhancement rather than the feature — and why the pricing page can
            say there are no keys to create without it being a lie. */}
        {admin && (data.research_keys ?? []).map(k => (
          <div key={k.env}>
            <KeyRow
              envVar={k.env}
              hasKey={k.has_key}
              value={keyInputs[k.env] ?? ""}
              hidden={keyHidden[k.env] ?? true}
              saving={savingKey[k.env] ?? false}
              onChange={v => setKeyInputs(prev => ({ ...prev, [k.env]: v }))}
              onToggleHide={() => setKeyHidden(prev => ({ ...prev, [k.env]: !prev[k.env] }))}
              onSave={() => saveKey(k.env)}
            />
            <div className="settings-hint research-key-hint">
              {k.label}: {k.hint} · <button className="link-btn" onClick={() => openExternal(k.url)}>get a key</button>
            </div>
          </div>
        ))}
      </StepCard>
    </>
  );
  const responseCard = () => (
    <>
      {/* ── STEP 3: Response style ───────────────────────────────── */}
      <StepCard step={step()} title="Response Style" area="style" tone="c">
        <FieldLabel>I'm using iReliabee as</FieldLabel>
        <GlassSelect
          options={PERSONAS.map(p => ({ id: p.id, label: `${p.label} — ${p.hint}` }))}
          value={persona ?? ""}
          placeholder="Choose… (sets your default coach and practice)"
          onChange={id => {
            setPersona(id as PersonaId)
              .then(() => { setPersonaState(id as PersonaId); toast.success("Saved — new sessions use the matching coach"); })
              .catch(() => toast.error("Couldn't save that"));
          }}
          style={{ width: "100%", marginBottom: 14 }}
        />
        <FieldLabel>Language level</FieldLabel>
        <GlassSelect
          options={RESPONSE_TONES}
          value={responseTone}
          onChange={setResponseTone}
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, marginBottom: 14 }}>
          Default for new sessions. Change it per session in Preferences.
        </div>
        <FieldLabel>Session language</FieldLabel>
        <GlassSelect options={LANGUAGE_OPTIONS} value={language} onChange={setLanguage} style={{ width: "100%" }} />
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
          What your calls are spoken in. Transcription, the coach's suggestions, debriefs, recaps and study packs follow it.
          Change it per session in Preferences.
        </div>
        <label className="english-support-toggle">
          <input type="checkbox" checked={englishSupport} onChange={e => setEnglishSupport(e.target.checked)} />
          <span>
            <strong>Language support</strong>
            <small>For non-native speakers: simpler, natural phrasing in the session's language, pronunciation hints you can listen to, and phrasing fixes in mock feedback.</small>
          </span>
        </label>
        <label className="english-support-toggle">
          <input type="checkbox" checked={notebookAuto} onChange={e => setNotebookAuto(e.target.checked)} />
          <span>
            <strong>Write a notebook when a lecture or meeting ends</strong>
            <small>Skipped for anything under 5 minutes. Over 2 hours, it shows the cost in credits and waits for you. Charged by what it uses, like a debrief.</small>
          </span>
        </label>
        <label className="english-support-toggle">
          <input type="checkbox" checked={notebookRelay} onChange={e => setNotebookRelay(e.target.checked)} />
          <span>
            <strong>Use my own AI assistant for text features</strong>
            <small>Run text features on your own Claude Code, Codex or Antigravity (Gemini) subscription instead of spending iReliabee credits.{" "}
              <button type="button" className="link-btn" onClick={e => { e.preventDefault(); void openExternal("https://ireliabee.co.uk/help#assistant"); }}>How it works</button></small>
          </span>
        </label>
        <ClaudeOneClick onEnabled={on => { if (on) setNotebookRelay(true); }} />
        {notebookRelay && (
          <div className="settings-relay-box" style={{ marginTop: 10, marginBottom: 14, padding: "12px 14px", borderRadius: 8, background: "var(--card-bg, rgba(255,255,255,0.04))", border: "1px solid var(--border-color, rgba(255,255,255,0.1))" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Connection status:</span>
                {relayStatus?.listening ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#10b981", fontSize: 12, fontWeight: 600 }}>
                    <CheckCircle size={14} /> Connected and waiting {relayStatus.client ? `(${relayStatus.client})` : ""}
                  </span>
                ) : relayStatus && relayReady(relayStatus) ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#10b981", fontSize: 12, fontWeight: 600 }}>
                    <CheckCircle size={14} /> Ready: Claude Code starts when a feature needs it
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--muted, #94a3b8)", fontSize: 12 }}>
                    <XCircle size={14} /> Not connected
                  </span>
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, padding: "6px 8px", background: "rgba(0,0,0,0.2)", borderRadius: 6 }}>
              <div style={{ fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 8 }}>
                <span style={{ color: "var(--muted, #94a3b8)", fontFamily: "sans-serif" }}>Pairing key: </span>
                {relayStatus?.pairing_key ? `${relayStatus.pairing_key.slice(0, 16)}…` : "Loading…"}
              </div>
              <button
                type="button"
                className="btn-neutral"
                style={{ fontSize: 10, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 4 }}
                disabled={regeneratingKey}
                onClick={handleRegenerateKey}
              >
                <RefreshCw size={10} className={regeneratingKey ? "spin" : ""} /> Regenerate key
              </button>
            </div>

            {!relayStatus?.listening && !relayStatus?.auto?.enabled && (
              <div style={{ fontSize: 12, color: "var(--muted, #94a3b8)", marginBottom: 10, lineHeight: 1.4 }}>
                Your assistant isn't listening right now. Turn on "Use my Claude subscription" above, or follow the setup steps below and type start iReliabee in your assistant.
              </div>
            )}
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Claude Code setup (restart-proof stdio bridge):</div>
            <div style={{ position: "relative", marginBottom: 12 }}>
              <pre style={{ fontSize: 11, padding: "8px 10px", borderRadius: 4, background: "rgba(0,0,0,0.25)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {bridge ? claudeAddCommand(bridge) : "…"}
              </pre>
              <button
                type="button"
                className="btn-neutral"
                style={{ position: "absolute", top: 4, right: 4, padding: "2px 8px", fontSize: 10 }}
                onClick={() => {
                  if (bridge) navigator.clipboard.writeText(claudeAddCommand(bridge));
                  toast.success("Copied Claude Code command");
                }}
              >
                Copy
              </button>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Antigravity / Gemini setup (restart-proof):</div>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <pre style={{ fontSize: 11, padding: "8px 10px", borderRadius: 4, background: "rgba(0,0,0,0.25)", margin: 0, whiteSpace: "pre-wrap" }}>
                {bridge ? antigravityConfig(bridge) : "…"}
              </pre>
              <button
                type="button"
                className="btn-neutral"
                style={{ position: "absolute", top: 4, right: 4, padding: "2px 8px", fontSize: 10 }}
                onClick={() => {
                  if (bridge) navigator.clipboard.writeText(antigravityConfig(bridge));
                  toast.success("Copied Antigravity config");
                }}
              >
                Copy
              </button>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Codex setup (ChatGPT plan):</div>
            <div style={{ fontSize: 11, color: "var(--muted, #94a3b8)", marginBottom: 4, lineHeight: 1.4 }}>
              Add this to the end of ~/.codex/config.toml (Windows: C:\Users\&lt;you&gt;\.codex\config.toml), then restart Codex.
            </div>
            <div style={{ position: "relative", marginBottom: 6 }}>
              <pre style={{ fontSize: 11, padding: "8px 10px", borderRadius: 4, background: "rgba(0,0,0,0.25)", margin: 0, whiteSpace: "pre-wrap" }}>
                {bridge ? codexConfig(bridge, relayStatus?.repo_dir) : "…"}
              </pre>
              <button
                type="button"
                className="btn-neutral"
                style={{ position: "absolute", top: 4, right: 4, padding: "2px 8px", fontSize: 10 }}
                onClick={() => {
                  if (bridge) navigator.clipboard.writeText(codexConfig(bridge, relayStatus?.repo_dir));
                  toast.success("Copied Codex config");
                }}
              >
                Copy
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted, #94a3b8)", marginBottom: 10, lineHeight: 1.4 }}>
              The ChatGPT app and website can't connect: their connectors only reach online servers. Use Codex, which signs in with your ChatGPT plan.
            </div>
            <div style={{ fontSize: 12, color: "var(--muted, #94a3b8)", marginTop: 8, marginBottom: 8, lineHeight: 1.4 }}>
              Then type start iReliabee in your assistant, or pick the ireliabee-listen prompt.
            </div>
            <details style={{ fontSize: 11, color: "var(--muted, #94a3b8)", marginTop: 6 }}>
              <summary style={{ cursor: "pointer", marginBottom: 6 }}>Alternative: Direct SSE connection URL</summary>
              <div style={{ position: "relative", marginTop: 4 }}>
                <pre style={{ fontSize: 10, padding: "6px 8px", borderRadius: 4, background: "rgba(0,0,0,0.25)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {mcpUrl}
                </pre>
                <button
                  type="button"
                  className="btn-neutral"
                  style={{ position: "absolute", top: 2, right: 2, padding: "1px 6px", fontSize: 9 }}
                  onClick={() => {
                    navigator.clipboard.writeText(mcpUrl);
                    toast.success("Copied SSE URL");
                  }}
                >
                  Copy
                </button>
              </div>
            </details>
          </div>
        )}
        <label className="english-support-toggle">
          <input type="checkbox" checked={tray} onChange={e => { setTray(e.target.checked); void setKeepInTray(e.target.checked); }} />
          <span>
            <strong>Keep running in the tray when I close the window</strong>
            <small>So your meeting reminders still arrive. Open iReliabee from the tray icon, or choose Quit there.</small>
          </span>
        </label>
        <label className="english-support-toggle">
          <input type="checkbox" checked={chime} onChange={e => { setChime(e.target.checked); setReminderSound(e.target.checked); }} />
          <span>
            <strong>Play a soft chime with meeting reminders</strong>
            <small>Two low notes when a reminder appears, once more after 2 minutes if you haven't answered. Never while the coach is listening or you're on a practice call.</small>
          </span>
        </label>
        {isTauri() && (
          <label className="english-support-toggle">
            <input type="checkbox" checked={atLogin} onChange={async e => {
              const on = e.target.checked;
              setAtLogin(on);
              if (!(await setStartsAtLogin(on))) { setAtLogin(!on); toast.error("Couldn't change that. Try again, or check your system's startup apps."); return; }
              if (on && !tray) { setTray(true); void setKeepInTray(true); }
            }} />
            <span>
              <strong>Start iReliabee when I sign in to this computer</strong>
              <small>It opens quietly in the tray, so meeting reminders come after a restart too. Turning this on also keeps it in the tray.</small>
            </span>
          </label>
        )}
        <PhoneSettings />
      </StepCard>
    </>
  );
  const listeningCard = () => (
    <>
      {/* ── STEP 4: Listening (applies immediately, saved on this device) ── */}
      <StepCard step={step()} title="Listening" area="listening" tone="a">
        <FieldLabel>Wait for pauses</FieldLabel>
        <GlassSelect
          options={PAUSE_TOLERANCES.map(p => ({ id: p.id, label: p.label }))}
          value={pauseTolerance}
          onChange={id => { setPauseToleranceState(id as PauseToleranceId); setPauseTolerance(id as PauseToleranceId); }}
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, lineHeight: 1.55 }}>
          How long someone can pause mid-sentence before the coach answers. Their words are
          joined into one question until then. Pick <strong>Patient</strong> or <strong>Very patient</strong> for
          slow or thoughtful speakers. Press <span className="kbd">R</span> in a session to answer
          what they said without waiting, or <span className="kbd">Shift+R</span> for what you said. You can also change this from the session screen.
        </div>
      </StepCard>
    </>
  );
  const appearanceCard = () => (
    <>
      {/* ── STEP 5: Appearance (applies immediately, saved on this device) ── */}
      <StepCard step={step()} title="Appearance" area="look" tone="e">
        <div className="appearance-grid">
          <div>
            <FieldLabel>Text size</FieldLabel>
            <div className="text-size-picker" role="radiogroup" aria-label="Text size">
              {TEXT_SIZES.map(s => (
                <button key={s.id} role="radio" aria-checked={textSize === s.id}
                  className={textSize === s.id ? "active" : ""}
                  onClick={() => { setTextSizeState(s.id); setTextSize(s.id); }}
                  title={`${s.label} (${Math.round(s.scale * 100)}%)`}>
                  <span style={{ fontSize: Math.round(13 * s.scale) }}>Aa</span>
                  <small>{s.label}</small>
                </button>
              ))}
            </div>
            <div className="settings-hint">
              Shortcuts anywhere: <span className="kbd">Ctrl +</span> bigger,{" "}
              <span className="kbd">Ctrl −</span> smaller, <span className="kbd">Ctrl 0</span> default.
            </div>
          </div>

          <div>
            <FieldLabel>Page width</FieldLabel>
            <div className="page-width-picker" role="radiogroup" aria-label="Page width">
              {PAGE_WIDTHS.map(w => (
                <button key={w.id} role="radio" aria-checked={pageWidth === w.id}
                  className={pageWidth === w.id ? "active" : ""}
                  onClick={() => { setPageWidthState(w.id); setPageWidth(w.id); }}>
                  <span className={`pw-glyph pw-${w.id}`}><i /></span>
                  <strong>{w.label}</strong>
                  <small>{w.hint}</small>
                </button>
              ))}
            </div>
            <div className="settings-hint">
              Every screen uses this width, so pages line up as you move between them. The live session always fills the window.
            </div>
          </div>

          {canResizeWindow() && (
            <div>
              <FieldLabel>Window size</FieldLabel>
              <div className="window-size-picker">
                {WINDOW_SIZES.map(z => {
                  const fits = !screenLimit || (z.w <= screenLimit.w && z.h <= screenLimit.h);
                  return (
                    <button key={z.id} className="btn-neutral" disabled={!fits}
                      title={fits ? `Resize the window to ${z.label}` : "Larger than this screen"}
                      onClick={() => resizeWindow(z).catch(() => toast.error("Couldn't resize the window"))}>
                      {z.label}
                    </button>
                  );
                })}
                <button className="btn-neutral" onClick={() => resizeWindow("maximize").catch(() => toast.error("Couldn't maximise the window"))}>
                  <Maximize2 size={12} /> Fill screen
                </button>
              </div>
              <div className="settings-hint">
                Resizes and centres the window{screenLimit ? ` (this screen fits up to ${screenLimit.w} × ${screenLimit.h})` : ""}. You can still drag its edges.
              </div>
            </div>
          )}
        </div>
      </StepCard>
    </>
  );

  return (
    <div className="page-content">
      <div className="page-toolbar settings-toolbar">
        <p className="muted">
          {admin ? "Models and response style are" : "Response style is"} saved with <strong>Save</strong>. Listening and appearance apply right away on this device.
        </p>
        <div className="page-toolbar-end">
          <button className="btn-neutral" onClick={fetchConfig} title="Reload from the app"><RefreshCw size={12} /> Refresh</button>
          <button className="btn-primary" onClick={saveConfig} disabled={saving}><Save size={13} /> {saving ? "Saving…" : "Save"}</button>
        </div>
      </div>

      {/* A bento grid: tiles of different sizes and colours locking into one
          solid block — shared edges, no gaps, rounded outside corners. The
          areas are laid out per account type in index.css so each row pairs
          tiles of similar height, and every tile stretches to fill its cell:
          no holes at any width. Tiles read left to right, top to bottom, and
          are numbered in that order. */}
      <div className={`settings-bento ${admin ? "for-admin" : `for-user${backoffice ? " with-backoffice" : ""}`}`}>
      {/* ── Models: the admin's alone ─────────────────────────────────
          Ordinary accounts are served by whatever the backoffice chose on the
          server, so a model picker here would be a control that does nothing
          — or, for speech, one that broke listening (audit 178-H5). The
          admin's picks go straight to the provider on their own keys: the
          diagnostic path for when the service is the suspect. */}
      {admin && (<>
      {/* ── LLM ──────────────────────────────────────────────────── */}
      <StepCard step={step()} title="Language Model" area="llm" tone="b">
        <FieldLabel>Provider</FieldLabel>
        <ProviderPicker providers={data.llm_providers} value={llmProvider} onChange={onLlmProviderChange} />

        {activeLlm && (
          <>
            <FieldLabel style={{ marginTop: 16 }}>Model</FieldLabel>
            <GlassSelect
              options={activeLlm.models.map(m => ({ id: m.id, label: `${m.id} — ${m.label}` }))}
              value={llmModel}
              onChange={setLlmModel}
              style={{ width: "100%" }}
            />

            {/* Provider keys belong to one seeded account — the diagnostic
                path for when the proxy itself is the suspect. Everyone else
                gets the AI through us and has no key to enter.
                See docs/hosted-pivot.md, step 8. */}
            {admin && activeLlm.env && (
              <KeyRow
                envVar={activeLlm.env}
                hasKey={activeLlm.has_key}
                value={keyInputs[activeLlm.env] ?? ""}
                hidden={keyHidden[activeLlm.env] ?? true}
                saving={savingKey[activeLlm.env] ?? false}
                onChange={v => setKeyInputs(prev => ({ ...prev, [activeLlm.env!]: v }))}
                onToggleHide={() => setKeyHidden(prev => ({ ...prev, [activeLlm.env!]: !prev[activeLlm.env!] }))}
                onSave={() => saveKey(activeLlm.env!)}
              />
            )}
          </>
        )}
      </StepCard>

      {/* ── STT ──────────────────────────────────────────────────── */}
      <StepCard step={step()} title="Speech-to-Text" area="stt" tone="a">
        <FieldLabel>Provider</FieldLabel>
        <ProviderPicker providers={data.stt_providers} value={sttProvider} onChange={onSttProviderChange} />

        {activeStt && (
          <>
            <FieldLabel style={{ marginTop: 16 }}>Model</FieldLabel>
            <GlassSelect
              options={activeStt.models.map(m => ({ id: m.id, label: `${m.id} — ${m.label}` }))}
              value={sttModel}
              onChange={setSttModel}
              style={{ width: "100%" }}
            />

            {admin && activeStt.env && (
              <KeyRow
                envVar={activeStt.env}
                hasKey={activeStt.has_key}
                value={keyInputs[activeStt.env] ?? ""}
                hidden={keyHidden[activeStt.env] ?? true}
                saving={savingKey[activeStt.env] ?? false}
                onChange={v => setKeyInputs(prev => ({ ...prev, [activeStt.env!]: v }))}
                onToggleHide={() => setKeyHidden(prev => ({ ...prev, [activeStt.env!]: !prev[activeStt.env!] }))}
                onSave={() => saveKey(activeStt.env!)}
              />
            )}
          </>
        )}
      </StepCard>
      </>)}

      {admin ? <>{responseCard()}{researchCard()}</> : <>{researchCard()}{listeningCard()}</>}
      {/* Which provider the hosted service uses for everyone is chosen on
          the web, not here: these keys only ever affect this one machine. */}
      {backoffice && (
        <StepCard step="★" title="Backoffice" area="backoffice" tone="d">
          <div className="settings-hint" style={{ marginTop: 0 }}>
            {admin && "The keys above are for this computer only. "}To choose which AI answers
            for <strong>everyone</strong> — and see traffic, response times and spend — use the backoffice.
          </div>
          <button className="btn-neutral" style={{ marginTop: 12 }} onClick={openBackoffice} disabled={openingBackoffice}>
            <ExternalLink size={12} /> {openingBackoffice ? "Opening…" : "Open backoffice"}
          </button>
        </StepCard>
      )}
      {admin ? listeningCard() : responseCard()}
      {appearanceCard()}

      {/* ── STEP 6: Theme and pattern (applies immediately, saved on this device) ── */}
      <StepCard step={step()} title="Theme" full area="theme" tone="b">
        <div className="look-settings">
          <div>
            <FieldLabel>Colour theme</FieldLabel>
            <ThemePicker />
          </div>
          <div>
            <FieldLabel>Background pattern</FieldLabel>
            <PatternPicker />
            <div className="settings-hint">
              A stippled dot field behind page headers, empty screens and highlight cards, in your theme's colour.
            </div>
          </div>
        </div>
      </StepCard>
      </div>
    </div>
  );
}

function StepCard({ step, title, wide, full, area, tone, children }: {
  step: string; title: string; wide?: boolean; full?: boolean;
  /** Its place in the bento grid (see .settings-bento in index.css). */
  area?: string;
  /** Its colour, from the theme's own tokens, so every theme gets its own palette. */
  tone?: "a" | "b" | "c" | "d" | "e";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`glass-card settings-card ${wide ? "wide" : ""} ${full ? "full" : ""} ${tone ? `tone-${tone}` : ""}`}
      style={area ? { gridArea: area } : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span style={{
          width: 20, height: 20, borderRadius: "50%",
          background: "rgba(var(--accent-rgb),0.20)",
          color: "var(--primary-hover)",
          fontSize: 11, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>{step}</span>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.07em", color: "var(--primary-hover)", textTransform: "uppercase" }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase", ...style }}>
      {children}
    </div>
  );
}

function ProviderPicker({ providers, value, onChange }: {
  providers: ProviderDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {providers.map(p => {
        const active = value === p.id;
        const ok = p.has_key || p.env === null;
        return (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            style={{
              padding: "6px 13px",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "var(--font)",
              display: "flex", alignItems: "center", gap: 6,
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              border: "none",
              transition: "all 0.15s",
              background: active ? "var(--primary)" : "rgba(var(--ink-rgb),0.05)",
              color: active ? "#fff" : "var(--muted)",
              boxShadow: active ? "0 0 16px var(--primary-glow)" : "none",
            }}
          >
            {ok
              ? <CheckCircle size={11} style={{ color: active ? "rgba(var(--ink-rgb),0.8)" : "var(--tone-green)" }} />
              : <XCircle    size={11} style={{ color: active ? "rgba(var(--ink-rgb),0.6)" : "var(--tone-red)" }} />
            }
            {p.id}
          </button>
        );
      })}
    </div>
  );
}

function KeyRow({ envVar, hasKey, value, hidden, saving, onChange, onToggleHide, onSave }: {
  envVar: string;
  hasKey: boolean;
  value: string;
  hidden: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onToggleHide: () => void;
  onSave: () => void;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
        <Key size={10} style={{ color: "var(--muted)", flexShrink: 0 }} />
        <code style={{ fontSize: 11, color: "var(--muted)", background: "rgba(255,255,255,0.05)", padding: "1px 6px", borderRadius: 4 }}>{envVar}</code>
        {hasKey
          ? <span style={{ fontSize: 10, color: "var(--tone-green)" }}>✓ set</span>
          : <span style={{ fontSize: 10, color: "var(--tone-red)" }}>not set</span>
        }
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type={hidden ? "password" : "text"}
          className="glass-input"
          placeholder={hasKey ? "Paste new key to replace…" : "Paste API key…"}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onSave(); }}
          style={{ flex: 1, padding: "7px 10px", fontSize: 12 }}
        />
        <button
          onClick={onToggleHide}
          style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: "7px 8px", display: "flex", alignItems: "center", borderRadius: "var(--radius-sm)", transition: "color 0.15s" }}
          title={hidden ? "Show key" : "Hide key"}
        >
          {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button
          className="btn-primary"
          style={{ padding: "7px 14px", fontSize: 12, flexShrink: 0 }}
          onClick={onSave}
          disabled={saving || !value.trim()}
        >
          {saving ? "…" : "Save"}
        </button>
      </div>
    </div>
  );
}
