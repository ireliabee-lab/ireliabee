import { describe, expect, it } from "vitest";
import { serverDate } from "./dates";

describe("serverDate reads the backend's UTC times", () => {
  it("reads a naive time as UTC", () => {
    expect(serverDate("2026-10-07T08:52:28").toISOString()).toBe("2026-10-07T08:52:28.000Z");
  });

  it("reads a time that already ends in Z", () => {
    expect(serverDate("2026-10-07T08:52:28Z").toISOString()).toBe("2026-10-07T08:52:28.000Z");
  });

  it("reads a time with an offset (link-imported sources), not Invalid Date", () => {
    expect(serverDate("2026-10-07T08:52:28+00:00").toISOString()).toBe("2026-10-07T08:52:28.000Z");
    expect(serverDate("2026-10-07T09:52:28.123456+01:00").toISOString()).toBe("2026-10-07T08:52:28.123Z");
  });
});
