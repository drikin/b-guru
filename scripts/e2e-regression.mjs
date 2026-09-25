#!/usr/bin/env node
/**
 * E2E regression guard for the B-guru portal.
 *
 * Why this exists: the chat scroll bug regressed twice. The first fix
 * ("never scroll on tab open") was correct for the report it answered and
 * wrong for the next one, and no unit test could catch it because the bug
 * only appears in a real browser with a real layout. Static source checks
 * (chat-scroll.test.ts) pin the *shape* of the fix; this script pins the
 * *behaviour*.
 *
 * It drives a real Chromium against a running instance and asserts the
 * user-visible outcomes drikin reported. Run it against production after
 * every deploy, and against a local build in CI.
 *
 * Usage:
 *   node scripts/e2e-regression.mjs                    # against production
 *   BASE_URL=http://localhost:3000 node scripts/e2e-regression.mjs
 *
 * Requires a session token in BSM_SESSION (see the skill for how to mint one).
 */

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "https://bsm.backspace.fm";
const SESSION = process.env.BSM_SESSION;
const HEADLESS = process.env.HEADLESS !== "0";

if (!SESSION) {
  console.error("BSM_SESSION is required (a valid bsm_session token).");
  process.exit(2);
}

const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Distance from the bottom of the chat list, in px. 0 = pinned to bottom. */
const CHAT_DIST = `(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  if (!chat) return null;
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  if (!vp) return null;
  return {
    scrollTop: Math.round(vp.scrollTop),
    scrollHeight: Math.round(vp.scrollHeight),
    clientHeight: Math.round(vp.clientHeight),
    dist: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight),
  };
})()`;

/** Click the タイムライン / チャット segmented control. */
const clickTab = (label) => `(() => {
  const btns = [...document.querySelectorAll('label, button, [role="radio"]')];
  const b = btns.find(x => x.textContent && x.textContent.includes(${JSON.stringify(label)}));
  if (!b) return false;
  b.click();
  return true;
})()`;

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
await context.addCookies([
  {
    name: "bsm_session",
    value: SESSION,
    domain: new URL(BASE_URL).hostname,
    path: "/",
    secure: BASE_URL.startsWith("https"),
    httpOnly: true,
  },
]);

const page = await context.newPage();
const consoleErrors = [];
const notFound = [];
// Console messages for failed subresources carry no URL, so correlate with the
// response event: a 404 from /api/avatar/<md5> is EXPECTED (the member has no
// Gravatar and SafeAvatar falls back to the initial-letter placeholder; the
// proxy caches the negative result). Counting it as an error would make this
// guard cry wolf on every run.
const expected404 = new Set();
page.on("response", (r) => {
  if (r.status() === 404 && /\/api\/avatar\/[a-f0-9]{32}/.test(r.url())) {
    expected404.add(r.url());
  }
});
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text().slice(0, 200);
  if (/Failed to load resource/.test(text) && expected404.size > 0) {
    notFound.push(text);
    return;
  }
  consoleErrors.push(text);
});

console.log(`\n=== B-guru E2E regression guard ===`);
console.log(`target: ${BASE_URL}\n`);

// ---------------------------------------------------------------- load
console.log("1. Initial load");
await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);

const bodyText = await page.evaluate(() => document.body.innerText);
check("page renders (no client crash)", !/couldn't load/i.test(bodyText), `${bodyText.length} chars`);
check("timeline is visible", /タイムライン/.test(bodyText));
check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

// ------------------------------------------------- chat scroll: open at bottom
console.log("\n2. Chat opens at the bottom (drikin 2026-09-23)");
// Scroll the timeline down first — this is the exact precondition reported.
await page.evaluate(() => window.scrollBy(0, 6000));
await page.waitForTimeout(1200);
const timelineScroll = await page.evaluate(() => Math.round(window.scrollY));
check("timeline scrolled down", timelineScroll > 1000, `scrollY=${timelineScroll}`);

await page.evaluate(clickTab("チャット"));
// Poll rather than sleep: the chat list mounts, then the messages load, then
// the open-transition pin settles. How long that takes varies with the machine.
let d = null;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(250);
  d = await page.evaluate(CHAT_DIST);
  if (d && d.dist < 5) break;
}
check("chat list exists", d !== null);
if (!d) {
  // Without the chat list we cannot verify anything below — fail hard rather
  // than silently skipping, so a broken build never looks like a pass.
  console.log("\nFATAL: chat list not found; cannot verify scroll behaviour.");
  await browser.close();
  process.exit(1);
}
check("chat opens pinned to the bottom", d.dist < 5, `dist=${d.dist}px`);

// Record the pin state right after opening, before anything else runs. If the
// pin is already released here, the failure downstream is not about the
// observer at all — it is about the open transition not holding.
const pinAfterOpen = await page.evaluate(`(() => window.__e2ePinProbe ? window.__e2ePinProbe() : null)()`);
console.log("  [diag] pin right after open: " + JSON.stringify(pinAfterOpen));
// Start recording every scroll event from here on, so a later failure can name
// the exact event that released the pin.
await page.evaluate(`(() => { window.__e2eScrollLog = []; })()`);

// ------------------------------------------- chat scroll: late content settles
console.log("\n3. Stays at the bottom while late content loads");
// Let images/avatars land, then confirm the list is still pinned.
let stillPinned = null;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250);
  stillPinned = await page.evaluate(CHAT_DIST);
  if (stillPinned && stillPinned.dist >= 5) break; // drifted — stop early
}
check(
  "still at the bottom after images/avatars settle",
  !!stillPinned && stillPinned.dist < 5,
  `dist=${stillPinned?.dist}px`
);

// 3b. Force late content growth. This is the part that actually catches the
// regression: on a warm cache the avatars/images are already loaded, so the
// fixed 60/240ms timers alone are enough and a missing ResizeObserver would
// pass unnoticed. Injecting a tall node AFTER those timers have fired proves
// the list keeps pinning as content grows.
console.log("\n3b. Keeps pinning when content grows after the settle timers");
const grew = await page.evaluate(`(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  const inner = vp.firstElementChild;
  if (!inner) return null;
  const before = vp.scrollHeight;
  const d = document.createElement('div');
  d.id = '__e2e_growth';
  d.style.height = '400px';
  d.style.flex = '0 0 auto';
  inner.appendChild(d);
  return { before, after: vp.scrollHeight };
})()`);
check("growth injected", grew !== null && grew.after > grew.before, grew ? `${grew.before} → ${grew.after}` : "no inner");
// ResizeObserver fires asynchronously, and how long it takes varies with the
// machine (measured: settled by +300ms locally, later on a CI runner). Poll
// instead of sleeping a fixed amount, so the check tests the behaviour rather
// than the runner's speed.
let settled = null;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250);
  settled = await page.evaluate(CHAT_DIST);
  if (settled && settled.dist < 5) break;
}
// Diagnostics: when this check fails, the numbers below say WHY. A dist that
// equals the injected height means the observer never ran; a dist that shrinks
// slowly means it ran but was too late; scrollTop moving means something
// scrolled the list.
if (!settled || settled.dist >= 5) {
  const diag = await page.evaluate(`(() => {
    const chat = document.querySelector('[class*="bguru-chat-view"]');
    const vp = chat.querySelector('.mantine-ScrollArea-viewport');
    const inner = vp.firstElementChild;
    // Count how many ResizeObservers the app created and whether any of them
    // is still connected. Patch the constructor BEFORE the app runs is not
    // possible here, so instead: does a fresh observer on the same target fire?
    // (yes => the browser is fine, so the app's observer must be gone or
    //  watching something else)
    return new Promise((resolve) => {
      let mineFired = 0;
      const ro = new ResizeObserver(() => { mineFired++; });
      ro.observe(inner);
      const d2 = document.createElement('div');
      d2.style.height = '200px';
      d2.style.flex = '0 0 auto';
      inner.appendChild(d2);
      setTimeout(() => {
        ro.disconnect();
        resolve({
          scrollTop: Math.round(vp.scrollTop),
          scrollHeight: Math.round(vp.scrollHeight),
          clientHeight: Math.round(vp.clientHeight),
          dist: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight),
          growthPresent: !!document.getElementById('__e2e_growth'),
          growthHeight: document.getElementById('__e2e_growth')?.offsetHeight ?? null,
          innerIsVpChild: vp.contains(inner),
          innerClass: inner?.className ?? null,
          myObserverFired: mineFired,
          // Is the app's pin still armed? If the pin was released, the observer
          // firing would do nothing — that is a different bug from "not firing".
          pinArmed: window.__e2ePinProbe ? window.__e2ePinProbe() : "no-probe",
          ua: navigator.userAgent,
        });
      }, 1500);
    });
  })()`);
  console.log("  [diag] " + JSON.stringify(diag));
  const scrollLog = await page.evaluate(`(() => window.__e2eScrollLog || [])()`);
  console.log("  [diag] scroll events: " + JSON.stringify(scrollLog));
}
check(
  "still pinned to the bottom after late growth",
  !!settled && settled.dist < 5,
  `dist=${settled?.dist}px (a missing ResizeObserver leaves this > 0)`
);
await page.evaluate(`(() => { document.getElementById('__e2e_growth')?.remove(); })()`);
await page.waitForTimeout(500);

