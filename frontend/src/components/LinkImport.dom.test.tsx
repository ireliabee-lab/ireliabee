// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../test/dom";
import LinkImport from "./LinkImport";
import { linksApi, type LinkSource } from "../lib/links";

vi.mock("../lib/links", () => ({ linksApi: { preview: vi.fn(), save: vi.fn(), screenshotPrice: vi.fn(), screenshot: vi.fn(), openBrowser: vi.fn(), closeBrowser: vi.fn(), listen: vi.fn() } }));
const source: LinkSource = { url: "https://example.com/article", title: "Article", text: "Captured text to review.", author: "Ada", method: "public" };
const doc = { id: 42, name: "Article", source: { url: source.url, platform: "web", author: "Ada", captured_at: "2026-10-06T12:00:00Z", method: "public" } };
let capture: (data: LinkSource) => void;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(linksApi.listen).mockImplementation(async fn => { capture = fn; return vi.fn(); });
  vi.mocked(linksApi.closeBrowser).mockResolvedValue();
  vi.mocked(linksApi.openBrowser).mockResolvedValue();
  vi.mocked(linksApi.preview).mockResolvedValue(source);
  vi.mocked(linksApi.save).mockResolvedValue(doc);
  vi.mocked(linksApi.screenshotPrice).mockResolvedValue({ credits: 0.219, model: "vision", max_output: 4096 });
  vi.mocked(linksApi.screenshot).mockResolvedValue({ ...source, method: "screenshot" });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:local-image"), revokeObjectURL: vi.fn() }));
});

async function readLink() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Web page or social post link"), source.url);
  await user.click(screen.getByRole("button", { name: "Read link" }));
  return user;
}
async function fallback() {
  vi.mocked(linksApi.preview).mockResolvedValue({ url: source.url, platform: "web", fallback: true, reason: "Public text unavailable." });
  await readLink();
  await screen.findByRole("button", { name: "Open in app browser" });
}

describe("link import", () => {
  it("pastes one link, previews editable text and saves only after approval", async () => {
    const saved = vi.fn();
    render(<LinkImport onClose={vi.fn()} onSaved={saved} />);
    const user = await readLink();
    const text = await screen.findByLabelText("Captured text");
    expect((text as HTMLTextAreaElement).value).toBe(source.text);
    expect(linksApi.save).not.toHaveBeenCalled();
    await user.clear(text);
    await user.type(text, "Reviewed correction.");
    await user.click(screen.getByRole("button", { name: "Add to notebook" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(doc));
    expect(linksApi.save).toHaveBeenCalledWith({ ...source, text: "Reviewed correction." });
  });

  it("fallback does not automatically open a browser or send an image", async () => {
    render(<LinkImport onClose={vi.fn()} onSaved={vi.fn()} />);
    await fallback();
    expect(linksApi.openBrowser).not.toHaveBeenCalled();
    expect(linksApi.screenshot).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open in app browser" }));
    expect(linksApi.openBrowser).toHaveBeenCalledWith(source.url);
  });

  it("captured browser text is reviewed before Library save", async () => {
    render(<LinkImport target="library" onClose={vi.fn()} onSaved={vi.fn()} />);
    await fallback();
    fireEvent.click(screen.getByRole("button", { name: "Open in app browser" }));
    await waitFor(() => expect(linksApi.openBrowser).toHaveBeenCalled());
    const { act } = await import("@testing-library/react");
    act(() => capture({ ...source, method: "browser" }));
    expect((await screen.findByLabelText("Captured text") as HTMLTextAreaElement).value).toBe(source.text);
    expect(linksApi.save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Add to Library" }));
    expect(linksApi.save).toHaveBeenCalledWith({ ...source, method: "browser" });
  });

  it("chosen image stays local until the quoted credit cost is confirmed", async () => {
    render(<LinkImport onClose={vi.fn()} onSaved={vi.fn()} />);
    await fallback();
    const file = new File(["png"], "screen.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Or paste, drop or choose a screenshot"), file);
    const confirm = await screen.findByRole("button", { name: "Read screenshot (up to 0.219 credits)" });
    expect(linksApi.screenshotPrice).toHaveBeenCalledOnce();
    expect(linksApi.screenshot).not.toHaveBeenCalled();
    await userEvent.click(confirm);
    await screen.findByLabelText("Captured text");
    expect(linksApi.screenshot).toHaveBeenCalledWith(source.url, file, expect.objectContaining({ credits: 0.219 }));
    expect(linksApi.save).not.toHaveBeenCalled();
  });

  it("pasted and dropped screenshots are selected locally without automatic vision", async () => {
    render(<LinkImport onClose={vi.fn()} onSaved={vi.fn()} />);
    await fallback();
    const file = new File(["png"], "paste.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("dialog"), { clipboardData: { files: [file] } });
    await screen.findByRole("button", { name: "Read screenshot (up to 0.219 credits)" });
    fireEvent.drop(screen.getByRole("dialog"), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(linksApi.screenshotPrice).toHaveBeenCalledTimes(2));
    expect(linksApi.screenshot).not.toHaveBeenCalled();
  });

  it("unknown credit cost prevents screenshot transmission", async () => {
    vi.mocked(linksApi.screenshotPrice).mockRejectedValue(new Error("Price unavailable"));
    render(<LinkImport onClose={vi.fn()} onSaved={vi.fn()} />);
    await fallback();
    await userEvent.upload(screen.getByLabelText("Or paste, drop or choose a screenshot"), new File(["png"], "screen.png", { type: "image/png" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /Read screenshot/ })).toBeNull();
    expect(linksApi.screenshot).not.toHaveBeenCalled();
  });

  it("cancel and Escape close without saving", async () => {
    const close = vi.fn();
    render(<LinkImport onClose={close} onSaved={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    expect(linksApi.save).not.toHaveBeenCalled();
  });

  it("empty captures cannot be saved", async () => {
    vi.mocked(linksApi.preview).mockResolvedValue({ ...source, text: "" });
    render(<LinkImport onClose={vi.fn()} onSaved={vi.fn()} />);
    await readLink();
    const save = await screen.findByRole("button", { name: "Add to notebook" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(linksApi.save).not.toHaveBeenCalled();
  });

  it("says plainly when only the start of a post is public, and offers the whole one", async () => {
    const start: LinkSource = { ...source, url: "https://x.com/karpathy/status/2109361546505966046", text: "Dusting off this tweet from April",
      partial: "X shares only the start of long posts with apps, so this is not the whole post." };
    vi.mocked(linksApi.preview).mockResolvedValue(start);
    const saved = vi.fn();
    render(<LinkImport onClose={vi.fn()} onSaved={saved} />);
    await readLink();
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("not the whole post");
    expect(screen.getByText(/start only/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open in app browser" }));
    expect(linksApi.openBrowser).toHaveBeenCalledWith(start.url);
    // Saving the start anyway records that it is only the start.
    await userEvent.click(screen.getByRole("button", { name: "Add to notebook" }));
    await waitFor(() => expect(linksApi.save).toHaveBeenCalledWith(start));
  });

  it("a cut post can go to a screenshot instead", async () => {
    vi.mocked(linksApi.preview).mockResolvedValue({ ...source, partial: "Only the start is public." });
    render(<LinkImport onClose={vi.fn()} onSaved={vi.fn()} />);
    await readLink();
    await userEvent.click(await screen.findByRole("button", { name: "Use a screenshot instead" }));
    expect(screen.getByLabelText("Or paste, drop or choose a screenshot")).toBeTruthy();
  });
});
