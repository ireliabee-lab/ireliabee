/**
 * Text boxes grow with their content instead of scrolling inside themselves.
 * Modern webviews do this in CSS (`field-sizing: content`, see index.css);
 * this fallback covers webviews without it (e.g. older WebKitGTK on Linux).
 * A textarea's `rows` stays its minimum height.
 */
export function installAutoGrow() {
  if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return;

  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";  // back to the rows height, then grow to fit
    el.style.height = `${el.scrollHeight + 2}px`;
    el.style.overflowY = "hidden";
  };
  const isBox = (t: EventTarget | null): t is HTMLTextAreaElement =>
    t instanceof HTMLTextAreaElement && t.classList.contains("glass-input");

  document.addEventListener("input", e => { if (isBox(e.target)) fit(e.target); }, true);
  document.addEventListener("focusin", e => { if (isBox(e.target)) fit(e.target); }, true);

  // Values set by the app (a loaded profile, a generated plan) fire no input
  // event, so re-fit after the page changes — at most a few times a second.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      document.querySelectorAll<HTMLTextAreaElement>("textarea.glass-input").forEach(fit);
    }, 250);
  }).observe(document.body, { childList: true, subtree: true });
}
