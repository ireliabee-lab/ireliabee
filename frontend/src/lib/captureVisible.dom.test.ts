// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RAW from "../../src-tauri/src/capture-visible.js?raw";
import X_PAGE from "./fixtures/x-post-karpathy.html?raw";

/** The script the app browser runs on Save to notebook (src-tauri/src/capture-visible.js). */
const SCRIPT = RAW.replace("__CAPTURE_NONCE__", JSON.stringify("nonce"));

const POST = "Stress does not cause stuttering, but it can make it worse. ".repeat(6);

type Captured = { text: string; title: string; author: string };

async function captureAll(html: string): Promise<Captured> {
  document.body.innerHTML = html;
  const invoke = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
  window.eval(SCRIPT);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  return invoke.mock.calls[0][1] as Captured;
}

async function capture(html: string): Promise<string> {
  return (await captureAll(html)).text;
}

beforeEach(() => {
  // jsdom has no layout: treat every text as on screen, so the test is about which parts are chosen.
  Range.prototype.getClientRects = () => [{ width: 10, height: 10, top: 1, left: 1, bottom: 11, right: 11 }] as unknown as DOMRectList;
});

describe("Save to notebook keeps the post, not the page around it", () => {
  it("takes the main region and leaves the side columns, menus and header", async () => {
    const text = await capture(`
      <header>LinkedIn  Home  My Network  Jobs</header>
      <aside>Mensah Oliver · Profile viewers 10 · Try Premium</aside>
      <main><article><header><h1>Why stress isn't the cause</h1></header><p>${POST}</p></article></main>
      <div role="complementary">Add to your feed · Satya Nadella · Follow</div>
      <footer>About · Accessibility</footer>`);
    expect(text).toContain("Why stress isn't the cause");     // the post's own header stays
    expect(text).toContain("Stress does not cause stuttering");
    for (const gone of ["Profile viewers", "Satya Nadella", "My Network", "Accessibility"]) expect(text).not.toContain(gone);
  });

  it("takes a post opened in a dialog over the feed", async () => {
    const text = await capture(`
      <main><article><p>${"Someone else's post in the feed. ".repeat(10)}</p></article></main>
      <div role="dialog"><p>${POST}</p></div>`);
    expect(text).toContain("Stress does not cause stuttering");
    expect(text).not.toContain("Someone else's post");
  });

  it("falls back to the whole page when there is no main region", async () => {
    const text = await capture(`<div><p>${POST}</p></div><aside>Sponsored</aside>`);
    expect(text).toContain("Stress does not cause stuttering");
    expect(text).not.toContain("Sponsored");
  });
});

describe("Save to notebook takes a long post whole", () => {
  const ON = { width: 10, height: 10, top: 1, left: 1, bottom: 11, right: 11 };
  const BELOW = { width: 10, height: 10, top: 5000, left: 1, bottom: 5010, right: 11 };
  const below = (n: Node | null) => !!(n instanceof Element ? n : n?.parentElement)?.closest("[data-below]");

  beforeEach(() => {
    Range.prototype.getClientRects = function (this: Range) {
      return [below(this.startContainer) ? BELOW : ON] as unknown as DOMRectList;
    };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return (this.hasAttribute("data-below") ? BELOW : ON) as DOMRect;
    };
  });

  it("keeps the part of an on-screen post that runs below the window", async () => {
    const text = await capture(`
      <main>
        <article><p>Dusting off this tweet from April because this gap is widening.</p>
          <div data-below><p>${POST}</p><p>The end of the long post.</p></div></article>
        <article data-below><p>${"A reply further down the page. ".repeat(10)}</p></article>
      </main>`);
    expect(text).toContain("Dusting off this tweet");
    expect(text).toContain("The end of the long post.");
    expect(text).not.toContain("A reply further down");
  });

  it("still leaves off-screen text that is not in an on-screen post", async () => {
    const text = await capture(`<main><p>${POST}</p><p data-below>Far below the window.</p></main>`);
    expect(text).toContain("Stress does not cause stuttering");
    expect(text).not.toContain("Far below the window.");
  });
});

/** The X post the owner saved on 2026-10-14, as the cleaned capture should read. */
const KARPATHY_TEXT = `Dusting off this tweet from April because this gap in shared understanding of LLM capability is *widening*. It's now less "two groups of people speaking past each other" and more a sharp funnel.

- Napkin math somewhere around 6B people (~75% of the population) have barely come across a capable model at all.

- The middle has tried a free tier once and kept that impression.

- At the narrow end, people using the best models every day on real work see a different technology, and that group is pulling away.

Quoting Andrej Karpathy (@karpathy):
Judging by my tl there is a growing gap in understanding of AI capability.

The first issue I think is around recency and tier of use. I think a lot of people tried the free tier of ChatGPT somewhere last year and allowed it to inform their views on AI a little too much. This is… [X shows only the start of the quoted post]`;

