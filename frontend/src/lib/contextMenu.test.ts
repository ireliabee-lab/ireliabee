// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installContextMenuGuard, keepNativeMenu } from "./contextMenu";

function el(html: string): Element {
  const box = document.createElement("div");
  box.innerHTML = html;
  document.body.appendChild(box);
  return box.firstElementChild!;
}

describe("the webview's right-click menu", () => {
  it("is kept in text boxes and editable areas", () => {
    expect(keepNativeMenu(el("<input type='text'>"), "")).toBe(true);
    expect(keepNativeMenu(el("<textarea></textarea>"), "")).toBe(true);
    const editor = el("<div contenteditable='true'><p><b>word</b></p></div>");
    expect(keepNativeMenu(editor.querySelector("b"), "")).toBe(true);
  });

  it("is kept over selected text, so it can be copied", () => {
    expect(keepNativeMenu(el("<p>Some words</p>"), "Some")).toBe(true);
  });

  it("is hidden everywhere else, including on buttons and checkboxes", () => {
    expect(keepNativeMenu(el("<div>card</div>"), "")).toBe(false);
    expect(keepNativeMenu(el("<button>Start</button>"), "")).toBe(false);
    expect(keepNativeMenu(el("<input type='checkbox'>"), "")).toBe(false);
    expect(keepNativeMenu(el("<div contenteditable='false'>locked</div>"), "")).toBe(false);
    expect(keepNativeMenu(null, "  ")).toBe(false);
  });

  it("is blocked by the installed guard in a release build, and left alone in development", () => {
    installContextMenuGuard(false);
    const card = el("<div>card</div>");
    const blocked = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    card.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    const box = el("<textarea></textarea>");
    const kept = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    box.dispatchEvent(kept);
    expect(kept.defaultPrevented).toBe(false);
  });
});