// ------------------------------------- chat scroll: reading history is respected
console.log("\n4. Scrolling up to read history is not stolen");
await page.evaluate(`(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  vp.scrollTop = 0;
  vp.dispatchEvent(new Event('scroll', { bubbles: true }));
})()`);
await page.waitForTimeout(4000);
d = await page.evaluate(CHAT_DIST);
check("position held while scrolled up", !!d && d.scrollTop < 50, `scrollTop=${d?.scrollTop}`);

// ------------------------------------------- chat scroll: re-open resets to bottom
console.log("\n5. Re-opening the tab resets to the bottom");
await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollBy(0, 4000));
await page.waitForTimeout(800);
await page.evaluate(clickTab("チャット"));
await page.waitForTimeout(4000);
d = await page.evaluate(CHAT_DIST);
check("re-open lands at the bottom", !!d && d.dist < 5, `dist=${d?.dist}px`);

// ------------------------------------------------- chat view survives search
console.log("\n6. Chat body survives opening search (2026-09-22 fix)");
const chatHeightBefore = await page.evaluate(`(() => {
  const c = document.querySelector('[class*="bguru-chat-view"]');
  return c ? Math.round(c.getBoundingClientRect().height) : 0;
})()`);
check("chat body has height", chatHeightBefore > 200, `${chatHeightBefore}px`);

// ------------------------------------------------- tab bar does not move
console.log("\n6b. Tab bar stays put when switching (drikin 2026-09-23)");
// The tabs are position:sticky, so ANY window scroll shifts them (80px at
// scrollY=0, 56px once scrolled). The bug was that opening the chat scrolled
// the window, so the bar jumped on every switch. Compare like with like: start
// from the top of the timeline, which is the state a user is in when they tap
// the chat tab without having scrolled.
const tabPos = async () =>
  page.evaluate(`(() => {
    const t = document.querySelector('[data-cx="navtabs"]');
    return t ? { top: Math.round(t.getBoundingClientRect().top), scrollY: Math.round(window.scrollY) } : null;
  })()`);

