// Evaluated only after the native Save to notebook action. No scrolling,
// observers, timers, fetching, storage access or automatic capture.
// What is taken: a post or article that is on screen, whole (a long X post is
// taller than the window, so its end is below it), and other text only where
// it is on screen.

/** Text an element shows, roughly: enough to compare candidates, not to capture. */
function __irbTextSize(el) {
  return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().length;
}

/**
 * Where the content is, so a post or article comes without the page around it:
 * a post opened in a dialog, else the page's main region, else the whole page.
 * Side columns, navigation and banners inside it are skipped by the walker.
 */
function __irbPickRoot(doc) {
  const dialogs = Array.from(doc.querySelectorAll("[role='dialog'],dialog[open]"))
    .filter(d => !d.closest("[hidden],[aria-hidden='true']") && __irbTextSize(d) >= 200);
  if (dialogs.length) return dialogs.sort((a, b) => __irbTextSize(b) - __irbTextSize(a))[0];
  const main = doc.querySelector("main,[role='main']");
  if (main && __irbTextSize(main) >= 200) return main;
  const articles = Array.from(doc.querySelectorAll("article,[role='article']")).filter(a => __irbTextSize(a) >= 200);
  if (articles.length === 1) return articles[0];
  return doc.body;
}

/** Parts of a page that are never the content: menus, banners, side columns, forms. */
const __IRB_SKIP = "script,style,noscript,iframe,form,input,textarea,button,nav,header,footer,aside,"
  + "[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary'],[hidden],[aria-hidden='true']";

/** Whether a box is at least partly inside the window. */
function __irbOnScreen(r) {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/** Posts and articles in `root` that are on screen: these are taken whole. */
function __irbOnScreenPosts(root) {
  const posts = Array.from(root.querySelectorAll("article,[role='article']"));
  if (root.matches("article,[role='article']")) posts.push(root);
  return posts.filter(p => __irbOnScreen(p.getBoundingClientRect()));
}

/** The text in `root` that is on screen, or inside an on-screen post, one text node per line. */
function __irbVisibleText(root) {
  const pieces = [];
  let length = 0;
  const posts = __irbOnScreenPosts(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;
    // A header inside the post itself (its title, its author) is content; the page's own header is not.
    const skipped = parent.closest(__IRB_SKIP);
    const postHeader = skipped && skipped.tagName === "HEADER" && skipped.closest("article,[role='article'],[role='dialog'],dialog");
    if (skipped && !postHeader) continue;
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility !== "visible" || parseFloat(style.opacity) === 0) continue;
    let transparentAncestor = false;
    for (let ancestor = parent.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (parseFloat(getComputedStyle(ancestor).opacity) === 0) { transparentAncestor = true; break; }
    }
    if (transparentAncestor) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects());
    // Laid out (not collapsed away), and on screen or inside a post that is.
    if (!rects.some(r => r.width > 0 && r.height > 0)) continue;
    if (!rects.some(__irbOnScreen) && !posts.some(p => p.contains(node))) continue;
    const text = node.textContent.trim();
    if (!text) continue;
    length += text.length;
    if (length > 5000000) break;
    pieces.push(text);
  }
  return pieces.join("\n");
}

// ---- X (Twitter) --------------------------------------------------------
// A post page carries X's chrome ("Post", "Log in", "Sign up"), the post's
// edit note, time and views, and the replies below it. Only the post is kept:
// its author, its text, and the post it quotes, labelled as the public path
// labels it. `var`, not `const`, so running the script again is harmless.

var __IRB_X_HOST = /(^|\.)(x|twitter)\.com$/i;
var __IRB_X_HANDLE = /^@\w{1,15}$/;
/** Where X cuts a post on the page, in the saved text, so a notebook knows. */
var __IRB_X_QUOTE_CUT = "… [X shows only the start of the quoted post]";
var __IRB_X_POST_CUT = "… [X shows only the start of this post]";

/** Whether an element is drawn: not display:none, hidden or fully transparent. */
function __irbDrawn(el) {
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) !== 0;
}

