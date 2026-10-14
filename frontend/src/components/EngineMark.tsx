import { Ear, Sparkle } from "lucide-react";
import { engineTip, shortModel, swapped, type Engine } from "../lib/engine";

/**
 * Which models are doing the work, in the width of a few words.
 *
 * Two jobs run in a session and they are not the same model: one hears, one
 * answers. For an ordinary account both are chosen by iReliabee's service, not
 * by this computer, so the name in Settings is a request — and the header used
 * to show that request as if it were fact, to the admin only.
 *
 * This shows what actually ran instead, in place of that label rather than
 * beside it: two short names, each behind the glyph for its job. Both halves
 * are always present, because a missing one reads as a bug rather than as
 * "that job has not started" — an empty half shows a dash and says so when
 * pointed at. A name that has not confirmed itself yet is dotted, one whose
 * job has stopped is dimmed, and one that differs from what was asked for is
 * accented.
 */

interface Props {
  /** The transcriber, from the audio socket. Kept after listening stops. */
  hearing: Engine | null;
  /** The model that wrote the last answer. */
  answering: Engine | null;
  /** Whether anything is being listened to right now. */
  listening: boolean;
}

function Bit({ what, engine, idle }: { what: "hear" | "answer"; engine: Engine | null; idle?: boolean }) {
  const glyph = what === "hear" ? <Ear size={11} /> : <Sparkle size={11} />;
  if (!engine?.model) {
    return <span className="engine-bit empty">{glyph}—</span>;
  }
  const odd = swapped(engine);
  return (
    <span className={`engine-bit${engine.confirmed ? "" : " assumed"}${odd ? " swapped" : ""}${idle ? " idle" : ""}`}>
      {glyph}
      {shortModel(engine.model)}
    </span>
  );
}

export default function EngineMark({ hearing, answering, listening }: Props) {
  return (
    <span className="engine" title={engineTip(hearing, answering, listening)}>
      <Bit what="hear" engine={hearing} idle={!listening} />
      <Bit what="answer" engine={answering} />
    </span>
  );
}