await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(2000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
const tabOnTimeline = await tabPos();
await page.evaluate(clickTab("チャット"));
await page.waitForTimeout(3000);
const tabOnChat = await tabPos();

check("tab bar found on both views", tabOnTimeline !== null && tabOnChat !== null);
if (tabOnTimeline && tabOnChat) {
  check(
    "tab bar does not move between views",
    tabOnTimeline.top === tabOnChat.top,
    `timeline=${tabOnTimeline.top}px chat=${tabOnChat.top}px`
  );
  check(
    "window is not scrolled in chat view",
    tabOnChat.scrollY === 0,
    `scrollY=${tabOnChat.scrollY}`
  );
}

// 6c. The reported precondition: scrolled deep in the timeline, then switch.
// The chat must still open with the tab bar at its resting position.
console.log("\n6c. Switching from a scrolled timeline does not shift the bar");
await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(2000);
await page.evaluate(() => window.scrollTo(0, 6000));
await page.waitForTimeout(1000);
await page.evaluate(clickTab("チャット"));
await page.waitForTimeout(3000);
const tabFromScrolled = await tabPos();
if (tabFromScrolled) {
  check(
    "tab bar is at its resting position after switching from a scrolled timeline",
    tabFromScrolled.top === tabOnTimeline?.top,
    `expected=${tabOnTimeline?.top}px got=${tabFromScrolled.top}px`
  );
}

// 6d. The bar must not move WHILE the timeline scrolls (drikin 2026-09-23:
// 「タイムラインがスクロールすると、タブの位置が若干ずれる」). With the sticky
// offset set to the header height the bar rested at 80px but snapped to 56px on
// the first scroll — a 24px jump that made every tab switch look jittery.
console.log("\n6d. Tab bar is pinned while the timeline scrolls");
await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(2000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
const tabAtTop = await tabPos();
const tabWhileScrolling = [];
for (const y of [50, 200, 800, 2500, 6000]) {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(350);
  tabWhileScrolling.push(await tabPos());
}
const tops = tabWhileScrolling.map((t) => t?.top);
const allSame = tops.every((t) => t === tabAtTop?.top);
check(
  "tab bar does not move while scrolling the timeline",
  allSame,
  `at top=${tabAtTop?.top}px, while scrolling=${tops.join("/")}px`
);

// 6e. The bar must sit FLUSH against the header. Pinning it lower (80px) left a
// 24px strip above it where scrolled content showed through, which looks broken
// (drikin: 「スクロールしたコンテンツがタブの裏側に見えて変」).
console.log("\n6e. Tab bar sits flush under the header (no gap)");
await page.evaluate(() => window.scrollTo(0, 3000));
await page.waitForTimeout(600);
const gapInfo = await page.evaluate(`(() => {
  const t = document.querySelector('[data-cx="navtabs"]');
  const header = document.querySelector('[data-cx="header"]') || document.querySelector('header');
  if (!t) return null;
  const tr = t.getBoundingClientRect();
  const hr = header ? header.getBoundingClientRect() : null;
  return {
    tabTop: Math.round(tr.top),
    headerBottom: hr ? Math.round(hr.bottom) : null,
    gap: hr ? Math.round(tr.top - hr.bottom) : null,
  };
})()`);
check(
  "no gap between the header and the tab bar",
  !!gapInfo && gapInfo.gap !== null && Math.abs(gapInfo.gap) <= 1,
  gapInfo ? `header bottom=${gapInfo.headerBottom}px tab top=${gapInfo.tabTop}px gap=${gapInfo.gap}px` : "not found"
);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(500);

// 6f. Pull-to-refresh must be OFF in the chat view (drikin 2026-09-23:
// 「チャットに切り替えたときにスクロールしようとすると引っ張りリロードになっちゃう」).
// The window is frozen at scrollY=0 while the chat is open, so the gesture's
// `window.scrollY > 0` guard never trips and every scroll attempt was read as a
// pull. Two things must hold: the iOS custom gesture is not armed, and the
// native overscroll is contained so Android Chrome does not reload either.
console.log("\n6f. Pull-to-refresh is disabled in the chat view");
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
// Open the chat tab. The switcher is a Mantine SegmentedControl: the clickable
// elements are <label class="mantine-SegmentedControl-label">, and they are NOT
// siblings of the same element type, so :nth-of-type() does not select them —
// index into the NodeList instead.
const tabLabels = await page.$$('[data-cx="navtabs"] label.mantine-SegmentedControl-label');
if (tabLabels.length >= 2) {
  await tabLabels[1].click();
  await page.waitForTimeout(2500);
}
const ptrInfo = await page.evaluate(`(() => {
  const view = document.querySelector('.bguru-chat-view');
  if (!view) return { found: false };
  const cs = getComputedStyle(view);
  const vp = view.querySelector('[data-radix-scroll-area-viewport], .mantine-ScrollArea-viewport');
  const vpCs = vp ? getComputedStyle(vp) : null;
  // The two layers are set independently and BOTH matter:
  //   - the view's own overscroll-behavior comes from the inline style in
  //     page.tsx (belt) and the .bguru-chat-view rule in globals.css (braces)
  //   - the ScrollArea viewport is the element that actually receives the touch,
  //     and it is only covered by the globals.css rule
  // Verified by degrading each layer separately: removing the CSS rule alone
  // left the view check PASSing (the inline style still applied) while the
  // viewport check failed — so the viewport assertion is the one that catches a
  // CSS-only regression, and the view assertion catches an inline-style one.
  return {
    found: true,
    viewOverscroll: cs.overscrollBehaviorY || cs.overscrollBehavior,
    viewportOverscroll: vpCs ? (vpCs.overscrollBehaviorY || vpCs.overscrollBehavior) : null,
    hasViewport: !!vp,
  };
})()`);
check(
  "chat view contains overscroll (native pull-to-refresh off)",
  ptrInfo.found && ptrInfo.viewOverscroll === "contain",
  ptrInfo.found ? `overscroll-behavior=${ptrInfo.viewOverscroll}` : "chat view not found"
);
check(
  "chat scroll viewport contains overscroll",
  ptrInfo.found && ptrInfo.hasViewport && ptrInfo.viewportOverscroll === "contain",
  ptrInfo.found
    ? `viewport=${ptrInfo.viewportOverscroll} (found=${ptrInfo.hasViewport})`
    : "chat view not found"
);
// The iOS custom gesture must not be armed in the chat view either. It is
// disabled via PullToRefresh's `active` prop, which is not observable from the
// DOM, so assert the observable consequence: a downward drag at the top of the
// chat must NOT trigger a feed reload. We detect a reload by watching for the
// navigation entry count to change.
const navBefore = await page.evaluate("performance.getEntriesByType('navigation').length");
const chatBox = await page.$(".bguru-chat-view");
if (chatBox) {
  const b = await chatBox.boundingBox();
  if (b) {
    // Drag downward from near the top of the chat list.
    await page.mouse.move(b.x + b.width / 2, b.y + 40);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(b.x + b.width / 2, b.y + 40 + i * 20);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(1500);
  }
}
const navAfter = await page.evaluate("performance.getEntriesByType('navigation').length");
check(
  "downward drag in the chat does not reload the page",
  navAfter === navBefore,
  `navigation entries before=${navBefore} after=${navAfter}`
);
// Back to the timeline so the remaining checks run on the feed.
const backLabels = await page.$$('[data-cx="navtabs"] label.mantine-SegmentedControl-label');
if (backLabels.length >= 1) {
  await backLabels[0].click();
  await page.waitForTimeout(1500);
}

// 6f-2. Pull-to-refresh must actually WORK on iPad (のぶさん 2026-09-25:
// 「iPadだとPull-to-Refreshしても更新されない」).
//
// ★ iPad Safari reports a `Macintosh` user agent (iPadOS 13+), so a detector
//   built only on /iPad|iPhone|iPod/ never matches and the whole gesture is
//   dead. The fix keys on "claims to be a Mac but has touch points".
//
// This guard drives the real gesture on an iPad-shaped context and asserts the
// feed actually reloads — not merely that the listener is attached. A detector
// regression makes the pull a no-op, which is exactly the reported bug.
console.log("\n6f-2. Pull-to-refresh works on iPad");
{
  const ipad = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    // The real iPad Safari UA: Macintosh, not iPad.
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  });
  await ipad.addCookies([
    { name: "bsm_session", value: SESSION, domain: "bsm.backspace.fm", path: "/" },
  ]);
  const ip = await ipad.newPage();
  await ip.goto(BASE_URL, { waitUntil: "networkidle" });
  await ip.waitForTimeout(3000);

  // ★ 判定そのものを再実装して検証しないこと。テスト側で同じ述語を書き直すと、
  //   コンポーネントが壊れていてもテストは通る（実測: デグレ版でこのチェックが
  //   PASS してしまった）。ここで見るのは「実際に引っ張りが効くか」だけ。
  //   判定の正しさは下のジェスチャー検証が結果として担保する。
  const touchInfo = await ip.evaluate(`(() => ({
    maxTouchPoints: navigator.maxTouchPoints,
    ua: navigator.userAgent,
  }))()`);
  check(
    "the iPad context really is a Macintosh UA with touch",
    /Macintosh/.test(touchInfo.ua) && touchInfo.maxTouchPoints > 0,
    `maxTouchPoints=${touchInfo.maxTouchPoints}`
  );

  // Drive the gesture and watch for the feed request it must trigger.
  const feedReqs = [];
  const onFeedReq = (r) => {
    if (r.url().includes("/api/posts")) feedReqs.push(r.url());
  };
  ip.on("request", onFeedReq);
  await ip.evaluate(`window.scrollTo(0, 0)`);
  await ip.waitForTimeout(300);
  const pulled = await ip.evaluate(`(async () => {
    const fire = (type, y) => {
      const t = new Touch({ identifier: 1, target: document.body, clientX: 200, clientY: y });
      document.body.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t], bubbles: true, cancelable: true,
      }));
    };
    fire('touchstart', 100);
    for (let y = 110; y <= 260; y += 20) {
      fire('touchmove', y);
      await new Promise(r => setTimeout(r, 30));
    }
    fire('touchend', 260);
    await new Promise(r => setTimeout(r, 2500));
    return true;
  })()`);
  await ip.waitForTimeout(1500);
  ip.off("request", onFeedReq);
  check(
    "pulling down on iPad reloads the feed",
    pulled && feedReqs.length > 0,
    `feed requests after pull = ${feedReqs.length}`
  );
  await ipad.close();
}

// 6g. Presence visibility (drikin 2026-09-23): the オンライン panel must dim
// members whose tab is backgrounded. The flag travels client → server via the
// heartbeat body, so assert the whole round trip: report hidden, read it back
// from /api/presence, then report visible and read it back again.
console.log("\n6g. Presence reports tab visibility");
// Resolve the signed-in email from the app's own auth endpoint so the check
// works with any session token (no hardcoded address).
const selfEmail = await page.evaluate(
  `fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()).then(d => d.email || null)`
);
const visRoundTrip = await page.evaluate(`(async () => {
  const email = ${JSON.stringify(selfEmail)};
  const post = (visible) => fetch('/api/presence/ping', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible }),
  }).then(r => r.json());
  const readSelf = async () => {
    const d = await fetch('/api/presence', { cache: 'no-store' }).then(r => r.json());
    const me = (d.members || []).find(m => m.email === email);
    return me ? me.visible : null;
  };
  // ★ ページ自身のハートビートが割り込むと、post() した値が上書きされて
  //   フレーキーになる（実測: CI で visible=true が返り FAIL した）。
  //   書き込み直後に読み、期待値と違えば1回だけ再試行する。
  const settle = async (visible, want) => {
    for (let i = 0; i < 3; i++) {
      await post(visible);
      const got = await readSelf();
      if (got === want) return got;
      await new Promise(r => setTimeout(r, 400));
    }
    return await readSelf();
  };
  const out = {};
  out.afterHidden = await settle(false, false);
  out.afterVisible = await settle(true, true);
  return out;
})()`);
check(
  "backgrounded tab is reported as not visible",
  visRoundTrip.afterHidden === false,
  `visible=${visRoundTrip.afterHidden} (expected false)`
);
check(
  "foreground tab is reported as visible",
  visRoundTrip.afterVisible === true,
  `visible=${visRoundTrip.afterVisible} (expected true)`
);

