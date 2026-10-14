import { describe, expect, it } from "vitest";
import { describeUpdateFailure } from "./updateError";

/**
 * Every failure used to say "Check your connection and try again." and the
 * exception was thrown away, so a bad signature, a full disk and dropped wifi
 * read identically and left nothing for support to go on.
 *
 * The strings here are the updater plugin's own (tauri-plugin-updater 2.11.0,
 * src/error.rs), so this breaks if its wording moves rather than quietly
 * falling back to the connection line.
 */
describe("what the user is told when an update fails", () => {
  it("a dropped connection is still the connection message", () => {
    const out = describeUpdateFailure(
      "error sending request for url (https://updates.example.org/latest.json)");
    expect(out.message).toBe("Check your connection and try again.");
  });

  it("a bad signature is not blamed on the connection", () => {
    const out = describeUpdateFailure("Signature verification failed");
    expect(out.message).toMatch(/signature check/i);
    expect(out.message).not.toMatch(/connection/i);
  });

  it("a full disk says so", () => {
    const out = describeUpdateFailure("There is not enough space on the disk. (os error 112)");
    expect(out.message).toMatch(/room|disk space/i);
  });

  it("an installer this install cannot use points at the website", () => {
    expect(describeUpdateFailure("invalid updater binary format").message)
      .toMatch(/ireliabee\.co\.uk/);
  });

  it("no build for this computer says that, not something vaguer", () => {
    const out = describeUpdateFailure(
      "the platform `linux-x86_64` was not found in the response `platforms` object");
    expect(out.message).toMatch(/no installer for this computer/i);
  });

  it("a declined permission prompt says what to do", () => {
    expect(describeUpdateFailure("Authentication failed or was cancelled").message)
      .toMatch(/permission|approve/i);
  });

  it("a locked file names the likely cause", () => {
    expect(describeUpdateFailure("Access is denied. (os error 5)").message)
      .toMatch(/other copy/i);
  });

  it("keeps the updater's own words, whatever it says", () => {
    expect(describeUpdateFailure("Signature verification failed").detail)
      .toBe("Signature verification failed");
    expect(describeUpdateFailure(new Error("boom")).detail).toBe("boom");
  });

  it("something it has never seen is not dressed up as understood", () => {
    const out = describeUpdateFailure("the moon was in the wrong phase");
    expect(out.message).toBe("Something went wrong while installing the update.");
    expect(out.detail).toBe("the moon was in the wrong phase");
  });

  it("survives anything at all being thrown", () => {
    for (const thrown of [undefined, null, "", {}, 7, new Error("")]) {
      expect(() => describeUpdateFailure(thrown)).not.toThrow();
    }
    // Nothing to go on reads as the commonest cause rather than as a mystery.
    expect(describeUpdateFailure(undefined).message).toBe("Check your connection and try again.");
  });
});
