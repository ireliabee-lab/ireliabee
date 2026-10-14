import { Mic, Headphones, AlertTriangle } from "lucide-react";
import { BARS, bars, boostLabel, hearing, isDead, type Level } from "../lib/levels";

/**
 * How loud a source is, drawn.
 *
 * The app already had a dot that lit up when someone spoke, which answered
 * "is anyone speaking" but not "is this thing hearing me" — and those are
 * different questions, as a microphone delivering almost nothing proved. The
 * meter answers the second: a quiet room shows a little, a dead device shows
 * nothing and says so.
 */

interface Props {
  /** "You" or the other side. */
  label: string;
  which: "mic" | "system";
  on: boolean;
  level: Level;
  /** Fewer, smaller segments for the in-call overlay. */
  small?: boolean;
}

export default function LevelMeter({ label, which, on, level, small }: Props) {
  const count = small ? 7 : BARS;
  const lit = on ? bars(level.level, count) : 0;
  const dead = isDead(on, level, which);
  const boost = on ? boostLabel(level.gain) : "";
  const said = hearing(on, level);

  return (
    <span className={`meter ${on ? "on" : ""} ${level.speaking ? "speaking" : ""} ${small ? "small" : ""}`}
          title={dead
            ? `${label}: nothing is arriving from this device — check it is the right one and not muted`
            : `${label}: ${said}${boost ? ` · boosted ${boost}` : ""}`}>
      {which === "mic" ? <Mic size={small ? 11 : 12} /> : <Headphones size={small ? 11 : 12} />}
      {!small && <span className="meter-label">{label}</span>}
      <span className="meter-bars" aria-hidden>
        {Array.from({ length: count }, (_, i) => (
          <i key={i} className={i < lit ? "lit" : ""} />
        ))}
      </span>
      {dead ? (
        <span className="meter-dead"><AlertTriangle size={small ? 10 : 11} /> {small ? "" : "nothing"}</span>
      ) : (
        boost && <span className="meter-boost">{boost}</span>
      )}
      <span className="visually-hidden" role="status">{label}: {said}</span>
    </span>
  );
}
