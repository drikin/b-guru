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
//
// ⚠️ The open-transition pin MUST live in its own effect keyed only on
// `chatView`. It was originally inside the auto-scroll effect, whose deps
// include `chatMessages`; loading the messages re-ran that effect and its
// cleanup disconnected the ResizeObserver, so late content was never followed
// (measured: 3 creates, 1 disconnect, list 376px short of the bottom).

const ROOT = path.resolve(__dirname, "../../..");
const page = readFileSync(path.join(ROOT, "src/app/page.tsx"), "utf8");

/** The dedicated open-transition effect (deps: [chatView]). */
function openEffect(): string {
  const start = page.indexOf("// The open-transition pin lives in its OWN effect");
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf("}, [chatView]);", start);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

/** The follow-on-new-message effect (deps: [chatMessages, chatView]). */
function followEffect(): string {
  const start = page.indexOf("const chatWasOpenRef = useRef(false);");
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf("// Track whether the chat list is currently scrolled", start);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("chat opens at the bottom", () => {
  it("has a dedicated effect keyed only on chatView", () => {
    const body = openEffect();
    // Keyed on chatView alone — NOT on chatMessages, or loading the messages
    // tears the observer down before late content arrives. Strip comments
    // first: the explanatory comment legitimately mentions chatMessages.
    const code = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("if (!chatView) return;");
    expect(code).not.toContain("chatMessages");
  });

  it("scrolls to the bottom immediately and after layout settles", () => {
    const body = openEffect();
    expect(body).toContain("el.scrollTop = el.scrollHeight;");
    expect(body).toContain("requestAnimationFrame(toBottom)");
    expect(body).toContain("window.setTimeout(toBottom, 60)");
    expect(body).toContain("window.setTimeout(toBottom, 240)");
  });

  it("marks the list as at-bottom so subsequent messages keep following", () => {
    expect(openEffect()).toContain("chatAtBottomRef.current = true;");
  });

  it("keeps pinning while late content grows the list", () => {
    const body = openEffect();
    // Fixed 60/240ms timers are not enough: avatars/images/fonts load later and
    // left the list hundreds of px short of the bottom in testing.
    expect(body).toContain("new ResizeObserver");
    expect(body).toContain("chatPinningRef.current = true;");
    expect(body).toContain("ro?.disconnect()");
    // No time limit: a fixed window expired before the last image on a slow
    // runner and made the E2E guard flaky. The scroll listener releases it.
    expect(body).not.toContain("stopPin");
  });

  it("observes the ScrollArea content, not the viewport", () => {
    // The viewport has a fixed height, so only the content growing means the
    // list got taller. Mantine mounts the content a tick after the viewport, so
    // on a slow machine firstElementChild is still null when the effect runs —
    // observing the viewport as a fallback then never fires (measured on CI).
    const body = openEffect();
    expect(body).toContain("const target = el.firstElementChild;");
    expect(body).toContain("ro.observe(target);");
    // Must retry, and must not fall back to observing the viewport.
    expect(body).toContain("requestAnimationFrame(attach)");
    expect(body).toContain("window.setTimeout(attach, 120)");
    expect(body).not.toContain("el.firstElementChild ?? el");
  });

  it("cleans up every timer and frame it schedules", () => {
    const body = openEffect();
    for (const cleanup of [
      "cancelAnimationFrame(r1)",
      "cancelAnimationFrame(r2)",
      "cancelAnimationFrame(r3)",
      "window.clearTimeout(t1)",
      "window.clearTimeout(t2)",
      "window.clearTimeout(t3)",
      "ro?.disconnect()",
    ]) {
      expect(body).toContain(cleanup);
    }
  });
});

describe("a new message does not steal a reader's position", () => {
  it("gates the follow on being at the bottom", () => {
    const body = followEffect();
    expect(body).toContain("if (!chatAtBottomRef.current) return;");
    // And the delayed callbacks re-check before moving.
    expect(body).toContain("if (d < 120) el.scrollTop = el.scrollHeight;");
  });

  it("leaves the open transition to the dedicated effect", () => {
    // The follow effect must not also try to handle the open case.
    expect(followEffect()).toContain("if (justOpened) return;");
  });

  it("cancels the pin when the user scrolls away", () => {
    const start = page.indexOf("const onScroll = () => {");
    expect(start).toBeGreaterThan(-1);
    const body = page.slice(start, start + 1400);
    // The pin is released only for a scroll the user actually caused.
    expect(body).toContain("chatPinningRef.current = false;");
    expect(body).toContain("chatLastScrollTopRef.current");
  });

  it("does not let content growth cancel the pin", () => {
    // Growth fires a scroll event too (the browser clamps scrollTop). Treating
    // that as "the user scrolled away" cancelled the pin before the
    // ResizeObserver could follow, leaving the list ~400px short of the bottom
    // — reproduced on CI while passing locally.
    const start = page.indexOf("const onScroll = () => {");
    const body = page.slice(start, start + 1400);
    // The release must be guarded by a real position change, not just !atBottom.
    expect(body).not.toMatch(/if \(!atBottom\) chatPinningRef\.current = false;/);
    expect(body).toContain("const moved = Math.abs(el.scrollTop - chatLastScrollTopRef.current) > 4;");
    expect(body).toContain("if (moved) chatPinningRef.current = false;");
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