/** Text as it reads inline: spans joined as they are, line breaks kept, emoji from their alt text. */
function __irbInlineText(el) {
  let out = "";
  const walk = n => {
    if (n.nodeType === 3) { out += n.textContent; return; }
    if (n.nodeType !== 1 || !__irbDrawn(n)
      || n.matches("script,style,noscript,svg,button,[data-testid='tweet-text-show-more-link']")) return;
    if (n.tagName === "BR") { out += "\n"; return; }
    if (n.tagName === "IMG") { out += n.getAttribute("alt") || ""; return; }
    n.childNodes.forEach(walk);
  };
  walk(el);
  return out.replace(/[ \t ]+/g, " ").split("\n").map(l => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

/** The display name and @handle in an X User-Name block ("Name @handle · date"). */
function __irbXUser(box) {
  let handle = "";
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent.trim();
    if (__IRB_X_HANDLE.test(t)) { handle = t; break; }
  }
  const all = __irbInlineText(box).replace(/\n/g, " ");
  const name = (handle ? all.split(handle)[0] : all).replace(/[\s·]+$/, "").trim();
  return { name, handle };
}

/** Whether a quoted post's text stops mid-sentence (X cut it on the page). */
function __irbEndsMidSentence(text) {
  return !/([.!?"”'’)\]]|\p{Extended_Pictographic}️?)$/u.test(text);
}

/** Mark where X cut a post's text on the page. */
function __irbCut(text, mark) {
  return text.replace(/\s*…$/, "") + mark;
}

/** A post and the post it quotes, joined and labelled as the public path does ("Quoting Name (@handle):"). */
function __irbXResult(user, body, quote) {
  const parts = body ? [body] : [];
  if (quote && quote.text) {
    const q = quote.user;
    const label = q.name && q.handle ? `${q.name} (${q.handle})` : q.name || q.handle || "another post";
    parts.push(`Quoting ${label}:\n${quote.text}`);
  }
  if (!parts.length) return null;
  return { text: parts.join("\n\n"), author: user.name, title: user.name ? `Post by ${user.name}` : "X post" };
}

/** The post a page is about: the one the address names, else the first on screen, else the first. */
function __irbXArticle(doc) {
  const shaped = list => Array.from(list).filter(a => a.querySelector("[data-testid='User-Name']"));
  let articles = shaped(__irbPickRoot(doc).querySelectorAll("article[data-testid='tweet']"));
  if (!articles.length) articles = shaped(doc.querySelectorAll("article[data-testid='tweet']"));
  if (!articles.length) return null;
  const id = (location.pathname.match(/\/status(?:es)?\/(\d+)/) || [])[1];
  const ownLink = new RegExp(`/status(?:es)?/${id}/?$`);
  const own = id && articles.find(a => Array.from(a.querySelectorAll("a[href] time"))
    .some(t => ownLink.test(t.closest("a").getAttribute("href") || "")));
  return own || articles.find(a => __irbOnScreen(a.getBoundingClientRect())) || articles[0];
}

/**
 * An X post read from its page structure: the post's own author and text, and
 * the post it quotes. Its time, edit note, views and buttons, and the replies
 * below it, are not part of it. Null when the page is not shaped like an X post.
 */
function __irbXPost(doc) {
  const article = __irbXArticle(doc);
  if (!article) return null;
  const names = Array.from(article.querySelectorAll("[data-testid='User-Name']"));
  // The quoted post: the box around the second author that holds its text, short of the main author.
  let quoteBox = null;
  for (let el = names[1] && names[1].parentElement; el && el !== article && !el.contains(names[0]); el = el.parentElement) {
    if (el.querySelector("[data-testid='tweetText']")) { quoteBox = el; break; }
  }
  const inQuote = el => !!quoteBox && quoteBox.contains(el);
  const showsMore = (box, keep) => Array.from(box.querySelectorAll("[data-testid='tweet-text-show-more-link'],button,[role='button'],span"))
    .some(el => keep(el) && (el.matches("[data-testid='tweet-text-show-more-link']") || el.textContent.trim() === "Show more"));
  const ownText = Array.from(article.querySelectorAll("[data-testid='tweetText']")).find(el => !inQuote(el));
  let body = ownText ? __irbInlineText(ownText) : "";
  if (body && showsMore(article, el => !inQuote(el))) body = __irbCut(body, __IRB_X_POST_CUT);
  let quote = null;
  if (quoteBox) {
    const quoted = quoteBox.querySelector("[data-testid='tweetText']");
    let text = quoted ? __irbInlineText(quoted) : "";
    if (text && (showsMore(quoteBox, () => true) || __irbEndsMidSentence(text))) text = __irbCut(text, __IRB_X_QUOTE_CUT);
    quote = { user: __irbXUser(names[1]), text };
  }
  return __irbXResult(__irbXUser(names[0]), body, quote);
}

/** "7:12 PM · Oct 11, 2026" or "19:12 · 11 Oct 2026": the post's own timestamp, where the post ends. */
var __IRB_X_STAMP = /^\d{1,2}:\d{2}(\s?[AP]M)?\s*·\s*\S/i;
/** A short post date beside an author: "Apr 9", "9 Apr", "Oct 11, 2025", "2h". */
var __IRB_X_DATE = /^(\w{3} \d{1,2}(, \d{4})?|\d{1,2} \w{3}( \d{4})?|\d+[smhd])$/;

/** Skip the "·" and short date that follow an author's @handle. */
function __irbPastDate(lines, i) {
  while (i < lines.length && (lines[i] === "·" || __IRB_X_DATE.test(lines[i]))) i++;
  return i;
}

/**
 * The same cleaning from captured lines, for an X page whose structure is not
 * recognised: start at the first author ("Name", "@handle"), stop at the post's
 * own edit note or timestamp (replies come after it), and label a quoted post.
 * Null when no author is found.
 */
function __irbCleanXLines(lines) {
  lines = lines.map(l => l.trim()).filter(Boolean);
  const isAuthor = (l, next) => !l.startsWith("@") && l !== "·" && __IRB_X_HANDLE.test(next || "");
  const at = lines.findIndex((l, i) => isAuthor(l, lines[i + 1]));
  if (at < 0) return null;
  const start = __irbPastDate(lines, at + 2);
  let end = lines.findIndex((l, k) => k >= start && (l === "Last edited" || __IRB_X_STAMP.test(l)));
  if (end < 0) end = lines.length;
  const rest = lines.slice(start, end).filter(l => l !== "Translate post");
  // A quoted post: "Name", "@handle", then "·" or a short date.
  const q = rest.findIndex((l, k) => isAuthor(l, rest[k + 1]) && (rest[k + 2] === "·" || __IRB_X_DATE.test(rest[k + 2] || "")));
  const own = q >= 0 ? rest.slice(0, q) : rest;
  let body = own.filter(l => l !== "Show more").join("\n");
  if (body && own.includes("Show more")) body = __irbCut(body, __IRB_X_POST_CUT);
  let quote = null;
  if (q >= 0) {
    const quoted = rest.slice(__irbPastDate(rest, q + 2));
    let text = quoted.filter(l => l !== "Show more").join("\n");
    if (text && (quoted.includes("Show more") || __irbEndsMidSentence(text))) text = __irbCut(text, __IRB_X_QUOTE_CUT);
    quote = { user: { name: rest[q], handle: rest[q + 1] }, text };
  }
  return __irbXResult({ name: lines[at], handle: lines[at + 1] }, body, quote);
}

(async () => {
  const onX = __IRB_X_HOST.test(location.hostname);
  let found = onX || document.querySelector("article[data-testid='tweet'] [data-testid='User-Name']")
    ? __irbXPost(document) : null;
  if (!found) {
    const text = __irbVisibleText(__irbPickRoot(document));
    found = (onX && __irbCleanXLines(text.split("\n")))
      || { text, title: document.title, author: document.querySelector('meta[name="author"]')?.content || "" };
  }
  await window.__TAURI_INTERNALS__.invoke("capture_link_text", {
    nonce: __CAPTURE_NONCE__, text: found.text, title: found.title, author: found.author,
  });
})().catch(() => { /* The app can retry the native action or use a screenshot. */ });
