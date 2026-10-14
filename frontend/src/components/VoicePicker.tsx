import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Square, Loader2, Check } from "lucide-react";
import { fetchApi, apiMediaUrl } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";

export interface Voice {
  id: string;
  name: string;
  accent: string;
  gender: "female" | "male";
  family: "flux" | "aura2";
}

const ACCENT_ORDER = ["American", "British", "Irish", "Australian", "Indian", "Filipino", "Singaporean"];

export default function VoicePicker({ value, onChange }: { value: string; onChange: (voice: Voice) => void }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [accent, setAccent] = useState("All");
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetchApi("/mock/voices").then(r => r.json()).then((list: Voice[]) => {
      setVoices(list);
      // A voice saved from an older, larger list falls back to the first voice.
      const current = list.find(v => v.id === value) ?? list[0];
      if (current) onChange(current);
    }).catch(notifyError);
    return () => { audioRef.current?.pause(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accents = useMemo(
    () => ["All", ...ACCENT_ORDER.filter(a => voices.some(v => v.accent === a))],
    [voices],
  );

  const shown = voices
    .filter(v => accent === "All" || v.accent === accent)
    // Grouped by country, female first within each.
    .sort((a, b) =>
      ACCENT_ORDER.indexOf(a.accent) - ACCENT_ORDER.indexOf(b.accent) ||
      (a.gender === b.gender ? 0 : a.gender === "female" ? -1 : 1));

  function togglePreview(voice: Voice) {
    audioRef.current?.pause();
    if (playing === voice.id) { setPlaying(null); return; }
    // An <audio> element cannot send a header: the token rides in the URL (audit 180-C3).
    const audio = new Audio(apiMediaUrl(`/mock/voices/${voice.id}/preview`));
    audioRef.current = audio;
    setLoading(voice.id);
    setPlaying(null);
    audio.oncanplay = () => { setLoading(l => (l === voice.id ? null : l)); };
    audio.onplaying = () => { setLoading(null); setPlaying(voice.id); };
    audio.onended = () => setPlaying(p => (p === voice.id ? null : p));
    audio.onerror = async () => {
      setLoading(null);
      setPlaying(null);
      // The audio element hides the server's reason; ask again to show it.
      const res = await fetchApi(`/mock/voices/${voice.id}/preview`).catch(e => e);
      notifyError(res instanceof Response && !res.ok ? await errorFromResponse(res) : res);
    };
    audio.play().catch(() => { setLoading(null); });
  }

  return (
    <div className="voice-picker">
      <div className="voice-filters">
        <div className="voice-chips">
          {accents.map(a => (
            <button key={a} className={`voice-chip ${accent === a ? "active" : ""}`} onClick={() => setAccent(a)}>{a}</button>
          ))}
        </div>
      </div>

      <div className="voice-grid">
        {shown.map(v => {
          const selected = v.id === value;
          return (
            <div
              key={v.id}
              role="button"
              tabIndex={0}
              className={`voice-card ${selected ? "selected" : ""} ${v.gender}`}
              onClick={() => onChange(v)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(v); } }}
            >
              <span className="voice-avatar">{selected ? <Check size={15} /> : v.name[0]}</span>
              <span className="voice-info">
                <span className="voice-name">
                  {v.name}
                  {v.family === "flux" && <em>New</em>}
                </span>
                <span className="voice-meta">{v.accent} · {v.gender === "female" ? "Female" : "Male"}</span>
              </span>
              <button
                className={`voice-play ${playing === v.id ? "playing" : ""}`}
                onClick={e => { e.stopPropagation(); togglePreview(v); }}
                title={playing === v.id ? "Stop preview" : `Hear ${v.name}`}
              >
                {loading === v.id ? <Loader2 size={13} className="spin" /> : playing === v.id ? <Square size={11} /> : <Play size={12} />}
              </button>
            </div>
          );
        })}
        {voices.length > 0 && shown.length === 0 && (
          <p className="muted" style={{ fontSize: 12, padding: 8 }}>No voices match these filters.</p>
        )}
      </div>
    </div>
  );
}
