/**
 * What the session screen tells the rest of the app before it is left.
 *
 * Going to another page unmounts the session screen, which closes its audio
 * socket: the call stops being heard, quietly, mid-interview. So navigation
 * asks first (App.tsx, LeaveSessionDialog). The session screen registers
 * itself while it is shown; nothing else does.
 */
export interface SessionGuard {
  /** Listening to the call or the microphone right now. */
  live(): boolean;
  /** Stop listening and mark the session paused, to resume from Sessions. */
  pause(): Promise<void>;
}

let current: SessionGuard | null = null;

export function registerSessionGuard(guard: SessionGuard): () => void {
  current = guard;
  return () => { if (current === guard) current = null; };
}

/** Leaving now would stop a session that is listening. */
export function leavingStopsASession(): boolean {
  return Boolean(current?.live());
}

export function pauseCurrentSession(): Promise<void> {
  return current ? current.pause() : Promise.resolve();
}