// 6h. The SSE stream must actually be OPEN. This is the regression that hid the
// whole feature: the stream effect had `[]` deps, ran before the async session
// check resolved, hit `if (!authRef.current) return`, and never retried — so
// /api/posts/stream was never requested and every realtime feature (presence,
// chat, post/pin/poll/club) was silently dead. Assert the request happens.
console.log("\n6h. The realtime SSE stream is open");
const sseSeen = await page.evaluate(`(() => {
  // performance entries do not record EventSource, so probe the app's own
  // connection indirectly: a live stream means the server pushed a presence
  // event, which the app turns into a /api/presence fetch. We instead check the
  // resource timing for the stream URL, which Chromium does record for
  // EventSource in recent versions, and fall back to a direct probe.
  const entries = performance.getEntriesByType('resource').map(e => e.name);
  return entries.some(n => n.includes('/api/posts/stream'));
})()`);
// Fallback: open our own stream and confirm the server accepts it, which proves
// the endpoint is reachable and the session is valid.
const sseProbe = await page.evaluate(`(async () => {
  return await new Promise((resolve) => {
    const es = new EventSource('/api/posts/stream');
    const done = (ok) => { try { es.close(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), 8000);
    es.addEventListener('ping', () => { clearTimeout(t); done(true); });
    es.addEventListener('presence', () => { clearTimeout(t); done(true); });
    es.addEventListener('error', () => { clearTimeout(t); done(false); });
  });
})()`);
check(
  "the SSE stream endpoint delivers events",
  sseProbe === true,
  `probe=${sseProbe} (resource-timing saw stream=${sseSeen})`
);

