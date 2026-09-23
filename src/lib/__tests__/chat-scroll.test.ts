import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Regression tests for the chat scroll-position behaviour.
//
// Two reports from drikin, and the fix for the second must not undo the first:
//
//  2026-09-22 「チャットに切り替えた時に、なんか勝手にスクロールして過去ログが
//              スクロールアウトしちゃいます」
//    → a new message must not steal the position of a user who scrolled up.
//
//  2026-09-23 「タイムラインが下にスクロールした状態でチャットに切り替えると
//              チャットログがスクロールして読めなくなる。チャットに切り替えたら
//              スクロール位置も正しくリセットする」
//    → opening the tab must land at the BOTTOM. The chat list is unmounted while
//      the timeline is shown, so on re-open its scrollTop is 0 and the user was
//      looking at the oldest messages.
//
// The first fix ("never scroll on the open transition") caused the second bug.
// These tests pin both behaviours so neither can regress alone.

const ROOT = path.resolve(__dirname, "../../..");
const page = readFileSync(path.join(ROOT, "src/app/page.tsx"), "utf8");

/** The auto-scroll effect body, from its declaration to the next effect. */
function autoScrollEffect(): string {
  const start = page.indexOf("const chatWasOpenRef = useRef(false);");
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf("// Track whether the chat list is currently scrolled", start);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("chat auto-scroll on tab open", () => {
  it("scrolls to the bottom when the chat tab opens", () => {
    const body = autoScrollEffect();
    // The justOpened branch must actively move the viewport, not bail out.
    expect(body).toContain("if (justOpened) {");
    expect(body).toContain("el.scrollTop = el.scrollHeight;");
    // It must NOT be a bare early-return any more (that was the 2026-09-23 bug).
    expect(body).not.toMatch(/if \(justOpened\) return;/);
  });

  it("re-applies the bottom position after layout settles", () => {
    const body = autoScrollEffect();
    // The list grows after the 180ms mount fade, so a single scroll is not
    // enough — the open branch needs the same rAF/timeout ladder as the follow.
    const openBranch = body.slice(body.indexOf("if (justOpened) {"));
    expect(openBranch).toContain("requestAnimationFrame");
    expect(openBranch).toContain("window.setTimeout(toBottom, 60)");
    expect(openBranch).toContain("window.setTimeout(toBottom, 240)");
  });

  it("marks the list as at-bottom so subsequent messages keep following", () => {
    const body = autoScrollEffect();
    const openBranch = body.slice(body.indexOf("if (justOpened) {"));
    expect(openBranch).toContain("chatAtBottomRef.current = true;");
  });

  it("still refuses to steal the position of a user who scrolled up", () => {
    const body = autoScrollEffect();
    // The follow path (new message while already open) must stay gated.
    expect(body).toContain("if (!chatAtBottomRef.current) return;");
    // And the delayed callbacks must re-check before moving.
    expect(body).toContain("if (d < 120) el.scrollTop = el.scrollHeight;");
  });

  it("cleans up every timer and frame it schedules", () => {
    const body = autoScrollEffect();
    for (const cleanup of [
      "cancelAnimationFrame(r1)",
      "cancelAnimationFrame(r2)",
      "window.clearTimeout(t1)",
      "window.clearTimeout(t2)",
    ]) {
      expect(body).toContain(cleanup);
    }
  });
});

describe("chat list is the element being scrolled", () => {
  it("binds chatListRef to the ScrollArea viewport", () => {
    expect(page).toContain("viewportRef={chatListRef}");
  });

  it("tracks at-bottom state from real scroll events", () => {
    // Reading scrollHeight inside the effect would always look far from the
    // bottom because the DOM has already grown by then.
    expect(page).toContain('el.addEventListener("scroll", onScroll, { passive: true })');
  });
});