describe("Save to notebook on an X post saves just the post", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("takes the post and its quoted post from the page, without X's chrome, stats or replies", async () => {
    history.replaceState(null, "", "/karpathy/status/2109361546505966046");
    const saved = await captureAll(X_PAGE);
    expect(saved.text).toBe(KARPATHY_TEXT);
    expect(saved.author).toBe("Andrej Karpathy");
    expect(saved.title).toBe("Post by Andrej Karpathy");
  });

  it("takes the post the address names, not a post above it in the thread", async () => {
    history.replaceState(null, "", "/karpathy/status/2109361546505966046");
    const parent = `<article data-testid="tweet"><div data-testid="User-Name"><span>Someone</span><span>@someone</span></div>
      <div data-testid="tweetText"><span>The post this one replies to.</span></div>
      <a href="/someone/status/1"><time>Oct 10</time></a></article>`;
    const saved = await captureAll(X_PAGE.replace('<div data-testid="cellInnerDiv">', `<div data-testid="cellInnerDiv">${parent}</div><div data-testid="cellInnerDiv">`));
    expect(saved.text).toBe(KARPATHY_TEXT);
    expect(saved.author).toBe("Andrej Karpathy");
  });

  it("marks a post X shows only the start of, and keeps a whole quoted post unmarked", async () => {
    const saved = await captureAll(`<main><article data-testid="tweet">
      <div data-testid="User-Name"><div><span>Ada Lovelace</span></div><div><span>@ada</span><span>·</span><time>2h</time></div></div>
      <div data-testid="tweetText"><span>The engine might compose elaborate pieces of music</span></div>
      <button data-testid="tweet-text-show-more-link">Show more</button>
      <div role="link"><div data-testid="User-Name"><span>Charles Babbage</span><span>@babbage</span><span>·</span><time>Oct 9</time></div>
        <div data-testid="tweetText"><span>The Analytical Engine weaves algebraic patterns.</span></div></div>
      <a href="/ada/status/5"><time>3:00 PM · Oct 12, 2026</time></a><span>12K</span><span>Views</span></article></main>`);
    expect(saved.text).toBe("The engine might compose elaborate pieces of music… [X shows only the start of this post]\n\n"
      + "Quoting Charles Babbage (@babbage):\nThe Analytical Engine weaves algebraic patterns.");
    expect(saved.title).toBe("Post by Ada Lovelace");
  });

  it("leaves other pages' title and author as the page gives them", async () => {
    document.title = "Why stress isn't the cause";
    const saved = await captureAll(`<main><article><h1>Why stress isn't the cause</h1><p>${POST}</p></article></main>`);
    expect(saved.title).toBe("Why stress isn't the cause");
    expect(saved.author).toBe("");
  });
});

describe("An X capture whose page shape is not recognised is cleaned line by line", () => {
  type Clean = (lines: string[]) => Captured | null;
  const clean = () => (window as unknown as { __irbCleanXLines: Clean }).__irbCleanXLines;

  beforeEach(async () => { await captureAll("<main><p>load the script</p></main>"); });

  it("drops X's chrome, the stats line and the reply below the post", () => {
    const lines = ["Post", "Log in", "Sign up", "Andrej Karpathy", "@karpathy",
      "Dusting off this tweet from April because this gap is *widening*.", "- Napkin math around 6B people.",
      "Andrej Karpathy", "@karpathy", "·", "Apr 9", "Judging by my tl there is a growing gap. This is", "Show more",
      "Last edited", "7:12 PM · Oct 11, 2026", "·", "6.3M", "Views", "1.9K", "3.1K", "42K",
      "pingfan", "@pingfan_ai", "Oct 11", "The funnel is real.", "13"];
    expect(clean()(lines)).toEqual({
      author: "Andrej Karpathy", title: "Post by Andrej Karpathy",
      text: "Dusting off this tweet from April because this gap is *widening*.\n- Napkin math around 6B people.\n\n"
        + "Quoting Andrej Karpathy (@karpathy):\nJudging by my tl there is a growing gap. This is… [X shows only the start of the quoted post]",
    });
  });

  it("gives up on text that has no X author line", () => {
    expect(clean()(["Something went wrong.", "Try reloading."])).toBeNull();
  });
});