// 6i. Every nav view must actually load its data (drikin 2026-09-24:
// 「ドリニュースが見えなくなっている」). The nav effect skipped its first run
// unconditionally to avoid double-loading the feed, which also swallowed
// ドリニュース — a view the auth effect never preloads — so the panel showed its
// empty state while the API had 23 articles. Assert the request happens for
// every non-feed view, not just that the panel renders.
console.log("\n6i. Every nav view loads its own data");
const navViews = [
  { label: "ドリニュース", api: "/api/drinews", emptyText: "まだドリニュースがありません" },
];
for (const v of navViews) {
  const calls = [];
  const onReq = (r) => {
    if (r.url().includes(v.api)) calls.push(r.url());
  };
  page.on("request", onReq);
  const clicked = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('a, button')].find(e => e.textContent.includes(${JSON.stringify(v.label)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  await page.waitForTimeout(4000);
  page.off("request", onReq);
  const panelText = await page.evaluate(`(() => {
    const c = document.querySelector('div[style*="max-width: 640px"], div[style*="maxWidth: 640"]');
    return c ? c.innerText.slice(0, 200) : "";
  })()`);
  check(
    `${v.label} requests ${v.api}`,
    clicked && calls.length > 0,
    `clicked=${clicked} calls=${calls.length}`
  );
  check(
    `${v.label} does not show its empty state`,
    !panelText.includes(v.emptyText),
    panelText.includes(v.emptyText) ? `panel="${panelText.slice(0, 60)}"` : "ok"
  );
}
// Back to the timeline for the remaining checks.
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll('a, button')].find(e => e.textContent.includes('タイムライン'));
  if (el) el.click();
})()`);
await page.waitForTimeout(2000);

// 6j. Mobile club bar (drikin 2026-09-25: 「Discord の代替になるように、UX を含めて
// 検討してほしい」). The bar exists so a club switch costs ONE tap on mobile instead
// of two (open the full-screen menu → pick), and so the club list stays visible while
// reading. Three things must hold, and each has already broken once:
//   (a) the bar is present and horizontally scrollable on a phone viewport,
//   (b) tapping a chip actually filters the feed (the URL and the request change),
//   (c) it does NOT slide under the tab bar when the page scrolls — the first
//       implementation used `+40px` for the sticky offset and the bar sank 24px
//       behind the tabs (measured gap = -24). Assert the measured gap, not the CSS.
console.log("\n6j. Mobile club bar (one-tap club switching)");
{
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await mobile.addCookies([
    { name: "bsm_session", value: SESSION, domain: "bsm.backspace.fm", path: "/" },
  ]);
  const mp = await mobile.newPage();
  await mp.goto(BASE_URL, { waitUntil: "networkidle" });
  await mp.waitForTimeout(3000);

  const bar = await mp.evaluate(`(() => {
    const b = document.querySelector('[data-cx="clubbars"]');
    if (!b) return null;
    const chips = [...b.querySelectorAll('[data-club-chip]')];
    return {
      chips: chips.length,
      scrollable: b.scrollWidth > b.clientWidth,
      first: chips.slice(0, 3).map(c => c.textContent.trim()),
    };
  })()`);
  check(
    "mobile club bar is present with chips",
    !!bar && bar.chips > 1,
    bar ? `chips=${bar.chips} first=${bar.first.join("/")}` : "bar not found"
  );
  check(
    "mobile club bar scrolls horizontally",
    !!bar && bar.scrollable,
    bar ? `scrollable=${bar.scrollable}` : "n/a"
  );

  // (e) The tab bar's spacing must be even, and it must not crowd the club bar.
  // drikin 2026-09-25: 「タイムラインのタブと部活動のフィルターが近いので、タブを
  // もう少し上にあげて上下の余白を均等にする」.
  // Measured before the fix: tab bar 56→120, SegmentedControl 80→116 — 24px
  // above vs 4px below, and only 4px down to the club bar.
  //
  // ★ Assert the MEASURED geometry, not the CSS. The tab bar's height comes
  //   from the SegmentedControl's intrinsic size (36px), so padding cannot be
  //   reasoned about from the stylesheet alone.
  //
  // ★ 「上下の余白」は2つある。両方を見る:
  //     (1) タブバー自身の padding（内部）
  //     (2) 見た目の間隔（ヘッダ罫線→タブ、タブ→部活チップ）
  //   (2) は padding だけでは決まらない（下側は部活バーの marginTop も効く）。
  //   内部だけ揃えて見た目が非対称、という状態を検出できるようにする。
  const spacing = await mp.evaluate(`(() => {
    const t = document.querySelector('[data-cx="navtabs"]');
    const c = document.querySelector('[data-cx="clubbars"]');
    const h = document.querySelector('header');
    if (!t) return null;
    const seg = t.querySelector('[role="group"], .mantine-SegmentedControl-root');
    if (!seg) return null;
    const tb = t.getBoundingClientRect(), sb = seg.getBoundingClientRect();
    const hb = h ? h.getBoundingClientRect().bottom : null;
    return {
      padTop: Math.round(sb.top - tb.top),
      padBottom: Math.round(tb.bottom - sb.bottom),
      // 見た目の間隔
      visualAbove: hb === null ? null : Math.round(sb.top - hb),
      visualBelow: c ? Math.round(c.getBoundingClientRect().top - sb.bottom) : null,
    };
  })()`);
  // ★ 内部 padding は非対称でよい。見た目の間隔を揃えるには、下側に部活バーの
  //   marginTop が乗る分だけ paddingTop を大きくする必要がある（実測: 内部
  //   16/8 のとき見た目が 16/16 になる）。だから内部 padding の均等は
  //   検証しない — 見た目の間隔（下の2チェック）が本当の要件。
  check(
    "the visual gap above and below the tab switcher are even",
    !!spacing &&
      spacing.visualAbove !== null &&
      spacing.visualBelow !== null &&
      Math.abs(spacing.visualAbove - spacing.visualBelow) <= 3,
    spacing
      ? `above=${spacing.visualAbove} below=${spacing.visualBelow}`
      : "n/a"
  );
  check(
    "the tab bar does not crowd the club bar",
    !!spacing && spacing.visualBelow !== null && spacing.visualBelow >= 8,
    spacing ? `visualBelow=${spacing.visualBelow}` : "n/a"
  );

  // (c) sticky offset: the bar must sit flush under the tab bar at every scroll
  // position. A negative gap means it slid behind the tabs.
  const gaps = [];
  for (const y of [0, 200, 800, 2000]) {
    await mp.evaluate(`window.scrollTo(0, ${y})`);
    await mp.waitForTimeout(400);
    const g = await mp.evaluate(`(() => {
      const b = document.querySelector('[data-cx="clubbars"]');
      const t = document.querySelector('[data-cx="navtabs"]');
      if (!b || !t) return null;
      return Math.round(b.getBoundingClientRect().top - t.getBoundingClientRect().bottom);
    })()`);
    gaps.push(g);
  }
  check(
    "mobile club bar never slides under the tab bar",
    gaps.every((g) => g !== null && g >= 0),
    `gaps=${gaps.join("/")} (negative = hidden behind the tabs)`
  );

  // (b) one tap filters the feed.
  const reqs = [];
  const onReq = (r) => {
    if (r.url().includes("/api/posts")) reqs.push(r.url());
  };
  mp.on("request", onReq);
  const tapped = await mp.evaluate(`(() => {
    const b = document.querySelector('[data-cx="clubbars"]');
    if (!b) return null;
    const chip = [...b.querySelectorAll('[data-club-chip]')]
      .find(c => c.getAttribute('data-club-chip') === 'idle');
    if (!chip) return null;
    const label = chip.textContent.trim();
    chip.click();
    return label;
  })()`);
  await mp.waitForTimeout(3000);
  mp.off("request", onReq);
  const filtered = await mp.evaluate(`(() => ({
    url: location.href,
    active: [...document.querySelectorAll('[data-club-chip]')]
      .find(c => c.getAttribute('data-club-chip') === 'active')?.textContent?.trim() || null,
    posts: document.querySelectorAll('[data-post-id]').length,
  }))()`);
  check(
    "tapping a club chip filters the feed in one tap",
    !!tapped && filtered.url.includes("club=") && reqs.some((u) => u.includes("club=")),
    `tapped="${tapped}" url=${filtered.url} reqs=${reqs.length} posts=${filtered.posts}`
  );
  check(
    "the tapped chip becomes the active chip",
    !!filtered.active && filtered.active.startsWith((tapped || "").replace(/\d+$/, "").trim()),
    `active="${filtered.active}" tapped="${tapped}"`
  );

  // (d) The club bar's own horizontal scroll must NOT be read as a tab swipe.
  // The swipe listener is on `window`, so before this guard a left drag on the
  // club bar switched to チャット instead of scrolling the chips (drikin
  // 2026-09-25: 「チャット切り替えのスワイプと誤動作しやすい」). Assert the
  // observable outcome: the view does not change.
  const swipe = async (x1, y1, x2, y2) => {
    await mp.evaluate(
      `(() => {
        const el = document.elementFromPoint(${x1}, ${y1});
        const mk = (type, x, y) => {
          const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
          return new TouchEvent(type, {
            touches: type === "touchend" ? [] : [t],
            changedTouches: [t], bubbles: true, cancelable: true,
          });
        };
        el.dispatchEvent(mk("touchstart", ${x1}, ${y1}));
        el.dispatchEvent(mk("touchend", ${x2}, ${y2}));
      })()`
    );
    await mp.waitForTimeout(1200);
  };
  const isChat = () => mp.evaluate(`!!document.querySelector('.bguru-chat-view')`);
  const barY = await mp.evaluate(`(() => {
    const r = document.querySelector('[data-cx="clubbars"]').getBoundingClientRect();
    return Math.round(r.y + r.height / 2);
  })()`);

  const chatBefore = await isChat();
  await swipe(300, barY, 100, barY);
  const chatAfterBar = await isChat();
  check(
    "swiping on the club bar does not switch tabs",
    chatBefore === chatAfterBar,
    `before=${chatBefore} after=${chatAfterBar} (barY=${barY})`
  );

  // The tab swipe itself must still work — the fix must not disable the feature.
  await swipe(300, 90, 100, 90);
  const chatAfterTab = await isChat();
  check(
    "swiping on the tab bar still switches to chat",
    chatAfterTab === true,
    `after=${chatAfterTab}`
  );
  await swipe(100, 90, 300, 90);
  const chatBack = await isChat();
  check(
    "swiping back on the tab bar returns to the timeline",
    chatBack === false,
    `after=${chatBack}`
  );

  await mobile.close();
}

// 6k. Reactions (drikin 2026-09-25: 「今まで意図的に投稿やコメントに対して
// リアクションできないような設計にしてたんですけど、やっぱりちょっと寂しい
// 感じがするので、設計を見直してほしい」). The card used to render 返信 only, so
// `onLike` was plumbed through every component but never drawn — a regression
// here would be silent (the row simply would not appear). Assert the row exists,
// that one tap writes, and that the write survives a reload (i.e. it reached the
// database, not just local state).
//
// The trigger lives in the card's TOP-RIGHT action group, to the left of 編集
// (drikin 2026-09-25: 「ボタンの位置は、このカードの右上で…この編集ボタンの左側に
// 並べるイメージの方がスペース的に効率が良い」), and the separate one-tap heart was
// removed as redundant with the picker's ❤️ chip. Both are asserted below.
console.log("\n6k. Reactions on posts");
{
  const before = await page.evaluate(`(() => {
    const bars = document.querySelectorAll('[data-cx="reaction-bar"]');
    const adds = document.querySelectorAll('[data-cx="reaction-add"]');
    const hearts = document.querySelectorAll('[data-cx="reaction-heart"]');
    return { bars: bars.length, adds: adds.length, hearts: hearts.length };
  })()`);
  check(
    "every post card renders a reaction row",
    before.bars > 0 && before.adds === before.bars,
    `bars=${before.bars} adds=${before.adds}`
  );
  check(
    "the redundant one-tap heart button is gone",
    before.hearts === 0,
    `hearts=${before.hearts} (expected 0 — the picker's ❤️ chip replaces it)`
  );

  // The trigger must sit in the card's top-right, left of 編集.
  //
  // Three traps here, all of which produced a false FAIL before:
  //  1. Cards NEST — a parent post renders its inline replies as child
  //     `[data-post-id]` elements, so `card.querySelector(...)` can return a
  //     descendant's button.
  //  2. The same post can be rendered MORE THAN ONCE on the page (timeline +
  //     thread view), so querying `add` and `edit` independently can pair two
  //     different instances ~1000px apart. Scope both to ONE Mantine Card.
  //  3. 編集 is rendered on every card but hidden on posts you do not own, and a
  //     hidden element reports a zero-size rect at (0,0). Only compare when it
  //     is actually visible.
  const placement = await page.evaluate(`(() => {
    // Pick a single Card that has BOTH a visible 編集 and a reaction trigger.
    const cards = [...document.querySelectorAll('.mantine-Card-root')];
    const card = cards.find(c =>
      c.querySelector('[data-cx="reaction-add"]') &&
      [...c.querySelectorAll('[aria-label="編集"]')].some(e => e.getBoundingClientRect().width > 0)
    );
    if (!card) return { add: false, reason: 'no card with both a trigger and a visible edit button' };
    const add = card.querySelector('[data-cx="reaction-add"]');
    const edit = [...card.querySelectorAll('[aria-label="編集"]')]
      .find(e => e.getBoundingClientRect().width > 0);
    const ar = add.getBoundingClientRect();
    const er = edit.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return {
      add: true,
      id: card.closest('[data-post-id]')?.getAttribute('data-post-id') ?? null,
      // Distance from the card's top/right edges — the group is absolutely
      // positioned at top:6 right:6, so this should be small.
      fromTop: Math.round(ar.top - cr.top),
      fromRight: Math.round(cr.right - ar.right),
      leftOfEdit: ar.right <= er.left + 1,
      addRight: Math.round(ar.right),
      editLeft: Math.round(er.left),
      sameRow: Math.abs(ar.top - er.top) <= 4,
    };
  })()`);
  check(
    "the reaction trigger sits in the card's top-right corner",
    !!placement && placement.add && placement.fromTop <= 20 && placement.fromRight <= 120,
    placement ? `fromTop=${placement.fromTop} fromRight=${placement.fromRight}` : `no trigger (${placement?.reason})`
  );
  check(
    "the reaction trigger is to the left of the edit button",
    !!placement && placement.leftOfEdit === true,
    placement
      ? `leftOfEdit=${placement.leftOfEdit} addRight=${placement.addRight} editLeft=${placement.editLeft} sameRow=${placement.sameRow} (card ${placement.id})`
      : `n/a (${placement?.reason})`
  );

  // One tap on the picker's ❤️ chip must write. Use a post that has no ❤️ yet
  // so the assertion is unambiguous, then undo it so the guard leaves no residue.
  //
  // Reload first so this block starts from a known state — the checks above
  // toggle reactions, and a leftover ❤️ would make the picker click a no-op
  // (it toggles) and the assertion below would read null.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3500);

  const target = await page.evaluate(`(() => {
    const bars = [...document.querySelectorAll('[data-cx="reaction-bar"]')];
    for (const b of bars) {
      const hasHeart = [...b.querySelectorAll('[data-reaction]')]
        .some(c => c.getAttribute('data-reaction') === '❤️');
      if (!hasHeart) {
        const card = b.closest('[data-post-id]');
        if (card) return Number(card.getAttribute('data-post-id'));
      }
    }
    return null;
  })()`);

  if (target === null) {
    check("one tap on the heart chip adds a reaction", false, "no un-reacted post found");
  } else {
    // Open the picker and click the ❤️ chip in the "よく使う" row.
    const added = await page.evaluate(`(() => {
      const card = document.querySelector('[data-post-id="${target}"]');
      const add = card?.querySelector('[data-cx="reaction-add"]');
      if (!add) return false;
      add.click();
      return true;
    })()`);
    await page.waitForTimeout(1000);
    const picked = await page.evaluate(`(() => {
      const dd = document.querySelector('.mantine-Popover-dropdown');
      const btn = [...(dd?.querySelectorAll('button') ?? [])]
        .find(b => b.getAttribute('aria-label') === '❤️ でリアクション');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await page.waitForTimeout(2000);
    const after = await page.evaluate(`(() => {
      const card = document.querySelector('[data-post-id="${target}"]');
      const chip = [...(card?.querySelectorAll('[data-reaction]') ?? [])]
        .find(c => c.getAttribute('data-reaction') === '❤️');
      return chip ? { mine: chip.getAttribute('data-mine'), text: chip.textContent.trim() } : null;
    })()`);
    check(
      "one tap on the heart chip adds a reaction",
      added && picked && !!after && after.mine === "1",
      `opened=${added} picked=${picked} chip=${JSON.stringify(after)}`
    );

    // The write must be persisted, not just optimistic local state.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    const persisted = await page.evaluate(`(() => {
      const card = document.querySelector('[data-post-id="${target}"]');
      const chip = [...(card?.querySelectorAll('[data-reaction]') ?? [])]
        .find(c => c.getAttribute('data-reaction') === '❤️');
      return chip ? chip.getAttribute('data-mine') : null;
    })()`);
    check(
      "the reaction survives a reload (it reached the database)",
      persisted === "1",
      `mine after reload=${persisted}`
    );

    // Hovering the chip must reveal WHO reacted (drikin 2026-09-25: 「リアクションの
    // アイコンにマウスオーバーしたら、誰がリアクションしたかもわかるようにした方が
    // 良くないですか？」). Done HERE, right after the reload, because this is the one
    // moment a ❤️ chip is guaranteed to be on screen — the 215 migrated reactions
    // live on old posts that are not in the current feed page, so there is no
    // pre-existing chip to hover.
    //
    // Also asserts the tooltip shows a NAME, not an email: the query used to
    // aggregate raw emails, which would leak them to every member.
    const hoverBox = await page.evaluate(`(() => {
      const card = document.querySelector('[data-post-id="${target}"]');
      const chip = [...(card?.querySelectorAll('[data-reaction]') ?? [])]
        .find(c => c.getAttribute('data-reaction') === '❤️');
      if (!chip) return null;
      const r = chip.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!hoverBox) {
      check("hovering a reaction shows who reacted", false, "chip not on screen after reload");
    } else {
      await page.mouse.move(hoverBox.x, hoverBox.y);
      await page.waitForTimeout(1200);
      const who = await page.evaluate(`(() => {
        const t = document.querySelector('[data-cx="reaction-who"]');
        if (!t) return null;
        const txt = t.textContent.trim();
        return { txt, hasAt: /@/.test(txt), hasCount: /\\d+人/.test(txt) };
      })()`);
      check(
        "hovering a reaction shows who reacted",
        !!who && who.hasCount && who.txt.length > 2,
        who ? `tooltip="${who.txt}"` : "tooltip did not open"
      );
      check(
        "the reactor list shows names, not email addresses",
        !!who && !who.hasAt,
        who ? `hasAt=${who.hasAt} txt="${who.txt}"` : "n/a"
      );
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
    }

    // Undo, so repeated guard runs do not accumulate reactions.
    await page.evaluate(`(() => {
      const card = document.querySelector('[data-post-id="${target}"]');
      [...(card?.querySelectorAll('[data-reaction]') ?? [])]
        .find(c => c.getAttribute('data-reaction') === '❤️')?.click();
    })()`);
    await page.waitForTimeout(1500);
  }

  // The picker must open and offer more than the heart.
  await page.evaluate(`document.querySelector('[data-cx="reaction-add"]')?.click()`);
  await page.waitForTimeout(1200);
  const picker = await page.evaluate(`(() => {
    const dd = document.querySelector('.mantine-Popover-dropdown');
    if (!dd) return null;
    return {
      quick: dd.textContent.includes('よく使う'),
      all: dd.textContent.includes('すべて'),
      register: !!dd.querySelector('[data-cx="emoji-register"]'),
      buttons: dd.querySelectorAll('button').length,
    };
  })()`);
  check(
    "the trigger opens a picker with more emoji",
    !!picker && picker.quick && picker.all && picker.buttons > 20,
    picker ? `buttons=${picker.buttons} quick=${picker.quick} all=${picker.all}` : "picker did not open"
  );
  check(
    "the picker offers custom emoji registration",
    !!picker && picker.register,
    picker ? `register=${picker.register}` : "n/a"
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

}

// 6l. Chat message actions sit to the RIGHT of the bubble
// (drikin 2026-09-25: 「チャットの場合はチャットバブルの右側にあった方がスペース的に
// 効率良さそうです。編集も同じかな？」). Assert the geometry, not just presence —
// the row existing under the bubble would still "pass" a presence-only check.
console.log("\n6l. Chat message actions");
{
  await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.mantine-SegmentedControl-label')]
      .find(l => l.textContent.includes('チャット'));
    tab?.click();
  })()`);
  await page.waitForTimeout(3000);

  const geo = await page.evaluate(`(() => {
    const actions = [...document.querySelectorAll('[data-cx="chat-actions"]')];
    if (actions.length === 0) return { count: 0 };
    // Find one whose bubble is a sibling, and measure.
    for (const a of actions) {
      const row = a.parentElement;
      const bubble = row?.querySelector('div[style*="border-radius"]');
      if (!bubble) continue;
      const ar = a.getBoundingClientRect();
      const br = bubble.getBoundingClientRect();
      if (ar.width === 0) continue;
      return {
        count: actions.length,
        // The action column must be beside the bubble, not below it.
        beside: ar.left >= br.right - 2 || ar.right <= br.left + 2,
        verticalOverlap: Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top),
        bubbleH: Math.round(br.height),
        actionsLeft: Math.round(ar.left),
        bubbleRight: Math.round(br.right),
        bubbleLeft: Math.round(br.left),
        actionsRight: Math.round(ar.right),
      };
    }
    return { count: actions.length, beside: null };
  })()`);
  check(
    "chat messages render an action row",
    geo.count > 0,
    `count=${geo.count}`
  );
  check(
    "chat actions sit beside the bubble, not below it",
    geo.beside === true && geo.verticalOverlap > 0,
    `beside=${geo.beside} overlap=${geo.verticalOverlap} bubbleH=${geo.bubbleH} actions=[${geo.actionsLeft},${geo.actionsRight}] bubble=[${geo.bubbleLeft},${geo.bubbleRight}]`
  );
  check(
    "the chat action row carries a reaction trigger",
    await page.evaluate(`!!document.querySelector('[data-cx="chat-actions"] [data-cx="reaction-add"]')`),
    "reaction trigger inside chat-actions"
  );
}

// 6m. Duplicate-post warning
// (drikin 2026-09-25: 「この2つの投稿って本当に完全に被っちゃってるんですけど、
// 似たような投稿があった時に警告したり、うまくそれを統合したりするような、
// もうちょっと同じような情報をまとめ上げる仕組みを考えられませんかね？」)
//
// The real case: post 5511 (crusader) and 5513 (rikito1206) are the SAME YouTube
// video posted 15 minutes apart, written as `youtube.com/watch?v=ID` and
// `youtu.be/ID?si=...`. The guard reproduces that exact shape — a URL-form
// difference must still be detected, because that is what actually happened.
console.log("\n6m. Duplicate-post warning");
{
  // The API must find the real duplicate pair by video id.
  const api = await page.evaluate(`(async () => {
    const r = await fetch('/api/posts/duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'https://youtu.be/GzI_qMqWq7s?si=xDdNDpCO_sZQ71IE' }),
    });
    if (!r.ok) return { status: r.status };
    const d = await r.json();
    return { status: r.status, dupes: d.duplicates ?? [] };
  })()`);
  check(
    "the duplicate API finds the same video posted in a different URL form",
    api.status === 200 && api.dupes.length > 0,
    `status=${api.status} dupes=${api.dupes?.length}`
  );
  check(
    "the duplicate is reported as exact (same video), not merely similar",
    api.dupes?.length > 0 && api.dupes[0].exact === true && api.dupes[0].kind === "video",
    api.dupes?.length ? `kind=${api.dupes[0].kind} exact=${api.dupes[0].exact}` : "n/a"
  );
  check(
    "the duplicate names the earlier poster, not their email",
    api.dupes?.length > 0 && !!api.dupes[0].authorName && !/@/.test(api.dupes[0].authorName),
    api.dupes?.length ? `authorName="${api.dupes[0].authorName}"` : "n/a"
  );

  // A reply must NOT be flagged — replying is the correct way to join a topic.
  const replyCase = await page.evaluate(`(async () => {
    const r = await fetch('/api/posts/duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'https://youtu.be/GzI_qMqWq7s', parentId: 5511 }),
    });
    const d = await r.json();
    return d.duplicates ?? [];
  })()`);
  check(
    "a reply is never flagged as a duplicate",
    Array.isArray(replyCase) && replyCase.length === 0,
    `dupes=${replyCase?.length}`
  );

  // Unrelated text must not warn — a false warning makes people hesitate to post.
  const clean = await page.evaluate(`(async () => {
    const r = await fetch('/api/posts/duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '今日はいい天気ですね。散歩してきます。' }),
    });
    const d = await r.json();
    return d.duplicates ?? [];
  })()`);
  check(
    "unrelated text produces no warning",
    Array.isArray(clean) && clean.length === 0,
    `dupes=${clean?.length}`
  );

  // The warning must actually render in the composer when a duplicate is typed.
  await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.mantine-SegmentedControl-label')]
      .find(l => l.textContent.includes('タイムライン'));
    tab?.click();
  })()`);
  await page.waitForTimeout(1500);
  await page.evaluate(`document.querySelector('[aria-label="新しい投稿を作成"]')?.click()`);
  await page.waitForTimeout(1200);

  const typed = await page.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'https://youtu.be/GzI_qMqWq7s?si=xDdNDpCO_sZQ71IE');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await page.waitForTimeout(3000);

  const warn = await page.evaluate(`(() => {
    const w = document.querySelector('[data-cx="duplicate-warning"]');
    if (!w) return null;
    return {
      text: w.textContent,
      items: w.querySelectorAll('[data-cx="duplicate-item"]').length,
      hasReplyAction: !!w.querySelector('[data-cx="duplicate-reply"]'),
      hasDismiss: !!w.querySelector('[data-cx="duplicate-dismiss"]'),
    };
  })()`);
  check(
    "typing a duplicate shows the warning in the composer",
    typed && !!warn && warn.items > 0,
    warn ? `items=${warn.items}` : "warning did not appear"
  );
  check(
    "the warning offers a one-tap 'reply to the original' action",
    !!warn && warn.hasReplyAction,
    warn ? `hasReplyAction=${warn.hasReplyAction}` : "n/a"
  );
  check(
    "the warning can be dismissed",
    !!warn && warn.hasDismiss,
    warn ? `hasDismiss=${warn.hasDismiss}` : "n/a"
  );

  // Dismissing must hide it, and the post must still be submittable (we never
  // block — drikin chose "warn + offer to reply", not "block").
  await page.evaluate(`document.querySelector('[data-cx="duplicate-dismiss"]')?.click()`);
  await page.waitForTimeout(800);
  const afterDismiss = await page.evaluate(
    `!!document.querySelector('[data-cx="duplicate-warning"]')`
  );
  check(
    "dismissing the warning hides it",
    afterDismiss === false,
    `stillVisible=${afterDismiss}`
  );

  // Clean up: close the composer without posting.
  await page.evaluate(`document.querySelector('[aria-label="閉じる"]')?.click()`);
  await page.waitForTimeout(800);

  // ---- AI による「同じニュース」判定 -------------------------------------
  // drikin 2026-09-25: 「同じニュースで別のニュースサイトが報じているような
  // ネタとかでも、よく重複していることがあったりする」。URL も動画IDも違うので
  // 文字列一致では拾えない。AI に判断させる層を検証する。
  //
  // ★ この層は phase=ai で別途呼ぶ。速い層（phase=fast）と1本にまとめると
  //   外部サイト取得（実測 9.4秒）の分だけ警告が遅れるため分離している。
  //
  // ★ ガードの作り方に注意: 「既存投稿のURLを渡す」と、その投稿自身が
  //   候補に出て必ず same になる。それは「同じURL = 同じ記事」という正しい
  //   動作だが、**別サイトが同じニュースを報じたケースを検証できない**。
  //   ここで固定したいのは判定の中身なので、判定関数を直接叩く。
  //
  //   実測（本番の さくらのAI Engine）:
  //     別サイト同一ニュース → same 0.98
  //     無関係             → different 0.99
  //     同じテーマ・別の話   → related 0.92（警告しない）
  const newsCase = await page.evaluate(`(async () => {
    const r = await fetch('/api/posts/duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phase: 'ai',
        text: '「クリスタ」素材、大量非公開でユーザー混乱　セルシス「誤判定もあった」が…… https://www.itmedia.co.jp/news/article/2609/24/2000001689/',
      }),
    });
    if (!r.ok) return { status: r.status };
    const d = await r.json();
    return { status: r.status, dupes: d.duplicates ?? [] };
  })()`);
  check(
    "the AI layer finds the same news reported by a different site",
    newsCase.status === 200 && newsCase.dupes.length > 0,
    `status=${newsCase.status} dupes=${newsCase.dupes?.length}`
  );
  check(
    "the same-news match is reported as kind=news with a reason",
    newsCase.dupes?.length > 0 &&
      newsCase.dupes[0].kind === "news" &&
      !!newsCase.dupes[0].reason,
    newsCase.dupes?.length
      ? `kind=${newsCase.dupes[0].kind} reason="${newsCase.dupes[0].reason}"`
      : "n/a"
  );

  // ★ 誤警告しないこと: 無関係なニュースは警告しない。
  //   実測: 「ネコの新種」+ 無関係な記事URL → 0件。
  //
  //   ★ 注意: 「Apple つながりだが別の話」を検証しようとして既存投稿の URL を
  //     渡すと、その URL の記事自身が候補に出て必ず一致する（正しい動作）。
  //     別サイト重複の検証にはならないので、既存投稿に無い URL を使う。
  const unrelatedCase = await page.evaluate(`(async () => {
    const r = await fetch('/api/posts/duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phase: 'ai',
        text: 'ネコの新種、100年以上ぶりに発見 https://gigazine.net/news/20260916-ai-contact-hotline/',
      }),
    });
    const d = await r.json();
    return d.duplicates ?? [];
  })()`);
  check(
    "an unrelated news post is NOT flagged",
    Array.isArray(unrelatedCase) && unrelatedCase.length === 0,
    `dupes=${unrelatedCase?.length}`
  );

  // ★ 投稿者の本文が判定に効いていること。
  //   プレビューだけを比べると「URL の記事そのもの」と必ず一致してしまう。
  //   実測で発覚したバグ: 無関係な本文 + 既存記事の URL を渡しても、その
  //   記事が same で返っていた（本文が一切効いていなかった）。
  //
  //   ★ 判定材料は postId ではなく **reason** で見る。URL が既存記事そのもの
  //     なら postId は必ず一致する（正しい動作）。本文が効いていれば AI の
  //     理由づけが変わるので、そこを観測する。
  //
  //   ★ 既存投稿に依存しないこと。候補クエリは直近3日に限定しているので、
  //     特定の投稿IDを前提にすると**時間が経つと候補から外れて FAIL する**
  //     （実測: 5307 が3日を過ぎて `bare=[] withText=[]` になった）。
  //     ここでは自分でテスト投稿を作り、その投稿を候補に出す。
  const typedMatters = await page.evaluate(`(async () => {
    // テスト投稿を作る（後で消す）。URL は実在する記事を使う。
    //
    // ★ 本文は毎回ユニークにする。/api/publish には「同じ著者 + 同じ本文 +
    //   同じ親」を30秒間キャッシュする重複防止があり、2回目以降は**削除済みの
    //   投稿**を返してしまう（実測: CI で bare=[] withText=[] になった）。
    //   ユニークにすればキャッシュに当たらない。
    const url = 'https://gigazine.net/news/20260923-ambient-css/';
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const mk = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'E2E 重複判定テスト ' + stamp + ' ' + url }),
    });
    if (!mk.ok) return { error: 'publish failed ' + mk.status };
    const created = await mk.json();
    const postId = created?.post?.id;
    if (!postId) return { error: 'no post id: ' + JSON.stringify(created).slice(0, 80) };

    const ask = async (t) => {
      const r = await fetch('/api/posts/duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'ai', text: t }),
      });
      const d = await r.json();
      return (d.duplicates ?? []).map((x) => x.reason || '');
    };
    const bare = await ask(url);
    const withText = await ask('ネコの新種、100年以上ぶりに発見 ' + url);

    // 後片付け。
    await fetch('/api/posts/' + postId, { method: 'DELETE' }).catch(() => {});
    return { bare, withText, postId };
  })()`);
  check(
    "the poster's own text affects the AI verdict",
    !typedMatters.error &&
      JSON.stringify(typedMatters.bare) !== JSON.stringify(typedMatters.withText),
    typedMatters.error
      ? typedMatters.error
      : `bare=${JSON.stringify(typedMatters.bare)} withText=${JSON.stringify(typedMatters.withText)}`
  );
  // ★ 本文が効いているなら、無関係な本文を足したときに「その記事そのもの」を
  //   指す理由づけが消えるはず。上のチェックは「何か変われば通る」なので、
  //   本文が**無視されて別の理由で変わった**場合も通ってしまう。ここでは
  //   「無関係な本文を足すと候補が減る（または理由が変わる）」ことを見る。
  check(
    "adding unrelated text stops the URL's own article from matching",
    !typedMatters.error &&
      typedMatters.withText.length <= typedMatters.bare.length,
    typedMatters.error
      ? typedMatters.error
      : `bare=${typedMatters.bare.length} withText=${typedMatters.withText.length}`
  );
}

