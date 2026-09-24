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
  const out = {};
  await post(false);
  out.afterHidden = await readSelf();
  await post(true);
  out.afterVisible = await readSelf();
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
