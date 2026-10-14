/**
 * What went wrong when an update failed.
 *
 * The updater plugin serialises its error with Display and nothing else
 * (tauri-plugin-updater 2.11.0, src/error.rs: `serialize_str(self.to_string())`),
 * so all the frontend ever receives is one sentence — there are no codes to
 * switch on. These are that plugin’s own sentences. Anything unrecognised is
 * shown as it came rather than dressed up as something we understood.
 *
 * Every failure used to be reported as "Check your connection and try again."
 * and the exception was thrown away, so a bad signature, a full disk and dropped
 * wifi were the same sentence, and nothing was left for anyone to look at.
 */
export interface UpdateFailure {
  /** One line for the person: what happened, and what they can do about it. */
  message: string;
  /** The updater’s own words, kept so a support message has something in it. */
  detail: string;
}

function textOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return err == null ? "" : String(err);
}

export function describeUpdateFailure(err: unknown): UpdateFailure {
  const detail = textOf(err);
  const t = detail.toLowerCase();
  const say = (message: string): UpdateFailure => ({ message, detail });

  // The feed offered an installer this install cannot use — a .deb install sent
  // the AppImage, for one.
  if (t.includes("invalid updater binary format") || t.includes("binary for the current target")) {
    return say("This release has no installer for the way iReliabee was installed here. "
      + "Download the latest version from ireliabee.co.uk.");
  }
  if (t.includes("not found in the response") || t.includes("fallback platforms")) {
    return say("This release has no installer for this computer. "
      + "Download the latest version from ireliabee.co.uk.");
  }
  // The update was not what we signed. The wording comes from minisign_verify,
  // so the word "signature" is the only handle on it.
  if (t.includes("signature") || t.includes("minisign")) {
    return say("The downloaded update failed its signature check, so nothing was installed. "
      + "Try again later, or download the installer from ireliabee.co.uk.");
  }
  if (t.includes("authentication failed") || t.includes("failed to install")) {
    return say("The update needed your permission to install and didn’t get it. "
      + "Try again and approve the prompt.");
  }
  if (t.includes("not enough space") || t.includes("no space")
      || t.includes("temp directory") || t.includes("temporary directory")) {
    return say("There wasn’t room to save the update. Free some disk space and try again.");
  }
  if (t.includes("access is denied") || t.includes("permission denied") || t.includes("os error 5")) {
    return say("iReliabee wasn’t allowed to write the update. "
      + "Close any other copy of iReliabee and try again.");
  }
  // The ordinary case — and the one this used to claim for everything.
  if (!detail || t.includes("error sending request") || t.includes("dns") || t.includes("timed out")
      || t.includes("connection") || t.includes("network") || t.includes("tcp connect")
      || t.includes("certificate")) {
    return say("Check your connection and try again.");
  }
  return say("Something went wrong while installing the update.");
}