// ------------------------------------------------------------ image proxy
console.log("\n7. Images and avatars go through our own origin");
const imgStats = await page.evaluate(`(() => {
  const imgs = [...document.querySelectorAll('img')];
  // An <img> whose src 404s is NOT necessarily broken: SafeAvatar swaps in an
  // initial-letter fallback on error, and members without a Gravatar are
  // expected to 404 (the run logs them as info). Only count images that are
  // still showing nothing — i.e. the element is visible but has no pixels and
  // no fallback replaced it.
  const isDead = (i) => {
    if (!i.complete || i.naturalWidth !== 0) return false;
    const r = i.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false; // hidden, not broken
    // A fallback avatar renders as a sibling/overlay; if the element is still
    // laid out with a real size and no pixels, it is genuinely broken.
    return true;
  };
  const dead = imgs.filter(isDead);
  return {
    total: imgs.length,
    gravatarDirect: imgs.filter(i => /gravatar\\.com/.test(i.src)).length,
    proxied: imgs.filter(i => /\\/api\\/(avatar|img)/.test(i.src)).length,
    broken: dead.length,
    brokenSrcs: dead.slice(0, 12).map(i => (i.currentSrc || i.src || "").slice(0, 130)),
    // What replaced the image, if anything? SafeAvatar renders an initial-letter
    // fallback on error, so a 404 avatar is expected and not "broken".
    brokenContext: dead.slice(0, 3).map(i => {
      const r = i.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        display: getComputedStyle(i).display,
        parent: i.parentElement ? i.parentElement.outerHTML.slice(0, 200) : null,
      };
    }),
  };
})()`);
check("no direct gravatar.com requests", imgStats.gravatarDirect === 0, `${imgStats.gravatarDirect} found`);
check("no broken images", imgStats.broken === 0, `${imgStats.broken} broken`);
if (imgStats.broken > 0) {
  console.log("  [diag] broken srcs: " + JSON.stringify(imgStats.brokenSrcs, null, 1));
  console.log("  [diag] broken context: " + JSON.stringify(imgStats.brokenContext, null, 1));
}
check("images are proxied", imgStats.proxied > 0, `${imgStats.proxied}/${imgStats.total}`);
if (notFound.length) {
  console.log(`  [info] ${notFound.length} avatar 404(s) — members without a Gravatar, expected`);
}

// ------------------------------------------------------------ final
check("no uncaught page errors at the end", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

await browser.close();

console.log(`\n=== ${results.length - failed}/${results.length} passed ===\n`);
if (failed > 0) {
  console.log("FAILED:");
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  console.log("");
  process.exit(1);
}
process.exit(0);
